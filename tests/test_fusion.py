import tempfile, unittest
from pathlib import Path
from datetime import datetime

from cairn.db import Database
from cairn.vault import VaultManager, VersionConflict
from cairn.markdown_engine import append_dated_update, append_under_heading_dated, replace_heading_body, suggest_headings, headings

class FusionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name); self.root=root/'vault'; self.root.mkdir(); self.db=Database(root/'test.db'); self.v=VaultManager(self.db,self.root)
    def tearDown(self):
        self.db.close(); self.tmp.cleanup()

    def test_dated_append_keeps_existing_content(self):
        src='# Note\n\nOriginal.\n'
        out=append_dated_update(src,'New material','New Material',datetime(2026,8,24,12,0))
        self.assertTrue(out.startswith(src.rstrip('\n')))
        self.assertIn('## New Material — 2026-08-24',out)
        self.assertIn('New material',out)

    def test_dated_nested_heading_uses_child_level(self):
        src='# Thesis\n\n## Methodology\nOld.\n\n## Results\nR.\n'
        out=append_under_heading_dated(src,'SVM details',heading='Methodology',title='SVM',now=datetime(2026,8,24,12,0))
        self.assertIn('### SVM — 2026-08-24',out)
        self.assertEqual('## Results'+src.split('## Results',1)[1],'## Results'+out.split('## Results',1)[1])

    def test_patch_heading_body_is_surgical(self):
        src='# Thesis\n\n## Introduction\nA\n\n## Methodology\nOld\n\n### Subsection\nOld sub\n\n## Conclusion\nC\n'
        out=replace_heading_body(src,'Replacement body',heading='Methodology')
        self.assertIn('## Introduction\nA',out)
        self.assertIn('## Methodology\n\nReplacement body',out)
        self.assertNotIn('Old sub',out)
        self.assertEqual('## Conclusion'+src.split('## Conclusion',1)[1],'## Conclusion'+out.split('## Conclusion',1)[1])

    def test_suggestions_return_two_or_three(self):
        s=suggest_headings('Support Vector Machine classification for flood susceptibility.\nDrainage assessment notes.')
        self.assertGreaterEqual(len(s),2); self.assertLessEqual(len(s),3)

    def test_explicit_reference_resolution_unique_and_ambiguous(self):
        self.v.create('Thesis/Chapter 1.md','Chapter 1','A')
        self.v.create('Archive/Chapter 1.md','Old Chapter 1','B')
        self.v.create('Chapter 2.md','Chapter 2','C')
        self.v.full_index()
        r=self.db.resolve_note_refs(['Chapter 2.md','Chapter 1.md','Missing.md'])
        self.assertEqual([x['path'] for x in r['resolved']],['Chapter 2.md'])
        self.assertEqual(r['missing'],['Missing.md'])
        self.assertEqual(r['ambiguous'][0]['ref'],'Chapter 1.md')
        r2=self.db.resolve_note_refs(['Thesis/Chapter 1.md'])
        self.assertEqual(r2['resolved'][0]['path'],'Thesis/Chapter 1.md')

    def test_context_space_persists(self):
        m=self.db.upsert_manifest('Thesis',['A.md','B.md'],'B.md')
        self.assertEqual(m['handle'],'@Thesis')
        rows=self.db.list_manifests()
        self.assertEqual(rows[0]['paths'],['A.md','B.md'])
        self.assertEqual(rows[0]['default_write_target'],'B.md')

    def test_delete_can_be_undone(self):
        self.v.create('DeleteMe.md','Delete Me','Body')
        _,h=self.v.read('DeleteMe.md')
        d=self.v.delete('DeleteMe.md',expected_hash=h)
        self.assertFalse((self.root/'DeleteMe.md').exists())
        self.v.undo(d['operation_id'])
        self.assertTrue((self.root/'DeleteMe.md').exists())
        self.assertIn('Body',(self.root/'DeleteMe.md').read_text())

    def test_undo_last_picks_the_truly_most_recent_op_even_within_the_same_second(self):
        # Regression test: operations.requested_at has 1-second resolution
        # (int(time.time())), so two operations landing in the same wall-clock
        # second used to be ordered ambiguously by ORDER BY requested_at DESC
        # alone, which could make "undo last" target the wrong operation.
        # Reproduced live against a running server before this was fixed.
        self.v.create('P.md', 'P', '## Section\nOld body')
        _, h = self.v.read('P.md')
        patched = self.v.patch_heading('P.md', 'New body', heading='Section', expected_hash=h)
        rows = self.db.query(
            "SELECT operation_id FROM operations WHERE rollback_available=1 AND undone_by IS NULL "
            "AND stage='confirmed' ORDER BY requested_at DESC, rowid DESC LIMIT 1"
        )
        self.assertEqual(rows[0]['operation_id'], patched['operation_id'])
        self.v.undo(rows[0]['operation_id'])
        self.assertIn('Old body', (self.root / 'P.md').read_text())

if __name__=='__main__': unittest.main()
