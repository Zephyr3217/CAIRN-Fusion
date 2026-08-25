const DEFAULT_URL = 'http://127.0.0.1:7821';

async function settings() {
  return await chrome.storage.local.get({ serviceUrl: DEFAULT_URL, token: '', brainOn: true });
}

async function api(path, options = {}) {
  const { serviceUrl, token } = await settings();
  if (!token) throw new Error('Open the CAIRN extension popup and paste the Bridge token first.');
  const headers = { ...(options.headers || {}), 'X-CAIRN-Token': token };
  const response = await fetch(serviceUrl.replace(/\/$/, '') + path, { ...options, headers });
  let payload;
  const text = await response.text();
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
  if (!response.ok) {
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(message || `CAIRN request failed (${response.status})`);
  }
  return payload;
}

function jsonPost(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function saveInbox(content, title = 'Web Capture', source = 'browser') {
  return jsonPost('/api/inbox/save', {
    content, title, source_id: source, client_id: 'browser-extension', operation_id: crypto.randomUUID(),
  });
}



async function discoverProviderTabs() {
  const tabs = await chrome.tabs.query({});
  const found = [];
  await Promise.all(tabs.map(async tab => {
    if (!tab?.id) return;
    try {
      const info = await chrome.tabs.sendMessage(tab.id, { type: 'CAIRN_PROVIDER_PING' });
      if (info?.isAi && info?.provider) {
        found.push({
          tabId: tab.id,
          provider: info.provider,
          label: info.label || info.provider,
          host: info.host || '',
          connected: info.connected !== false,
        });
      }
    } catch (_) {}
  }));
  found.sort((a, b) => (a.label || '').localeCompare(b.label || '') || a.tabId - b.tabId);
  return found;
}

function providerGroups(tabs, excludeTabId = null) {
  const groups = new Map();
  for (const tab of tabs) {
    if (excludeTabId && tab.tabId === excludeTabId) continue;
    const current = groups.get(tab.provider) || { provider: tab.provider, label: tab.label, count: 0 };
    current.count += 1;
    groups.set(tab.provider, current);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function broadcastPrompt(msg, sender) {
  const sourceTabId = sender?.tab?.id || null;
  const tabs = await discoverProviderTabs();
  const targets = tabs.filter(tab => tab.tabId !== sourceTabId && (msg.target === 'all' || tab.provider === msg.target));
  const results = [];
  for (const tab of targets) {
    try {
      const result = await chrome.tabs.sendMessage(tab.tabId, {
        type: 'CAIRN_UI_REMOTE_COMPOSE',
        text: msg.text || '',
        paths: msg.paths || [],
        attach: !!msg.attach,
        sourceProvider: msg.sourceProvider || '',
      });
      results.push({ tabId: tab.tabId, provider: tab.provider, label: tab.label, ok: !!result?.ok, result });
    } catch (error) {
      results.push({ tabId: tab.tabId, provider: tab.provider, label: tab.label, ok: false, error: String(error?.message || error) });
    }
  }
  return {
    matched: targets.length,
    inserted: results.filter(x => x.ok && x.result?.inserted).length,
    attachedFiles: results.reduce((sum, x) => sum + (Number(x.result?.attachedCount) || 0), 0),
    attachmentFailures: results.filter(x => x.ok && x.result?.attachRequested && !x.result?.attachedOk).length,
    failed: results.filter(x => !x.ok || !x.result?.inserted).length,
    results,
  };
}

async function broadcastDetach(msg, sender) {
  const sourceTabId = sender?.tab?.id || null;
  const tabs = await discoverProviderTabs();
  const targets = tabs.filter(tab => tab.tabId !== sourceTabId && (msg.target === 'all' || tab.provider === msg.target));
  const results = [];
  for (const tab of targets) {
    try {
      const result = await chrome.tabs.sendMessage(tab.tabId, {
        type: 'CAIRN_UI_REMOTE_DETACH',
        paths: msg.paths || [],
      });
      results.push({ tabId: tab.tabId, provider: tab.provider, label: tab.label, ok: !!result?.ok, result });
    } catch (error) {
      results.push({ tabId: tab.tabId, provider: tab.provider, label: tab.label, ok: false, error: String(error?.message || error) });
    }
  }
  return {
    matched: targets.length,
    detached: results.reduce((sum, x) => sum + (Number(x.result?.detachedCount) || 0), 0),
    failed: results.filter(x => !x.ok).length,
    results,
  };
}

async function handleMessage(msg) {
  const source = msg.source || 'browser';
  switch (msg?.type) {
    case 'CAIRN_GET_SETTINGS': return settings();
    case 'CAIRN_CHECK_CONNECTION': {
      const health = await api('/api/health');
      return { connected: true, watcher: !!health.watcher };
    }
    case 'CAIRN_LIST_NOTES': return api('/api/notes');
    case 'CAIRN_LIST_FOLDERS': return api('/api/folders');
    case 'CAIRN_REFRESH_VAULT': return jsonPost('/api/vault/refresh', {});
    case 'CAIRN_GET_HEADINGS': return api('/api/headings?path=' + encodeURIComponent(msg.path));
    case 'CAIRN_SUGGEST_HEADINGS': return jsonPost('/api/headings/suggest', { content: msg.content || '', count: 3 });
    case 'CAIRN_READ_NOTE': return api('/api/note/read?path=' + encodeURIComponent(msg.path) + '&client_id=browser-extension');
    case 'CAIRN_BUILD_CONTEXT': return jsonPost('/api/context/build', { paths: msg.paths || [], client_id: 'browser-extension', source_id: source });
    case 'CAIRN_RESOLVE_REFS': return jsonPost('/api/context/resolve-refs', { refs: msg.refs || [], client_id: 'browser-extension', source_id: source });
    case 'CAIRN_LIST_MANIFESTS': return api('/api/manifests');
    case 'CAIRN_SAVE_MANIFEST': return jsonPost('/api/manifests', { handle: msg.handle, paths: msg.paths || [], default_write_target: msg.defaultWriteTarget || null, client_id: 'browser-extension' });
    case 'CAIRN_DELETE_MANIFEST': return api('/api/manifests/' + encodeURIComponent(msg.handle.replace(/^@/, '')), { method: 'DELETE' });
    case 'CAIRN_SAVE_INBOX':
    case 'CAIRN_SAVE': return saveInbox(msg.content, msg.title || 'Web Capture', source);
    case 'CAIRN_CREATE_FOLDER': return jsonPost('/api/folder/create', { path: msg.path, client_id: 'browser-extension' });
    case 'CAIRN_CREATE_NOTE': return jsonPost('/api/note/create', {
      path: msg.path, title: msg.title, body: msg.content, client_id: 'browser-extension', source_id: source, operation_id: crypto.randomUUID(),
    });
    case 'CAIRN_APPEND_NOTE': return jsonPost('/api/note/append', {
      path: msg.path, content: msg.content, expected_hash: msg.expectedHash || null, client_id: 'browser-extension', source_id: source, operation_id: crypto.randomUUID(),
    });
    case 'CAIRN_APPEND_UPDATE': return jsonPost('/api/note/append-update', {
      path: msg.path, content: msg.content, title: msg.title || null, expected_hash: msg.expectedHash || null, client_id: 'browser-extension', source_id: source, operation_id: crypto.randomUUID(),
    });
    case 'CAIRN_APPEND_HEADING': return jsonPost('/api/note/append-under-heading', {
      path: msg.path, content: msg.content, heading_path: msg.headingPath, expected_hash: msg.expectedHash || null, client_id: 'browser-extension', source_id: source, operation_id: crypto.randomUUID(),
    });
    case 'CAIRN_APPEND_HEADING_UPDATE': return jsonPost('/api/note/append-under-heading-update', {
      path: msg.path, content: msg.content, heading_path: msg.headingPath, title: msg.title || null, expected_hash: msg.expectedHash || null, client_id: 'browser-extension', source_id: source, operation_id: crypto.randomUUID(),
    });
    case 'CAIRN_PATCH_HEADING': return jsonPost('/api/note/patch-heading', {
      path: msg.path, content: msg.content, heading_path: msg.headingPath, expected_hash: msg.expectedHash || null, client_id: 'browser-extension', source_id: source, operation_id: crypto.randomUUID(),
    });
    case 'CAIRN_AGENT_ASK': return jsonPost('/api/agent/ask', { text: msg.text || '', client_id: 'browser-extension', source_id: source });
    default: throw new Error('UNKNOWN_CAIRN_MESSAGE');
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({brainOn:true}, s => chrome.storage.local.set({brainOn:s.brainOn}));
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cairn-save-selection', title: 'Save selection as new CAIRN Inbox note', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'cairn-open-brain', title: 'Open CAIRN Brain', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'cairn-save-chat', title: 'Save complete chat with CAIRN', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'cairn-open-brain' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {type:'CAIRN_UI_OPEN_BRAIN'}).catch(()=>{}); return;
  }
  if (info.menuItemId === 'cairn-save-chat' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {type:'CAIRN_UI_CAPTURE_CHAT'}).catch(()=>{}); return;
  }
  if (info.menuItemId !== 'cairn-save-selection') return;
  try {
    await saveInbox(info.selectionText, tab?.title || 'Selection', new URL(info.pageUrl).hostname);
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: 'CAIRN', message: 'Saved selection to Inbox.' }).catch(() => {});
  } catch (error) { console.error(error); }
});

chrome.commands?.onCommand?.addListener(async command => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id) return;
  if (command === 'open-brain') chrome.tabs.sendMessage(tab.id,{type:'CAIRN_UI_OPEN_BRAIN'}).catch(()=>{});
  if (command === 'open-agent') chrome.tabs.sendMessage(tab.id,{type:'CAIRN_UI_OPEN_AGENT'}).catch(()=>{});
  if (command === 'capture-selection') chrome.tabs.sendMessage(tab.id,{type:'CAIRN_UI_CAPTURE_SELECTION'}).catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type?.startsWith('CAIRN_')) return;
  if (msg.type === 'CAIRN_LIST_PROVIDER_TABS') {
    discoverProviderTabs()
      .then(tabs => sendResponse({ ok: true, result: { tabs, groups: providerGroups(tabs, sender?.tab?.id || null) } }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.type === 'CAIRN_BROADCAST_PROMPT') {
    broadcastPrompt(msg, sender)
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (msg.type === 'CAIRN_BROADCAST_DETACH') {
    broadcastDetach(msg, sender)
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  handleMessage(msg)
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
