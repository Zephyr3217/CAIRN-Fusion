from __future__ import annotations
import asyncio, hmac, json, os, secrets, subprocess, sys, tempfile, threading, time, webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from . import __version__
from .config import Config
from .db import Database
from .vault import VaultManager, VaultError, VersionConflict
from .watcher import VaultWatcher
from .markdown_engine import HeadingNotFound, AmbiguousHeading, heading_dicts, suggest_headings, semantic_title
from .security import CapabilityManager, safe_resolve
from .context import build_context, ContextError
from .agent_engine import ask_agent

class Runtime:
    def __init__(self):
        self.cfg = Config.load(); self.db = Database(); self.vault: VaultManager|None = None; self.watcher: VaultWatcher|None = None
        self.clients: set[asyncio.Queue] = set(); self.loop: asyncio.AbstractEventLoop|None = None
        self.caps = CapabilityManager(self.db); self.caps.ensure_default()
        self.last_browser_seen: float | None = None
        self.event_tickets: dict[str, float] = {}
        if self.cfg.vault_path and Path(self.cfg.vault_path).exists(): self.set_vault(Path(self.cfg.vault_path))
    def mint_event_ticket(self, ttl: float = 60.0) -> str:
        now = time.time()
        # Opportunistically prune expired tickets so this dict never grows unbounded.
        for t in [t for t, exp in self.event_tickets.items() if exp < now]:
            del self.event_tickets[t]
        ticket = secrets.token_urlsafe(24)
        self.event_tickets[ticket] = now + ttl
        return ticket
    def consume_event_ticket(self, ticket: str) -> bool:
        exp = self.event_tickets.get(ticket)
        return exp is not None and exp >= time.time()
    def set_vault(self, path: Path):
        if self.watcher: self.watcher.stop()
        self.vault = VaultManager(self.db, path); self.vault.full_index(); self.cfg.vault_path = str(path); self.cfg.save()
        self.watcher = VaultWatcher(self.vault, self.broadcast); self.watcher.start(); self.broadcast({"type":"vault_registered","path":str(path)})
    def broadcast(self, event: dict):
        if not self.loop: return
        def put():
            for q in list(self.clients):
                try: q.put_nowait(event)
                except Exception: pass
        self.loop.call_soon_threadsafe(put)

rt = Runtime()

@asynccontextmanager
async def lifespan(app: FastAPI):
    rt.loop = asyncio.get_running_loop()
    yield
    if rt.watcher: rt.watcher.stop()
    rt.db.close()

app = FastAPI(title='CAIRN Fusion', version=__version__, lifespan=lifespan)
STATIC = Path(__file__).parent/'static'
app.mount('/static', StaticFiles(directory=STATIC), name='static')

async def auth(x_cairn_token: str | None = Header(None), request: Request | None = None):
    if not x_cairn_token or not hmac.compare_digest(x_cairn_token, rt.cfg.token):
        raise HTTPException(401, 'INVALID_TOKEN')
    origin = request.headers.get('origin') if request else None
    if origin and not (origin.startswith('chrome-extension://') or origin.startswith('moz-extension://') or origin.startswith(f'http://{rt.cfg.host}:{rt.cfg.port}')):
        raise HTTPException(403, 'ORIGIN_NOT_ALLOWED')
    ua = request.headers.get('user-agent','') if request else ''
    if request and (origin or 'Chrome' in ua or 'Firefox' in ua or 'Brave' in ua):
        rt.last_browser_seen = time.time()

class VaultRegister(BaseModel): path: str
class CreateReq(BaseModel): path: str; title: str; body: str = ''; operation_id: str|None=None; client_id: str='browser-extension'; source_id: str='browser'
class FolderReq(BaseModel): path: str; client_id: str='browser-extension'
class AppendReq(BaseModel): path: str; content: str; expected_hash: str|None=None; operation_id: str|None=None; client_id: str='browser-extension'; source_id: str='browser'; title: str|None=None
class AppendHeadingReq(AppendReq): heading: str|None=None; heading_path: list[str]|None=None
class InboxReq(BaseModel): content: str; title: str|None=None; operation_id: str|None=None; client_id: str='browser-extension'; source_id: str='browser'
class ContextReq(BaseModel): paths: list[str] = Field(min_length=1, max_length=30); client_id: str='browser-extension'; source_id: str='browser'
class RefReq(BaseModel): refs: list[str] = Field(min_length=1, max_length=30); client_id: str='browser-extension'; source_id: str='browser'
class SuggestReq(BaseModel): content: str; count: int=3
class ManifestReq(BaseModel): handle: str; paths: list[str] = Field(min_length=1, max_length=100); default_write_target: str|None=None; client_id: str='browser-extension'
class AgentReq(BaseModel): text: str; client_id: str='browser-extension'; source_id: str='browser'
class OpenReq(BaseModel): path: str

@app.get('/')
def home(): return FileResponse(STATIC/'index.html')

@app.get('/api/health')
def health():
    return {
        "ok":True,"version":__version__,"vault":str(rt.vault.root) if rt.vault else None,
        "notes":rt.db.query('SELECT COUNT(*) AS n FROM notes')[0]['n'],
        "watcher":bool(rt.watcher and rt.watcher._thread and rt.watcher._thread.is_alive()),
        "browser_seen_seconds": None if rt.last_browser_seen is None else max(0,int(time.time()-rt.last_browser_seen)),
    }

@app.get('/api/bootstrap')
def bootstrap(): return {"token":rt.cfg.token,"vault":rt.cfg.vault_path,"port":rt.cfg.port,"version":__version__}

@app.post('/api/vault/register')
async def register(req: VaultRegister, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    p=Path(req.path).expanduser()
    if not p.exists() or not p.is_dir(): raise HTTPException(400,'VAULT_PATH_INVALID')
    rt.set_vault(p); return {"ok":True,"path":str(p.resolve())}

@app.post('/api/vault/refresh')
async def refresh_vault(request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    rt.vault.full_index(); rt.broadcast({"type":"vault_refresh","ts":time.time()})
    return {"ok":True,"notes":rt.db.query('SELECT COUNT(*) AS n FROM notes')[0]['n']}

@app.get('/api/notes')
async def notes(request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request); return rt.db.query('SELECT path,title,content_hash,mtime_ns,size_bytes FROM notes ORDER BY path')

@app.get('/api/folders')
async def folders(request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request); return rt.db.query('SELECT path FROM folders ORDER BY path')

@app.post('/api/folder/create')
async def folder_create(req: FolderReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: return rt.vault.create_folder(req.path)
    except Exception as e: raise HTTPException(400,str(e))

@app.get('/api/headings')
async def get_headings(path: str, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    try: data,_=rt.vault.read(path); return heading_dicts(data.decode('utf-8'))
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/headings/suggest')
async def heading_suggest(req: SuggestReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    return {"suggestions": suggest_headings(req.content, req.count), "engine":"deterministic"}

@app.get('/api/note/read')
async def read_note(path: str, request: Request, x_cairn_token: str|None=Header(None), client_id: str='browser-extension'):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(client_id,'read',path): raise HTTPException(403,'CAPABILITY_DENIED')
    try:
        data,digest=rt.vault.read(path); text=data.decode('utf-8')
        return {"path":path,"content_hash":digest,"content":text,"chars":len(text)}
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/context/build')
async def context_build(req: ContextReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    for path in req.paths:
        if not rt.caps.allowed(req.client_id,'read',path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: return build_context(rt.vault, req.paths)
    except ContextError as e: raise HTTPException(400,str(e))
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/context/resolve-refs')
async def resolve_refs(req: RefReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    result=rt.db.resolve_note_refs(req.refs)
    for note in result['resolved']:
        if not rt.caps.allowed(req.client_id,'read',note['path']): raise HTTPException(403,'CAPABILITY_DENIED')
    paths=[n['path'] for n in result['resolved']]
    bundle = build_context(rt.vault, paths) if paths else None
    return {**result,"bundle":bundle}

@app.get('/api/manifests')
async def manifests(request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request); return rt.db.list_manifests()

@app.post('/api/manifests')
async def manifest_upsert(req: ManifestReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    for path in req.paths:
        if not rt.caps.allowed(req.client_id,'read',path): raise HTTPException(403,'CAPABILITY_DENIED')
    if req.default_write_target and not rt.caps.allowed(req.client_id,'write',req.default_write_target): raise HTTPException(403,'CAPABILITY_DENIED')
    try: return rt.db.upsert_manifest(req.handle, req.paths, req.default_write_target)
    except Exception as e: raise HTTPException(400,str(e))

@app.delete('/api/manifests/{handle}')
async def manifest_delete(handle: str, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request); rt.db.delete_manifest(handle if handle.startswith('@') else '@'+handle); return {"ok":True}

@app.post('/api/note/create')
async def create(req: CreateReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.create(req.path,req.title,req.body,source_id=req.source_id,operation_id=req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/note/append')
async def append(req: AppendReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.append(req.path,req.content,req.expected_hash,source_id=req.source_id,operation_id=req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except VersionConflict: raise HTTPException(409,'VERSION_CONFLICT')
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/note/append-update')
async def append_update(req: AppendReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.append_update(req.path,req.content,req.title,req.expected_hash,source_id=req.source_id,operation_id=req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except VersionConflict: raise HTTPException(409,'VERSION_CONFLICT')
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/note/append-under-heading')
async def append_heading(req: AppendHeadingReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.append_heading(req.path,req.content,req.heading,req.heading_path,req.expected_hash,source_id=req.source_id,operation_id=req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except AmbiguousHeading as e: raise HTTPException(409,{"error":"AMBIGUOUS_HEADING","candidates":e.candidates})
    except HeadingNotFound: raise HTTPException(404,'HEADING_NOT_FOUND')
    except VersionConflict: raise HTTPException(409,'VERSION_CONFLICT')
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/note/append-under-heading-update')
async def append_heading_update(req: AppendHeadingReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.append_heading_update(req.path,req.content,req.heading,req.heading_path,req.title,req.expected_hash,source_id=req.source_id,operation_id=req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except AmbiguousHeading as e: raise HTTPException(409,{"error":"AMBIGUOUS_HEADING","candidates":e.candidates})
    except HeadingNotFound: raise HTTPException(404,'HEADING_NOT_FOUND')
    except VersionConflict: raise HTTPException(409,'VERSION_CONFLICT')
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/note/patch-heading')
async def patch_heading(req: AppendHeadingReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.patch_heading(req.path,req.content,req.heading,req.heading_path,req.expected_hash,source_id=req.source_id,operation_id=req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except AmbiguousHeading as e: raise HTTPException(409,{"error":"AMBIGUOUS_HEADING","candidates":e.candidates})
    except HeadingNotFound: raise HTTPException(404,'HEADING_NOT_FOUND')
    except VersionConflict: raise HTTPException(409,'VERSION_CONFLICT')
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/note/delete')
async def delete_note(req: AppendReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write',req.path): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.delete(req.path,req.expected_hash,source_id=req.source_id,operation_id=req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except VersionConflict: raise HTTPException(409,'VERSION_CONFLICT')
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/inbox/save')
async def inbox(req: InboxReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    if not rt.caps.allowed(req.client_id,'write','CAIRN/Inbox/**'): raise HTTPException(403,'CAPABILITY_DENIED')
    try: result=rt.vault.save_inbox(req.content,req.source_id,req.title,req.operation_id); rt.broadcast({"type":"operation",**result}); return result
    except Exception as e: raise HTTPException(400,str(e))

@app.get('/api/operations')
async def operations(request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request); return rt.db.recent_operations(100)

@app.post('/api/operations/{op_id}/undo')
async def undo(op_id: str, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    try: result=rt.vault.undo(op_id); rt.broadcast({"type":"operation",**result}); return result
    except VersionConflict: raise HTTPException(409,'UNDO_CONFLICT')
    except Exception as e: raise HTTPException(400,str(e))

@app.get('/api/search')
async def search(q: str, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    try: return rt.db.query("SELECT path,title,snippet(notes_fts,2,'[',']','…',12) AS snippet,bm25(notes_fts) AS rank FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 30", (q,))
    except Exception: return []

@app.post('/api/open/explorer')
async def open_explorer(req: OpenReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    try:
        p=safe_resolve(rt.vault.root, req.path)
        if sys.platform.startswith('win'):
            if p.exists() and p.is_file(): subprocess.Popen(['explorer.exe','/select,',str(p)])
            else: subprocess.Popen(['explorer.exe',str(p if p.is_dir() else p.parent)])
        elif sys.platform=='darwin': subprocess.Popen(['open','-R',str(p)])
        else: subprocess.Popen(['xdg-open',str(p if p.is_dir() else p.parent)])
        return {"ok":True}
    except Exception as e: raise HTTPException(400,str(e))

@app.post('/api/open/obsidian')
async def open_obsidian(req: OpenReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    if not rt.vault: raise HTTPException(409,'NO_VAULT')
    try:
        p=safe_resolve(rt.vault.root, req.path)
        uri='obsidian://open?path='+quote(str(p))
        webbrowser.open(uri)
        return {"ok":True,"uri":uri}
    except Exception as e: raise HTTPException(400,str(e))

@app.get('/api/doctor')
async def doctor(request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    checks=[]
    def add(name, ok, detail, help_text=''):
        checks.append({"name":name,"ok":bool(ok),"detail":detail,"help":help_text})
    add('Local Core', True, 'CAIRN local service is responding.', 'Restart CAIRN.bat if this ever fails.')
    try:
        rt.db.query('SELECT 1 AS ok'); add('SQLite Index', True, 'SQLite database is readable and WAL-backed.', 'Run setup again if the DB becomes unavailable.')
    except Exception as e: add('SQLite Index', False, str(e), 'Close duplicate CAIRN processes and restart.')
    if rt.vault:
        add('Vault', True, str(rt.vault.root), 'Reconnect the vault from the dashboard if it moves.')
        try:
            probe=rt.vault.root/'.cairn_doctor_write.tmp'; probe.write_text('ok',encoding='utf-8'); probe.unlink(); add('Vault Write', True, 'Temporary write/delete succeeded.', 'Check Windows folder permissions or antivirus locks.')
        except Exception as e: add('Vault Write', False, str(e), 'Check Windows folder permissions, OneDrive locks, or read-only flags.')
    else:
        add('Vault', False, 'No vault selected.', 'Choose your Obsidian vault folder in the CAIRN dashboard.')
        add('Vault Write', False, 'Cannot test without a vault.', 'Connect a vault first.')
    add('Watcher', bool(rt.watcher and rt.watcher._thread and rt.watcher._thread.is_alive()), 'Live filesystem watcher is active.' if rt.watcher else 'Watcher is not active.', 'Reconnect the vault or restart CAIRN.')
    browser_ok = rt.last_browser_seen is not None and time.time()-rt.last_browser_seen < 120
    add('Browser Bridge', browser_ok, 'Browser extension contacted CAIRN recently.' if browser_ok else 'No browser extension request seen in the last 2 minutes.', 'Open the extension popup and press Test Connection.')
    return {"ok":all(c['ok'] for c in checks if c['name'] not in ('Browser Bridge',)),"checks":checks}

@app.post('/api/agent/ask')
async def agent(req: AgentReq, request: Request, x_cairn_token: str|None=Header(None)):
    await auth(x_cairn_token, request)
    def undo_last():
        if not rt.vault:
            raise RuntimeError('No vault is connected.')
        rows=rt.db.query("SELECT operation_id FROM operations WHERE rollback_available=1 AND undone_by IS NULL AND stage='confirmed' ORDER BY requested_at DESC, rowid DESC LIMIT 1")
        if not rows:
            raise RuntimeError('No undoable operation is available.')
        result=rt.vault.undo(rows[0]['operation_id'], source_id='cairn-agent')
        rt.broadcast({"type":"operation",**result})
        return result
    try:
        return ask_agent(req.text, db=rt.db, vault=rt.vault, health_snapshot=health(), undo_last=undo_last)
    except Exception as e:
        return {"type":"error","text":str(e)}

@app.post('/api/events/ticket')
async def events_ticket(request: Request, x_cairn_token: str|None=Header(None)):
    # The browser EventSource API cannot send a custom header, so the long-lived
    # Bridge token is never placed in the /events URL. Callers authenticate normally
    # to mint a short-lived, purpose-only ticket instead.
    await auth(x_cairn_token, request)
    return {"ticket": rt.mint_event_ticket(), "expires_in": 60}

@app.get('/events')
async def events(request: Request, ticket: str):
    if not rt.consume_event_ticket(ticket): raise HTTPException(401,'INVALID_OR_EXPIRED_TICKET')
    q=asyncio.Queue(); rt.clients.add(q)
    async def gen():
        try:
            yield 'event: hello\ndata: {"ok":true}\n\n'
            while True:
                if await request.is_disconnected(): break
                try: evt=await asyncio.wait_for(q.get(),timeout=15); yield f"data: {json.dumps(evt)}\n\n"
                except asyncio.TimeoutError: yield ': ping\n\n'
        finally: rt.clients.discard(q)
    return StreamingResponse(gen(),media_type='text/event-stream')
