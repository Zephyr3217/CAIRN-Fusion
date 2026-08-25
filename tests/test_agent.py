import tempfile, unittest
from pathlib import Path
from cairn.db import Database
from cairn.vault import VaultManager
from cairn.agent_engine import ask_agent

class AgentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name); self.root=root/'vault'; self.root.mkdir(); self.db=Database(root/'test.db'); self.v=VaultManager(self.db,self.root)
        self.v.create('Thesis/Chapter 2.md','Chapter 2','Support Vector Machine classification for flood susceptibility and drainage assessment.')
        self.v.full_index()
        self.health={'version':'0.5.0-fusion','notes':1,'watcher':True,'vault':str(self.root)}
    def tearDown(self):
        self.db.close(); self.tmp.cleanup()
    def ask(self,text): return ask_agent(text,db=self.db,vault=self.v,health_snapshot=self.health,undo_last=None)
    def test_history_aliases_understood(self):
        for text in ('history','show history','view recent activity','show recent changes'):
            self.assertEqual(self.ask(text)['type'],'history',text)
    def test_natural_search(self):
        r=self.ask('find my notes about SVM')
        self.assertEqual(r['type'],'search')
        self.assertTrue(any(x['path']=='Thesis/Chapter 2.md' for x in r['results']))
    def test_read_explicit_md(self):
        r=self.ask('what is in [Thesis/Chapter 2.md]?')
        self.assertEqual(r['type'],'note')
        self.assertIn('Support Vector Machine',r['text'])
    def test_list_notes(self):
        r=self.ask('show my notes')
        self.assertEqual(r['type'],'notes')
        self.assertEqual(r['results'][0]['path'],'Thesis/Chapter 2.md')
    def test_status_and_doctor_variants(self):
        for text in ('status','system status','doctor','diagnose','check for problems'):
            r=self.ask(text)
            self.assertIn(r['type'],('status','doctor'),text)
    def test_undo_last_without_handler_reports_unavailable(self):
        r=ask_agent('undo last',db=self.db,vault=self.v,health_snapshot=self.health,undo_last=None)
        self.assertEqual(r['type'],'error')
    def test_undo_last_with_nothing_to_undo(self):
        def no_ops():
            raise RuntimeError('No undoable operation is available.')
        r=ask_agent('undo the last change',db=self.db,vault=self.v,health_snapshot=self.health,undo_last=no_ops)
        self.assertEqual(r['type'],'error')
        self.assertIn('undo',r['text'].lower())
    def test_unrecognized_free_text_falls_back_to_vault_search(self):
        r=self.ask('drainage assessment thesis notes')
        self.assertIn(r['type'],('search_answer','answer','help'))

if __name__=='__main__': unittest.main()
