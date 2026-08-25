const $=id=>document.getElementById(id);
const DEFAULT_URL='http://127.0.0.1:7821';

chrome.storage.local.get({serviceUrl:DEFAULT_URL,token:'',brainOn:true},s=>{
  $('url').value=s.serviceUrl;
  $('token').value=s.token;
  $('brainOn').checked=s.brainOn!==false;
});

async function currentTab(){const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return tab;}
function values(){return {serviceUrl:$('url').value.trim().replace(/\/$/,''),token:$('token').value.trim(),brainOn:$('brainOn').checked};}
function setStatus(text,ok=false){$('status').textContent=text;$('status').className=ok?'ok':'';}

async function validateBridge({serviceUrl,token}){
  if(!token) throw new Error('Paste the Bridge token first.');
  const response=await fetch(serviceUrl+'/api/notes',{headers:{'X-CAIRN-Token':token}});
  const text=await response.text();
  if(!response.ok){
    if(response.status===401) throw new Error('Bridge token rejected. Copy the current token from the CAIRN dashboard.');
    throw new Error(text||`Connection failed (${response.status})`);
  }
  const notes=JSON.parse(text||'[]');
  const health=await fetch(serviceUrl+'/api/health').then(r=>r.json()).catch(()=>({watcher:false}));
  return {notes:Array.isArray(notes)?notes.length:0,watcher:!!health.watcher};
}

async function reloadActivePage(){
  const tab=await currentTab();
  if(!tab?.id)return false;
  try{await chrome.tabs.reload(tab.id);return true;}catch(_){return false;}
}

async function connectAndReload(saveFirst=true){
  const cfg=values();
  try{
    if(saveFirst) await chrome.storage.local.set(cfg);
    setStatus('Connecting Bridge…');
    const result=await validateBridge(cfg);
    setStatus(`Connected · ${result.notes} notes · watcher ${result.watcher?'ON':'OFF'} · reloading page…`,true);
    await reloadActivePage();
    setTimeout(()=>window.close(),250);
  }catch(e){setStatus('Connection failed: '+e.message);}
}

$('save').onclick=()=>connectAndReload(true);
$('test').onclick=()=>connectAndReload(true);

$('saveChat').onclick=async()=>{const tab=await currentTab();if(!tab?.id)return;setStatus('Opening complete-chat capture…');chrome.tabs.sendMessage(tab.id,{type:'CAIRN_UI_CAPTURE_CHAT'}).catch(e=>{setStatus('Refresh the page and try again: '+e.message)});window.close();};
$('openHelp').onclick=()=>{chrome.storage.local.get({serviceUrl:DEFAULT_URL},s=>chrome.tabs.create({url:s.serviceUrl.replace(/\/$/,'')+'/?help=1'}));};
