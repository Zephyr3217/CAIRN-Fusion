from __future__ import annotations
from pathlib import Path
from fnmatch import fnmatch
from .db import Database

class SecurityError(Exception): pass


def safe_resolve(root: Path, rel: str) -> Path:
    root = root.resolve()
    candidate = (root / rel).resolve()
    if not candidate.is_relative_to(root):
        raise SecurityError("PATH_OUTSIDE_VAULT")
    return candidate

class CapabilityManager:
    def __init__(self, db: Database):
        self.db = db

    def ensure_default(self):
        if not self.db.query("SELECT grant_id FROM grants WHERE grant_id='browser-default'"):
            import json, time
            self.db.execute(
                "INSERT INTO grants(grant_id,client_id,read_scopes,write_scopes,created_at) VALUES(?,?,?,?,?)",
                ("browser-default", "browser-extension", json.dumps(["**"]), json.dumps(["**"]), int(time.time()))
            )

    def allowed(self, client_id: str, action: str, relpath: str) -> bool:
        import json
        rows = self.db.query("SELECT * FROM grants WHERE client_id=? AND revoked_at IS NULL", (client_id,))
        key = "read_scopes" if action == "read" else "write_scopes"
        norm = relpath.replace('\\','/')
        for row in rows:
            for scope in json.loads(row[key]):
                if scope == "**" or fnmatch(norm, scope):
                    return True
        return False
