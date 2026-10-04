"""Offline, deterministic run-ledger paging and disclosure-boundary checks."""
import json
import unittest
from unittest.mock import patch

from dgc import pips, workspace_registry
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_pips_local as fixtures


class PipRunActivityTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def make_run(self, workspace_id=None, key="request-1"):
        pip = self.store.create(workspace_id or self.workspace["id"], "Audit", "Inspect source", "user")
        with patch.object(pips, "source_revision", return_value="a" * 40), \
             patch.object(pips, "_require_runner_platform"):
            return self.store.enqueue(pip["id"], key, "user", self.cfg)

    def event(self, run, **payload):
        self.registry.event(run["workspace_id"], "pip_run_progress", pip_id=run["pip_id"],
                            run_id=run["id"], payload=payload)

    def call(self, run_id, **args):
        request = {"type": "list_pip_run_activity", "request_id": "review-1", "run_id": run_id, **args}
        with patch.object(pips, "WorkspaceRegistry", lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(pips, "start_queued", side_effect=AssertionError("reading must not start work")):
            return pips.handle_control(self.cfg, request, "local-editor", start_worker=False)

    def result(self, run_id, **args):
        response = self.call(run_id, **args)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def test_filters_by_authoritative_run_pip_and_workspace(self):
        run = self.make_run()
        other_run = self.make_run(key="other")
        other_root = self.base / "another"
        other_root.mkdir()
        other_workspace = self.registry.resolve(other_root)["id"]
        other_workspace_run = self.make_run(other_workspace)
        self.event(run, message="selected run")
        self.event(other_run, message="OTHER_RUN_SECRET")
        self.event(other_workspace_run, message="OTHER_WORKSPACE_SECRET")
        # Even inconsistent/corrupt identity columns may not disclose another
        # Pip/workspace merely because its event supplies the requested run ID.
        self.registry.event(run["workspace_id"], "wrong_pip", pip_id=other_run["pip_id"],
                            run_id=run["id"], payload={"message": "FORGED_PIP"})
        self.registry.event(other_workspace, "wrong_workspace", pip_id=run["pip_id"],
                            run_id=run["id"], payload={"message": "FORGED_WORKSPACE"})
        result = self.result(run["id"])
        self.assertEqual((result["workspace_id"], result["pip_id"], result["run_id"]),
                         (run["workspace_id"], run["pip_id"], run["id"]))
        self.assertEqual(len(result["events"]), 2)
        encoded = json.dumps(result)
        for excluded in ("OTHER_RUN_SECRET", "OTHER_WORKSPACE_SECRET", "FORGED_PIP", "FORGED_WORKSPACE"):
            self.assertNotIn(excluded, encoded)
        self.assertFalse(result["history_may_be_truncated"])
        self.assertFalse(result["has_more"])
        self.assertEqual(result["retention_scope"], "workspace")
        self.assertEqual(result["retention_limit"], 5000)

    def test_page_cursor_fetches_every_matching_event_once(self):
        run = self.make_run()
        other = self.make_run(key="other")
        for index in range(54):
            self.event(run, message=str(index))
            self.event(other, message="skip")
        first = self.result(run["id"])
        self.assertEqual(len(first["events"]), 50)
        self.assertTrue(first["has_more"])
        self.assertEqual(first["oldest_cursor"], first["events"][0]["seq"])
        second = self.result(run["id"], after=first["next_cursor"])
        self.assertEqual(len(second["events"]), 5)
        self.assertFalse(second["has_more"])
        all_events = first["events"] + second["events"]
        self.assertEqual(len({event["seq"] for event in all_events}), 55)
        empty = self.result(run["id"], after=second["next_cursor"])
        self.assertEqual(empty["events"], [])
        self.assertEqual(empty["next_cursor"], second["next_cursor"])
        self.assertFalse(empty["has_more"])
        self.assertFalse(empty["history_may_be_truncated"])

    def test_cursor_is_exact_sqlite_range_integer(self):
        run = self.make_run()
        for cursor in (-1, True, False, 0.0, 1.5, "0", None, [], {}, 2**63):
            with self.subTest(cursor=cursor):
                response = self.call(run["id"], after=cursor)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_cursor")
        result = self.result(run["id"], after=2**63 - 1)
        self.assertEqual(result["events"], [])
        self.assertEqual(result["next_cursor"], 2**63 - 1)

    def test_unknown_run_and_invalid_ids_fail_closed(self):
        for run_id in ("run_unknown", "", None, [], "x" * 129):
            with self.subTest(run_id=run_id):
                response = self.call(run_id)
                self.assertFalse(response["ok"])
                self.assertNotIn("result", response)
        self.assertEqual(self.call("run_unknown")["error"]["code"], "not_found")

    def test_caller_cannot_supply_workspace_pip_or_page_limit(self):
        run = self.make_run()
        for extra in ({"workspace_id": run["workspace_id"]}, {"pip_id": run["pip_id"]}, {"limit": 100}):
            with self.subTest(extra=extra):
                response = self.call(run["id"], **extra)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "invalid_request")

    def test_byte_budget_pages_without_dropping_event_payloads(self):
        run = self.make_run()
        for index in range(32):
            self.event(run, index=index, message="界" * 2500)
        events, after, pages = [], 0, 0
        while True:
            response = self.call(run["id"], after=after)
            self.assertTrue(response["ok"], response)
            self.assertLessEqual(len(json.dumps(response, ensure_ascii=False).encode()), 128 * 1024)
            page = response["result"]
            self.assertLess(len(page["events"]), 50)
            events.extend(page["events"])
            pages += 1
            if not page["has_more"]:
                break
            self.assertGreater(page["next_cursor"], after)
            after = page["next_cursor"]
            self.assertLess(pages, 10)
        self.assertGreater(pages, 1)
        self.assertEqual(len(events), 33)
        self.assertEqual(len({event["seq"] for event in events}), 33)
        self.assertTrue(all(event["payload"]["message"] == "界" * 2500 for event in events[1:]))

    def test_output_redacts_known_secret_and_authorization_value(self):
        run = self.make_run()
        self.cfg.set("api_key", "fixture-activity-secret-123", persist=False)
        self.event(run, message="fixture-activity-secret-123", detail="Authorization: Bearer test-private-value-987")
        response = self.call(run["id"])
        self.assertTrue(response["ok"], response)
        encoded = json.dumps(response)
        self.assertNotIn("fixture-activity-secret-123", encoded)
        self.assertNotIn("test-private-value-987", encoded)
        self.assertIn("[REDACTED]", encoded)

    def test_workspace_retention_explicitly_reports_possible_missing_history(self):
        run = self.make_run()
        other = self.make_run(key="other")
        self.assertFalse(self.result(run["id"])["history_may_be_truncated"])
        with patch.object(workspace_registry, "MAX_EVENTS", 3):
            for index in range(4):
                self.event(run, message=str(index))
            partial = self.result(run["id"])
            self.assertEqual(len(partial["events"]), 3)
            self.assertTrue(partial["history_may_be_truncated"])
            self.assertEqual(partial["retention_limit"], 3)
            for index in range(3):
                self.event(other, message=str(index))
            gone = self.result(run["id"])
            self.assertEqual(gone["events"], [])
            self.assertEqual(gone["oldest_cursor"], 0)
            self.assertFalse(gone["has_more"])
            self.assertTrue(gone["history_may_be_truncated"])

    def test_oversize_stored_payload_is_refused_before_payload_decode(self):
        run = self.make_run()
        self.registry.db.execute("UPDATE workspace_events SET payload=? WHERE run_id=?", ("x" * 8193, run["id"]))
        response = self.call(run["id"])
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "stored_data_limit")
        self.assertNotIn("result", response)

    def test_nonobject_payload_fails_closed(self):
        run = self.make_run()
        self.registry.db.execute("UPDATE workspace_events SET payload='[]' WHERE run_id=?", (run["id"],))
        response = self.call(run["id"])
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "invalid_activity")

    def test_disabled_request_never_opens_registry(self):
        self.cfg.data["pips_enabled"] = False
        with patch.object(pips, "WorkspaceRegistry", side_effect=AssertionError("must not open")):
            response = pips.handle_control(self.cfg, {"type": "list_pip_run_activity", "request_id": "r", "run_id": "run_x"}, "user")
        self.assertEqual(response["error"]["code"], "disabled")

    def test_run_activity_does_not_resolve_or_create_launch_workspace(self):
        run = self.make_run()
        self.cfg.project_root = self.base / "gone"
        before = len(self.registry.list())
        self.assertEqual(len(self.result(run["id"])["events"]), 1)
        self.assertEqual(len(self.registry.list()), before)


if __name__ == "__main__":
    unittest.main()
