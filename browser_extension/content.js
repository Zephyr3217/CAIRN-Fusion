(() => {
  if (window.__CAIRN_FUSION_UI__) return;
  window.__CAIRN_FUSION_UI__ = true;

  let capturedText = '';
  let panel = null;
  let noteCache = [];
  let brainSelected = new Map();
  let brainOn = true;
  let activeThread = '';
  let manifestsCache = [];
  let captureLabel = 'Selection';
  let captureTitle = document.title;
  let captureInboxTitle = '';
  let bridgeConnected = false;
  let connectionCheckInFlight = false;
  const cairnManagedAttachments = new Set();
  const sourceAttachmentCache = new Map();
  const sourceAttachmentSeenAt = new Map();
  const attachmentRecoveryAttempts = new Map();

  // Chat composers are much less reliable than the models' theoretical context
  // windows. Large text files should be attached as files instead of pasted inline.
  // CAIRN never truncates an oversized selected note.
  const INLINE_TEXT_ATTACHMENT_LIMIT = 30000;

  function stripInjectedCairnContext(text){
    const value=canonicalDraft(text);
    const memory='<<< CAIRN VAULT MEMORY >>>',prompt='<<< USER PROMPT >>>';
    if(value.includes(memory)&&value.includes(prompt)){
      const i=value.lastIndexOf(prompt);
      if(i>=0)return canonicalDraft(value.slice(i+prompt.length));
    }
    return value;
  }
  function oversizedInlineNotes(bundle){
    return (bundle?.notes||[]).filter(n=>Number(n.chars||0)>INLINE_TEXT_ATTACHMENT_LIMIT);
  }
  function inlineAttachmentWarning(bundle){
    const over=oversizedInlineNotes(bundle);
    if(!over.length)return '';
    const details=over.map(n=>{
      const chars=Number(n.chars||0),words=Number(n.words||0);
      return `${n.path} (${chars.toLocaleString()} characters${words?`, ~${words.toLocaleString()} words`:''})`;
    }).join(' · ');
    return `Large text note detected: ${details}. CAIRN will not paste this note into an AI chat box because it exceeds the ${INLINE_TEXT_ATTACHMENT_LIMIT.toLocaleString()}-character reliable inline limit. Nothing was inserted or sent. Recommended: attach the .md file itself, then use Multi-Provider → Insert / Sync; attachment transfer is automatic.`;
  }

  // Query open shadow roots as well as the main document. Modern AI composers
  // increasingly hide upload controls inside web components; ordinary
  // document.querySelectorAll() misses those inputs entirely.
  function deepRoots(root=document){
    const roots=[root],seen=new Set([root]);
    for(let i=0;i<roots.length;i++){
      const r=roots[i];
      let nodes=[];try{nodes=[...r.querySelectorAll?.('*')||[]];}catch(_){}
      for(const el of nodes){const sr=el.shadowRoot;if(sr&&!seen.has(sr)){seen.add(sr);roots.push(sr);}}
    }
    return roots;
  }
  function deepQueryAll(selector,root=document){
    const out=[];for(const r of deepRoots(root)){try{for(const el of r.querySelectorAll?.(selector)||[])if(!out.includes(el))out.push(el);}catch(_){}}
    return out;
  }

  // Mount CAIRN inside the page body and keep it mounted. Some SPA sites (notably
  // Claude) replace/reconcile large DOM regions during navigation, so direct children
  // of <html> are not a reliable home for extension UI.
  const uiRoot = document.createElement('div');
  uiRoot.id = 'cairn-ui-root';
  function ensureUiRoot() {
    const host = document.body || document.documentElement;
    if (host && !uiRoot.isConnected) host.appendChild(uiRoot);
  }
  ensureUiRoot();
  const mountObserver = new MutationObserver(() => ensureUiRoot());
  mountObserver.observe(document.documentElement, {childList:true, subtree:true});

  const floating = document.createElement('button');
  floating.id = 'cairn-floating-save';
  floating.textContent = 'Save to CAIRN';
  uiRoot.appendChild(floating);

  const launcherDock = document.createElement('div');
  launcherDock.id = 'cairn-launcher-dock';
  uiRoot.appendChild(launcherDock);

  const assistantButton = document.createElement('button');
  assistantButton.id = 'cairn-assistant-button';
  assistantButton.textContent = 'CAIRN';
  assistantButton.dataset.short = 'C';
  assistantButton.title = 'Open CAIRN Brain, Multi-Provider, Agent, and Help';
  launcherDock.appendChild(assistantButton);

  const chatButton = document.createElement('button');
  chatButton.id = 'cairn-chat-button';
  chatButton.textContent = 'Save Chat';
  chatButton.dataset.short = 'S';
  chatButton.title = 'Capture the complete AI conversation without highlighting it';
  launcherDock.appendChild(chatButton);

  const refChip = document.createElement('button');
  refChip.id = 'cairn-ref-chip';
  refChip.style.display = 'none';
  uiRoot.appendChild(refChip);

  const replyToastHost=document.createElement('div');
  replyToastHost.id='cairn-reply-toast-host';
  uiRoot.appendChild(replyToastHost);
  let lastReplyToastEventId='';
  function showReplyToast(label,eventId=''){
    // A reply event is delivered through both direct tab messaging and the
    // storage event bus. Deduplicate by event id so every AI tab shows one toast.
    if(eventId&&eventId===lastReplyToastEventId)return;
    if(eventId)lastReplyToastEventId=eventId;
    const toast=document.createElement('div');toast.className='cairn-reply-toast';toast.textContent=`${label} has replied`;replyToastHost.appendChild(toast);
    requestAnimationFrame(()=>toast.classList.add('show'));
    setTimeout(()=>{toast.classList.remove('show');setTimeout(()=>toast.remove(),220);},3600);
  }

  // Connection-aware UI: do not advertise CAIRN controls until the local service
  // is reachable and the stored Bridge token is accepted.
  assistantButton.style.display = 'none';
  chatButton.style.display = 'none';
  floating.style.display = 'none';

  function message(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, response => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok) return reject(new Error(response?.error || 'CAIRN request failed'));
        resolve(response.result);
      });
    });
  }

  chrome.storage.local.get({brainOn:true}, s => {
    brainOn = s.brainOn !== false; activeThread = ''; syncBrainVisibility();
  });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.brainOn) { brainOn = changes.brainOn.newValue !== false; syncBrainVisibility(); }
    // Reliable cross-tab reply event bus. Direct chrome.tabs.sendMessage is kept
    // as a fast path, while storage propagation reaches inactive/frozen provider
    // tabs that may miss a one-shot message. Only supported AI pages render it.
    const event=changes.cairnReplyEvent?.newValue;
    if(event?.id&&Date.now()-Number(event.ts||0)<10000&&providerInfo().provider!=='unknown'){
      showReplyToast(event.label||event.provider||'AI',event.id);
    }
  });

  function syncBrainVisibility() {
    assistantButton.style.display = bridgeConnected ? 'block' : 'none';
    chatButton.style.display = bridgeConnected ? 'block' : 'none';
    if (!bridgeConnected || !brainOn) refChip.style.display = 'none';
    if (!bridgeConnected) {
      floating.style.display = 'none';
      if (panel) removePanel();
    }
  }

  async function refreshConnectionState() {
    if (connectionCheckInFlight) return bridgeConnected;
    connectionCheckInFlight = true;
    try {
      await message({type:'CAIRN_CHECK_CONNECTION'});
      bridgeConnected = true;
    } catch (_) {
      bridgeConnected = false;
    } finally {
      connectionCheckInFlight = false;
      syncBrainVisibility();
    }
    return bridgeConnected;
  }

  function sourceId() { return location.hostname || 'browser'; }
  function providerInfo() {
    const host=location.hostname.toLowerCase();
    const path=location.pathname.toLowerCase();
    if(host.includes('chatgpt.com')||host.includes('openai.com')) return {provider:'chatgpt',label:'ChatGPT',isAi:true,host};
    if(host.includes('claude.ai')) return {provider:'claude',label:'Claude',isAi:true,host};
    if(host.includes('gemini.google.com')) return {provider:'gemini',label:'Gemini',isAi:true,host};
    if(host.includes('copilot.microsoft.com')||host.includes('copilot.cloud.microsoft')) return {provider:'copilot',label:'Copilot',isAi:true,host};
    if(host.includes('perplexity.ai')) return {provider:'perplexity',label:'Perplexity',isAi:true,host};
    if(host==='grok.com'||host.endsWith('.grok.com')||(host==='x.com'&&path.includes('/i/grok'))) return {provider:'grok',label:'Grok',isAi:true,host};
    if(host.includes('chat.deepseek.com')) return {provider:'deepseek',label:'DeepSeek',isAi:true,host};
    if(host==='poe.com'||host.endsWith('.poe.com')) return {provider:'poe',label:'Poe',isAi:true,host};
    if(host==='meta.ai'||host.endsWith('.meta.ai')) return {provider:'meta-ai',label:'Meta AI',isAi:true,host};
    if(host.includes('chat.mistral.ai')) return {provider:'mistral',label:'Mistral',isAi:true,host};
    if(host.includes('huggingface.co')&&path.includes('/chat')) return {provider:'huggingface',label:'HuggingChat',isAi:true,host};
    if(host==='you.com'||host.endsWith('.you.com')) return {provider:'you',label:'You.com',isAi:true,host};
    if(host==='pi.ai'||host.endsWith('.pi.ai')) return {provider:'pi',label:'Pi',isAi:true,host};
    return {provider:'',label:host,isAi:false,host};
  }
  function previewText() { const s=capturedText.trim(); return s.length>360 ? s.slice(0,360)+'…' : s; }
  function safeFilename(text) {
    return (text || 'Web Capture').replace(/[<>:"/\\|?*\x00-\x1F]/g,' ').replace(/\s+/g,' ').trim().slice(0,80) || 'Web Capture';
  }
  function removePanel(){ panel?.remove(); panel=null; launcherDock.classList.remove('is-active'); }

  function shell(title,{back=false,backFn=renderHome}={}) {
    removePanel(); panel=document.createElement('section'); panel.id='cairn-capture-panel'; launcherDock.classList.add('is-active');
    const head=document.createElement('div'); head.className='cairn-head';
    const left=document.createElement('div'); left.className='cairn-head-left';
    if(back){const b=document.createElement('button');b.className='cairn-back';b.textContent='←';b.title='Back';b.onclick=backFn;left.appendChild(b);}
    const heading=document.createElement('strong');heading.textContent=title;left.appendChild(heading);
    const close=document.createElement('button');close.className='cairn-close';close.textContent='✕';close.onclick=removePanel;
    head.append(left,close);
    const body=document.createElement('div');body.className='cairn-body';
    panel.append(head,body);ensureUiRoot();uiRoot.appendChild(panel);return body;
  }

  function addPreview(body){
    const preview=document.createElement('div');preview.className='cairn-preview';preview.textContent=previewText();
    const meta=document.createElement('div');meta.className='cairn-meta';meta.textContent=`${captureLabel} · ${capturedText.length.toLocaleString()} characters · ${location.hostname}`;
    body.append(preview,meta);
  }
  function status(body,text,kind=''){let el=body.querySelector('.cairn-status');if(!el){el=document.createElement('div');el.className='cairn-status';body.appendChild(el);}el.className=`cairn-status ${kind}`;el.textContent=text;return el;}
  function actionButton(label,description,onClick){const b=document.createElement('button');b.className='cairn-action';const strong=document.createElement('b');strong.textContent=label;const small=document.createElement('span');small.textContent=description;b.append(strong,small);b.onclick=onClick;return b;}
  function footer(body,...els){const f=document.createElement('div');f.className='cairn-footer';f.append(...els);body.appendChild(f);return f;}

  function showTabTutorial(body,title,sections=[]){
    body.querySelector('.cairn-tab-tutorial-overlay')?.remove();
    const overlay=document.createElement('div');overlay.className='cairn-tab-tutorial-overlay';
    const card=document.createElement('div');card.className='cairn-tab-tutorial-card';
    const head=document.createElement('div');head.className='cairn-tab-tutorial-head';const h=document.createElement('strong');h.textContent=title;const close=document.createElement('button');close.className='cairn-close';close.textContent='✕';close.onclick=()=>overlay.remove();head.append(h,close);card.appendChild(head);
    const content=document.createElement('div');content.className='cairn-tab-tutorial-content';
    sections.forEach(([name,text])=>{const sec=document.createElement('section');const b=document.createElement('b');b.textContent=name;const p=document.createElement('p');p.textContent=text;sec.append(b,p);content.appendChild(sec);});
    card.appendChild(content);overlay.appendChild(card);overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};body.appendChild(overlay);
  }
  function tabTutorialButton(label,onClick){const b=document.createElement('button');b.className='cairn-secondary cairn-tab-help';b.textContent=label;b.onclick=onClick;return b;}

  async function fetchNotes(force=false){ if(force){try{await message({type:'CAIRN_REFRESH_VAULT'});}catch(_){}} noteCache=await message({type:'CAIRN_LIST_NOTES'});return noteCache; }
  async function fetchManifests(){ manifestsCache=await message({type:'CAIRN_LIST_MANIFESTS'});return manifestsCache; }

  async function renderHome(backFn=null){
    const body=shell('CAIRN Capture',{back:!!backFn,backFn:backFn||renderHome});addPreview(body);
    const actions=document.createElement('div');actions.className='cairn-actions';
    actions.append(
      actionButton('⚡ Save to Inbox','Create a new Markdown note inside CAIRN/Inbox/',async()=>{try{status(body,'Saving…');const r=await message({type:'CAIRN_SAVE_INBOX',content:capturedText,title:captureInboxTitle||captureTitle||document.title,source:sourceId()});status(body,`Saved to ${r.path}`,'ok');setTimeout(removePanel,900);}catch(e){status(body,cleanError(e),'bad');}}),
      actionButton('＋ Create New Note','Create folders + note; semantic H1, no date',renderCreate),
      actionButton('🗓 Append Existing Note','ZEPHRA-style semantic dated update heading',()=>renderNotePicker('append_update')),
      actionButton('§ Add Under Heading','Dated nested update under an exact Markdown heading',()=>renderNotePicker('heading_update')),
      actionButton('✎ Patch Heading Body','Replace one exact heading body; hash check + undo protected',()=>renderNotePicker('patch')),
      actionButton('↳ Raw Append (CAIRN)','Keep the original CAIRN raw append behavior',()=>renderNotePicker('append_raw')),
    );
    body.appendChild(actions);
  }

  function renderCreate(){
    const body=shell('Create Folder + Note',{back:true});addPreview(body);
    const titleLabel=document.createElement('label');titleLabel.textContent='Semantic note title';
    const title=document.createElement('input');title.value=safeFilename(captureTitle || document.title);
    const pathLabel=document.createElement('label');pathLabel.textContent='Vault-relative path';
    const path=document.createElement('input');path.value=`Web Captures/${safeFilename(captureTitle || document.title)}.md`;path.placeholder='Research/New Folder/New Note.md';
    const hint=document.createElement('div');hint.className='cairn-meta';hint.textContent='Missing folders are created automatically. If captured content already starts with # H1, CAIRN preserves it.';
    const save=document.createElement('button');save.className='cairn-primary';save.textContent='Create Note';
    save.onclick=async()=>{let target=path.value.trim().replace(/\\/g,'/');if(!target)return status(body,'Enter a note path.','bad');if(!target.toLowerCase().endsWith('.md'))target+='.md';try{save.disabled=true;status(body,'Creating…');const r=await message({type:'CAIRN_CREATE_NOTE',path:target,title:title.value.trim()||safeFilename(captureTitle || document.title),content:capturedText,source:sourceId()});status(body,`Created ${r.path}`,'ok');setTimeout(removePanel,900);}catch(e){status(body,cleanError(e),'bad');}finally{save.disabled=false;}};
    body.append(titleLabel,title,pathLabel,path,hint,save);
  }

  async function renderNotePicker(mode){
    const labels={append_update:'Append Existing Note',append_raw:'Raw Append',heading_update:'Choose Note for Heading',patch:'Choose Note to Patch'};
    const body=shell(labels[mode]||'Choose Note',{back:true});addPreview(body);
    const toolbar=document.createElement('div');toolbar.className='cairn-inline';
    const search=document.createElement('input');search.placeholder='Search indexed notes…';
    const refresh=document.createElement('button');refresh.className='cairn-mini';refresh.textContent='↻';refresh.title='Refresh live vault index';
    toolbar.append(search,refresh);
    const list=document.createElement('div');list.className='cairn-list cairn-scroll-list';body.append(toolbar,list);status(body,'Loading notes…');
    const load=async(force=false)=>{try{const notes=await fetchNotes(force);body.querySelector('.cairn-status')?.remove();const draw=()=>{list.replaceChildren();const q=search.value.trim().toLowerCase();const filtered=notes.filter(n=>!q||`${n.title||''} ${n.path}`.toLowerCase().includes(q)).slice(0,120);if(!filtered.length){const empty=document.createElement('div');empty.className='cairn-empty';empty.textContent='No matching Markdown notes.';list.appendChild(empty);return;}for(const note of filtered){const b=document.createElement('button');b.className='cairn-note';const name=document.createElement('b');name.textContent=note.title||note.path;const p=document.createElement('small');p.textContent=note.path;b.append(name,p);b.onclick=()=>{if(mode==='append_update')appendToNote(note,body,b,true);else if(mode==='append_raw')appendToNote(note,body,b,false);else renderHeadingPicker(note,mode);};list.appendChild(b);}};search.oninput=draw;draw();}catch(e){list.replaceChildren();status(body,cleanError(e),'bad');}};
    refresh.onclick=()=>load(true);load(false);
  }

  async function appendToNote(note,body,button,dated){
    try{button.disabled=true;status(body,`Appending to ${note.path}…`);const r=await message({type:dated?'CAIRN_APPEND_UPDATE':'CAIRN_APPEND_NOTE',path:note.path,content:capturedText,expectedHash:note.content_hash,source:sourceId()});status(body,`Appended to ${r.path}`,'ok');setTimeout(removePanel,900);}catch(e){status(body,cleanError(e),'bad');button.disabled=false;}
  }

  async function renderHeadingPicker(note,mode='heading_update'){
    const body=shell(mode==='patch'?'Patch Heading Body':'Choose Heading',{back:true,backFn:()=>renderNotePicker(mode)});addPreview(body);
    const noteInfo=document.createElement('div');noteInfo.className='cairn-meta';noteInfo.textContent=`Target: ${note.path}`;
    const list=document.createElement('div');list.className='cairn-list cairn-scroll-list';body.append(noteInfo,list);status(body,'Loading headings…');
    try{const hs=await message({type:'CAIRN_GET_HEADINGS',path:note.path});body.querySelector('.cairn-status')?.remove();
      if(!hs.length){
        const empty=document.createElement('div');empty.className='cairn-empty';empty.textContent='This note has no Markdown headings. CAIRN will not perform a destructive patch on unstructured content.';list.appendChild(empty);
        const sug=await message({type:'CAIRN_SUGGEST_HEADINGS',content:capturedText});
        const title=document.createElement('div');title.className='cairn-meta';title.textContent='Create a new dated section instead:';list.appendChild(title);
        for(const s of sug.suggestions){const b=document.createElement('button');b.className='cairn-heading';b.textContent=s;b.onclick=async()=>{try{b.disabled=true;status(body,'Creating safe dated section…');const r=await message({type:'CAIRN_APPEND_UPDATE',path:note.path,title:s,content:capturedText,expectedHash:note.content_hash,source:sourceId()});status(body,`Created section in ${r.path}`,'ok');setTimeout(removePanel,900);}catch(e){status(body,cleanError(e),'bad');b.disabled=false;}};list.appendChild(b);}return;
      }
      for(const h of hs){const b=document.createElement('button');b.className='cairn-heading';const name=document.createElement('b');name.textContent=`${'#'.repeat(h.level)} ${h.title}`;const p=document.createElement('small');p.textContent=h.path.join(' › ');b.append(name,p);b.onclick=async()=>{
        if(mode==='patch'&&!confirm(`Replace the body under “${h.path.join(' › ')}”?\n\nCAIRN will hash-check the note first and record an Undo snapshot.`))return;
        try{b.disabled=true;status(body,mode==='patch'?`Patching ${h.title}…`:`Adding under ${h.title}…`);const r=await message({type:mode==='patch'?'CAIRN_PATCH_HEADING':'CAIRN_APPEND_HEADING_UPDATE',path:note.path,headingPath:h.path,content:capturedText,expectedHash:note.content_hash,source:sourceId()});status(body,mode==='patch'?`Patched ${h.title} in ${r.path}`:`Added dated update under ${h.title} in ${r.path}`,'ok');setTimeout(removePanel,1000);}catch(e){status(body,cleanError(e),'bad');b.disabled=false;}
      };list.appendChild(b);}
    }catch(e){status(body,cleanError(e),'bad');}
  }

  function cleanCaptureText(el){
    if(!el)return '';
    const clone=el.cloneNode(true);
    clone.querySelectorAll?.('button,nav,svg,[aria-hidden="true"],script,style').forEach(x=>x.remove());
    return String(clone.innerText||clone.textContent||'').replace(/\n{4,}/g,'\n\n\n').trim();
  }
  function pushUnit(units,role,el){
    const text=cleanCaptureText(el); if(!text||text.length<2)return;
    const sig=`${role}|${text.slice(0,160)}`; if(units.some(x=>x.sig===sig))return;
    units.push({role,text,sig});
  }
  function conversationUnits(){
    const host=location.hostname.toLowerCase(), units=[];
    if(host.includes('chatgpt.com')||host.includes('openai.com')){
      document.querySelectorAll('[data-message-author-role]').forEach(el=>pushUnit(units,el.getAttribute('data-message-author-role')||'message',el));
      if(!units.length)document.querySelectorAll('article[data-testid^="conversation-turn"]').forEach(el=>pushUnit(units,el.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role')||'message',el));
    } else if(host.includes('claude.ai')){
      // Claude's DOM changes frequently. Keep several narrow selectors plus a
      // conservative fallback instead of depending on one historical class.
      const userSelectors=[
        '[data-testid="user-message"]',
        '[data-testid*="user-message"]',
        '[data-testid*="human-message"]'
      ];
      const assistantSelectors=[
        '[data-testid="assistant-message"]',
        '[data-testid*="assistant-message"]',
        '[data-testid*="assistant-response"]',
        '[data-testid*="model-response"]',
        '.font-claude-response-body',
        '[class*="claude-response"]',
        '[data-is-streaming="true"]'
      ];
      for(const sel of userSelectors) document.querySelectorAll(sel).forEach(el=>pushUnit(units,'user',el));
      for(const sel of assistantSelectors) document.querySelectorAll(sel).forEach(el=>pushUnit(units,'assistant',el));

      // Newer Claude builds may expose generic message/test-id containers rather
      // than the older response class. Only use nodes with useful text and infer
      // role from attributes/classes; de-duplication in pushUnit prevents repeats.
      if(units.length<2){
        document.querySelectorAll('main [data-testid*="message"], main [data-testid*="response"], main article').forEach(el=>{
          const hint=`${el.getAttribute('data-testid')||''} ${el.getAttribute('aria-label')||''} ${el.className||''}`.toLowerCase();
          const role=/user|human/.test(hint)?'user':(/assistant|claude|model|response/.test(hint)?'assistant':'message');
          pushUnit(units,role,el);
        });
      }
    } else if(host.includes('gemini.google.com')){
      document.querySelectorAll('user-query').forEach(el=>pushUnit(units,'user',el));
      document.querySelectorAll('model-response').forEach(el=>pushUnit(units,'assistant',el));
    }
    if(!units.length){
      const candidates=[...document.querySelectorAll('main article, main [role="article"], main [data-message-id], main [data-testid*="message"]')];
      candidates.forEach((el,i)=>pushUnit(units,`message ${i+1}`,el));
    }
    return units;
  }
  function formatConversation(units,label='Complete Chat'){
    const parts=[`# ${document.title||'AI Conversation'}`,`> ${label} captured by CAIRN`,`> Source: ${location.href}`,`> Captured: ${new Date().toISOString()}`,''];
    units.forEach((u,i)=>{const role=(u.role||`message ${i+1}`).replace(/_/g,' ');parts.push(`## ${role.charAt(0).toUpperCase()+role.slice(1)}`,'',u.text,'');});
    return parts.join('\n').trim();
  }
  function captureCompleteChat(){
    const units=conversationUnits();
    if(!units.length)return null;
    return {text:formatConversation(units,'Complete Chat'),title:`${document.title||'AI Conversation'} - Complete Chat`,label:`Complete Chat (${units.length} messages)`};
  }
  function captureLatestReply(){
    const units=conversationUnits(); if(!units.length)return null;
    const chosen=[...units].reverse().find(x=>/assistant|model/i.test(x.role))||units[units.length-1];
    return {text:formatConversation([chosen],'Latest Reply'),title:`${document.title||'AI Conversation'} - Latest Reply`,label:'Latest AI Reply'};
  }
  function smartLatestReplyUnit(){
    const provider=providerInfo().provider;
    const selectorGroups=provider==='chatgpt'
      ? [['[data-message-author-role="assistant"]']]
      : provider==='gemini'
        ? [['model-response']]
        : provider==='claude'
          ? [
              ['[data-testid="assistant-message"]'],
              ['[data-testid*="assistant-message"]'],
              ['[data-testid*="assistant-response"]'],
              ['[data-testid*="model-response"]'],
              ['.font-claude-response-body'],
              ['[class*="claude-response"]']
            ]
          : [['[data-message-author-role="assistant"]','model-response','[data-testid*="assistant-message"]','[data-testid*="assistant-response"]']];
    for(const selectors of selectorGroups){
      const candidates=[];
      for(const sel of selectors){for(const el of document.querySelectorAll(sel)){if(isVisible(el)&&!candidates.includes(el))candidates.push(el);}}
      const usable=candidates.filter(el=>cleanCaptureText(el).length>1);
      if(usable.length){
        const el=usable[usable.length-1],text=cleanCaptureText(el);
        return {role:'assistant',text,sig:`assistant|${text.slice(0,160)}`};
      }
    }
    const units=conversationUnits();
    return [...units].reverse().find(x=>/assistant|model/i.test(x.role))||units[units.length-1]||null;
  }
  function captureSmartLatestReply(){
    const chosen=smartLatestReplyUnit();if(!chosen)return null;
    return {text:formatConversation([chosen],'Smart Latest Reply'),title:`${document.title||'AI Conversation'} - Smart Latest Reply`,label:'Smart Latest AI Reply'};
  }
  async function renderChatCapture(){
    const body=shell('Save Chat',{back:true,backFn:()=>renderAssistant('brain')});
    const info=document.createElement('div');info.className='cairn-brain-info';info.textContent='Save conversations from this tab or another open AI provider without switching tabs. Choose Complete Chat, Latest Chat, or Smart Latest Chat for exactly one newest AI reply.';body.appendChild(info);
    const row=document.createElement('div');row.className='cairn-broadcast-target';const target=document.createElement('select');target.className='cairn-select';const refresh=document.createElement('button');refresh.className='cairn-mini';refresh.textContent='↻';row.append(target,refresh);body.appendChild(row);
    const meta=document.createElement('div');meta.className='cairn-meta';body.appendChild(meta);
    const loadTargets=async()=>{try{const r=await message({type:'CAIRN_LIST_PROVIDER_TABS'});const tabs=r.tabs||[];const current=providerInfo();target.replaceChildren();const cur=document.createElement('option');cur.value='current';cur.textContent=`Current tab — ${current.label||location.hostname}`;target.appendChild(cur);const all=document.createElement('option');all.value='all';all.textContent=`All open AI chats (${tabs.length})`;target.appendChild(all);const counts=new Map();for(const t of tabs){const g=counts.get(t.provider)||{provider:t.provider,label:t.label,count:0};g.count++;counts.set(t.provider,g);}const by=counts;for(const [key,label] of [['chatgpt','ChatGPT'],['claude','Claude'],['gemini','Gemini']]){const g=by.get(key);const o=document.createElement('option');o.value=key;o.textContent=`${label} (${g?.count||0})`;target.appendChild(o);by.delete(key);}for(const g of by.values()){const o=document.createElement('option');o.value=g.provider;o.textContent=`${g.label} (${g.count})`;target.appendChild(o);}meta.textContent='Choose a provider, or combine all open AI chats into one Markdown capture.';}catch(e){meta.textContent='Provider discovery failed: '+cleanError(e);}};
    refresh.onclick=loadTargets;await loadTargets();
    const localCapture=mode=>mode==='complete'?captureCompleteChat():(mode==='smart'?captureSmartLatestReply():captureLatestReply());
    const modeLabel=mode=>mode==='complete'?'Complete Chats':(mode==='smart'?'Smart Latest Replies':'Latest Chats');
    const capture=async(mode)=>{try{status(body,'Capturing conversation…');let captures=[];if(target.value==='current'){const c=localCapture(mode);if(c)captures=[{...c,provider:providerInfo().label,url:location.href}];}else{const r=await message({type:'CAIRN_CAPTURE_PROVIDER_CHATS',target:target.value,mode});captures=r.captures||[];}if(!captures.length)return status(body,'No compatible conversation content was detected for that target.','bad');captureInboxTitle=mode==='complete'?'NEIL-COMPLETE CHAT':(mode==='smart'?'NEIL-SMART CHAT':'NEIL-LATEST CHAT');if(captures.length===1){const c=captures[0];capturedText=c.text;captureTitle=c.title;captureLabel=c.label;}else{const title=`Multi-Provider ${modeLabel(mode)}`;const parts=[`# ${title}`,`> Captured by CAIRN`, `> Captured: ${new Date().toISOString()}`,''];for(const c of captures){parts.push(`## ${c.provider||'AI'} — ${c.title||'Conversation'}`,'',c.text,'');}capturedText=parts.join('\n').trim();captureTitle=title;captureLabel=`${title} (${captures.length} chats)`;}renderHome(()=>renderChatCapture());}catch(e){status(body,cleanError(e),'bad');}};
    body.append(
      actionButton('💬 Save Complete Chat','Capture the full visible conversation from the selected provider(s)',()=>capture('complete')),
      actionButton('◈ Save Latest Chat','Use CAIRN’s existing latest-reply capture behavior',()=>capture('latest')),
      actionButton('◎ Smart Save Latest Chat','Capture exactly one newest assistant/model reply from each selected provider',()=>capture('smart'))
    );
    const help=tabTutorialButton('How to use Save Chat',()=>showTabTutorial(body,'Save Chat Tutorial',[
      ['1 · Choose source','Pick Current tab, ChatGPT, Claude, Gemini, another detected provider, or All open AI chats.'],
      ['2 · Complete Chat','Use this when you want the whole visible conversation saved to your vault.'],
      ['3 · Latest Chat','Keeps the previous CAIRN latest-reply behavior for compatibility.'],
      ['4 · Smart Latest Chat','Use this when you only want the single newest AI answer—no earlier replies.'],
      ['5 · Save destination','After capture, choose Inbox/Create/Append/Heading. Use the ← button to return to Save Chat without switching browser tabs.']
    ]));body.appendChild(help);
  }

  const ATTACHMENT_EXT_RE=/([\w .()\-\[\]]+\.(?:md|markdown|txt|rtf|pdf|docx?|odt|pages|xlsx?|ods|numbers|pptx?|odp|key|csv|tsv|json|xml|ya?ml|toml|sql|ipynb|html?|css|scss|sass|py|js|mjs|cjs|ts|tsx|jsx|java|kt|kts|c|h|cpp|hpp|cs|rs|go|php|rb|sh|ps1|bat|cmd|log|epub|zip|7z|rar|tar|gz|png|jpe?g|gif|webp|svg|bmp|heic|tiff?|avif|mp4|mov|avi|mkv|webm|m4v|mp3|wav|m4a|aac|ogg|flac))/ig;
  function attachmentKey(file){return `${file.name}:${file.size}:${file.lastModified||0}`;}
  function rememberSourceFiles(files=[]){
    const now=Date.now();
    for(const file of files){
      if(!(file instanceof File))continue;
      const key=attachmentKey(file);
      sourceAttachmentCache.set(key,file);
      sourceAttachmentSeenAt.set(key,now);
    }
    // Keep the cache bounded. It is only a short-lived bridge for provider UIs
    // that destroy their native File object immediately after upload.
    for(const [key,seen] of [...sourceAttachmentSeenAt]){
      if(now-seen>30*60*1000){sourceAttachmentSeenAt.delete(key);sourceAttachmentCache.delete(key);}
    }
  }
  function captureFilesFromInputs(){
    for(const input of deepQueryAll('input[type="file"]')) rememberSourceFiles([...(input.files||[])]);
  }
  document.addEventListener('change',event=>{const input=event.target;if(input?.matches?.('input[type="file"]'))rememberSourceFiles([...(input.files||[])]);},true);
  document.addEventListener('input',event=>{const input=event.target;if(input?.matches?.('input[type="file"]')&&input.files?.length)rememberSourceFiles([...(input.files||[])]);},true);
  document.addEventListener('drop',event=>rememberSourceFiles([...(event.dataTransfer?.files||[])]),true);
  document.addEventListener('paste',event=>rememberSourceFiles([...(event.clipboardData?.files||[])]),true);
  // Some AI sites clear their native file input almost immediately after upload.
  // Poll briefly and cache File objects while they are still available so a later
  // Multi-Provider sync can transfer images/PDFs/docs/etc. without re-selecting.
  setInterval(captureFilesFromInputs,220);

  function findFileInput(){
    const inputs=deepQueryAll('input[type="file"]').filter(x=>!x.disabled);
    return inputs.find(x=>{const a=(x.accept||'').toLowerCase();return !a||a.includes('*')||a.includes('image')||a.includes('audio')||a.includes('video')||a.includes('document')||a.includes('pdf')||a.includes('text')||a.includes('.md')||a.includes('.doc')||a.includes('.zip');})||inputs[0]||null;
  }
  async function ensureFileInput(){
    let input=findFileInput(); if(input)return input;
    // Current AI sites often create their hidden upload input only after the + / attach
    // control is opened. Search broadly but only click visible composer-adjacent controls.
    const composer=findChatInput();
    const scope=composer?.closest?.('form')||composer?.parentElement?.parentElement||document;
    const buttons=[...deepQueryAll('button,[role="button"]',scope), ...(scope===document?[]:deepQueryAll('button,[role="button"]'))]
      .filter((b,i,a)=>a.indexOf(b)===i&&!b.closest?.('#cairn-capture-panel')&&!b.disabled&&isVisible(b));
    const trigger=buttons.find(b=>/attach|upload|add content|add file|add files|paperclip|files|plus|insert/i.test(`${b.getAttribute?.('aria-label')||''} ${b.getAttribute?.('title')||''} ${b.getAttribute?.('data-testid')||''} ${b.textContent||''}`));
    if(trigger){
      try{trigger.click();await new Promise(r=>setTimeout(r,260));}catch(_){}
      input=findFileInput();
    }
    return input;
  }
  async function queueFilesInComposer(files){
    if(!files?.length)return {ok:false,reason:'NO_FILES',count:0};
    const input=await ensureFileInput();
    if(!input)return {ok:false,reason:'NO_FILE_INPUT',count:0};
    try{
      const dt=new DataTransfer();
      const existing=[...(input.files||[])];
      const names=new Set();
      for(const file of existing){dt.items.add(file);names.add(`${file.name}:${file.size}`);}
      let added=0;
      for(const file of files){
        const key=`${file.name}:${file.size}`;
        if(names.has(key))continue;
        dt.items.add(file);names.add(key);added++;
      }
      input.files=dt.files;
      rememberSourceFiles(files);
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
      files.forEach(f=>cairnManagedAttachments.add(f.name));
      await new Promise(r=>setTimeout(r,180));
      return {ok:true,count:added||files.length,names:files.map(f=>f.name)};
    }catch(e){return {ok:false,reason:String(e),count:0};}
  }
  async function attachMarkdownPaths(paths){
    if(!paths?.length)return {ok:false,reason:'NO_SELECTION'};
    const files=await Promise.all(paths.map(async path=>{
      const r=await message({type:'CAIRN_READ_NOTE',path});
      return new File([r.content],path.split('/').pop()||'note.md',{type:'text/markdown'});
    }));
    return queueFilesInComposer(files);
  }
  const TRANSFER_FILE_MAX_BYTES=12*1024*1024;
  const TRANSFER_TOTAL_MAX_BYTES=32*1024*1024;
  function fileToDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(reader.error||new Error('FILE_READ_FAILED'));reader.readAsDataURL(file);});}
  function attachmentScope(){
    const composer=findChatInput();
    if(!composer)return document.body||document.documentElement;
    const provider=providerInfo().provider;
    const explicit=provider==='chatgpt'
      ? composer.closest?.('form,[data-type="unified-composer"],[data-testid*="composer" i]')
      : provider==='claude'
        ? composer.closest?.('form,[data-testid*="composer" i],[data-testid*="chat-input" i]')
        : provider==='gemini'
          ? composer.closest?.('form,input-area-v2,rich-textarea')?.parentElement
          : composer.closest?.('form');
    if(explicit)return explicit;
    // Fall back to the smallest composer ancestor that contains interactive controls.
    // This deliberately avoids scanning the whole conversation, which previously
    // made sent-message attachments look like "current" attachments.
    let cur=composer;
    for(let depth=0;cur&&depth<6;depth++,cur=cur.parentElement){
      if(deepQueryAll('button,[role="button"],input[type="file"]',cur).length>=1)return cur;
    }
    return composer.parentElement||document.body||document.documentElement;
  }
  function extractAttachmentNamesFromText(text){
    const out=[];for(const m of String(text||'').matchAll(ATTACHMENT_EXT_RE)){const name=String(m[1]||'').trim();const words=name.split(/\s+/).filter(Boolean);if(!name||name.length>140||words.length>8||/[!?;:]/.test(name))continue;if(!out.includes(name))out.push(name);}return out;
  }
  function visibleAttachmentNames(){
    const scope=attachmentScope();const out=new Set();const composer=findChatInput();
    const selectors='[data-testid*="attachment" i],[data-testid*="upload" i],[aria-label*="attachment" i],[aria-label*="file" i],[class*="attachment" i],[class*="file-chip" i],[class*="file-pill" i],[class*="upload" i],[class*="preview" i]';
    for(const el of deepQueryAll(selectors,scope).slice(0,160)){
      const raw=`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.textContent||''}`;
      for(const name of extractAttachmentNamesFromText(raw))out.add(name);
    }
    // Provider UI class names change frequently. As a fallback, scan only short
    // composer-local labels that actually look like filenames with known extensions.
    for(const el of deepQueryAll('span,div,p',scope).slice(0,650)){
      if(composer&&(el===composer||composer.contains?.(el)||el.contains?.(composer)))continue;
      const raw=String(el.textContent||'').trim();if(!raw||raw.length>180)continue;
      for(const name of extractAttachmentNamesFromText(raw))out.add(name);
    }
    return [...out];
  }
  function normalizeAttachmentName(name){
    return String(name||'').trim().toLowerCase().replace(/\s*\(\d+\)(?=\.[^.]+$)/,'').replace(/\s+/g,' ');
  }
  function visibleAttachmentCount(){
    const scope=attachmentScope();
    const selectors='[data-testid*="attachment" i],[data-testid*="upload" i],[aria-label*="attachment" i],[aria-label*="file" i],[class*="attachment" i],[class*="file-chip" i],[class*="file-pill" i],[class*="upload" i],[class*="preview" i],figure';
    const boxes=deepQueryAll(selectors,scope).filter(el=>{
      if(el.closest?.('#cairn-ui-root')||!isVisible(el)||el.matches?.('input[type="file"]'))return false;
      const raw=`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.getAttribute?.('data-testid')||''} ${el.className||''} ${el.textContent||''}`.trim();
      if((el.matches?.('button,[role="button"]'))&&/attach|upload|add file|add content|paperclip/i.test(raw)&&!/remove|delete|clear|discard/i.test(raw))return false;
      const looksLikeFile=extractAttachmentNamesFromText(raw).length>0;
      const looksLikeChip=/file-chip|file-pill|attachment-chip|attachment-preview|upload-preview|preview-card|uploaded/i.test(raw);
      const hasRemove=deepQueryAll('button,[role="button"]',el).some(b=>/remove|delete|clear|discard/i.test(`${b.getAttribute?.('aria-label')||''} ${b.getAttribute?.('title')||''} ${b.getAttribute?.('data-testid')||''}`));
      if(!looksLikeFile&&!looksLikeChip&&!hasRemove)return false;
      const r=el.getBoundingClientRect();
      return r.width>24&&r.height>16&&r.width<Math.max(520,window.innerWidth*.8)&&r.height<220;
    });
    const leaves=boxes.filter(el=>!boxes.some(other=>other!==el&&el.contains(other)));
    return Math.min(12,leaves.length);
  }
  function currentAttachmentSnapshot(){
    captureFilesFromInputs();
    const visible=visibleAttachmentNames();
    const visibleCount=Math.max(visible.length,visibleAttachmentCount());
    const inputFiles=[];for(const input of deepQueryAll('input[type="file"]'))inputFiles.push(...(input.files||[]));
    const now=Date.now();
    const cached=[...sourceAttachmentCache.entries()]
      .filter(([key,file])=>file instanceof File&&now-(sourceAttachmentSeenAt.get(key)||0)<15*60*1000)
      .sort((a,b)=>(sourceAttachmentSeenAt.get(b[0])||0)-(sourceAttachmentSeenAt.get(a[0])||0));
    const raw=[...cached.map(x=>x[1]),...inputFiles].filter(f=>f instanceof File);
    const byName=new Map(),byNorm=new Map();
    for(const f of raw){byName.set(f.name,f);byNorm.set(normalizeAttachmentName(f.name),f);}
    const resolved=[];
    for(const name of visible){
      let f=byName.get(name)||byNorm.get(normalizeAttachmentName(name));
      if(f){
        if(f.name!==name){try{f=new File([f],name,{type:f.type||'application/octet-stream',lastModified:f.lastModified||Date.now()});}catch(_){}}
        resolved.push(f);
      }
    }
    let files=[];
    if(visible.length){
      files=resolved;
      // Some providers show a generic chip (or hide a filename) for a newly selected
      // file. Fill unresolved visible slots from the newest cached File objects.
      if(visibleCount>files.length){
        const used=new Set(files.map(f=>attachmentKey(f)));
        for(const [,f] of cached){if(files.length>=visibleCount)break;if(!used.has(attachmentKey(f))){files.push(f);used.add(attachmentKey(f));}}
      }
    }else if(visibleCount>0){
      // Filename-free provider UI: the newest N captured files represent the current
      // composer state. This fixes .md uploads that clear the native file input.
      files=cached.slice(0,visibleCount).map(x=>x[1]);
    }else{
      files=[...new Map(inputFiles.filter(f=>f instanceof File).map(f=>[`${f.name}:${f.size}`,f])).values()];
    }
    files=[...new Map(files.map(f=>[attachmentKey(f),f])).values()];
    const names=[...new Set([...visible,...files.map(f=>f.name)])];
    return {names,visible,visibleCount,files,transferableNames:files.map(f=>f.name)};
  }
  function filenameContainers(name){
    const scope=attachmentScope(),norm=normalizeAttachmentName(name),stem=norm.replace(/\.[^.]+$/,'');
    const selector='[data-testid*="attachment" i],[data-testid*="upload" i],[aria-label*="attachment" i],[aria-label*="file" i],[class*="attachment" i],[class*="file-chip" i],[class*="file-pill" i],[class*="upload" i],[class*="preview" i],figure';
    const out=[];
    for(const el of deepQueryAll(selector,scope)){
      const raw=normalizeAttachmentName(`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.textContent||''}`);
      if(raw.includes(norm)||raw.includes(stem))out.push(el);
    }
    if(!out.length){
      for(const el of deepQueryAll('span,div,p',scope)){
        const raw=normalizeAttachmentName(`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.textContent||''}`);
        if(raw.length<220&&(raw.includes(norm)||raw.includes(stem))){
          let cur=el;for(let i=0;cur&&i<4;i++,cur=cur.parentElement)if(cur&&!out.includes(cur))out.push(cur);
        }
      }
    }
    return out.slice(0,16);
  }
  async function blobToRecoveredFile(blob,name){
    if(!blob||!blob.size||blob.size>TRANSFER_FILE_MAX_BYTES)return null;
    const ext=String(name||'').split('.').pop().toLowerCase();
    const type=blob.type||({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',md:'text/markdown'}[ext]||'application/octet-stream');
    try{return new File([blob],name,{type,lastModified:Date.now()});}catch(_){return null;}
  }
  async function recoverVisibleAttachmentFile(name){
    const norm=normalizeAttachmentName(name),last=attachmentRecoveryAttempts.get(norm)||0;
    if(Date.now()-last<2500)return null;attachmentRecoveryAttempts.set(norm,Date.now());
    for(const box of filenameContainers(name)){
      for(const el of deepQueryAll('img[src],video[src],audio[src],source[src],a[href],object[data],embed[src],iframe[src]',box)){
        const url=el.getAttribute?.('src')||el.getAttribute?.('href')||el.getAttribute?.('data')||'';
        if(!url||(!url.startsWith('blob:')&&!url.startsWith('data:')&&!url.startsWith(location.origin)))continue;
        try{
          const response=await fetch(url,{credentials:'include'});if(!response.ok)continue;
          const file=await blobToRecoveredFile(await response.blob(),name);if(file){rememberSourceFiles([file]);return file;}
        }catch(_){}
      }
      for(const canvas of deepQueryAll('canvas',box)){
        try{const blob=await new Promise(resolve=>canvas.toBlob(resolve));const file=await blobToRecoveredFile(blob,name);if(file){rememberSourceFiles([file]);return file;}}catch(_){}
      }
    }
    return null;
  }
  async function collectTransferableSourceFiles(){
    let snap=currentAttachmentSnapshot();
    const readyNorm=new Set(snap.files.map(f=>normalizeAttachmentName(f.name)));
    // If a provider has already cleared its native <input type=file>, try to recover
    // image/media bytes from the still-visible attachment preview before giving up.
    for(const name of snap.visible){
      if(readyNorm.has(normalizeAttachmentName(name)))continue;
      const recovered=await recoverVisibleAttachmentFile(name);
      if(recovered)readyNorm.add(normalizeAttachmentName(recovered.name));
    }
    snap=currentAttachmentSnapshot();
    const visibleSet=new Set(snap.visible.map(normalizeAttachmentName));
    const candidates=snap.visible.length?snap.files.filter(f=>visibleSet.has(normalizeAttachmentName(f.name))):snap.files;
    const files=[];const skipped=[];let total=0;
    for(const file of candidates){
      if(file.size>TRANSFER_FILE_MAX_BYTES||total+file.size>TRANSFER_TOTAL_MAX_BYTES){skipped.push(file.name);continue;}
      files.push({name:file.name,type:file.type||'application/octet-stream',size:file.size,lastModified:file.lastModified||Date.now(),dataUrl:await fileToDataUrl(file)});
      total+=file.size;
    }
    const transferableNames=files.map(f=>f.name),transferableNorm=new Set(transferableNames.map(normalizeAttachmentName));
    const unavailable=(snap.visible||[]).filter(name=>!transferableNorm.has(normalizeAttachmentName(name)));
    if(Number(snap.visibleCount||0)>transferableNames.length&&!(snap.visible||[]).length){
      unavailable.push(`${Number(snap.visibleCount||0)-transferableNames.length} attachment${Number(snap.visibleCount||0)-transferableNames.length===1?'':'s'} with hidden filename`);
    }
    return {files,skipped,unavailable,totalBytes:total,detected:Math.max(snap.names.length,Number(snap.visibleCount||0)),visibleNames:snap.names,transferableNames};
  }
  async function waitForTransferableSourceFiles({timeoutMs=12000,onProgress=null}={}){
    const started=Date.now();let last=null;
    while(true){
      last=await collectTransferableSourceFiles();
      const missing=(last.unavailable||[]).filter(Boolean);
      if(!missing.length)return last;
      const elapsed=Date.now()-started;
      if(elapsed>=timeoutMs)return last;
      if(onProgress)onProgress(missing,elapsed,timeoutMs);
      await new Promise(r=>setTimeout(r,320));
    }
  }
  async function detachOneComposerAttachment(name){
    const result=await detachMarkdownPaths([name]);
    return {ok:result.count>0,count:result.count,names:result.names||[],reason:result.reason||''};
  }

  async function waitForComposerAttachmentUi(expectedNames=[],timeoutMs=12000){
    if(!expectedNames.length)return {ok:true};
    const expected=new Set(expectedNames.map(normalizeAttachmentName));
    const started=Date.now();
    while(Date.now()-started<timeoutMs){
      const visible=visibleAttachmentNames().map(normalizeAttachmentName);
      const matched=visible.filter(name=>expected.has(name)).length;
      if(matched>=expected.size||visibleAttachmentCount()>=expected.size)return {ok:true};
      await new Promise(r=>setTimeout(r,300));
    }
    return {ok:false,reason:'ATTACHMENT_LOAD_TIMEOUT'};
  }

  async function attachTransferredFiles(items=[]){
    if(!items.length)return {ok:true,count:0,names:[]};
    try{
      const files=[];
      for(const item of items){
        const response=await fetch(item.dataUrl);const blob=await response.blob();
        files.push(new File([blob],item.name||'attachment',{type:item.type||blob.type||'application/octet-stream',lastModified:item.lastModified||Date.now()}));
      }
      const queued=await queueFilesInComposer(files);
      if(!queued.ok)return queued;
      const loaded=await waitForComposerAttachmentUi(files.map(f=>f.name),12000);
      if(!loaded.ok)return {ok:false,count:queued.count||0,names:queued.names||files.map(f=>f.name),reason:loaded.reason};
      return {...queued,ready:true};
    }catch(e){return {ok:false,count:0,reason:String(e)};}
  }
  function attachmentNames(paths=[]){
    const named=(paths||[]).map(p=>String(p).split('/').pop()).filter(Boolean);
    return new Set(named.length?named:[...cairnManagedAttachments]);
  }
  function removeAttachmentChipByName(scope,name){
    const semantic=b=>/remove|delete|close|detach|discard|clear/i.test(`${b.getAttribute?.('aria-label')||''} ${b.getAttribute?.('title')||''} ${b.getAttribute?.('data-testid')||''} ${b.textContent||''}`);
    const candidateSelector='[data-testid*="attachment" i],[data-testid*="upload" i],[aria-label*="attachment" i],[class*="attachment" i],[class*="file-chip" i],[class*="file-pill" i],[class*="upload" i],[class*="preview" i]';
    const containers=deepQueryAll(candidateSelector,scope).filter(el=>{
      const raw=`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.textContent||''}`;return raw.includes(name)||raw.includes(name.replace(/\.[^.]+$/,''));
    });
    for(const box of containers){
      const buttons=deepQueryAll('button,[role="button"]',box).filter(b=>!b.closest?.('#cairn-capture-panel'));
      const btn=buttons.find(semantic)||buttons.find(b=>b.querySelector('svg')&&b.getBoundingClientRect().width<56)||((buttons.length===1)?buttons[0]:null);
      if(btn){try{btn.click();return true;}catch(_){} }
    }
    const textNodes=deepQueryAll('span,div,p',scope).filter(el=>{
      const raw=`${el.getAttribute?.('aria-label')||''} ${el.getAttribute?.('title')||''} ${el.textContent||''}`.trim();return raw.length<240&&(raw.includes(name)||raw.includes(name.replace(/\.[^.]+$/,'')));
    }).slice(0,60);
    for(const el of textNodes){
      let cur=el;
      for(let depth=0;cur&&depth<6;depth++,cur=cur.parentElement){
        const buttons=deepQueryAll('button,[role="button"]',cur).filter(b=>!b.closest?.('#cairn-capture-panel'));
        const btn=buttons.find(semantic)||buttons.find(b=>b.querySelector('svg')&&b.getBoundingClientRect().width<56)||((buttons.length===1)?buttons[0]:null);
        if(btn){try{btn.click();return true;}catch(_){} }
      }
    }
    return false;
  }
  async function detachMarkdownPaths(paths=[]){
    const names=attachmentNames(paths);
    if(!names.size)return {ok:true,reason:'NO_MANAGED_ATTACHMENTS',count:0,names:[]};
    const removed=new Set();
    const input=findFileInput();
    if(input?.files?.length){
      try{
        const dt=new DataTransfer();
        for(const file of [...input.files]){
          if(names.has(file.name))removed.add(file.name); else dt.items.add(file);
        }
        if(removed.size){
          input.files=dt.files;
          input.dispatchEvent(new Event('input',{bubbles:true}));
          input.dispatchEvent(new Event('change',{bubbles:true}));
        }
      }catch(_){}
    }
    const scope=attachmentScope();
    for(const name of names){
      if(removeAttachmentChipByName(scope,name)){removed.add(name);await new Promise(r=>setTimeout(r,80));}
    }
    for(const name of removed){
      cairnManagedAttachments.delete(name);
      for(const [key,file] of [...sourceAttachmentCache])if(file?.name===name){sourceAttachmentCache.delete(key);sourceAttachmentSeenAt.delete(key);}
    }
    return {ok:true,count:removed.size,names:[...removed],reason:removed.size?'':'ATTACHMENT_UI_NOT_FOUND'};
  }
  async function detachAllComposerAttachments(){
    const removed=new Set();
    const before=new Set(visibleAttachmentNames());
    // Clear exposed file inputs first.
    for(const input of deepQueryAll('input[type="file"]')){
      if(!input.files?.length)continue;
      try{for(const file of [...input.files])removed.add(file.name);input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}catch(_){}
    }
    const semantic=/remove|delete|close|detach|discard|clear/i;
    // Providers frequently render chips outside the <form>, so search the document,
    // but only act on small attachment-like controls and never CAIRN's own UI.
    for(let pass=0;pass<4;pass++){
      let clicked=0;
      const names=[...new Set([...visibleAttachmentNames(),...cairnManagedAttachments])];
      for(const name of names){
        if(removeAttachmentChipByName(document,name)){removed.add(name);clicked++;await new Promise(r=>setTimeout(r,55));}
      }
      const buttons=deepQueryAll('button,[role="button"]').filter(b=>{
        if(b.closest?.('#cairn-ui-root')||b.disabled||!isVisible(b))return false;
        const h=`${b.getAttribute?.('aria-label')||''} ${b.getAttribute?.('title')||''} ${b.getAttribute?.('data-testid')||''}`.toLowerCase();
        const r=b.getBoundingClientRect();
        return r.width<90&&r.height<70&&((semantic.test(h)&&/(file|attachment|upload|image|document)/i.test(h))||/remove file|remove attachment|delete file|clear attachment/i.test(h));
      }).slice(0,24);
      for(const btn of buttons){try{btn.click();clicked++;await new Promise(r=>setTimeout(r,60));}catch(_){}}
      if(!clicked)break;
    }
    await new Promise(r=>setTimeout(r,120));
    const remaining=visibleAttachmentNames();
    for(const name of before)if(!remaining.some(x=>normalizeAttachmentName(x)===normalizeAttachmentName(name)))removed.add(name);
    for(const name of removed)cairnManagedAttachments.delete(name);
    for(const [key,file] of [...sourceAttachmentCache]){if(removed.has(file?.name)||[...removed].some(n=>normalizeAttachmentName(n)===normalizeAttachmentName(file?.name))){sourceAttachmentCache.delete(key);sourceAttachmentSeenAt.delete(key);}}
    return {ok:remaining.length===0,count:removed.size,names:[...removed],remaining};
  }

  async function syncManagedAttachments({markdownPaths=[],transferFiles=[]}={}){
    // Multi-Provider attachment state follows the latest sync, just like prompt text.
    // A target is only considered ready when its previous attachment state was
    // actually cleared; otherwise CAIRN would silently stack stale files.
    const detached=await detachAllComposerAttachments();
    let md={ok:true,count:0,names:[]},transferred={ok:true,count:0,names:[]};
    if(markdownPaths.length)md=await attachMarkdownPaths(markdownPaths);
    if(transferFiles.length)transferred=await attachTransferredFiles(transferFiles);
    return {detached,md,transferred,ok:!!detached.ok&&!!md.ok&&!!transferred.ok,remaining:detached.remaining||[]};
  }
  async function attachMarkdown(note){ return attachMarkdownPaths([note.path]); }
  async function detachMarkdown(note){ return detachMarkdownPaths([note.path]); }
  async function downloadMarkdown(note){
    const r=await message({type:'CAIRN_READ_NOTE',path:note.path});const blob=new Blob([r.content],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=note.path.split('/').pop()||'note.md';a.style.display='none';ensureUiRoot();uiRoot.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},1000);
  }
  async function renderNoteViewer(note,backFn=()=>renderAssistant('brain')){
    const body=shell('Open .md',{back:true,backFn});status(body,'Reading note…');
    try{const r=await message({type:'CAIRN_READ_NOTE',path:note.path});body.querySelector('.cairn-status')?.remove();const meta=document.createElement('div');meta.className='cairn-meta';meta.textContent=`${note.path} · ${r.chars.toLocaleString()} characters`;const pre=document.createElement('pre');pre.className='cairn-md-view';pre.textContent=r.content;body.append(meta,pre);
      const insert=document.createElement('button');insert.className='cairn-primary';insert.textContent='Insert into Chat';insert.onclick=()=>{const bundle={notes:[{path:note.path,chars:r.chars,words:r.words||0}]};const warning=inlineAttachmentWarning(bundle);if(warning)return status(body,warning,'bad');if(insertIntoChat(r.content)){status(body,'Inserted Markdown into the chat box.','ok');}else status(body,'No compatible chat box found.','bad');};
      const attach=document.createElement('button');attach.className='cairn-secondary';attach.textContent='Attach .md';attach.onclick=async()=>{const a=await attachMarkdown(note);if(a.ok)status(body,'Attached .md to the current chat input. Review before sending.','ok');else status(body,'This site did not expose a compatible file input. Use Download .md or Insert into Chat instead.','bad');};
      const detach=document.createElement('button');detach.className='cairn-secondary';detach.textContent='Detach all files';detach.onclick=async()=>{const d=await detachAllComposerAttachments();if(d.ok)status(body,`Detached all ${d.count} composer attachment${d.count===1?'':'s'} from this chat.`,'ok');else status(body,'CAIRN could not find that attachment in the current composer. It may already have been removed or the site hides its attachment controls.','bad');};
      const dl=document.createElement('button');dl.className='cairn-secondary';dl.textContent='Download .md';dl.onclick=()=>downloadMarkdown(note);
      footer(body,insert,attach,detach,dl);
    }catch(e){status(body,cleanError(e),'bad');}
  }
  function isVisible(el){if(!el)return false;const style=getComputedStyle(el);const r=el.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&r.width>20&&r.height>8;}
  function composerHint(el){return `${el?.getAttribute?.('placeholder')||''} ${el?.getAttribute?.('aria-label')||''} ${el?.getAttribute?.('data-placeholder')||''} ${el?.getAttribute?.('data-testid')||''} ${el?.id||''} ${el?.className||''}`.toLowerCase();}
  function isLikelyComposer(el){if(!isTextInput(el)||!isVisible(el))return false;const hint=composerHint(el);if(/search/.test(hint)&&!/message|prompt|reply|chat|composer/.test(hint))return false;const form=el.closest?.('form');const rect=el.getBoundingClientRect();const nearBottom=rect.bottom>Math.max(120,window.innerHeight*0.38);return !!form||nearBottom||/message|prompt|reply|chat|composer|prosemirror|lexical|ql-editor/.test(hint);}
  function isTextInput(el){if(!el||el.closest?.('#cairn-capture-panel'))return false;if(el instanceof HTMLTextAreaElement)return !el.disabled&&!el.readOnly;if(el instanceof HTMLInputElement)return ['text','search'].includes(el.type)&&!el.disabled&&!el.readOnly;return el.isContentEditable||el.getAttribute?.('contenteditable')==='true'||el.getAttribute?.('role')==='textbox';}
  function composerSelectors(){
    const host=location.hostname.toLowerCase();
    if(host.includes('claude.ai')) return [
      '[data-testid="chat-input"] [contenteditable="true"]','[data-testid*="chat-input"] [contenteditable="true"]','[data-testid*="composer"] [contenteditable="true"]','form .ProseMirror[contenteditable="true"]','.ProseMirror[contenteditable="true"]','[data-lexical-editor="true"][contenteditable="true"]','[contenteditable="true"][aria-label*="message" i]','[contenteditable="true"][aria-label*="reply" i]','[contenteditable="true"][role="textbox"]','textarea'
    ];
    if(host.includes('gemini.google.com')) return [
      'rich-textarea .ql-editor[contenteditable="true"]','rich-textarea [contenteditable="true"]','.ql-editor[contenteditable="true"]','[data-lexical-editor="true"][contenteditable="true"]','[contenteditable="true"][role="textbox"]','textarea'
    ];
    if(host.includes('chatgpt.com')||host.includes('openai.com')) return [
      '#prompt-textarea','div#prompt-textarea[contenteditable="true"]','[data-testid="prompt-textarea"]','form [contenteditable="true"][role="textbox"]','form .ProseMirror[contenteditable="true"]','form textarea'
    ];
    return [];
  }
  function selectionComposer(){
    try{const node=window.getSelection?.()?.anchorNode;const el=node?.nodeType===1?node:node?.parentElement;const editable=el?.closest?.('[contenteditable="true"],[role="textbox"],textarea,input');return isLikelyComposer(editable)?editable:null;}catch(_){return null;}
  }
  function chatInputCandidates(){
    const selectors=[...composerSelectors(),'div[contenteditable="true"][role="textbox"]','textarea[placeholder*="Message" i]','textarea[placeholder*="Ask" i]','textarea','[contenteditable="true"]'];
    const found=[];const active=document.activeElement;const selected=selectionComposer();
    for(const first of [active,selected])if(isLikelyComposer(first)&&!found.includes(first))found.push(first);
    for(const selector of selectors){for(const el of document.querySelectorAll(selector)){if(!isLikelyComposer(el)||found.includes(el))continue;found.push(el);}}
    found.sort((a,b)=>{
      const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();const ah=composerHint(a),bh=composerHint(b);
      const aScore=(a===active?60000:0)+(a===selected?55000:0)+(a.id==='prompt-textarea'?30000:0)+(a.classList?.contains('ProseMirror')?22000:0)+(a.classList?.contains('ql-editor')?21000:0)+(a.getAttribute?.('data-lexical-editor')==='true'?18000:0)+(/message|prompt|reply|chat|composer/.test(ah)?12000:0)+(a.closest?.('form')?7000:0)+ar.bottom;
      const bScore=(b===active?60000:0)+(b===selected?55000:0)+(b.id==='prompt-textarea'?30000:0)+(b.classList?.contains('ProseMirror')?22000:0)+(b.classList?.contains('ql-editor')?21000:0)+(b.getAttribute?.('data-lexical-editor')==='true'?18000:0)+(/message|prompt|reply|chat|composer/.test(bh)?12000:0)+(b.closest?.('form')?7000:0)+br.bottom;
      return bScore-aScore;
    });
    return found;
  }
  function findChatInput(){return chatInputCandidates()[0]||null;}
  function nativeSetter(el,value){const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,value);else el.value=value;}
  function inputText(el){if(!el)return '';if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement)return el.value||'';return String(el.innerText||el.textContent||'').replace(/\u200B/g,'');}
  function canonicalDraft(text){return String(text||'').replace(/\r\n?/g,'\n').replace(/\u200B/g,'').replace(/\u00A0/g,' ').replace(/[ \t]+\n/g,'\n').trim();}
  function draftEquivalent(actual,wanted){const a=canonicalDraft(actual),w=canonicalDraft(wanted);if(a===w)return true;return a.replace(/\n{3,}/g,'\n\n')===w.replace(/\n{3,}/g,'\n\n');}
  function readCurrentDraft(){const candidates=chatInputCandidates();for(const el of candidates){const text=canonicalDraft(inputText(el));if(text)return {el,text};}const el=candidates[0]||null;return {el,text:el?canonicalDraft(inputText(el)):''};}
  function replaceEditableFast(el,text){
    try{
      const frag=document.createDocumentFragment(),lines=String(text).replace(/\r\n?/g,'\n').split('\n');
      lines.forEach((line,i)=>{if(i)frag.appendChild(document.createElement('br'));if(line)frag.appendChild(document.createTextNode(line));});
      el.replaceChildren(frag);
      el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return draftEquivalent(inputText(el),text);
    }catch(_){return false;}
  }
  function setContentEditableText(el,text){
    if(!el)return false;el.focus();
    // Large Markdown contexts use a single detached DocumentFragment first. This
    // avoids one live <p> per line (which caused huge paragraph spacing and slow
    // layout on long notes) while preserving every line of the original context.
    if(String(text).length>12000&&replaceEditableFast(el,text))return true;
    try{
      const sel=window.getSelection(),range=document.createRange();range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
      if(document.execCommand('insertText',false,text)){
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
        if(draftEquivalent(inputText(el),text))return true;
      }
    }catch(_){}
    return replaceEditableFast(el,text);
  }
  function setChatText(el,text){
    el.focus();
    if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement){nativeSetter(el,text);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));el.dispatchEvent(new Event('change',{bubbles:true}));el.setSelectionRange?.(text.length,text.length);return draftEquivalent(el.value||'',text);}
    return setContentEditableText(el,text);
  }
  function insertIntoChat(text){const el=findChatInput();if(!el)return false;const current=canonicalDraft(inputText(el));return setChatText(el,current?`${current}\n\n${text}`:text);}
  async function insertIntoChatRobust(text){for(const delay of [0,120,320]){if(delay)await new Promise(r=>setTimeout(r,delay));const el=findChatInput();if(!el)continue;const current=canonicalDraft(inputText(el));if(setChatText(el,current?`${current}\n\n${text}`:text))return true;}return false;}
  async function replaceChatTextRobust(text){for(const delay of [0,100,260]){if(delay)await new Promise(r=>setTimeout(r,delay));const el=findChatInput();if(el&&setChatText(el,text))return true;}return false;}
  async function clearChatTextRobust(){
    for(const delay of [0,100,260]){
      if(delay)await new Promise(r=>setTimeout(r,delay));
      const el=findChatInput();if(!el)continue;
      if(setChatText(el,'')&&canonicalDraft(inputText(el))==='')return true;
      try{
        el.focus();
        if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement){nativeSetter(el,'');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));el.dispatchEvent(new Event('change',{bubbles:true}));}
        else{const sel=window.getSelection(),range=document.createRange();range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);document.execCommand('delete',false,null);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));}
        if(canonicalDraft(inputText(el))==='')return true;
      }catch(_){}
    }
    return false;
  }
  function findSendButton(){
    const el=findChatInput();if(!el)return null;
    const provider=providerInfo().provider;
    const scope=el.closest?.('form')||el.closest?.('[data-testid*="composer" i],[data-type="unified-composer"],input-area-v2')||el.parentElement?.parentElement||document;
    const selectors=provider==='chatgpt'
      ? ['button[data-testid="send-button"]','#composer-submit-button','button[aria-label="Send prompt"]','button[aria-label="Send message"]','button[aria-label^="Send" i]']
      : provider==='claude'
        ? ['button[aria-label="Send message"]','button[data-testid="send-button"]','button[data-testid*="send" i]','button[aria-label^="Send" i]']
        : provider==='gemini'
          ? ['button[aria-label*="Send message" i]','button.send-button','button[mattooltip*="Send" i]','button[aria-label^="Send" i]']
          : ['button[data-testid="send-button"]','#composer-submit-button','button[aria-label="Send message"]','button[aria-label^="Send" i]','button.send-button'];
    const candidates=[];
    for(const sel of selectors){for(const b of scope.querySelectorAll?.(sel)||[]){if(!candidates.includes(b))candidates.push(b);}}
    // Only use document-wide fallbacks when the control still explicitly identifies
    // itself as a send action. This prevents Claude's temporary/incognito controls
    // (and other nearby mode buttons) from being clicked by a broad submit selector.
    if(scope!==document){for(const sel of selectors.filter(x=>!x.includes('data-testid*'))){for(const b of document.querySelectorAll(sel)){if(!candidates.includes(b))candidates.push(b);}}}
    const dangerous=/incognito|temporary|private|mode|new chat|new conversation|model|style|tools?/i;
    return candidates.find(b=>{
      if(b.disabled||b.getAttribute?.('aria-disabled')==='true'||b.closest?.('#cairn-capture-panel')||!isVisible(b))return false;
      const hint=`${b.getAttribute?.('aria-label')||''} ${b.getAttribute?.('title')||''} ${b.getAttribute?.('data-testid')||''} ${b.textContent||''}`.trim();
      return /send|submit/i.test(hint)&&!dangerous.test(hint);
    })||null;
  }
  async function sendCurrentComposerRobust(){
    for(const delay of [80,220,520]){
      await new Promise(r=>setTimeout(r,delay));
      const button=findSendButton();if(button){try{button.click();return true;}catch(_){}}
      const el=findChatInput(),form=el?.closest?.('form');
      if(form?.requestSubmit){
        const submitters=[...form.querySelectorAll('button[type="submit"],input[type="submit"]')].filter(b=>!b.disabled&&b.getAttribute?.('aria-disabled')!=='true');
        // Only use native form submission when the form has no ambiguous submit
        // controls. Claude gets the stricter path because a wrong nearby control can
        // change chat privacy/temporary mode instead of sending the message.
        if(providerInfo().provider!=='claude'&&submitters.length<=1){try{form.requestSubmit();return true;}catch(_){}}
      }
    }
    return false;
  }
  async function copyFallback(text){try{await navigator.clipboard.writeText(text);return true;}catch(_){return false;}}

  let replyWatchToken=0;
  function latestAssistantSnapshot(){
    const units=conversationUnits();const u=[...units].reverse().find(x=>/assistant|model/i.test(x.role));
    return u?canonicalDraft(u.text):'';
  }
  function providerGenerating(){
    return [...document.querySelectorAll('button,[role="button"]')].some(b=>{if(!isVisible(b))return false;const h=`${b.getAttribute?.('aria-label')||''} ${b.getAttribute?.('title')||''} ${b.getAttribute?.('data-testid')||''} ${b.textContent||''}`;return /stop generating|stop response|stop streaming|stop$/i.test(h.trim());});
  }
  function beginReplyWatch(){
    const token=++replyWatchToken,baseline=latestAssistantSnapshot(),started=Date.now();let seen='',stableSince=0;
    const tick=async()=>{
      if(token!==replyWatchToken)return;
      const now=Date.now(),latest=latestAssistantSnapshot();
      if(latest&&latest!==baseline){if(latest!==seen){seen=latest;stableSince=now;}else if(stableSince&&now-stableSince>800&&!providerGenerating()){
        const p=providerInfo();try{await message({type:'CAIRN_PROVIDER_REPLY_DONE',provider:p.provider,label:p.label});}catch(_){}return;
      }}
      if(now-started<240000)setTimeout(tick,300);
    };setTimeout(tick,350);
  }

  function assistantTabs(body,active){
    const tabs=document.createElement('div');tabs.className='cairn-assistant-tabs';
    const items=[['brain','Brain'],['multi','Multi-Provider'],['agent','Agent'],['help','Help']];
    for(const [id,label] of items){
      const b=document.createElement('button');b.className='cairn-assistant-tab'+(active===id?' active':'');b.textContent=label;
      if(id==='brain'&&!brainOn){b.title='Brain is OFF in the extension popup';b.classList.add('disabled');}
      b.onclick=()=>{if(id==='brain'&&!brainOn)return;renderAssistant(id);};tabs.appendChild(b);
    }
    body.appendChild(tabs);
  }

  function renderHelpContent(body){
    panel.classList.remove('cairn-brain-mode');
    const wrap=document.createElement('div');wrap.className='cairn-help-content';
    const sections=[
      ['1 · Connect Bridge','Start CAIRN.bat → open the dashboard → copy the Bridge token → extension popup → paste token → Save Settings. CAIRN reloads the active AI page once after a successful connection.'],
      ['2 · Save from AI/Web','Highlight text → Save to CAIRN, or use Save Chat to capture Complete Chat, Latest Chat, or Smart Latest Chat from the current provider, another open provider, or all open AI chats. Smart Latest Chat keeps only one newest AI reply. Save to Inbox creates a NEW .md inside CAIRN/Inbox/.'],
      ['3 · Brain · Vault → Chat','Brain → select exact notes or Load a Context Space. Sort notes by name or text size. Insert pastes note contents only when each selected note is within the 30,000-character reliable inline limit; larger notes should be attached as .md. Attach selected .md resets the Brain selection after success.'],
      ['4 · Multi-Provider Sync','Open CAIRN → Multi-Provider. The current AI composer is the source of truth: prompt text plus every accessible attached file sync automatically. No attachment/context toggles are needed. Attachment-only sync, replacement sync, Clear Targets, and Sync & Send All are supported.'],
      ['5 · Context Spaces','Select several notes → Save Space → name it. Later choose that Space → Load. Only those exact notes are selected/read.'],
      ['6 · [Note.md] references','Type [Chapter 2.md] in the AI composer. CAIRN offers an explicit resolver; duplicate filenames require an exact path instead of guessing.'],
      ['7 · Agent','Ask naturally: show history · find my SVM notes · what is in [Chapter 2.md]? · list notes · status · doctor · undo last. Ollama is optional.'],
      ['8 · If something goes wrong','Run Dashboard → Doctor. If Bridge is disconnected, verify CAIRN.bat is running and paste the current token again. If provider tabs are missing from Multi-Provider Prompt, open them and press ↻; CAIRN reloads only the selected target tabs and rediscovers them. If a write reports VERSION_CONFLICT, reopen the target and retry—CAIRN did not overwrite the newer file.'],
      ['9 · Requirements','Windows 10/11, Python 3.11+ with pip/venv, and a Chromium browser (Chrome/Brave/Edge) for the extension. Obsidian is optional for core file operations. Ollama is optional for local AI assistance.']
    ];
    for(const [title,text] of sections){const sec=document.createElement('section');const h=document.createElement('b');h.textContent=title;const p=document.createElement('p');p.textContent=text;sec.append(h,p);wrap.appendChild(sec);}
    body.appendChild(wrap);
    const open=document.createElement('button');open.className='cairn-secondary';open.textContent='Open Full Dashboard Help';open.onclick=()=>window.open('http://127.0.0.1:7821/?help=1','_blank','noopener');body.appendChild(open);
  }

  function showSpaceSaveDialog(paths,body,refreshSpaces){
    panel.querySelector('.cairn-space-save-dialog')?.remove();
    const box=document.createElement('div');box.className='cairn-space-save-dialog';
    const title=document.createElement('strong');title.textContent='Save Context Space';
    const meta=document.createElement('div');meta.className='cairn-meta';meta.textContent=`${paths.length} selected note${paths.length===1?'':'s'} will be stored in this Space.`;
    const input=document.createElement('input');input.placeholder='Name, e.g. Thesis';input.autocomplete='off';
    const actions=document.createElement('div');actions.className='cairn-space-save-actions';
    const cancel=document.createElement('button');cancel.className='cairn-secondary';cancel.textContent='Cancel';cancel.onclick=()=>box.remove();
    const save=document.createElement('button');save.className='cairn-primary';save.textContent='Save';
    const commit=async()=>{let handle=input.value.trim();if(!handle){input.focus();return;}try{save.disabled=true;const m=await message({type:'CAIRN_SAVE_MANIFEST',handle,paths,defaultWriteTarget:null});await refreshSpaces(m.handle);box.remove();status(body,`Saved ${m.handle}. Context Spaces updated instantly.`,'ok');}catch(e){status(body,cleanError(e),'bad');save.disabled=false;}};
    save.onclick=commit;input.onkeydown=e=>{if(e.key==='Enter')commit();if(e.key==='Escape')box.remove();};actions.append(cancel,save);box.append(title,meta,input,actions);panel.appendChild(box);setTimeout(()=>input.focus(),0);
  }

  async function renderAssistant(active='brain'){
    if(active==='brain'&&!brainOn)active='agent';
    const body=shell('CAIRN');panel.classList.add('cairn-assistant-mode');assistantTabs(body,active);
    const content=document.createElement('div');content.className='cairn-assistant-content';body.appendChild(content);
    if(active==='brain')await renderBrainContent(content);
    else if(active==='multi')await renderProviderBroadcastBox(content);
    else if(active==='agent')await renderAgentContent(content);
    else renderHelpContent(content);
  }

  function renderManifestPicker(body,manifests,onLoad,selectedHandle=''){
    const row=document.createElement('div');row.className='cairn-space-row';
    const sel=document.createElement('select');sel.className='cairn-select';
    const first=document.createElement('option');first.value='';first.textContent=manifests.length?'Context Spaces…':'No Context Spaces yet';sel.appendChild(first);
    manifests.forEach(m=>{const o=document.createElement('option');o.value=m.handle;o.textContent=`${m.handle} (${m.paths.length})${m.default_write_target?' → '+m.default_write_target:''}`;sel.appendChild(o);});
    if(selectedHandle && manifests.some(m=>m.handle===selectedHandle)) sel.value=selectedHandle;
    const load=document.createElement('button');load.className='cairn-mini';load.textContent='Load';load.disabled=!manifests.length;load.onclick=()=>{const m=manifests.find(x=>x.handle===sel.value);if(m)onLoad(m);};
    row.append(sel,load);body.appendChild(row);
    return {row,sel,load};
  }

  async function renderProviderBroadcastBox(body){
    const box=document.createElement('section');box.className='cairn-broadcast-box';
    const head=document.createElement('div');head.className='cairn-broadcast-head';
    const title=document.createElement('b');title.textContent='Multi-Provider Sync';
    const note=document.createElement('span');note.textContent='Source composer = truth';
    head.append(title,note);box.appendChild(head);

    const targetRow=document.createElement('div');targetRow.className='cairn-broadcast-target';
    const target=document.createElement('select');target.className='cairn-select';
    const refresh=document.createElement('button');refresh.className='cairn-mini';refresh.textContent='↻';refresh.title='Refresh open AI providers';
    targetRow.append(target,refresh);box.appendChild(targetRow);

    const currentFiles=document.createElement('div');currentFiles.className='cairn-current-attachments';
    const currentTitle=document.createElement('b');currentTitle.textContent='Current attachments';
    const currentList=document.createElement('div');currentList.className='cairn-current-attachment-list';currentList.textContent='Scanning…';currentFiles.append(currentTitle,currentList);box.appendChild(currentFiles);

    const rule=document.createElement('div');rule.className='cairn-multi-rule';rule.textContent='Insert / Sync automatically mirrors the current prompt and every transferable file attached to this composer. No attachment checkbox is needed.';box.appendChild(rule);

    const actions=document.createElement('div');actions.className='cairn-broadcast-actions cairn-broadcast-actions-3';
    const insert=document.createElement('button');insert.className='cairn-primary';insert.textContent='Insert / Sync';insert.title='Replace target drafts and target attachment state with the current source composer. Text is optional when files are attached.';
    const sendAll=document.createElement('button');sendAll.className='cairn-primary cairn-send-all';sendAll.textContent='Sync & Send All';sendAll.title='Prepare all targets, then submit the source and every prepared target.';
    const clear=document.createElement('button');clear.className='cairn-secondary';clear.textContent='Clear Targets';clear.title='Clear CAIRN-synchronized target drafts and remove target attachments.';
    actions.append(insert,sendAll,clear);box.appendChild(actions);
    const tutorial=tabTutorialButton('How to use Multi-Provider',()=>showTabTutorial(body,'Multi-Provider Tutorial',[
      ['1 · Open provider tabs','Keep ChatGPT, Claude, Gemini, or other supported AI chats open in the same browser window. The ↻ button refreshes only the selected target provider pages, never this source tab.'],
      ['2 · Prepare one source','Type your prompt in the current AI composer. Attach any files you want there—.md, images, PDF, DOCX, ZIP, and other normal browser files. CAIRN watches attachment loading in real time and waits briefly for file bytes before syncing.'],
      ['3 · Insert / Sync','Copies the current source state to the selected provider tabs. Repeating sync replaces the previous target draft and attachment state instead of appending another copy.'],
      ['4 · Attachment-only','A text prompt is not required. If the current composer only contains files, Insert / Sync still transfers them.'],
      ['5 · Sync & Send All','First prepares every target. If all are ready, CAIRN sends the current source and targets. CAIRN uses provider-specific send controls to avoid unrelated buttons such as Claude temporary/incognito mode.'],
      ['6 · Clear Targets','Clears target drafts and attempts to remove target composer attachments. Use Remove beside Current attachments to detach one source file. It never deletes the original file from your computer or vault.'],
      ['7 · Large notes','Brain blocks inline insertion for a selected text note over 30,000 characters and recommends attaching the .md instead. Multi-Provider then transfers that attachment automatically.']
    ]));box.appendChild(tutorial);
    const meta=document.createElement('div');meta.className='cairn-broadcast-meta';meta.textContent='Looking for other open AI tabs…';box.appendChild(meta);body.appendChild(box);

    const setBusy=v=>{insert.disabled=v;sendAll.disabled=v;clear.disabled=v;refresh.disabled=v;target.disabled=v;};
    const refreshAttachmentNotice=()=>{
      const snap=currentAttachmentSnapshot();
      currentList.replaceChildren();
      if(!snap.names.length){currentList.textContent='None';currentFiles.classList.add('is-empty');return snap;}
      currentFiles.classList.remove('is-empty');
      const transferable=new Set(snap.transferableNames.map(normalizeAttachmentName));
      for(const name of snap.names){
        const row=document.createElement('div');row.className='cairn-current-attachment-item';
        const label=document.createElement('span');label.textContent=transferable.has(normalizeAttachmentName(name))?`${name} ✓ ready`:`${name} · loading…`;
        const remove=document.createElement('button');remove.className='cairn-attachment-remove';remove.textContent='Remove';remove.title=`Remove ${name} from the current composer`;
        remove.onclick=async()=>{remove.disabled=true;try{const d=await detachOneComposerAttachment(name);if(!d.ok)status(body,`CAIRN could not remove ${name}. The provider may still be loading it.`,'bad');else status(body,`Removed ${name} from the current composer.`,'ok');}catch(e){status(body,cleanError(e),'bad');}finally{setTimeout(refreshAttachmentNotice,100);}};
        row.append(label,remove);currentList.appendChild(row);
      }
      return snap;
    };
    const refreshTargets=async({reloadPages=false}={})=>{
      const keep=target.value||'all';refresh.disabled=true;
      try{
        if(reloadPages){
          status(body,'Refreshing selected provider pages…');
          const reloaded=await message({type:'CAIRN_REFRESH_PROVIDER_TABS',target:keep});
          if(reloaded.reloaded)await new Promise(r=>setTimeout(r,900));
        }
        const r=await message({type:'CAIRN_LIST_PROVIDER_TABS'});const groups=r.groups||[];const total=groups.reduce((n,g)=>n+Number(g.count||0),0);
        target.replaceChildren();const all=document.createElement('option');all.value='all';all.textContent=`All open AI tabs (${total})`;target.appendChild(all);
        const byKey=new Map(groups.map(g=>[g.provider,g]));
        for(const [key,label] of [['chatgpt','ChatGPT'],['claude','Claude'],['gemini','Gemini']]){const g=byKey.get(key);const o=document.createElement('option');o.value=key;o.textContent=`${label} (${g?.count||0})`;target.appendChild(o);byKey.delete(key);}
        for(const g of [...byKey.values()]){const o=document.createElement('option');o.value=g.provider;o.textContent=`${g.label} (${g.count})`;target.appendChild(o);}
        if([...target.options].some(o=>o.value===keep))target.value=keep;
        meta.textContent=total?`Detected ${total} other AI tab${total===1?'':'s'}. Source prompt + current attachments sync automatically.`:'No other supported AI tabs detected yet.';
        insert.disabled=total===0;sendAll.disabled=total===0;clear.disabled=total===0;
      }catch(e){meta.textContent='Provider discovery failed: '+cleanError(e);insert.disabled=true;sendAll.disabled=true;clear.disabled=true;}
      finally{refresh.disabled=false;refreshAttachmentNotice();}
    };
    refresh.onclick=()=>refreshTargets({reloadPages:true});


    const preparePayload=async()=>{
      const draft=readCurrentDraft(),text=canonicalDraft(draft.text||'');
      status(body,'Reading current composer attachments…');
      const transfer=await waitForTransferableSourceFiles({timeoutMs:12000,onProgress:(missing,elapsed,timeoutMs)=>{
        refreshAttachmentNotice();
        const left=Math.max(1,Math.ceil((timeoutMs-elapsed)/1000));
        status(body,`Waiting for ${missing.length} attachment${missing.length===1?'':'s'} to finish loading… ${left}s`);
      }});
      const missing=(transfer.unavailable||[]).filter(Boolean);
      if(missing.length){
        throw new Error(`CAIRN waited for the attachment upload, but ${missing.length} file${missing.length===1?' is':'s are'} still unavailable: ${missing.join(', ')}. Nothing was synchronized or sent. Remove/re-attach the file and try again.`);
      }
      if(transfer.skipped?.length){
        throw new Error(`CAIRN did not sync because ${transfer.skipped.length} attachment${transfer.skipped.length===1?'':'s'} exceed the safe browser-transfer size: ${transfer.skipped.join(', ')}. Nothing was synchronized or sent.`);
      }
      if(!text&&!transfer.files.length)throw new Error('The current composer has no prompt text or transferable attachment to synchronize.');
      return {text,transfer};
    };

    const runBroadcast=async(sendNow)=>{
      setBusy(true);
      try{
        const {text,transfer}=await preparePayload();
        if(sendNow&&text&&!(await replaceChatTextRobust(text)))throw new Error('CAIRN could not verify the current source composer. Nothing was sent.');
        status(body,sendNow?'Preparing every target before sending…':'Synchronizing source prompt and attachments…');
        const prepared=await message({type:'CAIRN_BROADCAST_PROMPT',target:target.value,text,paths:[],attach:false,transferFiles:transfer.files,send:false,sourceProvider:providerInfo().provider,syncAttachments:true});
        if(!prepared.matched)throw new Error('No matching other AI tabs are open. Open the provider tabs and press ↻.');
        const providerPrep=(prepared.results||[]).map(x=>`${x.label||x.provider}: ${x.result?.ok?'ready ✓':'ready ✗'}`).join(' · ');
        if(prepared.synced!==prepared.matched){const fail=prepared.attachmentFailures+prepared.transferFailures;return status(body,`Prepared ${prepared.synced}/${prepared.matched} targets${fail?` · ${fail} attachment failure${fail===1?'':'s'}`:''}. Nothing was sent. ${providerPrep}`,'bad');}
        if(!sendNow){const count=prepared.transferredFiles;const skip=transfer.skipped.length?` Skipped oversized files: ${transfer.skipped.join(', ')}.`:'';refreshAttachmentNotice();return status(body,`Synced ${prepared.synced}/${prepared.matched} targets · ${count} transferred file${count===1?'':'s'} · removed old target attachments ${prepared.detachedFiles||0}. ${providerPrep}.${skip}`,'ok');}

        status(body,'All targets are ready. Sending source and target AI chats…');
        const [sentTargets,sourceSent]=await Promise.all([message({type:'CAIRN_BROADCAST_SEND',target:target.value}),sendCurrentComposerRobust()]);
        if(sourceSent)beginReplyWatch();
        const totalSent=(sentTargets.sent||0)+(sourceSent?1:0),expected=prepared.matched+1;
        const report=(sentTargets.results||[]).map(x=>`${x.label||x.provider}: ${x.result?.sent?'sent ✓':'sent ✗'}`).join(' · ');
        status(body,`Sent ${totalSent}/${expected} AI chats. ${report}${sourceSent?' · Current: sent ✓':' · Current: sent ✗'}`,totalSent===expected?'ok':'bad');
      }catch(e){status(body,cleanError(e),'bad');}
      finally{setBusy(false);refreshAttachmentNotice();}
    };
    insert.onclick=()=>runBroadcast(false);sendAll.onclick=()=>runBroadcast(true);
    clear.onclick=async()=>{setBusy(true);try{status(body,'Clearing target prompts and attachments…');const r=await message({type:'CAIRN_BROADCAST_CLEAR',target:target.value});if(!r.matched)return status(body,'No matching other AI tabs are open.','bad');status(body,`Cleared ${r.cleared}/${r.matched} target AI tab${r.matched===1?'':'s'} · removed ${r.detached} attachment${r.detached===1?'':'s'}.`,r.failed?'bad':'ok');}catch(e){status(body,cleanError(e),'bad');}finally{setBusy(false);}};
    refreshAttachmentNotice();const timer=setInterval(()=>{if(!box.isConnected){clearInterval(timer);return;}refreshAttachmentNotice();},750);
    await refreshTargets();return box;
  }

  async function renderBrainContent(body){
    panel.classList.add('cairn-brain-mode');
    const info=document.createElement('div');info.className='cairn-brain-info';info.textContent='Choose exact notes, load a Context Space, or use [Note.md]. Notes over 30,000 characters are better attached than pasted inline.';
    const top=document.createElement('div');top.className='cairn-brain-toolbar';
    const search=document.createElement('input');search.placeholder='Search indexed notes…';
    const sort=document.createElement('select');sort.className='cairn-select cairn-note-sort';
    for(const [value,label] of [['name-asc','Name A → Z'],['name-desc','Name Z → A'],['text-desc','Most text → least'],['text-asc','Least text → most']]){const o=document.createElement('option');o.value=value;o.textContent=label;sort.appendChild(o);}
    const refresh=document.createElement('button');refresh.className='cairn-mini';refresh.textContent='↻';refresh.title='Refresh vault index';top.append(search,sort,refresh);
    const selected=document.createElement('div');selected.className='cairn-meta cairn-selection-count';selected.textContent='0 notes selected';
    const list=document.createElement('div');list.className='cairn-list cairn-brain-list';
    body.append(info);
    const spacesHost=document.createElement('div');spacesHost.className='cairn-spaces-host';body.appendChild(spacesHost);
    let notes=[];
    const noteChars=n=>Number(n.chars||n.char_count||n.size_bytes||0);
    const noteWords=n=>Number(n.words||n.word_count||0);
    const updateSelected=()=>{const n=brainSelected.size;selected.textContent=`${n} note${n===1?'':'s'} selected`;};
    const formatCount=n=>Number(n||0).toLocaleString();
    const loadManifest=m=>{brainSelected=new Map();for(const p of m.paths){const n=noteCache.find(x=>x.path===p)||{path:p,title:p};brainSelected.set(p,n);}search.value='';drawNotes();updateSelected();status(body,`Loaded ${m.handle}.`,'ok');};
    const refreshSpaces=async(selectedHandle='')=>{try{const manifests=await fetchManifests();spacesHost.replaceChildren();renderManifestPicker(spacesHost,manifests,loadManifest,selectedHandle);return manifests;}catch(e){spacesHost.replaceChildren();const x=document.createElement('div');x.className='cairn-meta';x.textContent='Context Spaces unavailable.';spacesHost.appendChild(x);return [];}};
    await refreshSpaces();
    body.append(top,selected,list);status(body,'Loading live vault index…');
    const drawNotes=()=>{
      list.replaceChildren();const q=search.value.trim().toLowerCase();let filtered=notes.filter(n=>!q||`${n.title||''} ${n.path}`.toLowerCase().includes(q));
      const mode=sort.value;
      filtered.sort((a,b)=>{
        if(mode==='text-desc')return noteChars(b)-noteChars(a)||String(a.path).localeCompare(String(b.path));
        if(mode==='text-asc')return noteChars(a)-noteChars(b)||String(a.path).localeCompare(String(b.path));
        if(mode==='name-desc')return String(b.title||b.path).localeCompare(String(a.title||a.path));
        return String(a.title||a.path).localeCompare(String(b.title||b.path));
      });
      filtered=filtered.slice(0,160);
      if(!filtered.length){const e=document.createElement('div');e.className='cairn-empty';e.textContent='No matching Markdown notes.';list.appendChild(e);return;}
      for(const note of filtered){
        const row=document.createElement('div');row.className='cairn-brain-note cairn-brain-note-row';
        const pick=document.createElement('label');pick.className='cairn-brain-pick';const check=document.createElement('input');check.type='checkbox';check.className='cairn-brain-check';check.checked=brainSelected.has(note.path);const mark=document.createElement('span');mark.className='cairn-check-mark';mark.textContent='✓';const text=document.createElement('span');text.className='cairn-brain-note-text';const title=document.createElement('b');title.textContent=note.title||note.path;const path=document.createElement('small');path.textContent=note.path;text.append(title,path);pick.append(check,mark,text);
        const syncRow=()=>row.classList.toggle('is-selected',check.checked);syncRow();
        check.onchange=()=>{if(check.checked)brainSelected.set(note.path,note);else brainSelected.delete(note.path);syncRow();updateSelected();};
        const acts=document.createElement('div');acts.className='cairn-note-side';
        const metric=document.createElement('div');metric.className='cairn-note-size'+(noteChars(note)>INLINE_TEXT_ATTACHMENT_LIMIT?' is-large':'');metric.textContent=`${formatCount(noteChars(note))} chars · ${formatCount(noteWords(note))} words`;metric.title=noteChars(note)>INLINE_TEXT_ATTACHMENT_LIMIT?'Over the 30,000-character inline limit — attach this note instead of inserting it.':'Indexed note size';
        const buttons=document.createElement('div');buttons.className='cairn-note-mini-actions';
        const open=document.createElement('button');open.className='cairn-note-mini';open.textContent='Open .md';open.onclick=e=>{e.preventDefault();e.stopPropagation();renderNoteViewer(note,()=>renderAssistant('brain'));};
        const attach=document.createElement('button');attach.className='cairn-note-mini';attach.textContent='Attach';attach.onclick=async e=>{e.preventDefault();e.stopPropagation();const a=await attachMarkdown(note);if(a.ok){brainSelected.delete(note.path);check.checked=false;syncRow();updateSelected();status(body,`Attached ${note.path.split('/').pop()} to the chat. Selection reset so it will not be reused accidentally.`,'ok');}else status(body,'No compatible file input detected. Open .md to download or insert it instead.','bad');};
        buttons.append(open,attach);acts.append(metric,buttons);row.append(pick,acts);list.appendChild(row);
      }
    };
    const load=async(force=false)=>{try{notes=await fetchNotes(force);body.querySelector('.cairn-status')?.remove();drawNotes();updateSelected();}catch(e){list.replaceChildren();status(body,cleanError(e),'bad');}};
    search.oninput=drawNotes;sort.onchange=drawNotes;refresh.onclick=async()=>{refresh.disabled=true;try{await load(true);await refreshSpaces();status(body,'Notes and Context Spaces refreshed.','ok');}finally{refresh.disabled=false;}};await load(false);

    const help=tabTutorialButton('How to use Brain',()=>showTabTutorial(body,'Brain Tutorial',[
      ['Select notes','Tick only the notes you want CAIRN to read. The upper-right metric shows exact indexed characters and words.'],
      ['Sort by size','Use Most text → least or Least text → most to find heavy notes before inserting them.'],
      ['Insert','Pastes selected note contents into the current AI composer. Notes over 30,000 characters are blocked from inline insertion to avoid slow/broken composers.'],
      ['Attach','Attach the actual .md instead. After a successful attach, CAIRN removes that note from the current selection so it is not accidentally reused.'],
      ['Context Spaces','Load a saved group of notes when you want to work with the same knowledge set again.']
    ]));body.appendChild(help);

    const saveSpace=document.createElement('button');saveSpace.className='cairn-secondary';saveSpace.textContent='Save Space';saveSpace.onclick=()=>{const paths=[...brainSelected.keys()];if(!paths.length)return status(body,'Select at least one note.','bad');showSpaceSaveDialog(paths,body,refreshSpaces);};
    const insert=document.createElement('button');insert.className='cairn-primary cairn-sticky-primary';insert.textContent='Insert';insert.title='Insert selected note contents into the current chat box';insert.onclick=async()=>{const paths=[...brainSelected.keys()];if(!paths.length)return status(body,'Select at least one note.','bad');insert.disabled=true;try{status(body,`Checking ${paths.length} selected note${paths.length===1?'':'s'}…`);const bundle=await message({type:'CAIRN_BUILD_CONTEXT',paths,source:sourceId()});const warning=inlineAttachmentWarning(bundle);if(warning){status(body,warning,'bad');insert.disabled=false;return;}if(await insertIntoChatRobust(bundle.text)){status(body,`Inserted ${bundle.paths.length} full note${bundle.paths.length===1?'':'s'} into the chat box. Review, then send normally.`,'ok');setTimeout(removePanel,1400);}else if(await copyFallback(bundle.text)){status(body,'No compatible chat box found. Context copied to clipboard.','bad');insert.disabled=false;}else{status(body,'No compatible chat box found.','bad');insert.disabled=false;}}catch(e){status(body,cleanError(e),'bad');insert.disabled=false;}};
    const attachSelected=document.createElement('button');attachSelected.className='cairn-secondary';attachSelected.textContent='Attach selected .md';attachSelected.title='Attach the actual selected Markdown files to this chat';attachSelected.onclick=async()=>{const paths=[...brainSelected.keys()];if(!paths.length)return status(body,'Select at least one note.','bad');attachSelected.disabled=true;try{status(body,`Attaching ${paths.length} selected .md file${paths.length===1?'':'s'}…`);const r=await attachMarkdownPaths(paths);if(r.ok){brainSelected.clear();drawNotes();updateSelected();status(body,`Attached ${r.count} selected .md file${r.count===1?'':'s'}. Brain selection reset to 0.`,'ok');}else{status(body,location.hostname.includes('claude.ai')?'Claude did not expose a compatible upload input yet. Open Claude’s attachment control once, then retry.':'This site did not expose a compatible file input.','bad');}}catch(e){status(body,cleanError(e),'bad');}finally{attachSelected.disabled=false;}};
    const detachSelected=document.createElement('button');detachSelected.className='cairn-secondary';detachSelected.textContent='Detach all files';detachSelected.title='Remove all attachments currently visible in this chat composer';detachSelected.onclick=async()=>{detachSelected.disabled=true;try{const r=await detachAllComposerAttachments();if(r.ok)status(body,`Detached all ${r.count} composer attachment${r.count===1?'':'s'} from this chat.`,'ok');else status(body,'CAIRN could not remove every visible attachment. The provider may be hiding its attachment controls.','bad');}catch(e){status(body,cleanError(e),'bad');}finally{detachSelected.disabled=false;}};
    footer(body,saveSpace,insert,attachSelected,detachSelected);
  }

  function extractRefs(text){return [...new Set([...text.matchAll(/\[([^\]\n]+\.md)\]/gi)].map(m=>m[1].trim()))];}
  async function resolveCurrentRefs(){const el=findChatInput();if(!el)return;const original=stripInjectedCairnContext(inputText(el));const refs=extractRefs(original);if(!refs.length)return;try{const r=await message({type:'CAIRN_RESOLVE_REFS',refs,source:sourceId()});if(r.ambiguous?.length||r.missing?.length){const body=shell('Resolve [Note.md] References');if(r.missing?.length){const x=document.createElement('div');x.className='cairn-status bad';x.textContent='Missing: '+r.missing.join(', ');body.appendChild(x);}for(const a of r.ambiguous||[]){const x=document.createElement('div');x.className='cairn-status bad';x.textContent=`Ambiguous ${a.ref}: ${a.matches.join(' · ')}`;body.appendChild(x);}const hint=document.createElement('div');hint.className='cairn-meta';hint.textContent='Use an exact vault-relative path inside [brackets] to disambiguate.';body.appendChild(hint);return;}if(!r.bundle)return;const warning=inlineAttachmentWarning(r.bundle);if(warning)throw new Error(warning);const combined=`${r.bundle.text}\n\n<<< USER PROMPT >>>\n${original}`;setChatText(el,combined);refChip.style.display='none';}catch(e){const body=shell('CAIRN Brain');status(body,cleanError(e),'bad');}}


  async function renderAgentContent(body){
    panel.classList.remove('cairn-brain-mode');const info=document.createElement('div');info.className='cairn-brain-info';info.textContent='Vault-aware CAIRN assistant. Speak naturally: “show history”, “find my SVM notes”, “what is in [Chapter 2.md]?”, “status”, or “undo last”. It searches the SQLite index and can use a running local Ollama model when available. Webpage text never receives filesystem authority.';
    const log=document.createElement('div');log.className='cairn-agent-log';
    const row=document.createElement('div');row.className='cairn-agent-row';const input=document.createElement('input');input.placeholder='Ask about your vault or CAIRN…';const send=document.createElement('button');send.className='cairn-mini';send.textContent='Send';row.append(input,send);body.append(info,log);
    const help=tabTutorialButton('How to use Agent',()=>showTabTutorial(body,'Agent Tutorial',[['Ask naturally','Ask CAIRN to find notes, show history, inspect [Note.md], report status, or undo the last supported write.'],['Vault-aware','Agent answers can use your indexed Markdown notes and local CAIRN state.'],['Local AI','If Ollama is available CAIRN can use it; otherwise deterministic/search tools still work.'],['Safety','Agent operations remain constrained by CAIRN capabilities, hash checks, and the operation ledger.']]));body.appendChild(help);footer(body,row);
    const add=(who,text)=>{const x=document.createElement('div');x.className='cairn-agent-msg '+who;x.textContent=text;log.appendChild(x);log.scrollTop=log.scrollHeight;};
    const fmt=x=>{if(x.snippet)return `${x.path||x.title||'Result'} — ${String(x.snippet).replace(/\s+/g,' ').trim()}`;if(x.action)return `${x.action} · ${x.target_note||'vault'}${x.requested_at?' · '+new Date(x.requested_at*1000).toLocaleString():''}`;if(x.name)return `${x.ok?'✓':'✗'} ${x.name}`;return x.path||x.target_note||x.handle||String(x);};
    const ask=async()=>{const text=input.value.trim();if(!text)return;add('user',text);input.value='';try{const r=await message({type:'CAIRN_AGENT_ASK',text,source:sourceId()});add('agent',(r.text||'Done.')+(r.model?`\n\nLocal AI: ${r.model}`:''));if(r.results?.length){r.results.slice(0,8).forEach(x=>add('result',fmt(x)));}}catch(e){add('bad',cleanError(e));}};send.onclick=ask;input.onkeydown=e=>{if(e.key==='Enter')ask();};add('agent','Talk naturally. Try: show history · find notes about SVM · what is in [Chapter 2.md]? · list notes · status · doctor · undo last');
  }

  async function renderBrainPicker(){ return renderAssistant('brain'); }
  async function renderAgent(){ return renderAssistant('agent'); }

  function cleanError(error){const raw=String(error?.message||error||'Unknown error');if(raw.includes('VERSION_CONFLICT'))return 'Version conflict: the note changed after CAIRN loaded it. Re-open the picker and try again.';if(raw.includes('NOTE_EXISTS'))return 'That note already exists. Choose another path or append instead.';if(raw.includes('NO_VAULT'))return 'No vault is connected. Open the CAIRN dashboard and connect a vault first.';if(raw.includes('INVALID_TOKEN'))return 'Bridge token rejected. Copy the current token from the CAIRN dashboard into the extension popup.';if(raw.includes('CAPABILITY_DENIED'))return 'The browser does not have permission for that path.';if(raw.includes('CONTEXT_TOO_LARGE'))return 'Selected context is too large. Select fewer notes.';return raw.replace(/^Error:\s*/,'');}

  function currentSelection(){return String(window.getSelection()).trim();}
  document.addEventListener('selectionchange',()=>{if(panel||!bridgeConnected){floating.style.display='none';return;}const text=currentSelection();floating.style.display=text?'block':'none';});
  floating.addEventListener('mousedown',e=>{const text=currentSelection();if(text){capturedText=text;captureLabel='Selection';captureTitle=document.title;captureInboxTitle='';}e.preventDefault();});
  floating.addEventListener('click',()=>{const text=capturedText||currentSelection();if(!text)return;capturedText=text;captureLabel='Selection';captureTitle=document.title;captureInboxTitle='';floating.style.display='none';renderHome();});
  assistantButton.addEventListener('click',()=>{if(!bridgeConnected)return;floating.style.display='none';renderAssistant(brainOn?'brain':'agent');});
  chatButton.addEventListener('click',()=>{if(bridgeConnected)renderChatCapture();});
  refChip.addEventListener('click',resolveCurrentRefs);

  chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if(msg?.type==='CAIRN_PROVIDER_PING'){
      const p=providerInfo();
      sendResponse({...p,connected:bridgeConnected,hasComposer:!!findChatInput()});
      return;
    }
    if(msg?.type==='CAIRN_UI_REMOTE_COMPOSE'){
      (async()=>{
        // Draft and attachment state are synchronized independently. This allows
        // attachment-only broadcasts and prevents stale CAIRN files from sticking.
        const hasText=typeof msg.text==='string'&&msg.text.length>0;
        const inserted=hasText?!!(await replaceChatTextRobust(msg.text)):true;
        const attachRequested=!!msg.attach,transferRequested=!!(msg.transferFiles||[]).length,sendRequested=!!msg.send;
        const synced=await syncManagedAttachments({markdownPaths:attachRequested?(msg.paths||[]):[],transferFiles:msg.transferFiles||[]});
        const attachedOk=!attachRequested||!!synced.md.ok,attachedCount=Number(synced.md.count)||0,attachReason=synced.md.reason||'';
        const transferredOk=!transferRequested||!!synced.transferred.ok,transferredCount=Number(synced.transferred.count)||0,transferReason=synced.transferred.reason||'';
        const detachedCount=Number(synced.detached?.count)||0;
        const attachmentStateOk=!!synced.ok;
        const readyToSend=inserted&&attachedOk&&transferredOk&&attachmentStateOk;
        const sent=sendRequested&&readyToSend?await sendCurrentComposerRobust():false;if(sent)beginReplyWatch();
        sendResponse({ok:readyToSend,inserted,hasText,attachRequested,attachedOk,attachedCount,attachReason,transferRequested,transferredOk,transferredCount,transferReason,detachedCount,attachmentStateOk,remainingAttachments:synced.remaining||[],sendRequested,sent,provider:providerInfo().provider});
      })().catch(error=>sendResponse({ok:false,inserted:false,sent:false,error:String(error?.message||error),provider:providerInfo().provider}));
      return true;
    }
    if(msg?.type==='CAIRN_UI_REMOTE_DETACH'){
      (async()=>{const d=await detachAllComposerAttachments();sendResponse({ok:true,detachedOk:!!d.ok,detachedCount:Number(d.count)||0,reason:d.reason||'',provider:providerInfo().provider});})()
        .catch(error=>sendResponse({ok:false,detachedOk:false,detachedCount:0,error:String(error?.message||error),provider:providerInfo().provider}));
      return true;
    }
    if(msg?.type==='CAIRN_UI_REMOTE_CLEAR'){
      (async()=>{const d=await detachAllComposerAttachments();const cleared=await clearChatTextRobust();const ok=!!cleared&&!!d.ok;sendResponse({ok,cleared:!!cleared,detachedOk:!!d.ok,detachedCount:Number(d.count)||0,remaining:d.remaining||[],provider:providerInfo().provider});})().catch(error=>sendResponse({ok:false,cleared:false,detachedCount:0,error:String(error?.message||error),provider:providerInfo().provider}));return true;
    }
    if(msg?.type==='CAIRN_UI_REMOTE_SEND'){
      (async()=>{const sent=await sendCurrentComposerRobust();if(sent)beginReplyWatch();sendResponse({ok:!!sent,sent:!!sent,provider:providerInfo().provider});})().catch(error=>sendResponse({ok:false,sent:false,error:String(error?.message||error),provider:providerInfo().provider}));return true;
    }
    if(msg?.type==='CAIRN_UI_CAPTURE_CONVERSATION'){
      const c=msg.mode==='smart'?captureSmartLatestReply():(msg.mode==='latest'?captureLatestReply():captureCompleteChat());sendResponse({ok:!!c,capture:c?{...c,provider:providerInfo().label,url:location.href}:null});return;
    }
    if(msg?.type==='CAIRN_UI_PROVIDER_REPLY_DONE'){showReplyToast(msg.label||msg.provider||'AI',msg.eventId||'');sendResponse?.({ok:true});return;}
    if(!bridgeConnected)return;
    if(msg?.type==='CAIRN_UI_OPEN_BRAIN')renderAssistant('brain');
    if(msg?.type==='CAIRN_UI_OPEN_AGENT')renderAssistant('agent');
    if(msg?.type==='CAIRN_UI_CAPTURE_SELECTION'){const text=currentSelection();if(text){capturedText=text;captureLabel='Selection';captureTitle=document.title;captureInboxTitle='';renderHome();}}
    if(msg?.type==='CAIRN_UI_CAPTURE_CHAT')renderChatCapture();
  });

  // Lightweight explicit-reference detector. It never reads a note automatically;
  // it only offers a resolver button when Brain is ON and [Note.md] appears in the chat input.
  setInterval(()=>{
    if(!bridgeConnected||!brainOn||panel){refChip.style.display='none';return;}
    const el=findChatInput();const refs=el?extractRefs(inputText(el)):[];
    if(refs.length){refChip.textContent=`Brain: resolve ${refs.length} [Note.md] ref${refs.length===1?'':'s'}`;refChip.style.display='block';}
    else refChip.style.display='none';
  },700);

  // Initial probe plus a lightweight heartbeat. If CAIRN.bat stops or the token
  // becomes invalid, controls disappear automatically; if service returns with the
  // same valid token, they reappear without a full page reload.
  refreshConnectionState();
  setInterval(refreshConnectionState, 3000);

  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&panel)removePanel();});
})();
