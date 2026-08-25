from __future__ import annotations
import os, tempfile, time, uuid
from pathlib import Path
from .db import Database
from .markdown_engine import (
    hash_bytes, heading_dicts, append_under_heading, create_note,
    append_dated_update, append_under_heading_dated, replace_heading_body,
    HeadingNotFound, AmbiguousHeading,
)
from .security import safe_resolve, SecurityError

class VaultError(Exception): pass
class VersionConflict(VaultError): pass

class VaultManager:
    def __init__(self, db: Database, root: Path):
        self.db = db
        self.root = root.resolve()

    def rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    def index_file(self, path: Path):
        if not path.exists() or path.suffix.lower() != '.md':
            return
        data = path.read_bytes()
        text = data.decode('utf-8')
        hs = heading_dicts(text)
        title = hs[0]['title'] if hs else path.stem
        st = path.stat()
        self.db.upsert_note(self.rel(path), title, hash_bytes(data), st.st_mtime_ns, st.st_size, text, hs)

    def full_index(self):
        self.db.execute("DELETE FROM folders")
        self.db.execute("DELETE FROM headings")
        self.db.execute("DELETE FROM notes")
        self.db.execute("DELETE FROM notes_fts")
        for d, dirs, files in os.walk(self.root):
            rel_d = Path(d).resolve().relative_to(self.root).as_posix()
            self.db.add_folder("" if rel_d == "." else rel_d)
            for fn in files:
                p = Path(d) / fn
                if p.suffix.lower() == '.md':
                    try: self.index_file(p)
                    except UnicodeDecodeError: pass

    def read(self, relpath: str) -> tuple[bytes,str]:
        p = safe_resolve(self.root, relpath)
        data = p.read_bytes()
        return data, hash_bytes(data)

    def _atomic_write(self, target: Path, data: bytes):
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.cairn-", dir=str(target.parent))
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data); f.flush(); os.fsync(f.fileno())
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                try: os.unlink(tmp)
                except OSError: pass
        # Best-effort: fsync the directory entry too, so the rename survives a crash
        # right after replace(), not just the file content written before it. Not all
        # platforms support this (notably Windows), so failures here are non-fatal.
        if os.name != 'nt':
            try:
                dir_fd = os.open(str(target.parent), os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError:
                pass

    def _commit(self, action: str, relpath: str, new_data: bytes, *, expected_hash: str | None, source_id: str,
                target_heading: str | None = None, operation_id: str | None = None):
        p = safe_resolve(self.root, relpath)
        before = p.read_bytes() if p.exists() else b''
        before_hash = hash_bytes(before)
        if expected_hash is not None and before_hash != expected_hash:
            op = self.db.record_operation(operation_id=operation_id, action=action, target_note=relpath,
                target_heading=target_heading, source_id=source_id, stage='hash-check-failed',
                before_hash=before_hash, error_class='VERSION_CONFLICT', retryable=True)
            raise VersionConflict(op)
        self._atomic_write(p, new_data)
        after = p.read_bytes()
        after_hash = hash_bytes(after)
        op = self.db.record_operation(operation_id=operation_id, action=action, target_note=relpath,
            target_heading=target_heading, source_id=source_id, stage='confirmed', before_hash=before_hash,
            after_hash=after_hash, rollback_available=True, before_content=before, after_content=after)
        self.index_file(p)
        return {"operation_id":op,"before_hash":before_hash,"after_hash":after_hash,"path":relpath}

    def create(self, relpath: str, title: str, body: str, source_id='desktop', operation_id=None):
        p = safe_resolve(self.root, relpath)
        if p.exists(): raise VaultError('NOTE_EXISTS')
        data = create_note(title, body).encode('utf-8')
        return self._commit('create', relpath, data, expected_hash=hash_bytes(b''), source_id=source_id, operation_id=operation_id)

    def create_folder(self, relpath: str):
        p = safe_resolve(self.root, relpath)
        p.mkdir(parents=True, exist_ok=True)
        self.db.add_folder(self.rel(p))
        return {"path": self.rel(p)}

    def append(self, relpath: str, content: str, expected_hash: str | None = None, source_id='browser', operation_id=None):
        before, cur_hash = self.read(relpath)
        text = before.decode('utf-8')
        nl = '\r\n' if '\r\n' in text else '\n'
        prefix = '' if not text or text.endswith(nl+nl) else (nl if text.endswith(nl) else nl+nl)
        new = (text + prefix + content.strip('\r\n') + nl).encode('utf-8')
        return self._commit('append', relpath, new, expected_hash=expected_hash or cur_hash, source_id=source_id, operation_id=operation_id)

    def append_update(self, relpath: str, content: str, title: str | None = None, expected_hash: str | None = None,
                      source_id='browser', operation_id=None):
        before, cur_hash = self.read(relpath)
        text = before.decode('utf-8')
        new_text = append_dated_update(text, content, title=title)
        return self._commit('append_update', relpath, new_text.encode('utf-8'), expected_hash=expected_hash or cur_hash,
                            source_id=source_id, operation_id=operation_id)

    def append_heading(self, relpath: str, content: str, heading: str | None = None, heading_path: list[str] | None = None,
                       expected_hash: str | None = None, source_id='browser', operation_id=None):
        before, cur_hash = self.read(relpath)
        text = before.decode('utf-8')
        new_text = append_under_heading(text, content, heading=heading, heading_path=heading_path)
        return self._commit('append_under_heading', relpath, new_text.encode('utf-8'), expected_hash=expected_hash or cur_hash,
                            source_id=source_id, target_heading=' > '.join(heading_path or [heading or '']), operation_id=operation_id)

    def append_heading_update(self, relpath: str, content: str, heading: str | None = None, heading_path: list[str] | None = None,
                              title: str | None = None, expected_hash: str | None = None, source_id='browser', operation_id=None):
        before, cur_hash = self.read(relpath)
        text = before.decode('utf-8')
        new_text = append_under_heading_dated(text, content, heading=heading, heading_path=heading_path, title=title)
        return self._commit('append_under_heading_update', relpath, new_text.encode('utf-8'),
                            expected_hash=expected_hash or cur_hash, source_id=source_id,
                            target_heading=' > '.join(heading_path or [heading or '']), operation_id=operation_id)

    def patch_heading(self, relpath: str, content: str, heading: str | None = None, heading_path: list[str] | None = None,
                      expected_hash: str | None = None, source_id='browser', operation_id=None):
        before, cur_hash = self.read(relpath)
        text = before.decode('utf-8')
        new_text = replace_heading_body(text, content, heading=heading, heading_path=heading_path)
        return self._commit('patch_heading_body', relpath, new_text.encode('utf-8'), expected_hash=expected_hash or cur_hash,
                            source_id=source_id, target_heading=' > '.join(heading_path or [heading or '']), operation_id=operation_id)

    def delete(self, relpath: str, expected_hash: str | None = None, source_id='desktop', operation_id=None):
        p = safe_resolve(self.root, relpath)
        if not p.exists(): raise VaultError('NOTE_NOT_FOUND')
        before = p.read_bytes()
        before_hash = hash_bytes(before)
        if expected_hash is not None and expected_hash != before_hash:
            op = self.db.record_operation(operation_id=operation_id, action='delete', target_note=relpath,
                target_heading=None, source_id=source_id, stage='hash-check-failed', before_hash=before_hash,
                error_class='VERSION_CONFLICT', retryable=True)
            raise VersionConflict(op)
        p.unlink()
        after_hash = hash_bytes(b'')
        op = self.db.record_operation(operation_id=operation_id, action='delete', target_note=relpath,
            target_heading=None, source_id=source_id, stage='confirmed', before_hash=before_hash, after_hash=after_hash,
            rollback_available=True, before_content=before, after_content=b'')
        self.db.delete_note(relpath)
        return {"operation_id": op, "before_hash": before_hash, "after_hash": after_hash, "path": relpath}

    def save_inbox(self, content: str, source_id='browser', title: str | None = None, operation_id=None):
        """Create one Markdown note per Inbox capture.

        Inbox is a folder, never a single append-only Inbox.md. Repeated captures with
        the same title receive a numeric suffix so no prior capture is overwritten.
        """
        import re
        raw_title = (title or '').strip()
        if not raw_title or raw_title.lower() in {'capture', 'web capture', 'selection'}:
            raw_title = semantic_title(content, fallback='Capture')
        safe_title = re.sub(r'[<>:"/\\|?*\x00-\x1F]', ' ', raw_title)
        safe_title = re.sub(r'\s+', ' ', safe_title).strip(' .')[:96] or 'Capture'
        folder = 'CAIRN/Inbox'
        candidate = f"{folder}/{safe_title}.md"
        n = 2
        while safe_resolve(self.root, candidate).exists():
            candidate = f"{folder}/{safe_title} ({n}).md"
            n += 1
        body = content.strip()
        data = create_note(safe_title, body).encode('utf-8')
        return self._commit('inbox_create', candidate, data, expected_hash=hash_bytes(b''), source_id=source_id, operation_id=operation_id)

    def undo(self, op_id: str, source_id='desktop'):
        op = self.db.operation(op_id)
        if not op or not op['rollback_available'] or op['undone_by']:
            raise VaultError('UNDO_NOT_AVAILABLE')
        rel = op['target_note']
        p = safe_resolve(self.root, rel)
        current = p.read_bytes() if p.exists() else b''
        current_hash = hash_bytes(current)
        if current_hash != op['after_hash']:
            raise VersionConflict('UNDO_CONFLICT')
        before = op['before_content'] or b''
        if op['action'] in ('create','inbox_create') and before == b'':
            if p.exists(): p.unlink()
            after_hash = hash_bytes(b'')
            self.db.delete_note(rel)
        else:
            self._atomic_write(p, before)
            after_hash = hash_bytes(before)
            self.index_file(p)
        undo_id = self.db.record_operation(action='undo', target_note=rel, target_heading=None, source_id=source_id,
            stage='confirmed', before_hash=current_hash, after_hash=after_hash, rollback_available=False,
            before_content=current, after_content=before)
        self.db.execute("UPDATE operations SET undone_by=? WHERE operation_id=?", (undo_id, op_id))
        return {"operation_id":undo_id,"undone":op_id,"path":rel,"after_hash":after_hash}
