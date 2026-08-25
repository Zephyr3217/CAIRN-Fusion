from __future__ import annotations
import json, sqlite3, threading, time, uuid
from pathlib import Path
from typing import Any
from .config import data_dir

SCHEMA = r'''
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  title TEXT,
  content_hash TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  last_indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS headings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  heading_path TEXT NOT NULL,
  title TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path, title, body);
CREATE TABLE IF NOT EXISTS folders (
  path TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_note TEXT,
  target_heading TEXT,
  source_id TEXT,
  stage TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  error_class TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  rollback_available INTEGER NOT NULL DEFAULT 0,
  before_content BLOB,
  after_content BLOB,
  undone_by TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  read_scopes TEXT NOT NULL,
  write_scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS manifests (
  handle TEXT PRIMARY KEY,
  paths TEXT NOT NULL,
  default_write_target TEXT,
  created_at INTEGER NOT NULL
);
'''

class Database:
    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / "cairn.db")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            # Existing CAIRN databases predate note metrics. Add the columns in-place
            # instead of forcing users to rebuild or delete their index.
            columns = {row[1] for row in self._conn.execute("PRAGMA table_info(notes)").fetchall()}
            if "char_count" not in columns:
                self._conn.execute("ALTER TABLE notes ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0")
            if "word_count" not in columns:
                self._conn.execute("ALTER TABLE notes ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0")
            self._conn.commit()

    def close(self):
        """Close the SQLite connection so Windows can release DB/WAL/SHM files."""
        with self._lock:
            conn = getattr(self, "_conn", None)
            if conn is not None:
                try:
                    conn.commit()
                finally:
                    conn.close()
                    self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()

    def execute(self, sql: str, params: tuple = ()):
        with self._lock:
            if self._conn is None:
                raise RuntimeError("DATABASE_CLOSED")
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def query(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        with self._lock:
            if self._conn is None:
                raise RuntimeError("DATABASE_CLOSED")
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def upsert_note(self, path: str, title: str, content_hash: str, mtime_ns: int, size: int, body: str, headings: list[dict]):
        now = int(time.time())
        with self._lock:
            chars = len(body)
            words = len(body.split())
            self._conn.execute(
                "INSERT INTO notes(path,title,content_hash,mtime_ns,size_bytes,char_count,word_count,last_indexed_at) VALUES(?,?,?,?,?,?,?,?) "
                "ON CONFLICT(path) DO UPDATE SET title=excluded.title,content_hash=excluded.content_hash,mtime_ns=excluded.mtime_ns,size_bytes=excluded.size_bytes,char_count=excluded.char_count,word_count=excluded.word_count,last_indexed_at=excluded.last_indexed_at",
                (path, title, content_hash, mtime_ns, size, chars, words, now),
            )
            self._conn.execute("DELETE FROM headings WHERE note_path=?", (path,))
            for h in headings:
                self._conn.execute(
                    "INSERT INTO headings(note_path,level,heading_path,title,start_line,end_line) VALUES(?,?,?,?,?,?)",
                    (path, h["level"], json.dumps(h["path"]), h["title"], h["start_line"], h["end_line"]),
                )
            self._conn.execute("DELETE FROM notes_fts WHERE path=?", (path,))
            self._conn.execute("INSERT INTO notes_fts(path,title,body) VALUES(?,?,?)", (path, title, body))
            self._conn.commit()

    def delete_note(self, path: str):
        with self._lock:
            self._conn.execute("DELETE FROM notes WHERE path=?", (path,))
            self._conn.execute("DELETE FROM notes_fts WHERE path=?", (path,))
            self._conn.commit()

    def add_folder(self, path: str):
        self.execute("INSERT INTO folders(path,last_seen_at) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET last_seen_at=excluded.last_seen_at", (path, int(time.time())))

    def remove_folder(self, path: str):
        """Remove a folder and any notes indexed under it.

        A deleted folder takes its contents with it on disk; if we only removed the
        folders row, notes that used to live under that prefix would keep appearing
        in search/Brain/note pickers as phantom entries pointing at files that no
        longer exist, until the next full re-index papered over it.
        """
        prefix = path.rstrip('/') + '/%'
        with self._lock:
            self._conn.execute("DELETE FROM notes_fts WHERE path=? OR path LIKE ?", (path, prefix))
            self._conn.execute("DELETE FROM notes WHERE path=? OR path LIKE ?", (path, prefix))
            self._conn.execute("DELETE FROM folders WHERE path=? OR path LIKE ?", (path, prefix))
            self._conn.commit()

    def record_operation(self, *, operation_id: str | None = None, action: str, target_note: str | None, target_heading: str | None,
                         source_id: str | None, stage: str, before_hash: str | None = None, after_hash: str | None = None,
                         error_class: str | None = None, retryable: bool = False, rollback_available: bool = False,
                         before_content: bytes | None = None, after_content: bytes | None = None) -> str:
        op = operation_id or f"op_{uuid.uuid4().hex}"
        self.execute(
            "INSERT OR REPLACE INTO operations(operation_id,requested_at,action,target_note,target_heading,source_id,stage,before_hash,after_hash,error_class,retryable,rollback_available,before_content,after_content) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (op, int(time.time()), action, target_note, target_heading, source_id, stage, before_hash, after_hash, error_class, int(retryable), int(rollback_available), before_content, after_content),
        )
        return op

    def operation(self, op_id: str) -> dict | None:
        rows = self.query("SELECT * FROM operations WHERE operation_id=?", (op_id,))
        return rows[0] if rows else None

    def recent_operations(self, limit: int = 50) -> list[dict]:
        rows = self.query("SELECT operation_id,requested_at,action,target_note,target_heading,source_id,stage,before_hash,after_hash,error_class,retryable,rollback_available,undone_by FROM operations ORDER BY requested_at DESC, rowid DESC LIMIT ?", (limit,))
        return rows

    def list_manifests(self) -> list[dict]:
        rows = self.query("SELECT handle,paths,default_write_target,created_at FROM manifests ORDER BY handle")
        for row in rows:
            try:
                row["paths"] = json.loads(row["paths"])
            except Exception:
                row["paths"] = []
        return rows

    def upsert_manifest(self, handle: str, paths: list[str], default_write_target: str | None = None):
        handle = handle.strip()
        if not handle:
            raise ValueError("MANIFEST_HANDLE_REQUIRED")
        if not handle.startswith("@"):
            handle = "@" + handle
        self.execute(
            "INSERT INTO manifests(handle,paths,default_write_target,created_at) VALUES(?,?,?,?) "
            "ON CONFLICT(handle) DO UPDATE SET paths=excluded.paths,default_write_target=excluded.default_write_target",
            (handle, json.dumps(paths), default_write_target, int(time.time())),
        )
        return {"handle": handle, "paths": paths, "default_write_target": default_write_target}

    def delete_manifest(self, handle: str):
        self.execute("DELETE FROM manifests WHERE handle=?", (handle,))

    def resolve_note_refs(self, refs: list[str]) -> dict:
        """Resolve explicit [Note.md] references by exact relative path or unique basename."""
        notes = self.query("SELECT path,title,content_hash FROM notes ORDER BY path")
        resolved, missing, ambiguous = [], [], []
        for raw in refs:
            ref = raw.replace('\\','/').strip()
            exact = [n for n in notes if n['path'].casefold() == ref.casefold()]
            if len(exact) == 1:
                resolved.append(exact[0]); continue
            base = Path(ref).name.casefold()
            matches = [n for n in notes if Path(n['path']).name.casefold() == base]
            if len(matches) == 1:
                resolved.append(matches[0])
            elif len(matches) > 1:
                ambiguous.append({"ref": raw, "matches": [m['path'] for m in matches]})
            else:
                missing.append(raw)
        return {"resolved": resolved, "missing": missing, "ambiguous": ambiguous}
