from __future__ import annotations
import json, os, secrets
from dataclasses import dataclass, asdict
from pathlib import Path

APP_NAME = "CAIRN"


def config_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home()))
        return base / APP_NAME
    return Path.home() / ".cairn"


def data_dir() -> Path:
    p = config_dir()
    p.mkdir(parents=True, exist_ok=True)
    return p


@dataclass
class Config:
    vault_path: str | None = None
    token: str = ""
    host: str = "127.0.0.1"
    port: int = 7821

    @classmethod
    def load(cls) -> "Config":
        path = data_dir() / "config.json"
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                cfg = cls(**raw)
            except Exception:
                cfg = cls()
        else:
            cfg = cls()
        if not cfg.token:
            cfg.token = secrets.token_urlsafe(32)
            cfg.save()
        return cfg

    def save(self) -> None:
        path = data_dir() / "config.json"
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        if os.name != "nt":
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
