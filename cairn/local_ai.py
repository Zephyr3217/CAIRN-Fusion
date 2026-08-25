from __future__ import annotations
import json
from urllib.request import Request, urlopen
from urllib.error import URLError

OLLAMA_URL = "http://127.0.0.1:11434"


def ollama_models(timeout: float = 0.6) -> list[str]:
    try:
        with urlopen(f"{OLLAMA_URL}/api/tags", timeout=timeout) as r:
            raw = json.loads(r.read().decode("utf-8"))
        return [m.get("name", "") for m in raw.get("models", []) if m.get("name")]
    except Exception:
        return []


def choose_model(models: list[str]) -> str | None:
    if not models:
        return None
    preferred = ("qwen", "gemma", "llama", "mistral", "phi")
    for key in preferred:
        for model in models:
            if key in model.casefold():
                return model
    return models[0]


def ollama_generate(prompt: str, model: str | None = None, timeout: float = 25.0) -> tuple[str | None, str | None]:
    models = ollama_models()
    chosen = model or choose_model(models)
    if not chosen:
        return None, None
    payload = json.dumps({
        "model": chosen,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2},
    }).encode("utf-8")
    req = Request(f"{OLLAMA_URL}/api/generate", data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=timeout) as r:
            raw = json.loads(r.read().decode("utf-8"))
        text = (raw.get("response") or "").strip()
        return (text or None), chosen
    except Exception:
        return None, chosen
