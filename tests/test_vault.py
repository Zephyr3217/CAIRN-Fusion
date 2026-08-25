import tempfile, unittest
from pathlib import Path
from cairn.db import Database
from cairn.vault import VaultManager, VersionConflict
from cairn.markdown_engine import hash_bytes
from cairn.security import safe_resolve, SecurityError

class VaultTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name); self.root=root/'vault';self.root.mkdir();self.db=Database(root/'test.db');self.v=VaultManager(self.db,self.root)
    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()
    def test_create_append_undo(self):
        r=self.v.create('Test.md','Test','Hello')
        self.v.append('Test.md','World')
        ops=self.db.recent_operations();append_op=next(o for o in ops if o['action']=='append')
        self.v.undo(append_op['operation_id'])
        self.assertNotIn('World',(self.root/'Test.md').read_text())
    def test_version_conflict(self):
        self.v.create('T.md','T','A');data,h=self.v.read('T.md');(self.root/'T.md').write_text('# T\n\nExternal\n',encoding='utf-8')
        with self.assertRaises(VersionConflict): self.v.append('T.md','B',expected_hash=h)
        self.assertIn('External',(self.root/'T.md').read_text())
    def test_traversal(self):
        with self.assertRaises(SecurityError): safe_resolve(self.root,'../escape.md')
    def test_inbox(self):
        r1=self.v.save_inbox('Captured text',source_id='test',title='Demo')
        r2=self.v.save_inbox('Second capture',source_id='test',title='Demo')
        r3=self.v.save_inbox('Third capture',source_id='test',title='Demo')
        self.assertEqual(r1['path'],'CAIRN/Inbox/Demo.md')
        self.assertEqual(r2['path'],'CAIRN/Inbox/Demo (2).md')
        self.assertEqual(r3['path'],'CAIRN/Inbox/Demo (3).md')
        self.assertFalse((self.root/'CAIRN'/'Inbox.md').exists())
        txt=(self.root/'CAIRN'/'Inbox'/'Demo.md').read_text();self.assertIn('Captured text',txt);self.assertIn('# Demo',txt)
        txt2=(self.root/'CAIRN'/'Inbox'/'Demo (2).md').read_text();self.assertIn('Second capture',txt2)
        txt3=(self.root/'CAIRN'/'Inbox'/'Demo (3).md').read_text();self.assertIn('Third capture',txt3)

if __name__=='__main__': unittest.main()
