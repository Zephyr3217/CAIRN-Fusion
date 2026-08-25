let token='';const $=id=>document.getElementById(id);
async function bootstrap(){const b=await fetch('/api/bootstrap').then(r=>r.json());token=b.token;$('token').value=token;$('serviceUrl').textContent=location.origin;$('vaultPath').value=b.vault||'';await refreshAll();connectEvents();}
async function api(path,opts={}){opts.headers={...(opts.headers||{}),'X-CAIRN-Token':token};const r=await fetch(path,opts);let x;try{x=await r.json()}catch{x=await r.text()}if(!r.ok)throw new Error(typeof x==='string'?x:JSON.stringify(x));return x}
const post=(path,body={})=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function refreshAll(){await Promise.all([health(),ops(),notes(),doctor(),spaces()])}
async function health(){const h=await fetch('/api/health').then(r=>r.json());$('status').textContent=h.ok?'Running':'Problem';$('status').className='pill '+(h.ok?'ok':'bad');$('vaultInfo').textContent=h.vault?`${h.vault} · ${h.notes} indexed notes · watcher ${h.watcher?'ON':'OFF'}`:'No vault selected.';}
async function doctor(){try{const d=await api('/api/doctor');$('doctor').innerHTML=d.checks.map(c=>`<div class="doctor-item ${c.ok?'pass':'fail'}"><strong>${c.ok?'✓':'✗'} ${esc(c.name)}</strong><small>${esc(c.detail)}</small>${c.ok?'':`<details><summary>Help</summary><p>${esc(c.help)}</p></details>`}</div>`).join('')}catch(e){$('doctor').innerHTML=`<p class="badtext">${esc(e.message)}</p>`}}
async function ops(){const rows=await api('/api/operations');$('ops').innerHTML=rows.length?rows.map(o=>`<div class="item"><strong>${esc(o.action)} · ${esc(o.target_note||'')}</strong><small>${new Date(o.requested_at*1000).toLocaleString()} · ${esc(o.source_id||'local')} · ${esc(o.stage)}</small><div class="item-actions">${o.rollback_available&&!o.undone_by?`<button class="undo" data-op="${o.operation_id}">Undo</button>`:''}${o.target_note?`<button class="openmd secondary" data-path="${attr(o.target_note)}">Open .md</button><button class="openobs secondary" data-path="${attr(o.target_note)}">Open in Obsidian</button><button class="openexp secondary" data-path="${attr(o.target_note)}">Explorer</button>`:''}</div></div>`).join(''):'<p class="muted">No operations yet.</p>';bindItemButtons()}
async function notes(){const q=$('search').value.trim();let rows=q?await api('/api/search?q='+encodeURIComponent(q)):await api('/api/notes');$('notes').innerHTML=rows.length?rows.map(n=>`<div class="item"><strong>${esc(n.title||n.path)}</strong><small>${esc(n.path)}${n.snippet?' · '+esc(n.snippet):''}</small><div class="item-actions"><button class="openmd secondary" data-path="${attr(n.path)}">Open .md</button><button class="openobs secondary" data-path="${attr(n.path)}">Open in Obsidian</button><button class="openexp secondary" data-path="${attr(n.path)}">Explorer</button></div></div>`).join(''):'<p class="muted">No notes indexed.</p>';bindItemButtons()}
async function spaces(){try{const rows=await api('/api/manifests');$('spaces').innerHTML=rows.length?rows.map(m=>`<div class="item"><strong>${esc(m.handle)}</strong><small>${m.paths.length} notes${m.default_write_target?' · write → '+esc(m.default_write_target):''}</small><details><summary>Files</summary><p class="muted">${m.paths.map(esc).join('<br>')}</p></details></div>`).join(''):'<p class="muted">No Context Spaces yet.</p>'}catch(e){$('spaces').innerHTML=`<p class="muted">${esc(e.message)}</p>`}}
let currentNote=null;
async function openMd(path){
  try{const n=await api('/api/note/read?path='+encodeURIComponent(path)+'&client_id=browser-extension');currentNote=n;$('noteDialogTitle').textContent=(path.split('/').pop()||'Open .md');$('noteDialogPath').textContent=path+' · '+Number(n.chars||0).toLocaleString()+' characters';$('noteDialogContent').textContent=n.content||'';$('noteDialog').showModal();}catch(e){alert(e.message)}
}
function downloadCurrentNote(){if(!currentNote)return;const blob=new Blob([currentNote.content||''],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(currentNote.path||'note.md').split('/').pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function bindItemButtons(){document.querySelectorAll('.undo').forEach(b=>b.onclick=async()=>{try{await api(`/api/operations/${b.dataset.op}/undo`,{method:'POST'});await refreshAll()}catch(e){alert(e.message)}});document.querySelectorAll('.openmd').forEach(b=>b.onclick=()=>openMd(b.dataset.path));document.querySelectorAll('.openobs').forEach(b=>b.onclick=()=>post('/api/open/obsidian',{path:b.dataset.path}).catch(e=>alert(e.message)));document.querySelectorAll('.openexp').forEach(b=>b.onclick=()=>post('/api/open/explorer',{path:b.dataset.path}).catch(e=>alert(e.message)));}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function attr(s){return esc(s).replace(/`/g,'&#96;')}
$('setVault').onclick=async()=>{try{await post('/api/vault/register',{path:$('vaultPath').value});await refreshAll()}catch(e){alert(e.message)}};$('forceRefresh').onclick=async()=>{try{await post('/api/vault/refresh',{});await refreshAll()}catch(e){alert(e.message)}};
$('copyToken').onclick=()=>navigator.clipboard.writeText(token);$('refreshOps').onclick=ops;$('refreshNotes').onclick=notes;$('runDoctor').onclick=doctor;$('search').oninput=()=>{clearTimeout(window._st);window._st=setTimeout(notes,200)};
$('compact').onclick=()=>{document.body.classList.toggle('compact');$('compact').textContent=document.body.classList.contains('compact')?'Full':'Compact'};
function agentMsg(kind,text){const d=document.createElement('div');d.className='agent-msg '+kind;d.textContent=text;$('agentLog').appendChild(d);$('agentLog').scrollTop=$('agentLog').scrollHeight}
function fmtAgentResult(x){if(x.snippet)return `${x.path||x.title||'Result'} — ${String(x.snippet).replace(/\s+/g,' ').trim()}`;if(x.action)return `${x.action} · ${x.target_note||'vault'}${x.requested_at?' · '+new Date(x.requested_at*1000).toLocaleString():''}`;if(x.name)return `${x.ok?'✓':'✗'} ${x.name}`;return x.path||x.target_note||x.handle||JSON.stringify(x)}
async function askAgent(){const text=$('agentInput').value.trim();if(!text)return;agentMsg('user',text);$('agentInput').value='';try{const r=await post('/api/agent/ask',{text,source_id:'dashboard',client_id:'browser-extension'});agentMsg('agent',(r.text||'Done.')+(r.model?`\n\nLocal AI: ${r.model}`:''));(r.results||[]).slice(0,8).forEach(x=>agentMsg('result',fmtAgentResult(x)));await refreshAll()}catch(e){agentMsg('bad',e.message)}}
$('agentSend').onclick=askAgent;$('agentInput').onkeydown=e=>{if(e.key==='Enter')askAgent()};agentMsg('agent','Talk naturally. Try: show history · find notes about SVM · what is in [Chapter 2.md]? · list notes · status · doctor · undo last');
let liveEvents=null;
async function connectEvents(){
  try{
    const t=await post('/api/events/ticket',{});
    liveEvents?.close();
    liveEvents=new EventSource('/events?ticket='+encodeURIComponent(t.ticket));
    liveEvents.onmessage=()=>refreshAll();
    liveEvents.onerror=()=>{liveEvents.close();setTimeout(connectEvents,2000)};
  }catch(e){setTimeout(connectEvents,3000)}
}
$('help').onclick=()=>$('helpDialog').showModal();$('closeHelp').onclick=()=>$('helpDialog').close();
$('closeNote').onclick=()=>$('noteDialog').close();$('downloadNote').onclick=downloadCurrentNote;
$('noteObsidian').onclick=()=>{if(currentNote)post('/api/open/obsidian',{path:currentNote.path}).catch(e=>alert(e.message))};
$('noteExplorer').onclick=()=>{if(currentNote)post('/api/open/explorer',{path:currentNote.path}).catch(e=>alert(e.message))};
if(new URLSearchParams(location.search).get('help')==='1')setTimeout(()=>$('helpDialog').showModal(),250);
bootstrap().catch(e=>{$('status').textContent='Failed';$('status').className='pill bad';console.error(e)});
