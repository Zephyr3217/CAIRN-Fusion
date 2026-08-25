from __future__ import annotations
import os, threading, time
from pathlib import Path
from watchfiles import watch, Change
from .vault import VaultManager

class VaultWatcher:
    def __init__(self, vault: VaultManager, on_event=None):
        self.vault = vault
        self.on_event = on_event or (lambda event: None)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self):
        if self._thread and self._thread.is_alive(): return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name='cairn-watcher', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None

    def _catch_up_subtree(self, dir_path: Path):
        """Index anything already sitting inside a newly seen directory.

        A recursive filesystem watch has an inherent short race: the watch on a
        brand-new subdirectory isn't guaranteed to be registered before files
        written into it in the same instant (e.g. a folder pasted in from a file
        manager, or mkdir()+write() happening back-to-back). Rather than fall back
        to periodically rescanning the whole vault, we do a one-time, bounded walk
        of just this subtree the moment we learn it exists, so a same-instant
        create still gets picked up without waiting for the next full re-index.
        """
        try:
            for d, dirs, files in os.walk(dir_path):
                dd = Path(d)
                try:
                    rel_d = dd.resolve().relative_to(self.vault.root).as_posix()
                except Exception:
                    continue
                self.vault.db.add_folder("" if rel_d == "." else rel_d)
                for fn in files:
                    fp = dd / fn
                    if fp.suffix.lower() == '.md':
                        try:
                            self.vault.index_file(fp)
                        except (OSError, UnicodeDecodeError):
                            pass
        except OSError:
            pass

    def _run(self):
        try:
            for changes in watch(self.vault.root, stop_event=self._stop, debounce=200, step=50, recursive=True):
                for change, raw in changes:
                    p = Path(raw)
                    # CAIRN's own atomic-write temp files (see vault.py's mkstemp prefix
                    # ".{name}.cairn-...") flash in and out of existence around every
                    # single save. They're never indexable content, so surfacing them
                    # as vault_change events just makes every save broadcast three
                    # events (temp created, temp deleted, real change) instead of one,
                    # tripling the work anything subscribed to /events does per save.
                    if '.cairn-' in p.name:
                        continue
                    try:
                        rel = p.resolve().relative_to(self.vault.root).as_posix()
                    except Exception:
                        continue
                    kind = {Change.added:'created', Change.modified:'modified', Change.deleted:'deleted'}.get(change, 'changed')
                    try:
                        if change == Change.deleted:
                            if p.suffix.lower() == '.md': self.vault.db.delete_note(rel)
                            else: self.vault.db.remove_folder(rel)
                        elif p.exists() and p.is_dir():
                            self.vault.db.add_folder(rel)
                            self._catch_up_subtree(p)
                        elif p.suffix.lower() == '.md':
                            self.vault.index_file(p)
                        self.on_event({"type":"vault_change","kind":kind,"path":rel,"ts":time.time()})
                    except Exception as e:
                        self.on_event({"type":"watcher_error","path":rel,"error":str(e),"ts":time.time()})
        except Exception as e:
            self.on_event({"type":"watcher_error","error":str(e),"ts":time.time()})
