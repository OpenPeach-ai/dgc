"""Deterministic runner-wide read pages, hostile storage and no command effects."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_overview as overview, pips, pip_approvals
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures
from tests import test_pip_handoffs as handoff_fixtures


class OverviewTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    setup_source = handoff_fixtures.PipHandoffTests.setup_source
    propose = handoff_fixtures.PipHandoffTests.propose

    def clock(self):
        self.now = "2026-10-02T00:00:00.000Z"
        self.registry.clock = lambda: self.now

    def other_workspace(self, name="other"):
        root = self.base / name
        root.mkdir()
        return self.registry.resolve(root)["id"]

    def job(self, ws=None, name="Check source"):
        return self.store.create(ws or self.workspace["id"], name, "Inspect source", "reviewer")

    def update(self, job, name="New goal"):
        return self.store.propose(job["id"], job["current_version"], {"goal":name}, "reviewer", "Requested change")

    def control(self, command, **fields):
        with patch.object(pips, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)), \
             patch.object(pips, "start_queued", side_effect=AssertionError("read started runtime")):
            return pips.handle_control(self.cfg, {"type":command,"request_id":"overview-test",**fields}, "device")

    def test_empty_and_nonempty_workspace_counts_no_paths(self):
        self.clock()
        other = self.other_workspace()
        first = self.job()
        second = self.job()
        self.store.set_paused(second["id"], True, "reviewer")
        archived = self.job()
        self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (archived["id"],))
        self.update(first)
        self.store.propose(second["id"], second["current_version"], {"schedule":{"type":"interval","minutes":10,"missed_policy":"coalesce_latest"}}, "reviewer", "Schedule")
        with patch.object(pips, "source_revision", return_value="a"*40), patch.object(pips, "_require_runner_platform"):
            self.store.enqueue(first["id"], "queued", "reviewer", self.cfg)
        result = overview.workspace_overviews(self.registry)
        self.assertEqual(result["total_workspaces"], 2)
        byid = {w["id"]:w for w in result["workspaces"]}
        self.assertEqual(byid[self.workspace["id"]]["counts"], {"pips_active":1,"pips_paused":1,"pips_archived":1,"runs_active":0,"runs_queued":1,"reviews_job":1,"reviews_schedule":1,"reviews_handoff":0,"reviews_session_outcome":0,"reviews_total":2})
        self.assertTrue(all(v == 0 for v in byid[other]["counts"].values()))
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertNotIn("canonical_root", json.dumps(result))
        self.store.claim_next()
        self.assertEqual(next(w for w in overview.workspace_overviews(self.registry)["workspaces"] if w["id"]==first["workspace_id"])["counts"]["runs_active"], 1)

    def test_workspace_pages_stable_id_and_unknown_cursor(self):
        self.clock()
        for i in range(4):
            self.other_workspace(f"ws-{i}")
        seen, cursor = [], None
        while True:
            result = overview.workspace_overviews(self.registry, cursor, 2)
            seen.extend(w["id"] for w in result["workspaces"])
            if not result["has_more"]:
                self.assertIsNone(result["next_after_id"])
                break
            cursor = result["next_after_id"]
        self.assertEqual(seen, sorted(set(seen)))
        self.assertEqual(len(seen), 5)
        with self.assertRaisesRegex(RegistryError, "runner"):
            overview.workspace_overviews(self.registry, "ws_missing")

    def test_pending_pages_global_scope_expiry_and_no_mutation(self):
        self.clock()
        jobs = [self.job(), self.job(self.other_workspace())]
        for index in range(6):
            self.update(jobs[index % 2], f"Review {index}")
        before = self.registry.db.total_changes
        first = overview.pending_reviews(self.registry, limit=2)
        second = overview.pending_reviews(self.registry, before_id=first["next_before_id"], limit=2)
        third = overview.pending_reviews(self.registry, before_id=second["next_before_id"], limit=2)
        rows = first["reviews"]+second["reviews"]+third["reviews"]
        self.assertEqual(len({row["id"] for row in rows}), 6)
        self.assertEqual(first["total_pending"], 6)
        self.assertEqual(self.registry.db.total_changes, before)
        self.assertEqual(overview.pending_reviews(self.registry, jobs[0]["workspace_id"])["total_pending"], 3)
        self.assertNotIn("definition", json.dumps(rows))
        self.assertNotIn("reason", json.dumps(rows))
        ref = rows[0]["reference"]
        self.assertEqual(set(ref), {"approval_id","proposal_id","expected_version"})
        self.now = "2026-10-10T00:00:00.000Z"
        self.assertEqual(overview.pending_reviews(self.registry)["total_pending"], 0)
        self.assertEqual(self.registry.db.total_changes, before)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_approvals WHERE status='pending'").fetchone()[0], 6)

    def test_resolved_cursor_still_pages_but_foreign_scope_refused(self):
        self.clock()
        job = self.job()
        for i in range(3): self.update(job, str(i))
        other = self.other_workspace()
        first = overview.pending_reviews(self.registry, limit=1)
        cursor = first["next_before_id"]
        ref = first["reviews"][0]["reference"]
        self.store.reject(job["id"], ref["proposal_id"], ref["expected_version"], "reviewer")
        self.assertEqual(len(overview.pending_reviews(self.registry, before_id=cursor)["reviews"]), 2)
        with self.assertRaisesRegex(RegistryError, "scope"):
            overview.pending_reviews(self.registry, other, cursor)

    def test_handoff_routing_only_no_task_action_or_source_evidence(self):
        self.setup_source()
        h = self.propose(task="PRIVATE_SOURCE_INSTRUCTION")
        result = overview.pending_reviews(self.registry)
        row = result["reviews"][0]
        self.assertEqual(row["kind"], "handoff")
        self.assertEqual(row["pip_id"], self.target["id"])
        self.assertEqual(row["reference"], {"handoff_id":h["id"],"expected_revision":0,"source_pip_id":self.source["id"],"source_run_id":self.source_run["id"],"target_pip_id":self.target["id"],"target_job_version":1,"source_kind":"audit_finding.v1"})
        self.assertNotIn("PRIVATE_SOURCE_INSTRUCTION", json.dumps(result))
        self.assertNotIn("return 'hello'", json.dumps(result))
        self.assertEqual(overview.workspace_overviews(self.registry)["workspaces"][0]["counts"]["reviews_handoff"], 1)

    def test_recent_is_newest_first_and_global_or_scoped(self):
        self.clock()
        other = self.other_workspace()
        for i in range(8):
            self.registry.event(self.workspace["id"] if i%2 else other, "progress", payload={"index":i})
        first = overview.recent_activity(self.registry, limit=3)
        self.assertEqual([e["payload"]["index"] for e in first["events"]], [7,6,5])
        second = overview.recent_activity(self.registry, before_seq=first["next_before_seq"], limit=3)
        self.assertEqual([e["payload"]["index"] for e in second["events"]], [4,3,2])
        scoped = overview.recent_activity(self.registry, self.workspace["id"])
        self.assertTrue(all(e["workspace_id"]==self.workspace["id"] for e in scoped["events"]))
        self.assertFalse(scoped["history_may_be_truncated"])
        self.assertIsNone(scoped["next_before_seq"])
        self.assertEqual(overview.recent_activity(self.registry, before_seq=0)["events"], [])

    def test_retention_does_not_misinterpret_cross_workspace_sequence_gaps(self):
        self.clock()
        other = self.other_workspace()
        self.registry.event(other, "other_event")
        self.registry.event(self.workspace["id"], "selected_event")
        self.assertFalse(overview.recent_activity(self.registry)["history_may_be_truncated"])
        self.registry.db.execute("DELETE FROM workspace_events WHERE workspace_id=? AND event_type='workspace_resolved'", (other,))
        self.assertTrue(overview.recent_activity(self.registry)["history_may_be_truncated"])
        self.assertFalse(overview.recent_activity(self.registry, self.workspace["id"])["history_may_be_truncated"])
        self.assertEqual(overview.recent_activity(self.registry, other)["oldest_cursor"], self.registry.db.execute("SELECT min(seq) FROM workspace_events WHERE workspace_id=?", (other,)).fetchone()[0])

    def test_whole_event_byte_budget_preserves_next_page(self):
        self.clock()
        for i in range(30): self.registry.event(self.workspace["id"], "progress", payload={"value":"界"*2500,"i":i})
        first = overview.recent_activity(self.registry)
        self.assertTrue(first["has_more"])
        self.assertLess(len(first["events"]), 30)
        self.assertLess(len(json.dumps(first,ensure_ascii=False).encode()), 100*1024)
        seen = [e["seq"] for e in first["events"]]
        while first["has_more"]:
            first = overview.recent_activity(self.registry, before_seq=first["next_before_seq"])
            seen += [e["seq"] for e in first["events"]]
        self.assertEqual(len(seen), 31)
        self.assertEqual(seen, sorted(set(seen),reverse=True))

    def test_hostile_storage_is_bounded_before_payload_decode(self):
        self.clock()
        self.registry.event(self.workspace["id"], "malformed")
        self.registry.db.execute("UPDATE workspace_events SET payload=? WHERE event_type='malformed'", ('x'*(2*1024*1024),))
        with patch.object(overview, "_json_object", side_effect=AssertionError("oversize decoded")):
            with self.assertRaisesRegex(RegistryError,"bounded"):
                overview.recent_activity(self.registry)
        self.registry.db.execute("UPDATE workspaces SET name=? WHERE id=?", ('x'*(2*1024*1024),self.workspace["id"]))
        with self.assertRaisesRegex(RegistryError,"bounded"):
            overview.workspace_overviews(self.registry)

    def test_invalid_payload_shapes_and_depth_fail_closed(self):
        self.clock()
        self.registry.event(self.workspace["id"], "malformed")
        for raw in ('[]','{','{"x":1,"x":2}','{"x":NaN}', '{"x":'+ '['*30+'0'+']'*30+'}', '{"x":"\\ud800"}'):
            self.registry.db.execute("UPDATE workspace_events SET payload=? WHERE event_type='malformed'", (raw,))
            with self.subTest(raw=raw), self.assertRaises(RegistryError):
                overview.recent_activity(self.registry)

    def test_cursor_limits_scope_and_closed_control_fields(self):
        self.clock()
        for limit in (0,21,True,1.0,"2"):
            with self.subTest(limit=limit), self.assertRaises(RegistryError): overview.workspace_overviews(self.registry,limit=limit)
        for cursor in (-1,True,1.0,"2",2**53):
            with self.subTest(cursor=cursor), self.assertRaises(RegistryError): overview.recent_activity(self.registry,before_seq=cursor)
        for command in ("list_workspace_overviews","list_pending_pip_reviews","list_recent_workspace_activity"):
            result = self.control(command, path=str(self.root))
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "invalid_request")
            self.assertFalse(self.control(command,limit=None)["ok"])
        self.assertEqual(self.control("list_recent_workspace_activity",workspace_id="ws_missing")["error"]["code"],"not_found")

    def test_control_no_resolve_or_runtime_and_secret_redaction(self):
        self.clock()
        self.cfg.set("api_key","overview-secret-credential")
        self.registry.event(self.workspace["id"],"progress",payload={"message":"overview-secret-credential"})
        original = self.cfg.project_root
        self.cfg.project_root = self.base / "missing-launch-directory"
        try:
            with patch.object(WorkspaceRegistry,"resolve",side_effect=AssertionError("read resolved workspace")):
                for command in ("list_workspace_overviews","list_pending_pip_reviews","list_recent_workspace_activity"):
                    result = self.control(command)
                    self.assertTrue(result["ok"],result)
                    self.assertNotIn("overview-secret-credential",json.dumps(result))
        finally:
            self.cfg.project_root=original

    def test_aggregate_query_count_independent_of_pip_count(self):
        self.clock()
        queries=[]
        self.registry.db.set_trace_callback(queries.append)
        overview.workspace_overviews(self.registry)
        first=len(queries)
        for i in range(25): self.job(name=f"Job {i}")
        queries.clear()
        overview.workspace_overviews(self.registry)
        self.assertEqual(len(queries),first)
        self.registry.db.set_trace_callback(None)

    def test_foreign_runner_binding_is_excluded_from_every_global_read(self):
        self.clock()
        foreign=self.other_workspace("foreign-runner")
        job=self.job(foreign);self.update(job)
        self.registry.event(foreign,"private_other_runner",payload={"message":"foreign runner data"})
        self.registry.db.execute("UPDATE bindings SET runner_id='runner_elsewhere' WHERE workspace_id=?",(foreign,))
        self.assertEqual(overview.workspace_overviews(self.registry)["total_workspaces"],1)
        self.assertEqual(overview.pending_reviews(self.registry)["reviews"],[])
        self.assertTrue(all(e["workspace_id"]!=foreign for e in overview.recent_activity(self.registry)["events"]))
        for method in (overview.pending_reviews,overview.recent_activity):
            with self.assertRaisesRegex(RegistryError,"not found"):method(self.registry,foreign)
        with self.assertRaisesRegex(RegistryError,"runner"):overview.workspace_overviews(self.registry,foreign)

    def test_exact_proposal_read_has_approval_provenance_and_never_expires(self):
        self.clock();job=self.job();saved=self.update(job,"Inspect updated source")
        prior=self.registry.db.total_changes
        value=overview.proposal(self.registry,job["id"],saved["id"])
        item=value["proposal"]
        raw=json.loads(self.registry.db.execute("SELECT definition FROM pip_proposals WHERE id=?",(saved["id"],)).fetchone()[0])
        self.assertEqual(item["definition"],raw)
        self.assertEqual(item["actor"],"reviewer")
        self.assertEqual(item["reason"],"Requested change")
        self.assertEqual(item["approval"]["effective_status"],"pending")
        self.assertNotIn("session_id",json.dumps(value));self.assertNotIn("definition_digest",json.dumps(value))
        self.now="2026-10-10T00:00:00.000Z"
        item=overview.proposal(self.registry,job["id"],saved["id"])["proposal"]
        self.assertEqual((item["status"],item["approval"]["status"],item["approval"]["effective_status"]),("proposed","pending","expired"))
        self.assertEqual(self.registry.db.total_changes,prior)

    def test_proposal_foreign_membership_is_checked_before_decode(self):
        self.clock();job=self.job();other=self.job(self.other_workspace())
        saved=self.update(other)
        with patch.object(overview,"_json_object",side_effect=AssertionError("foreign definition decoded")):
            with self.assertRaisesRegex(RegistryError,"not found"):
                overview.proposal(self.registry,job["id"],saved["id"])
            self.registry.db.execute("UPDATE bindings SET runner_id='runner_elsewhere' WHERE workspace_id=?",(other["workspace_id"],))
            with self.assertRaisesRegex(RegistryError,"not found"):
                overview.proposal(self.registry,other["id"],saved["id"])

    def test_proposal_get_tracks_resolution_and_refuses_extra_control_fields(self):
        self.clock();job=self.job();saved=self.update(job)
        self.store.reject(job["id"],saved["id"],1,"reviewing-device")
        response=self.control("get_pip_proposal",pip_id=job["id"],proposal_id=saved["id"])
        self.assertTrue(response["ok"],response)
        approval=response["result"]["proposal"]["approval"]
        self.assertEqual((approval["status"],approval["effective_status"],approval["resolved_by"]),("rejected","rejected","reviewing-device"))
        self.assertFalse(self.control("get_pip_proposal",pip_id=job["id"],proposal_id=saved["id"],workspace_id=self.workspace["id"])["ok"])
        self.assertFalse(self.control("get_pip_proposal",pip_id=job["id"],proposal_id="missing")["ok"])

    def test_proposal_bound_before_decode_and_approval_digest_refusal(self):
        self.clock();job=self.job();saved=self.update(job)
        original=self.registry.db.execute("SELECT * FROM pip_proposals WHERE id=?",(saved["id"],)).fetchone()
        # New immutable malformed proposal is a hostile stored fixture, not an edit.
        values=dict(original);values.update(id="proposal_hostile",definition="x"*1000000)
        self.registry.db.execute("INSERT INTO pip_proposals VALUES(?,?,?,?,?,?,?,?)",tuple(values[k] for k in ("id","pip_id","expected_version","definition","actor","reason","status","created_at")))
        with patch.object(overview,"_json_object",side_effect=AssertionError("oversize decoded")):
            with self.assertRaisesRegex(RegistryError,"bounded"):
                overview.proposal(self.registry,job["id"],"proposal_hostile")
        with patch.object(pip_approvals,"digest",return_value="0"*64):
            with self.assertRaisesRegex(RegistryError,"digest"):
                overview.proposal(self.registry,job["id"],saved["id"])
