from __future__ import annotations
import threading, time, webbrowser
import uvicorn
from .config import Config

def main():
    cfg = Config.load()
    url = f"http://{cfg.host}:{cfg.port}/"
    def open_ui():
        time.sleep(1.0)
        try: webbrowser.open(url)
        except Exception: pass
    threading.Thread(target=open_ui, daemon=True).start()
    print(f"CAIRN MSP starting at {url}")
    print(f"Browser token: {cfg.token}")
    uvicorn.run('cairn.server:app', host=cfg.host, port=cfg.port, log_level='info')

if __name__ == '__main__': main()
