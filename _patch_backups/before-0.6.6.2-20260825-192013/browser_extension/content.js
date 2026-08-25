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
  let bridgeConnected = false;
  let connectionCheckInFlight = false;
  const cairnManagedAttachments = new Set();

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

  const assistantButton = document.createElement('button');
  assistantButton.id = 'cairn-assistant-button';
  assistantButton.textContent = 'CAIRN';
  assistantButton.title = 'Open CAIRN Brain, Multi-Provider, Agent, and Help';
  uiRoot.appendChild(assistantButton);

  const chatButton = document.createElement('button');
  chatButton.id = 'cairn-chat-button';
  chatButton.textContent = 'Save Chat';
  chatButton.title = 'Capture the complete AI conversation without highlighting it';
  uiRoot.appendChild(chatButton);

  const refChip = document.createElement('button');
  refChip.id = 'cairn-ref-chip';
  refChip.style.display = 'none';
  uiRoot.appendChild(refChip);

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
  function removePanel(){ panel?.remove(); panel=null; }

  function shell(title,{back=false,backFn=renderHome}={}) {
    removePanel(); panel=document.createElement('section'); panel.id='cairn-capture-panel';
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

  async function fetchNotes(force=false){ if(force){try{await message({type:'CAIRN_REFRESH_VAULT'});}catch(_){}} noteCache=await message({type:'CAIRN_LIST_NOTES'});return noteCache; }
  async function fetchManifests(){ manifestsCache=await message({type:'CAIRN_LIST_MANIFESTS'});return manifestsCache; }

  async function renderHome(){
    const body=shell('CAIRN Capture');addPreview(body);
    const actions=document.createElement('div');actions.className='cairn-actions';
    actions.append(
      actionButton('⚡ Save to Inbox','Create a new Markdown note inside CAIRN/Inbox/',async()=>{try{status(body,'Saving…');const r=await message({type:'CAIRN_SAVE_INBOX',content:capturedText,title:document.title,source:sourceId()});status(body,`Saved to ${r.path}`,'ok');setTimeout(removePanel,900);}catch(e){status(body,cleanError(e),'bad');}}),
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
  function renderChatCapture(){
    const body=shell('Capture Conversation');
    const info=document.createElement('div');info.className='cairn-brain-info';info.textContent='No highlighting required. CAIRN extracts the visible conversation from this page, then sends it through the same safe Save/Create/Append/Heading workflow.';body.appendChild(info);
    body.append(
      actionButton('💬 Save Complete Chat','Capture all detected user/assistant messages on this conversation',()=>{const c=captureCompleteChat();if(!c)return status(body,'No compatible conversation messages were detected on this page.','bad');capturedText=c.text;captureTitle=c.title;captureLabel=c.label;renderHome();}),
      actionButton('◈ Save Latest AI Reply','Capture only the most recent assistant/model response',()=>{const c=captureLatestReply();if(!c)return status(body,'No compatible AI reply was detected on this page.','bad');capturedText=c.text;captureTitle=c.title;captureLabel=c.label;renderHome();})
    );
  }
  function findFileInput(){
    const inputs=[...document.querySelectorAll('input[type="file"]')].filter(x=>!x.disabled);
    return inputs.find(x=>{const a=(x.accept||'').toLowerCase();return !a||a.includes('.md')||a.includes('text')||a.includes('*')||a.includes('document');})||inputs[0]||null;
  }
  async function ensureFileInput(){
    let input=findFileInput(); if(input)return input;
    const host=location.hostname.toLowerCase();
    // Best-effort provider assist. Some Claude builds only create the file input
    // after the attachment/add-content control is opened.
    if(host.includes('claude.ai')){
      const buttons=[...document.querySelectorAll('button')];
      const trigger=buttons.find(b=>/attach|upload|add content|add file|add files|paperclip/i.test(`${b.getAttribute('aria-label')||''} ${b.getAttribute('title')||''} ${b.innerText||''}`));
      if(trigger){try{trigger.click();await new Promise(r=>setTimeout(r,250));}catch(_){}}
      input=findFileInput();
    }
    return input;
  }
  async function attachMarkdownPaths(paths){
    if(!paths?.length)return {ok:false,reason:'NO_SELECTION'};
    const files=[];
    for(const path of paths){
      const r=await message({type:'CAIRN_READ_NOTE',path});
      files.push(new File([r.content],path.split('/').pop()||'note.md',{type:'text/markdown'}));
    }
    const input=await ensureFileInput();
    if(!input)return {ok:false,reason:'NO_FILE_INPUT'};
    try{
      const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));input.files=dt.files;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
      files.forEach(f=>cairnManagedAttachments.add(f.name));
      return {ok:true,count:files.length,names:files.map(f=>f.name)};
    }catch(e){return {ok:false,reason:String(e)};}
  }
  function attachmentNames(paths=[]){
    const named=(paths||[]).map(p=>String(p).split('/').pop()).filter(Boolean);
    return new Set(named.length?named:[...cairnManagedAttachments]);
  }
  function attachmentScope(){
    const composer=findChatInput();
    return composer?.closest('form')||composer?.parentElement?.parentElement||document.body||document.documentElement;
  }
  function removeAttachmentChipByName(scope,name){
    const buttonMatches=b=>/remove|delete|close|detach|discard/i.test(`${b.getAttribute?.('aria-label')||''} ${b.getAttribute?.('title')||''} ${b.textContent||''}`);
    const containers=[...scope.querySelectorAll('[data-testid*="attachment" i],[data-testid*="upload" i],[class*="attachment" i],[class*="file-chip" i],[class*="file-pill" i],[class*="upload" i]')]
      .filter(el=>String(el.textContent||'').includes(name));
    for(const box of containers){
      const btn=[...box.querySelectorAll('button,[role="button"]')].find(buttonMatches);
      if(btn){try{btn.click();return true;}catch(_){} }
    }
    const textNodes=[...scope.querySelectorAll('span,div,p')].filter(el=>{
      const t=String(el.textContent||'').trim();return t.length<220&&(t===name||t.includes(name));
    }).slice(0,40);
    for(const el of textNodes){
      let cur=el;
      for(let depth=0;cur&&depth<5;depth++,cur=cur.parentElement){
        const btn=[...cur.querySelectorAll?.('button,[role="button"]')||[]].find(buttonMatches);
        if(btn){try{btn.click();return true;}catch(_){} }
      }
    }
    return false;
  }
  async function detachMarkdownPaths(paths=[]){
    const names=attachmentNames(paths);
    if(!names.size)return {ok:false,reason:'NO_MANAGED_ATTACHMENTS',count:0};
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
      if(removeAttachmentChipByName(scope,name))removed.add(name);
    }
    for(const name of removed)cairnManagedAttachments.delete(name);
    return {ok:removed.size>0,count:removed.size,names:[...removed],reason:removed.size?'':'ATTACHMENT_UI_NOT_FOUND'};
  }
  async function attachMarkdown(note){ return attachMarkdownPaths([note.path]); }
  async function detachMarkdown(note){ return detachMarkdownPaths([note.path]); }
  async function downloadMarkdown(note){
    const r=await message({type:'CAIRN_READ_NOTE',path:note.path});const blob=new Blob([r.content],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=note.path.split('/').pop()||'note.md';a.style.display='none';ensureUiRoot();uiRoot.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},1000);
  }
  async function renderNoteViewer(note,backFn=()=>renderAssistant('brain')){
    const body=shell('Open .md',{back:true,backFn});status(body,'Reading note…');
    try{const r=await message({type:'CAIRN_READ_NOTE',path:note.path});body.querySelector('.cairn-status')?.remove();const meta=document.createElement('div');meta.className='cairn-meta';meta.textContent=`${note.path} · ${r.chars.toLocaleString()} characters`;const pre=document.createElement('pre');pre.className='cairn-md-view';pre.textContent=r.content;body.append(meta,pre);
      const insert=document.createElement('button');insert.className='cairn-primary';insert.textContent='Insert into Chat';insert.onclick=()=>{if(insertIntoChat(r.content)){status(body,'Inserted Markdown into the chat box.','ok');}else status(body,'No compatible chat box found.','bad');};
      const attach=document.createElement('button');attach.className='cairn-secondary';attach.textContent='Attach .md';attach.onclick=async()=>{const a=await attachMarkdown(note);if(a.ok)status(body,'Attached .md to the current chat input. Review before sending.','ok');else status(body,'This site did not expose a compatible file input. Use Download .md or Insert into Chat instead.','bad');};
      const detach=document.createElement('button');detach.className='cairn-secondary';detach.textContent='Detach all .md';detach.onclick=async()=>{const d=await detachMarkdownPaths([]);if(d.ok)status(body,`Detached all ${d.count} CAIRN-managed attachment${d.count===1?'':'s'} from this chat.`,'ok');else status(body,'CAIRN could not find that attachment in the current composer. It may already have been removed or the site hides its attachment controls.','bad');};
      const dl=document.createElement('button');dl.className='cairn-secondary';dl.textContent='Download .md';dl.onclick=()=>downloadMarkdown(note);
      footer(body,insert,attach,detach,dl);
    }catch(e){status(body,cleanError(e),'bad');}
  }
  function isVisible(el){if(!el)return false;const style=getComputedStyle(el);const r=el.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&r.width>20&&r.height>8;}
  function composerHint(el){return `${el?.getAttribute?.('placeholder')||''} ${el?.getAttribute?.('aria-label')||''} ${el?.getAttribute?.('data-placeholder')||''} ${el?.getAttribute?.('data-testid')||''} ${el?.id||''} ${el?.className||''}`.toLowerCase();}
  function isLikelyComposer(el){if(!isTextInput(el)||!isVisible(el))return false;const hint=composerHint(el);if(/search/.test(hint)&&!/message|prompt|reply|chat|composer/.test(hint))return false;const form=el.closest?.('form');const rect=el.getBoundingClientRect();const nearBottom=rect.bottom>Math.max(120,window.innerHeight*0.42);return !!form||nearBottom||/message|prompt|reply|chat|composer|prosemirror|lexical/.test(hint);}
  function isTextInput(el){if(!el||el.closest?.('#cairn-capture-panel'))return false;if(el instanceof HTMLTextAreaElement)return !el.disabled&&!el.readOnly;if(el instanceof HTMLInputElement)return ['text','search'].includes(el.type)&&!el.disabled&&!el.readOnly;return el.isContentEditable||el.getAttribute?.('contenteditable')==='true'||el.getAttribute?.('role')==='textbox';}
  function composerSelectors(){
    const host=location.hostname.toLowerCase();
    if(host.includes('claude.ai')) return [
      '[data-testid="chat-input"] [contenteditable="true"]',
      '[data-testid*="chat-input"] [contenteditable="true"]',
      '[data-testid*="composer"] [contenteditable="true"]',
      'form .ProseMirror[contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      '[data-lexical-editor="true"][contenteditable="true"]',
      '[contenteditable="true"][aria-label*="message" i]',
      '[contenteditable="true"][aria-label*="reply" i]',
      '[contenteditable="true"][role="textbox"]',
      'textarea'
    ];
    if(host.includes('gemini.google.com')) return [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '[data-lexical-editor="true"][contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea'
    ];
    if(host.includes('chatgpt.com')||host.includes('openai.com')) return [
      '#prompt-textarea',
      'div#prompt-textarea[contenteditable="true"]',
      '[data-testid="prompt-textarea"]',
      'form [contenteditable="true"][role="textbox"]',
      'form .ProseMirror[contenteditable="true"]',
      'form textarea'
    ];
    return [];
  }
  function chatInputCandidates(){
    const selectors=[...composerSelectors(),'div[contenteditable="true"][role="textbox"]','textarea[placeholder*="Message" i]','textarea[placeholder*="Ask" i]','textarea','[contenteditable="true"]'];
    const found=[];
    const active=document.activeElement;
    if(isLikelyComposer(active))found.push(active);
    for(const selector of selectors){
      for(const el of document.querySelectorAll(selector)){
        if(!isLikelyComposer(el)||found.includes(el))continue;
        found.push(el);
      }
    }
    found.sort((a,b)=>{
      const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();
      const ah=composerHint(a),bh=composerHint(b);
      const aScore=(a===active?50000:0)+(a.id==='prompt-textarea'?30000:0)+(a.classList?.contains('ProseMirror')?22000:0)+(a.getAttribute?.('data-lexical-editor')==='true'?18000:0)+(/message|prompt|reply|chat|composer/.test(ah)?12000:0)+(a.closest?.('form')?7000:0)+ar.bottom;
      const bScore=(b===active?50000:0)+(b.id==='prompt-textarea'?30000:0)+(b.classList?.contains('ProseMirror')?22000:0)+(b.getAttribute?.('data-lexical-editor')==='true'?18000:0)+(/message|prompt|reply|chat|composer/.test(bh)?12000:0)+(b.closest?.('form')?7000:0)+br.bottom;
      return bScore-aScore;
    });
    return found;
  }
  function findChatInput(){return chatInputCandidates()[0]||null;}
  function nativeSetter(el,value){const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,value);else el.value=value;}
  function inputText(el){
    if(!el)return '';
    if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement)return el.value||'';
    const text=el.innerText||el.textContent||'';
    return String(text).replace(/\u200B/g,'');
  }
  function readCurrentDraft(){
    const candidates=chatInputCandidates();
    for(const el of candidates){const text=inputText(el).trim();if(text)return {el,text};}
    const el=candidates[0]||null;return {el,text:el?inputText(el).trim():''};
  }
  function setContentEditableText(el,text){
    if(!el)return false;
    el.focus();
    // First choice: browser editing command. This is the least invasive path for
    // ProseMirror/Lexical-based AI composers because it emits a real input event.
    try{
      const sel=window.getSelection(),range=document.createRange();
      range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
      if(document.execCommand('insertText',false,text)){
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
        if(inputText(el).trim()===text.trim())return true;
      }
    }catch(_){ }
    // Fallback for background tabs / provider editors that reject execCommand.
    try{
      const isStructured=el.classList?.contains('ProseMirror')||el.getAttribute?.('data-lexical-editor')==='true'||el.querySelector?.('p');
      if(isStructured){
        el.replaceChildren();
        const lines=String(text).split('\n');
        for(const line of lines){const p=document.createElement('p');if(line)p.textContent=line;else p.appendChild(document.createElement('br'));el.appendChild(p);}
      }else{
        el.textContent=text;
      }
      el.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:text}));
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return inputText(el).trim()===text.trim();
    }catch(_){return false;}
  }
  function setChatText(el,text){
    el.focus();
    if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement){nativeSetter(el,text);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));el.dispatchEvent(new Event('change',{bubbles:true}));el.setSelectionRange?.(text.length,text.length);return String(el.value||'').trim()===String(text).trim();}
    return setContentEditableText(el,text);
  }
  function insertIntoChat(text){const el=findChatInput();if(!el)return false;const current=inputText(el).trim();return setChatText(el,current?`${current}\n\n${text}`:text);}
  async function insertIntoChatRobust(text){
    for(const delay of [0,120,360]){
      if(delay)await new Promise(r=>setTimeout(r,delay));
      const el=findChatInput();if(!el)continue;
      const current=inputText(el).trim();const wanted=current?`${current}\n\n${text}`:text;
      if(setChatText(el,wanted))return true;
    }
    return false;
  }
  async function copyFallback(text){try{await navigator.clipboard.writeText(text);return true;}catch(_){return false;}}

  function assistantTabs(body,active){
    const tabs=document.createElement('div');tabs.className='cairn-assistant-tabs';
    const items=[['brain','Brain'],['multi','Multi-Provider'],['agent','Agent'],['help','Help']];
    for(const [id,label] of items){
      const b=document.createElement('button');b.className='cairn-assistant-tab'+(active===id?' active':'');b.textContent=label;
      if((id==='brain'||id==='multi')&&!brainOn){b.title='Brain is OFF in the extension popup';b.classList.add('disabled');}
      b.onclick=()=>{if((id==='brain'||id==='multi')&&!brainOn)return;renderAssistant(id);};tabs.appendChild(b);
    }
    body.appendChild(tabs);
  }

  function renderHelpContent(body){
    panel.classList.remove('cairn-brain-mode');
    const wrap=document.createElement('div');wrap.className='cairn-help-content';
    const sections=[
      ['1 · Connect Bridge','Start CAIRN.bat → open the dashboard → copy the Bridge token → extension popup → paste token → Save Settings. CAIRN reloads the active AI page once after a successful connection.'],
      ['2 · Save from AI/Web','Highlight text → Save to CAIRN, or use Save Chat for Complete Chat / Latest AI Reply. Save to Inbox creates a NEW .md inside CAIRN/Inbox/.'],
      ['3 · Brain · Vault → Chat','Brain → select exact notes or Load a Context Space → Insert puts their contents in the current chat box. Attach .md queues the actual selected Markdown files; Detach .md removes CAIRN-managed attachments without deleting vault files.'],
      ['4 · Multi-Provider Prompt','Type a draft prompt in the current AI composer → Multi-Provider → choose All open AI, ChatGPT, Claude, Gemini, or another detected provider. Optionally include selected Brain context and/or attach selected .md files. CAIRN inserts only; it never presses Send.'],
      ['5 · Context Spaces','Select several notes → Save Space → name it. Later choose that Space → Load. Only those exact notes are selected/read.'],
      ['6 · [Note.md] references','Type [Chapter 2.md] in the AI composer. CAIRN offers an explicit resolver; duplicate filenames require an exact path instead of guessing.'],
      ['7 · Agent','Ask naturally: show history · find my SVM notes · what is in [Chapter 2.md]? · list notes · status · doctor · undo last. Ollama is optional.'],
      ['8 · If something goes wrong','Run Dashboard → Doctor. If Bridge is disconnected, verify CAIRN.bat is running and paste the current token again. If provider tabs are missing from Multi-Provider Prompt, open them, refresh the AI page once, then press its ↻. If a write reports VERSION_CONFLICT, reopen the target and retry—CAIRN did not overwrite the newer file.'],
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
    if((active==='brain'||active==='multi')&&!brainOn)active='agent';
    const body=shell('CAIRN');panel.classList.add('cairn-assistant-mode');assistantTabs(body,active);
    const content=document.createElement('div');content.className='cairn-assistant-content';body.appendChild(content);
    if(active==='brain')await renderBrainContent(content);
    else if(active==='multi')await renderMultiProviderContent(content);
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
    const title=document.createElement('b');title.textContent='Multi-Provider Prompt';
    const note=document.createElement('span');note.textContent='Insert only — CAIRN never presses Send.';
    head.append(title,note);

    const targetRow=document.createElement('div');targetRow.className='cairn-broadcast-target';
    const target=document.createElement('select');target.className='cairn-select';
    const refresh=document.createElement('button');refresh.className='cairn-mini';refresh.textContent='↻';refresh.title='Refresh open AI providers';
    targetRow.append(target,refresh);

    const toggles=document.createElement('div');toggles.className='cairn-broadcast-toggles';
    const contextLabel=document.createElement('label');contextLabel.className='cairn-broadcast-toggle';
    const contextCheck=document.createElement('input');contextCheck.type='checkbox';const contextMark=document.createElement('span');contextMark.className='cairn-toggle-mark';contextMark.textContent='✓';
    const contextText=document.createElement('span');contextText.textContent='Include selected Brain context';contextLabel.append(contextCheck,contextMark,contextText);
    const attachLabel=document.createElement('label');attachLabel.className='cairn-broadcast-toggle';
    const attachCheck=document.createElement('input');attachCheck.type='checkbox';const attachMark=document.createElement('span');attachMark.className='cairn-toggle-mark';attachMark.textContent='✓';
    const attachText=document.createElement('span');attachText.textContent='Attach selected .md';attachLabel.append(attachCheck,attachMark,attachText);
    toggles.append(contextLabel,attachLabel);

    const actions=document.createElement('div');actions.className='cairn-broadcast-actions';
    const insert=document.createElement('button');insert.className='cairn-primary';insert.textContent='Insert chat to…';
    const detach=document.createElement('button');detach.className='cairn-secondary';detach.textContent='Detach all from…';
    actions.append(insert,detach);
    const meta=document.createElement('div');meta.className='cairn-broadcast-meta';meta.textContent='Looking for other open AI tabs…';
    box.append(head,targetRow,toggles,actions,meta);
    body.appendChild(box);

    const refreshTargets=async()=>{
      const keep=target.value||'all';
      refresh.disabled=true;
      try{
        const r=await message({type:'CAIRN_LIST_PROVIDER_TABS'});
        const groups=r.groups||[];const total=groups.reduce((n,g)=>n+Number(g.count||0),0);
        target.replaceChildren();
        const all=document.createElement('option');all.value='all';all.textContent=`All open AI tabs (${total})`;target.appendChild(all);
        const byKey=new Map(groups.map(g=>[g.provider,g]));
        for(const [key,label] of [['chatgpt','ChatGPT'],['claude','Claude'],['gemini','Gemini']]){const g=byKey.get(key);const o=document.createElement('option');o.value=key;o.textContent=`${label} (${g?.count||0})`;target.appendChild(o);byKey.delete(key);}
        for(const g of [...byKey.values()]){const o=document.createElement('option');o.value=g.provider;o.textContent=`${g.label} (${g.count})`;target.appendChild(o);}
        if([...target.options].some(o=>o.value===keep))target.value=keep;
        meta.textContent=total?`Detected ${total} other AI tab${total===1?'':'s'}. Multiple tabs of the same provider are all targeted.`:'No other supported AI tabs detected yet.';
        insert.disabled=total===0;detach.disabled=total===0;
      }catch(e){meta.textContent='Provider discovery failed: '+cleanError(e);insert.disabled=true;detach.disabled=true;}
      finally{refresh.disabled=false;}
    };
    refresh.onclick=refreshTargets;

    insert.onclick=async()=>{
      const draft=readCurrentDraft();const prompt=draft.text;
      if(!prompt)return status(body,`CAIRN could not read the current ${providerInfo().label||'AI'} draft. Click once inside the AI composer and press Insert chat to… again.`,'bad');
      const paths=[...brainSelected.keys()];
      if(contextCheck.checked&&!paths.length)return status(body,'Select at least one Brain note or turn off “Include selected Brain context”.','bad');
      if(attachCheck.checked&&!paths.length)return status(body,'Select at least one Brain note or turn off “Attach selected .md”.','bad');
      insert.disabled=true;detach.disabled=true;
      try{
        let text=prompt;
        if(contextCheck.checked){
          status(body,`Building context from ${paths.length} selected note${paths.length===1?'':'s'}…`);
          const bundle=await message({type:'CAIRN_BUILD_CONTEXT',paths,source:sourceId()});
          text=`${bundle.text}\n\n<<< USER PROMPT >>>\n${prompt}`;
        }
        status(body,'Inserting draft into open AI provider tabs…');
        const r=await message({type:'CAIRN_BROADCAST_PROMPT',target:target.value,text,paths:attachCheck.checked?paths:[],attach:attachCheck.checked,sourceProvider:providerInfo().provider});
        if(!r.matched)return status(body,'No matching other AI tabs are open. Open ChatGPT, Claude, Gemini, or another supported provider and press ↻.','bad');
        const attachmentNote=attachCheck.checked?` · ${r.attachedFiles} file attachment${r.attachedFiles===1?'':'s'} queued${r.attachmentFailures?` · ${r.attachmentFailures} tab${r.attachmentFailures===1?'':'s'} could not attach`:''}`:'';
        const providerReport=(r.results||[]).map(x=>`${x.label||x.provider}: ${x.result?.inserted?'✓':'✗'}`).join(' · ');
        const kind=r.inserted===r.matched?'ok':'bad';
        status(body,`Inserted into ${r.inserted}/${r.matched} AI tab${r.matched===1?'':'s'}${attachmentNote}.${providerReport?' '+providerReport+'.':''} Review each tab, then send normally.`,kind);
      }catch(e){status(body,cleanError(e),'bad');}
      finally{insert.disabled=false;detach.disabled=false;}
    };

    detach.onclick=async()=>{
      insert.disabled=true;detach.disabled=true;
      try{
        status(body,'Detaching all CAIRN-managed .md files from target tabs…');
        const r=await message({type:'CAIRN_BROADCAST_DETACH',target:target.value,paths:[]});
        if(!r.matched)return status(body,'No matching other AI tabs are open.','bad');
        status(body,r.detached?`Detached ${r.detached} attachment${r.detached===1?'':'s'} across ${r.matched} target tab${r.matched===1?'':'s'}.`:'Target tabs were reached, but CAIRN could not find those attachments. They may already be removed or the provider may hide its attachment controls.',r.detached?'ok':'bad');
      }catch(e){status(body,cleanError(e),'bad');}
      finally{insert.disabled=false;detach.disabled=false;}
    };
    await refreshTargets();
    return box;
  }

  async function renderBrainContent(body){
    panel.classList.add('cairn-brain-mode');
    const info=document.createElement('div');info.className='cairn-brain-info';info.textContent='Choose exact notes, load a Context Space, or use [Note.md]. Only selected notes are read.';
    const top=document.createElement('div');top.className='cairn-inline';const search=document.createElement('input');search.placeholder='Search indexed notes…';const refresh=document.createElement('button');refresh.className='cairn-mini';refresh.textContent='↻';refresh.title='Refresh vault index';top.append(search,refresh);
    const selected=document.createElement('div');selected.className='cairn-meta cairn-selection-count';selected.textContent='0 notes selected';
    const list=document.createElement('div');list.className='cairn-list cairn-brain-list';
    body.append(info);
    const spacesHost=document.createElement('div');spacesHost.className='cairn-spaces-host';body.appendChild(spacesHost);
    const loadManifest=m=>{brainSelected=new Map();for(const p of m.paths){const n=noteCache.find(x=>x.path===p)||{path:p,title:p};brainSelected.set(p,n);}search.value='';drawNotes();updateSelected();status(body,`Loaded ${m.handle}.`,'ok');};
    const refreshSpaces=async(selectedHandle='')=>{try{const manifests=await fetchManifests();spacesHost.replaceChildren();renderManifestPicker(spacesHost,manifests,loadManifest,selectedHandle);return manifests;}catch(e){spacesHost.replaceChildren();const x=document.createElement('div');x.className='cairn-meta';x.textContent='Context Spaces unavailable.';spacesHost.appendChild(x);return [];}};
    await refreshSpaces();
    body.append(top,selected);
    body.append(list);status(body,'Loading live vault index…');
    let notes=[];
    const updateSelected=()=>{const n=brainSelected.size;selected.textContent=`${n} note${n===1?'':'s'} selected`;};
    const drawNotes=()=>{
      list.replaceChildren();const q=search.value.trim().toLowerCase();const filtered=notes.filter(n=>!q||`${n.title||''} ${n.path}`.toLowerCase().includes(q)).slice(0,160);
      if(!filtered.length){const e=document.createElement('div');e.className='cairn-empty';e.textContent='No matching Markdown notes.';list.appendChild(e);return;}
      for(const note of filtered){
        const row=document.createElement('div');row.className='cairn-brain-note cairn-brain-note-row';
        const pick=document.createElement('label');pick.className='cairn-brain-pick';const check=document.createElement('input');check.type='checkbox';check.className='cairn-brain-check';check.checked=brainSelected.has(note.path);const mark=document.createElement('span');mark.className='cairn-check-mark';mark.textContent='✓';const text=document.createElement('span');text.className='cairn-brain-note-text';const title=document.createElement('b');title.textContent=note.title||note.path;const path=document.createElement('small');path.textContent=note.path;text.append(title,path);pick.append(check,mark,text);
        const syncRow=()=>row.classList.toggle('is-selected',check.checked);syncRow();
        check.onchange=()=>{if(check.checked)brainSelected.set(note.path,note);else brainSelected.delete(note.path);syncRow();updateSelected();};
        const acts=document.createElement('div');acts.className='cairn-note-mini-actions';
        const open=document.createElement('button');open.className='cairn-note-mini';open.textContent='Open .md';open.onclick=e=>{e.preventDefault();e.stopPropagation();renderNoteViewer(note,()=>renderAssistant('brain'));};
        const attach=document.createElement('button');attach.className='cairn-note-mini';attach.textContent='Attach';attach.onclick=async e=>{e.preventDefault();e.stopPropagation();const a=await attachMarkdown(note);if(a.ok)status(body,`Attached ${note.path.split('/').pop()} to the chat.`,'ok');else status(body,'No compatible file input detected. Open .md to download or insert it instead.','bad');};
        acts.append(open,attach);row.append(pick,acts);list.appendChild(row);
      }
    };
    const load=async(force=false)=>{try{notes=await fetchNotes(force);body.querySelector('.cairn-status')?.remove();drawNotes();updateSelected();}catch(e){list.replaceChildren();status(body,cleanError(e),'bad');}};search.oninput=drawNotes;refresh.onclick=async()=>{refresh.disabled=true;try{await load(true);await refreshSpaces();status(body,'Notes and Context Spaces refreshed.','ok');}finally{refresh.disabled=false;}};await load(false);

    const saveSpace=document.createElement('button');saveSpace.className='cairn-secondary';saveSpace.textContent='Save Space';saveSpace.onclick=()=>{const paths=[...brainSelected.keys()];if(!paths.length)return status(body,'Select at least one note.','bad');showSpaceSaveDialog(paths,body,refreshSpaces);};
    const insert=document.createElement('button');insert.className='cairn-primary cairn-sticky-primary';insert.textContent='Insert';insert.title='Insert selected note contents into the current chat box';insert.onclick=async()=>{const paths=[...brainSelected.keys()];if(!paths.length)return status(body,'Select at least one note.','bad');insert.disabled=true;try{status(body,`Reading ${paths.length} selected note${paths.length===1?'':'s'}…`);const bundle=await message({type:'CAIRN_BUILD_CONTEXT',paths,source:sourceId()});if(insertIntoChat(bundle.text)){status(body,`Inserted ${bundle.paths.length} note${bundle.paths.length===1?'':'s'} into the chat box. Review, then send normally.`,'ok');setTimeout(removePanel,1400);}else if(await copyFallback(bundle.text)){status(body,'No compatible chat box found. Context copied to clipboard.','bad');insert.disabled=false;}else{status(body,'No compatible chat box found.','bad');insert.disabled=false;}}catch(e){status(body,cleanError(e),'bad');insert.disabled=false;}};
    const attachSelected=document.createElement('button');attachSelected.className='cairn-secondary';attachSelected.textContent='Attach .md';attachSelected.title='Attach the actual selected Markdown files to this chat';attachSelected.onclick=async()=>{const paths=[...brainSelected.keys()];if(!paths.length)return status(body,'Select at least one note.','bad');attachSelected.disabled=true;try{status(body,`Attaching ${paths.length} selected .md file${paths.length===1?'':'s'}…`);const r=await attachMarkdownPaths(paths);if(r.ok){status(body,`Attached ${r.count} selected .md file${r.count===1?'':'s'}. Review before sending.`,'ok');}else{status(body,location.hostname.includes('claude.ai')?'Claude did not expose a compatible upload input yet. Open Claude’s attachment control once, then retry Attach .md.':'This site did not expose a compatible file input.','bad');}}catch(e){status(body,cleanError(e),'bad');}finally{attachSelected.disabled=false;}};
    const detachSelected=document.createElement('button');detachSelected.className='cairn-secondary';detachSelected.textContent='Detach all .md';detachSelected.title='Remove all CAIRN-managed Markdown attachments from this chat composer';detachSelected.onclick=async()=>{detachSelected.disabled=true;try{const r=await detachMarkdownPaths([]);if(r.ok)status(body,`Detached all ${r.count} CAIRN-managed .md attachment${r.count===1?'':'s'} from this chat.`,'ok');else status(body,'CAIRN could not find those attachments in this composer. They may already be removed or the provider may hide its attachment controls.','bad');}catch(e){status(body,cleanError(e),'bad');}finally{detachSelected.disabled=false;}};
    footer(body,saveSpace,insert,attachSelected,detachSelected);
  }

  function extractRefs(text){return [...new Set([...text.matchAll(/\[([^\]\n]+\.md)\]/gi)].map(m=>m[1].trim()))];}
  async function resolveCurrentRefs(){const el=findChatInput();if(!el)return;const original=inputText(el);const refs=extractRefs(original);if(!refs.length)return;try{const r=await message({type:'CAIRN_RESOLVE_REFS',refs,source:sourceId()});if(r.ambiguous?.length||r.missing?.length){const body=shell('Resolve [Note.md] References');if(r.missing?.length){const x=document.createElement('div');x.className='cairn-status bad';x.textContent='Missing: '+r.missing.join(', ');body.appendChild(x);}for(const a of r.ambiguous||[]){const x=document.createElement('div');x.className='cairn-status bad';x.textContent=`Ambiguous ${a.ref}: ${a.matches.join(' · ')}`;body.appendChild(x);}const hint=document.createElement('div');hint.className='cairn-meta';hint.textContent='Use an exact vault-relative path inside [brackets] to disambiguate.';body.appendChild(hint);return;}if(!r.bundle)return;const combined=`${r.bundle.text}\n\n<<< USER PROMPT >>>\n${original}`;setChatText(el,combined);refChip.style.display='none';}catch(e){const body=shell('CAIRN Brain');status(body,cleanError(e),'bad');}}

  async function renderMultiProviderContent(body){
    panel.classList.remove('cairn-brain-mode');
    const info=document.createElement('div');info.className='cairn-brain-info';
    const updateInfo=()=>{const n=brainSelected.size;info.textContent=`Broadcast the draft already typed in this AI composer. ${n} Brain note${n===1?' is':'s are'} currently selected for optional shared context/attachments. CAIRN inserts only and never presses Send.`;};
    updateInfo();body.appendChild(info);
    await renderProviderBroadcastBox(body);
    const hint=document.createElement('div');hint.className='cairn-meta';hint.textContent='Need different notes? Open Brain, select them, then return to Multi-Provider. Your selection is preserved while the CAIRN panel stays open.';body.appendChild(hint);
  }

  async function renderAgentContent(body){
    panel.classList.remove('cairn-brain-mode');const info=document.createElement('div');info.className='cairn-brain-info';info.textContent='Vault-aware CAIRN assistant. Speak naturally: “show history”, “find my SVM notes”, “what is in [Chapter 2.md]?”, “status”, or “undo last”. It searches the SQLite index and can use a running local Ollama model when available. Webpage text never receives filesystem authority.';
    const log=document.createElement('div');log.className='cairn-agent-log';
    const row=document.createElement('div');row.className='cairn-agent-row';const input=document.createElement('input');input.placeholder='Ask about your vault or CAIRN…';const send=document.createElement('button');send.className='cairn-mini';send.textContent='Send';row.append(input,send);body.append(info,log);footer(body,row);
    const add=(who,text)=>{const x=document.createElement('div');x.className='cairn-agent-msg '+who;x.textContent=text;log.appendChild(x);log.scrollTop=log.scrollHeight;};
    const fmt=x=>{if(x.snippet)return `${x.path||x.title||'Result'} — ${String(x.snippet).replace(/\s+/g,' ').trim()}`;if(x.action)return `${x.action} · ${x.target_note||'vault'}${x.requested_at?' · '+new Date(x.requested_at*1000).toLocaleString():''}`;if(x.name)return `${x.ok?'✓':'✗'} ${x.name}`;return x.path||x.target_note||x.handle||String(x);};
    const ask=async()=>{const text=input.value.trim();if(!text)return;add('user',text);input.value='';try{const r=await message({type:'CAIRN_AGENT_ASK',text,source:sourceId()});add('agent',(r.text||'Done.')+(r.model?`\n\nLocal AI: ${r.model}`:''));if(r.results?.length){r.results.slice(0,8).forEach(x=>add('result',fmt(x)));}}catch(e){add('bad',cleanError(e));}};send.onclick=ask;input.onkeydown=e=>{if(e.key==='Enter')ask();};add('agent','Talk naturally. Try: show history · find notes about SVM · what is in [Chapter 2.md]? · list notes · status · doctor · undo last');
  }

  async function renderBrainPicker(){ return renderAssistant('brain'); }
  async function renderAgent(){ return renderAssistant('agent'); }

  function cleanError(error){const raw=String(error?.message||error||'Unknown error');if(raw.includes('VERSION_CONFLICT'))return 'Version conflict: the note changed after CAIRN loaded it. Re-open the picker and try again.';if(raw.includes('NOTE_EXISTS'))return 'That note already exists. Choose another path or append instead.';if(raw.includes('NO_VAULT'))return 'No vault is connected. Open the CAIRN dashboard and connect a vault first.';if(raw.includes('INVALID_TOKEN'))return 'Bridge token rejected. Copy the current token from the CAIRN dashboard into the extension popup.';if(raw.includes('CAPABILITY_DENIED'))return 'The browser does not have permission for that path.';if(raw.includes('CONTEXT_TOO_LARGE'))return 'Selected context is too large. Select fewer notes.';return raw.replace(/^Error:\s*/,'');}

  function currentSelection(){return String(window.getSelection()).trim();}
  document.addEventListener('selectionchange',()=>{if(panel||!bridgeConnected){floating.style.display='none';return;}const text=currentSelection();floating.style.display=text?'block':'none';});
  floating.addEventListener('mousedown',e=>{const text=currentSelection();if(text){capturedText=text;captureLabel='Selection';captureTitle=document.title;}e.preventDefault();});
  floating.addEventListener('click',()=>{const text=capturedText||currentSelection();if(!text)return;capturedText=text;captureLabel='Selection';captureTitle=document.title;floating.style.display='none';renderHome();});
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
        const inserted=!!(msg.text&&await insertIntoChatRobust(msg.text));
        let attachRequested=!!msg.attach, attachedOk=!attachRequested, attachedCount=0, attachReason='';
        if(attachRequested){
          const a=await attachMarkdownPaths(msg.paths||[]);
          attachedOk=!!a.ok;attachedCount=Number(a.count)||0;attachReason=a.reason||'';
        }
        sendResponse({ok:inserted,inserted,attachRequested,attachedOk,attachedCount,attachReason,provider:providerInfo().provider});
      })().catch(error=>sendResponse({ok:false,inserted:false,error:String(error?.message||error),provider:providerInfo().provider}));
      return true;
    }
    if(msg?.type==='CAIRN_UI_REMOTE_DETACH'){
      (async()=>{const d=await detachMarkdownPaths(msg.paths||[]);sendResponse({ok:true,detachedOk:!!d.ok,detachedCount:Number(d.count)||0,reason:d.reason||'',provider:providerInfo().provider});})()
        .catch(error=>sendResponse({ok:false,detachedOk:false,detachedCount:0,error:String(error?.message||error),provider:providerInfo().provider}));
      return true;
    }
    if(!bridgeConnected)return;
    if(msg?.type==='CAIRN_UI_OPEN_BRAIN')renderAssistant('brain');
    if(msg?.type==='CAIRN_UI_OPEN_AGENT')renderAssistant('agent');
    if(msg?.type==='CAIRN_UI_CAPTURE_SELECTION'){const text=currentSelection();if(text){capturedText=text;captureLabel='Selection';captureTitle=document.title;renderHome();}}
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
