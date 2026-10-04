"""Audit Git preparation must not occupy the SQLite queue write lock."""
import json
import threading
import unittest
from unittest.mock import patch

from dgc import pips, pip_daemon, pip_source_changes, pip_event_triggers
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures
from tests import test_pip_handoffs as handoff_fixtures


class EnqueuePreparationTests(unittest.TestCase):
    setUp=fixtures.LocalPipsTests.setUp
    git=fixtures.LocalPipsTests.git
    commit=fixtures.LocalPipsTests.commit
    setup_source=handoff_fixtures.PipHandoffTests.setup_source
    propose=handoff_fixtures.PipHandoffTests.propose

    def test_blocked_git_preparation_does_not_block_heartbeat_writer(self):
        self.commit()
        job=self.store.create(self.workspace["id"],"Auditor","Inspect source","user")
        entered,release=threading.Event(),threading.Event()
        errors=[];results=[];transactions=[]
        original=pip_source_changes.snapshot
        def worker():
            try:
                with WorkspaceRegistry(self.registry.directory) as registry:
                    store=pips.PipStore(registry)
                    def blocked(*args,**kwargs):
                        transactions.append(registry.db.in_transaction)
                        entered.set()
                        if not release.wait(10):raise AssertionError("test did not release preparation")
                        return original(*args,**kwargs)
                    with patch.object(pip_source_changes,"snapshot",side_effect=blocked):
                        results.append(store.enqueue(job["id"],"outside-lock","user",self.cfg))
            except BaseException as exc:errors.append(exc)
        thread=threading.Thread(target=worker)
        thread.start()
        try:
            self.assertTrue(entered.wait(10),"preparation did not start")
            # Fail promptly if a transaction was accidentally held. This is a
            # lock-contract assertion, never a measured performance assertion.
            self.registry.db.execute("PRAGMA busy_timeout=100")
            pip_daemon._heartbeat(self.registry,{"schema_version":1,"instance_id":"fixture-heartbeat"},"running")
            self.assertEqual(transactions,[False])
            self.assertEqual(pip_daemon._read(self.registry,pip_daemon.SUPERVISOR_KEY)["status"],"running")
        finally:
            release.set();thread.join(10)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
        self.assertEqual(len(results),1)

    def test_new_checkpoint_during_preparation_refuses_run_and_event_cursor_advance(self):
        self.commit();job=self.store.create(self.workspace["id"],"Auditor","Inspect source","user")
        proposal=self.store.propose(job["id"],1,{"event_trigger":{"events":["context_updated"]}},"user")
        job=self.store.accept(job["id"],proposal["id"],1,"user")
        prior=self.store.enqueue(job["id"],"previous","user",self.cfg);self.store.claim_next()
        self.registry.event(self.workspace["id"],"workspace_context_recorded",payload={"kind":"decision"})
        occurrence=pip_event_triggers.plan(self.registry,job["id"],now=self.registry.clock())
        state=dict(self.registry.db.execute("SELECT * FROM pip_event_trigger_state WHERE pip_id=?",(job["id"],)).fetchone())
        report=pips.validate_report(json.dumps({"summary":"Inspected","findings":[],"limitations":[]}),self.root,read_calls=1)
        original=pip_source_changes.snapshot
        def concurrent_checkpoint(*args,**kwargs):
            with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as other:
                pips.PipStore(other).finish(prior["id"],result=report)
            return original(*args,**kwargs)
        with patch.object(pip_source_changes,"snapshot",side_effect=concurrent_checkpoint),self.assertRaisesRegex(RegistryError,"checkpoint") as caught:
            self.store.enqueue(job["id"],pip_event_triggers.occurrence_key(2,occurrence["event"]["seq"]),"local-event-trigger",self.cfg,event_occurrence=occurrence)
        self.assertEqual(caught.exception.code,"conflict")
        self.assertEqual(len(self.store.runs(job["id"])),1)
        self.assertEqual(dict(self.registry.db.execute("SELECT * FROM pip_event_trigger_state WHERE pip_id=?",(job["id"],)).fetchone()),state)

    def test_job_change_during_preparation_refuses_without_new_run(self):
        self.commit();job=self.store.create(self.workspace["id"],"Auditor","Inspect source","user")
        original=pip_source_changes.snapshot
        def changed(*args,**kwargs):
            with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as other:
                store=pips.PipStore(other)
                proposal=store.propose(job["id"],1,{"name":"Changed reviewer"},"user")
                store.accept(job["id"],proposal["id"],1,"user")
            return original(*args,**kwargs)
        with patch.object(pip_source_changes,"snapshot",side_effect=changed),self.assertRaisesRegex(RegistryError,"job changed"):
            self.store.enqueue(job["id"],"stale","user",self.cfg)
        self.assertEqual(self.store.runs(job["id"]),[])

    def test_exact_retry_does_not_recompute_source_changes(self):
        self.commit();job=self.store.create(self.workspace["id"],"Auditor","Inspect source","user")
        first=self.store.enqueue(job["id"],"same","user",self.cfg)
        with patch.object(pip_source_changes,"snapshot",side_effect=AssertionError("retry recomputed Git")):
            self.assertEqual(self.store.enqueue(job["id"],"same","user",self.cfg)["id"],first["id"])

    def test_read_only_handoff_prepares_before_approval_write_transaction(self):
        self.setup_source();proposed=self.propose()
        original=pip_source_changes.snapshot;transactions=[]
        def checked(*args,**kwargs):
            transactions.append(self.registry.db.in_transaction)
            with WorkspaceRegistry(self.registry.directory) as writer:
                writer.db.execute("INSERT OR REPLACE INTO metadata VALUES('probe','success')")
            return original(*args,**kwargs)
        from dgc.pip_handoffs import accept
        with patch.object(pip_source_changes,"snapshot",side_effect=checked):
            result=accept(self.store,proposed["id"],0,"device",self.cfg)
        self.assertEqual(transactions,[False]);self.assertEqual(result["run"]["status"],"queued")
        self.assertIn("changes_since_checkpoint",result["run"]["manifest"])

    def test_stale_handoff_preparation_rolls_back_approval_reservation(self):
        self.setup_source();proposed=self.propose()
        original=self.store.prepare_handoff_audit
        def corrupt(pip_id):
            prepared=original(pip_id)
            prepared["source_revision"]="0"*40
            return prepared
        from dgc import pip_handoffs
        with patch.object(self.store,"prepare_handoff_audit",side_effect=corrupt),self.assertRaises(RegistryError):
            pip_handoffs.accept(self.store,proposed["id"],0,"device",self.cfg)
        pending=pip_handoffs.get(self.store,proposed["id"])
        self.assertEqual(pending["status"],"pending");self.assertIsNone(pending["run_id"])
        self.assertEqual(self.store.runs(self.target["id"]),[])
