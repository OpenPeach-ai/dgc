"""Controlled-clock, real-Git commit observations without sleeps or network."""
import json
import threading
import unittest
from unittest.mock import patch

from dgc import pip_commit_detector as detector, pip_event_triggers as triggers, pip_daemon, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, _execute_schema
from tests import test_pips_local as fixtures


class CommitDetectorTests(unittest.TestCase):
    git=fixtures.LocalPipsTests.git
    commit=fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.now="2026-10-01T10:00:00.000Z"
        self.registry.clock=lambda:self.now
        for table,schema in (("pip_event_trigger_state",triggers.SCHEMA_V10),("pip_commit_observations",detector.SCHEMA_V10)):
            if not self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name=?",(table,)).fetchone():
                with self.registry.transaction():_execute_schema(self.registry.db,schema)
        self.initial=self.commit()

    def job(self,source_ref="HEAD"):
        job=self.store.create(self.workspace["id"],"Observer","Inspect committed code","user",source_ref)
        return self.revise(job,event_trigger={"events":["commit_changed"]})

    def revise(self,job,**changes):
        old=self.registry.db.execute("SELECT p.current_version,v.definition FROM pips p JOIN pip_versions v ON v.pip_id=p.id AND v.version=p.current_version WHERE p.id=?",(job["id"],)).fetchone()
        value=json.loads(old["definition"]); value.update(changes)
        value["event_trigger"]=triggers.validate_event_trigger(value.get("event_trigger"))
        value["trigger"]="event" if value["event_trigger"] else "manual"
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)",(job["id"],old["current_version"]+1,json.dumps(value),"user","Reviewed fixture",self.now))
            self.registry.db.execute("UPDATE pips SET current_version=? WHERE id=?",(old["current_version"]+1,job["id"]))
            triggers.reset_trigger(self.registry,job["id"],old["current_version"]+1,value["event_trigger"],self.now)
            # Idempotent reset also permits these fixtures before root's seam lands.
            detector.reset_observation(self.registry,job["id"],old["current_version"]+1,value["event_trigger"],self.now)
        return self.store.get(job["id"])

    def change(self):
        (self.root/"source.py").write_text("def hello():\n    return 'updated'\n")
        self.git("add","source.py");self.git("commit","-qm","updated")
        return self.git("rev-parse","HEAD")

    def tick(self,**kw):return detector.tick(self.registry,self.cfg,**kw)
    def events(self):return self.registry.db.execute("SELECT * FROM workspace_events WHERE event_type='workspace_commit_changed' ORDER BY seq").fetchall()

    def test_initial_baseline_is_silent_then_change_emits_exact_metadata(self):
        job=self.job();first=self.tick()
        self.assertEqual(first["baselined"],1);self.assertEqual(self.events(),[])
        revised=self.change();self.now="2026-10-01T10:00:30.000Z"
        self.assertEqual(self.tick()["changed"],1)
        row=self.events()[0]
        self.assertEqual(row["pip_id"],job["id"])
        self.assertEqual(json.loads(row["payload"]),{"job_version":2,"source_ref":"HEAD","previous_revision":self.initial,"revision":revised})
        self.assertNotIn(str(self.root),row["payload"])
        self.assertEqual(self.store.runs(job["id"]),[])

    def test_same_commit_dirty_files_and_untracked_do_not_emit(self):
        job=self.job();self.tick()
        (self.root/"source.py").write_text("dirty")
        (self.root/"untracked.txt").write_text("untracked")
        self.now="2026-10-01T10:00:31.000Z"
        self.assertEqual(self.tick()["changed"],0)
        self.assertEqual(detector._state(self.registry,job["id"])["revision"],self.initial)
        self.assertEqual(self.events(),[])

    def test_cooldown_no_probe_and_clock_rollback(self):
        self.job();self.tick();self.change()
        for now in ("2026-10-01T10:00:29.999Z","2026-09-30T10:00:00.000Z"):
            self.now=now
            with patch.object(detector,"observe_commit",side_effect=AssertionError("early probe")):
                self.assertEqual(self.tick()["checked"],0)
        self.now="2026-10-01T10:00:30.000Z";self.assertEqual(self.tick()["changed"],1)

    def test_restart_preserves_baseline_counter_and_cooldown(self):
        job=self.job();self.tick();new=self.change();self.now="2026-10-01T10:00:30.000Z";self.tick()
        with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as reopened:
            state=detector._state(reopened,job["id"])
            self.assertEqual((state["revision"],state["observed_changes"]),(new,1))
            with patch.object(detector,"observe_commit",side_effect=AssertionError("restart probe")):
                self.assertEqual(detector.tick(reopened,self.cfg)["checked"],0)

    def test_reviewed_branch_switch_and_disable_reenable_silently_rebaseline(self):
        job=self.job();self.tick();self.change();self.git("branch","old-ref",self.initial)
        self.now="2026-10-01T10:01:00.000Z"
        job=self.revise(job,source_ref="old-ref")
        self.assertEqual(self.tick()["baselined"],1);self.assertEqual(self.events(),[])
        job=self.revise(job,event_trigger=None)
        self.assertIsNone(detector._state(self.registry,job["id"]))
        job=self.revise(job,source_ref="HEAD",event_trigger={"events":["commit_changed"]})
        self.assertEqual(self.tick()["baselined"],1);self.assertEqual(self.events(),[])

    def test_name_revision_keeps_baseline_and_detects_next_commit(self):
        job=self.job();self.tick();before=detector._state(self.registry,job["id"])
        job=self.revise(job,name="New observer name")
        after=detector._state(self.registry,job["id"])
        self.assertEqual(after["job_version"],3)
        for key in ("revision","last_checked_at","observed_changes"):self.assertEqual(after[key],before[key])
        self.change();self.now="2026-10-01T10:00:30.000Z"
        self.assertEqual(self.tick()["changed"],1)

    def test_removed_ref_failure_preserves_good_baseline_and_backoff(self):
        self.git("branch","observed");job=self.job("observed");self.tick();self.git("branch","-D","observed")
        self.now="2026-10-01T10:00:30.000Z";result=self.tick()
        self.assertEqual(result["unavailable"],1)
        state=detector._state(self.registry,job["id"])
        self.assertEqual(state["revision"],self.initial);self.assertEqual(state["last_checked_at"],self.now)
        with patch.object(detector,"observe_commit",side_effect=AssertionError("retry too soon")):self.tick()
        self.assertEqual(self.events(),[])

    def test_paused_disabled_global_stop_and_shutdown_do_not_probe(self):
        job=self.job();self.store.set_paused(job["id"],True,"user")
        with patch.object(detector,"observe_commit",side_effect=AssertionError("paused")):self.tick()
        self.store.set_paused(job["id"],False,"user")
        stop=threading.Event();stop.set()
        with patch.object(detector,"observe_commit",side_effect=AssertionError("stopped")):
            self.tick(stop_event=stop)
            self.cfg.set("pips_enabled",False);self.tick();self.cfg.set("pips_enabled",True)
            pip_daemon._set_paused(self.registry,True,"user");self.tick()
        self.assertIsNone(detector._state(self.registry,job["id"])["revision"])

    def test_cancellation_and_job_pause_during_probe_do_not_write_or_emit(self):
        job=self.job();stop=threading.Event()
        def cancelled(*_):stop.set();return self.initial
        with patch.object(detector,"observe_commit",side_effect=cancelled):self.tick(stop_event=stop)
        self.assertIsNone(detector._state(self.registry,job["id"])["revision"])
        def paused(*_):self.store.set_paused(job["id"],True,"user");return self.initial
        with patch.object(detector,"observe_commit",side_effect=paused):self.tick()
        self.assertIsNone(detector._state(self.registry,job["id"])["revision"])

    def test_competing_observation_commits_one_event_via_transaction_compare(self):
        job=self.job();self.tick();revision=self.change();self.now="2026-10-01T10:00:30.000Z"
        with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as other:
            def raced(*_):
                with patch.object(detector,"observe_commit",return_value=revision):detector.tick(other,self.cfg)
                return revision
            with patch.object(detector,"observe_commit",side_effect=raced):result=self.tick()
        self.assertEqual(result["skipped"],1);self.assertEqual(len(self.events()),1)
        self.assertEqual(detector._state(self.registry,job["id"])["observed_changes"],1)

    def test_tick_probe_budget_and_fair_order(self):
        for _ in range(10):self.job()
        with patch.object(detector,"observe_commit",return_value=self.initial) as observe:
            self.assertEqual(self.tick()["checked"],8)
            self.assertEqual(self.tick()["checked"],2)
            self.assertEqual(observe.call_count,10)
        for limit in (0,9,True,1.5):
            with self.assertRaises(RegistryError):self.tick(limit=limit)

    def test_malicious_ref_and_oversized_git_outputs_refused_before_use(self):
        for value in ("--exec=touch", "HEAD;touch marker", "HEAD^{commit}","../HEAD","HEAD\n--option", "x"*201, None):
            with self.subTest(value=value),patch.object(detector,"_capture",side_effect=AssertionError("invalid reference reached Git")),self.assertRaises(RegistryError):
                detector.observe_commit(self.root,value)
        for raw in (b"a"*40+b"\njunk",b"x"*129,b"bad\n",b"a"*40):
            with patch.object(detector,"_capture",side_effect=[(0,str(self.root).encode()+b"\n"),(0,raw)]),self.assertRaises(detector._Unavailable):
                detector.observe_commit(self.root,"HEAD")

    def test_subdirectory_and_symlink_root_are_not_observed(self):
        child=self.root/"nested";child.mkdir()
        alias=self.base/"alias";alias.symlink_to(self.root,target_is_directory=True)
        for root in (child,alias,self.base/"gone"):
            with self.subTest(root=root),self.assertRaises(detector._Unavailable):detector.observe_commit(root,"HEAD")

    def test_local_git_external_helpers_cannot_run(self):
        marker=self.base/"helper-ran"
        helper=self.base/"helper.sh";helper.write_text(f"#!/bin/sh\nprintf bad > '{marker}'\n");helper.chmod(0o700)
        self.git("config","core.fsmonitor",str(helper));self.git("config","diff.external",str(helper))
        self.git("config","core.hooksPath",str(self.base))
        self.assertEqual(detector.observe_commit(self.root,"HEAD"),self.initial)
        self.assertFalse(marker.exists())

    def test_paused_commits_are_silently_baselined_on_resume(self):
        job=self.job();self.tick();self.store.set_paused(job["id"],True,"user")
        revision=self.change();self.now="2026-10-01T10:02:00.000Z"
        self.store.set_paused(job["id"],False,"user")
        result=self.tick()
        self.assertEqual(result["baselined"],1);self.assertEqual(result["changed"],0)
        self.assertEqual(detector._state(self.registry,job["id"])["revision"],revision)
        self.assertEqual(self.events(),[])

    def test_rebinding_a_moved_directory_silently_rebaselines(self):
        job=self.job();self.tick();self.change();self.now="2026-10-01T10:02:00.000Z"
        previous=self.root;moved=self.base/"moved";previous.rename(moved)
        self.registry.rebind(self.workspace["id"],moved,expected_root=previous)
        self.assertEqual(self.tick()["baselined"],1)
        self.assertEqual(self.events(),[])

    def test_probe_failure_preserves_baseline_and_timeout_is_bounded(self):
        job=self.job();self.tick();self.now="2026-10-01T10:02:00.000Z"
        with patch.object(detector,"_capture",side_effect=detector._Unavailable("comparison_timeout")) as capture:
            result=self.tick()
        self.assertEqual(result["unavailable"],1)
        self.assertEqual(detector._state(self.registry,job["id"])["revision"],self.initial)
        self.assertEqual(capture.call_args.args[2],4097)
        self.assertIn("deadline",capture.call_args.kwargs)
        self.assertEqual(self.events(),[])

    def test_stored_oversized_definition_and_observation_are_refused_before_git(self):
        job=self.job()
        self.registry.db.execute("UPDATE pip_commit_observations SET source_ref=? WHERE pip_id=?",("x"*1000000,job["id"]))
        with patch.object(detector,"observe_commit",side_effect=AssertionError("bad data reached Git")):
            self.assertEqual(self.tick()["unavailable"],1)
        self.registry.db.execute("UPDATE pip_commit_observations SET source_ref='HEAD' WHERE pip_id=?",(job["id"],))
        # A new immutable version avoids disabling immutability triggers merely
        # to exercise a corrupt pre-existing storage boundary.
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO pip_versions VALUES(?,?,?,?,?,?)",(job["id"],3,"x"*1000000,"user","corrupt fixture",self.now))
            self.registry.db.execute("UPDATE pips SET current_version=3 WHERE id=?",(job["id"],))
        with patch.object(detector,"observe_commit",side_effect=AssertionError("oversize decoded/probed")):
            self.assertEqual(self.tick()["unavailable"],1)

    def test_rebind_same_timestamp_does_not_compare_distinct_binding_paths(self):
        job=self.job();self.tick();self.change()
        previous=self.root;moved=self.base/"moved-fast";previous.rename(moved)
        self.registry.rebind(self.workspace["id"],moved,expected_root=previous)
        self.now="2026-10-01T10:00:30.000Z"
        result=self.tick()
        self.assertEqual(result["baselined"],1);self.assertEqual(result["changed"],0)
        self.assertEqual(self.events(),[])
