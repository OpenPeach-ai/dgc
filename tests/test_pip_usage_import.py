import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from dgc import usage_ledger as ledger, pip_usage

class PipUsageImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.home=Path(self.tmp.name);self.run='run_'+'a'*32
        self.path=self.home/'pips'/'runs'/self.run/'worker-home'/'.dgc'/'usage.sqlite'
        self.path.parent.mkdir(parents=True)
        self.addCleanup(ledger._reset_for_tests)
    def source(self, rows=None):
        with sqlite3.connect(self.path) as db:
            db.execute(ledger._SCHEMA)
            for r in rows or [(int(time.time()),'ollama','localhost','model', 'main',20,5,10,1)]:
                db.execute('INSERT INTO requests(ts,provider,host,model,source,input_tokens,output_tokens,cached_input_tokens,metered) VALUES (?,?,?,?,?,?,?,?,?)',r)
    def report(self):return ledger.report('all',path=self.home/ledger.LEDGER_NAME)['totals']
    def test_import_is_atomic_idempotent_and_keeps_original_provider_counts(self):
        self.source();self.assertTrue(pip_usage.import_run(self.run,home=self.home));self.assertFalse(pip_usage.import_run(self.run,home=self.home))
        self.assertEqual(self.report()['requests'],1);self.assertEqual(self.report()['input_tokens'],20)
        with sqlite3.connect(self.home/ledger.LEDGER_NAME) as db:self.assertEqual(db.execute('SELECT source,host,model FROM requests').fetchall(),[('pip','localhost','model')])
    def test_import_keeps_each_runs_tokens_by_model_for_token_usage(self):
        now=int(time.time())
        self.source([(now,'ollama','localhost','deepseek-v4.1-flash:cloud','main',100,10,0,1),
                     (now,'ollama','localhost','deepseek-v4.1-flash:cloud','main',50,5,0,1),
                     (now,'anthropic','api.anthropic.com','claude-x','main',7,3,0,1)])
        pip_usage.import_run(self.run,home=self.home)
        got=sorted(pip_usage.run_models([self.run,'run_'+'f'*32,'bad'],home=self.home)[self.run])
        self.assertEqual(got,[('claude-x','anthropic','api.anthropic.com',7,3,1),('deepseek-v4.1-flash:cloud','ollama','localhost',150,15,2)])
        self.assertFalse(pip_usage.import_run(self.run,home=self.home),'a second import adds no second set of models')
        self.assertEqual(len(pip_usage.run_models([self.run],home=self.home)[self.run]),2)
    def test_a_refused_import_records_no_models(self):
        now=int(time.time());self.source([(now,'ollama','localhost','model','main',-1,5,0,1)])
        with self.assertRaises(ValueError):pip_usage.import_run(self.run,home=self.home)
        self.assertEqual(pip_usage.run_models([self.run],home=self.home),{})
    def test_bad_count_refuses_entire_batch_and_allows_clean_retry(self):
        now=int(time.time());self.source([(now,'ollama','localhost','model','main',20,5,0,1),(now,'ollama','localhost','model','main',-1,5,0,1)])
        with self.assertRaises(ValueError):pip_usage.import_run(self.run,home=self.home)
        self.assertEqual(self.report()['requests'],0)
        with sqlite3.connect(self.path) as db:db.execute('DELETE FROM requests WHERE input_tokens<0')
        self.assertTrue(pip_usage.import_run(self.run,home=self.home))
    def test_no_usage_and_unmetered_requests_are_not_fabricated(self):
        pip_usage.import_run(self.run,home=self.home);self.assertEqual(self.report()['requests'],0)
        self.run='run_'+'b'*32;self.path=self.home/'pips'/'runs'/self.run/'worker-home'/'.dgc'/'usage.sqlite';self.path.parent.mkdir(parents=True)
        self.source([(int(time.time()),'ollama','localhost','model','main',0,0,0,0)])
        pip_usage.import_run(self.run,home=self.home);self.assertEqual(self.report()['unmetered_requests'],1)
    def test_symlink_escape_is_refused(self):
        outside=self.home/'outside';outside.write_text('unused');self.path.symlink_to(outside)
        with self.assertRaises(ValueError):pip_usage.import_run(self.run,home=self.home)
    def test_oversize_ledger_is_refused_before_sqlite_open(self):
        with self.path.open('wb') as f:f.truncate(pip_usage.MAX_LEDGER_BYTES+1)
        with self.assertRaises(ValueError):pip_usage.import_run(self.run,home=self.home)
    def test_invalid_id_and_corrupt_database_are_not_marked_imported(self):
        with self.assertRaises(ValueError):pip_usage.import_run('../escape',home=self.home)
        self.path.write_text('not sqlite')
        with self.assertRaises(sqlite3.Error):pip_usage.import_run(self.run,home=self.home)
    def test_retry_after_reopen_does_not_duplicate(self):
        self.source();pip_usage.import_run(self.run,home=self.home);ledger._reset_for_tests()
        self.assertFalse(pip_usage.import_run(self.run,home=self.home));self.assertEqual(self.report()['requests'],1)
    def test_expired_rows_are_not_resurrected(self):
        self.source([(1,'ollama','localhost','model','main',20,5,0,1)])
        pip_usage.import_run(self.run,home=self.home);self.assertEqual(self.report()['requests'],0)
    def test_completed_sync_includes_failed_runs_but_not_running(self):
        self.source();registry=self.home/'pips'/'registry.sqlite3'
        with sqlite3.connect(registry) as db:
            db.execute('CREATE TABLE pip_runs(id TEXT,status TEXT,created_at TEXT)')
            db.executemany('INSERT INTO pip_runs VALUES (?,?,?)',[(self.run,'failed','2026'),('run_'+'b'*32,'running','2026')])
        with patch('dgc.config.USER_HOME',self.home):
            self.assertEqual(pip_usage.sync_completed(),'');self.assertEqual(ledger.report('all')['totals']['requests'],1)
    def test_virtual_read_surface_is_refused(self):
        with sqlite3.connect(self.path) as db:
            db.execute('CREATE VIEW requests AS SELECT 1 AS id')
        with self.assertRaisesRegex(ValueError,'requests table'):
            pip_usage.import_run(self.run,home=self.home)
    def test_request_count_limit_refuses_the_batch(self):
        self.source([(int(time.time()),'ollama','localhost','model','main',1,1,0,1)]*(pip_usage.MAX_REQUESTS+1))
        with self.assertRaisesRegex(ValueError,'request bound'):
            pip_usage.import_run(self.run,home=self.home)
        self.assertEqual(self.report()['requests'],0)
    def test_transaction_failure_rolls_back_requests_and_receipt(self):
        self.source()
        db=ledger._open(self.home/ledger.LEDGER_NAME,create=True)
        db.execute('CREATE TABLE pip_usage_imports(run_id TEXT PRIMARY KEY, imported_at INTEGER NOT NULL)')
        db.execute("CREATE TRIGGER refuse_receipt BEFORE INSERT ON pip_usage_imports BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):pip_usage.import_run(self.run,home=self.home)
        self.assertEqual(self.report()['requests'],0)
        self.assertEqual(db.execute('SELECT count(*) FROM pip_usage_imports').fetchone()[0],0)
        db.execute('DROP TRIGGER refuse_receipt')
        self.assertTrue(pip_usage.import_run(self.run,home=self.home))
        self.assertEqual(self.report()['requests'],1)
    def test_bounded_catchup_makes_progress_without_reimporting_old_runs(self):
        self.source();registry=self.home/'pips'/'registry.sqlite3'
        with sqlite3.connect(registry) as db:
            db.execute('CREATE TABLE pip_runs(id TEXT,status TEXT,created_at TEXT)')
            db.executemany('INSERT INTO pip_runs VALUES (?,?,?)', [('run_'+format(i,'032x'),'succeeded',str(i)) for i in range(pip_usage.BATCH_RUNS+2)])
        with patch('dgc.config.USER_HOME',self.home):
            self.assertIn('still importing',pip_usage.sync_completed())
            self.assertEqual(pip_usage.sync_completed(),'')
            self.assertEqual(pip_usage.sync_completed(),'')
        db=ledger._open(self.home/ledger.LEDGER_NAME,create=True)
        self.assertEqual(db.execute('SELECT count(*) FROM pip_usage_imports').fetchone()[0],pip_usage.BATCH_RUNS+2)
    def test_two_processes_cannot_double_import_the_same_worker(self):
        import os,subprocess,sys
        self.source()
        script="""import sys
from dgc.pip_usage import import_run
sys.stdin.buffer.read(1)
print(import_run(sys.argv[1],home=sys.argv[2]))
"""
        env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]),'PYTHONDONTWRITEBYTECODE':'1'}
        processes=[subprocess.Popen([sys.executable,'-c',script,self.run,str(self.home)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env) for _ in range(2)]
        try:
            for p in processes:p.stdin.write(b'x');p.stdin.flush()
            outputs=[]
            for p in processes:
                out,err=p.communicate(timeout=30)
                self.assertEqual(p.returncode,0,err.decode());outputs.append(out.strip())
            self.assertEqual(sorted(outputs),[b'False',b'True'])
            self.assertEqual(self.report()['requests'],1)
        finally:
            for p in processes:
                if p.poll() is None:p.kill()
                p.wait()
                for stream in (p.stdin,p.stdout,p.stderr):
                    if stream and not stream.closed:stream.close()
