import tempfile
import unittest
from pathlib import Path

from cairn.db import Database
from cairn.vault import VaultManager


class RebuildTests(unittest.TestCase):
    """The SQLite index must be a disposable, rebuildable view over the Markdown
    vault, never the other way around: if it's deleted or corrupted, a fresh
    full_index() against the same files must reconstruct the same picture, and
    running it repeatedly must be idempotent rather than accumulating duplicates.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'vault'
        self.root.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_index_is_idempotent(self):
        db = Database(Path(self.tmp.name) / 'test.db')
        v = VaultManager(db, self.root)
        v.create('A.md', 'A', 'Alpha')
        v.create('Thesis/B.md', 'B', 'Beta')
        v.full_index()
        v.full_index()
        v.full_index()
        rows = db.query("SELECT path FROM notes ORDER BY path")
        self.assertEqual([r['path'] for r in rows], ['A.md', 'Thesis/B.md'])
        fts_rows = db.query("SELECT path FROM notes_fts ORDER BY path")
        self.assertEqual([r['path'] for r in fts_rows], ['A.md', 'Thesis/B.md'])
        db.close()

    def test_index_survives_being_deleted_and_rebuilt_from_markdown(self):
        db_path = Path(self.tmp.name) / 'test.db'
        db = Database(db_path)
        v = VaultManager(db, self.root)
        v.create('Notes/Chapter 1.md', 'Chapter 1', 'First chapter body.')
        v.full_index()
        self.assertEqual(len(db.query("SELECT path FROM notes")), 1)
        db.close()

        # Simulate the index being lost entirely: delete the DB file (and its
        # WAL/SHM siblings) while the Markdown vault itself is untouched.
        for suffix in ('', '-wal', '-shm'):
            p = Path(str(db_path) + suffix)
            if p.exists():
                p.unlink()
        self.assertFalse(db_path.exists())
        self.assertTrue((self.root / 'Notes' / 'Chapter 1.md').exists())

        db2 = Database(db_path)
        v2 = VaultManager(db2, self.root)
        v2.full_index()
        rows = db2.query("SELECT path,title FROM notes")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['path'], 'Notes/Chapter 1.md')
        self.assertEqual(rows[0]['title'], 'Chapter 1')
        db2.close()

    def test_search_reflects_rebuilt_index(self):
        db = Database(Path(self.tmp.name) / 'test.db')
        v = VaultManager(db, self.root)
        v.create('SVM.md', 'SVM', 'Support vector machine notes for the thesis.')
        v.full_index()
        rows = db.query(
            "SELECT path FROM notes_fts WHERE notes_fts MATCH ?", ('vector',)
        )
        self.assertEqual([r['path'] for r in rows], ['SVM.md'])
        db.close()


if __name__ == '__main__':
    unittest.main()
