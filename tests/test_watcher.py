import tempfile, time, unittest
from pathlib import Path

from cairn.db import Database
from cairn.vault import VaultManager
from cairn.watcher import VaultWatcher


def wait_until(predicate, timeout=5.0, step=0.05):
    """Poll a predicate until it's true or we give up.

    The watcher itself is event-driven (no fixed-interval scanning); this helper is
    only test scaffolding to avoid a flaky fixed sleep while the watcher's own
    200ms debounce runs in a background thread.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.root = root / 'vault'
        self.root.mkdir()
        self.db = Database(root / 'test.db')
        self.v = VaultManager(self.db, self.root)
        self.v.full_index()
        self.events = []
        self.watcher = VaultWatcher(self.v, on_event=self.events.append)
        self.watcher.start()
        # Give the watcher a moment to actually start observing before we touch files.
        time.sleep(0.3)

    def tearDown(self):
        self.watcher.stop()
        self.db.close()
        self.tmp.cleanup()

    def test_external_create_is_indexed_without_manual_reindex(self):
        (self.root / 'External.md').write_text('# External\n\nCreated outside CAIRN.\n', encoding='utf-8')
        ok = wait_until(lambda: self.db.query("SELECT path FROM notes WHERE path='External.md'"))
        self.assertTrue(ok, 'watcher did not index an externally created file in time')

    def test_external_delete_is_removed_from_index(self):
        p = self.root / 'ToDelete.md'
        p.write_text('# ToDelete\n\nBody.\n', encoding='utf-8')
        self.assertTrue(wait_until(lambda: self.db.query("SELECT path FROM notes WHERE path='ToDelete.md'")))
        p.unlink()
        ok = wait_until(lambda: not self.db.query("SELECT path FROM notes WHERE path='ToDelete.md'"))
        self.assertTrue(ok, 'watcher did not remove a deleted file from the index in time')

    def test_external_rename_updates_index(self):
        old = self.root / 'Old Name.md'
        old.write_text('# Old Name\n\nBody.\n', encoding='utf-8')
        self.assertTrue(wait_until(lambda: self.db.query("SELECT path FROM notes WHERE path='Old Name.md'")))
        old.rename(self.root / 'New Name.md')
        ok_new = wait_until(lambda: self.db.query("SELECT path FROM notes WHERE path='New Name.md'"))
        ok_old_gone = wait_until(lambda: not self.db.query("SELECT path FROM notes WHERE path='Old Name.md'"))
        self.assertTrue(ok_new, 'watcher did not index the renamed file under its new path')
        self.assertTrue(ok_old_gone, 'watcher left the old path indexed after a rename')

    def test_deleting_a_folder_removes_notes_inside_it_from_the_index(self):
        # Regression test: deleting a folder used to leave notes that were inside it
        # as phantom rows in `notes`/`notes_fts`, since only the folders table was
        # cleared. See db.Database.remove_folder.
        folder = self.root / 'Project'
        folder.mkdir()
        (folder / 'A.md').write_text('# A\n\nBody A.\n', encoding='utf-8')
        (folder / 'B.md').write_text('# B\n\nBody B.\n', encoding='utf-8')
        self.assertTrue(wait_until(lambda: len(self.db.query(
            "SELECT path FROM notes WHERE path LIKE 'Project/%'")) == 2))

        import shutil
        shutil.rmtree(folder)

        ok = wait_until(lambda: not self.db.query("SELECT path FROM notes WHERE path LIKE 'Project/%'"))
        self.assertTrue(ok, 'notes that lived inside a deleted folder were still indexed')
        # And the FTS shadow table must not keep phantom rows either.
        remaining_fts = self.db.query("SELECT path FROM notes_fts WHERE path LIKE 'Project/%'")
        self.assertEqual(remaining_fts, [])


    def test_atomic_write_temp_files_do_not_surface_as_events(self):
        # A real save goes through VaultManager, which uses the same mkstemp
        # ".{name}.cairn-..." naming the watcher is taught to ignore.
        self.v.create('Note.md', 'Note', 'Body')
        self.assertTrue(wait_until(lambda: self.db.query("SELECT path FROM notes WHERE path='Note.md'")))
        # Give the watcher a moment to also report anything it saw for this save.
        time.sleep(0.5)
        noisy = [e for e in self.events if '.cairn-' in e.get('path', '')]
        self.assertEqual(noisy, [], f"watcher surfaced its own temp files as events: {noisy}")


if __name__ == '__main__':
    unittest.main()
