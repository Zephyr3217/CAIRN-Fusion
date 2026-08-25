import sqlite3
import tempfile
import unittest
from pathlib import Path

from cairn.db import Database
from cairn.vault import VaultManager


class NoteMetricsTests(unittest.TestCase):
    def test_index_exposes_exact_char_and_word_counts(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            vault_dir = root / 'vault'
            vault_dir.mkdir()
            text = '# Test\n\nhello world\nsecond line'
            (vault_dir / 'Metrics.md').write_text(text, encoding='utf-8')
            db = Database(root / 'cairn.db')
            try:
                vault = VaultManager(db, vault_dir)
                vault.full_index()
                row = db.query('SELECT char_count,word_count FROM notes WHERE path=?', ('Metrics.md',))[0]
                self.assertEqual(row['char_count'], len(text))
                self.assertEqual(row['word_count'], len(text.split()))
            finally:
                db.close()

    def test_existing_notes_table_is_migrated_in_place(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / 'legacy.db'
            conn = sqlite3.connect(db_path)
            conn.execute('CREATE TABLE notes(path TEXT PRIMARY KEY,title TEXT,content_hash TEXT NOT NULL,mtime_ns INTEGER NOT NULL,size_bytes INTEGER NOT NULL,last_indexed_at INTEGER NOT NULL)')
            conn.commit(); conn.close()
            db = Database(db_path)
            try:
                columns = {row['name'] for row in db.query('PRAGMA table_info(notes)')}
                self.assertIn('char_count', columns)
                self.assertIn('word_count', columns)
            finally:
                db.close()


if __name__ == '__main__':
    unittest.main()
