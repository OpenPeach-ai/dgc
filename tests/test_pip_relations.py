"""Which Pips a session is related to (pips-flow-design Q2, 14 Nov; Pips API 96 list_related_pips).

No session owns a Pip. A session is related to some Pips, worked out from what happened, never set by anyone and never
routing anything: 1. it gave the Pip a job (run_pip_now from that chat, in the last 30 days), 2. the Pip was set up
there (an accepted setup card, or a 0.51 attachment), 3. the Pip works on that session's folder. A Pip relates to many
sessions. The agent map's Pips section reads this list, strongest first, with what each Pip is doing.

Real registry, real runs and setups, the real control seam.
"""
from __future__ import annotations

import json
import unittest

from dgc import pip_relations, pip_report_delivery as delivery
from dgc.workspace_registry import RegistryError, identifier
from tests.test_pip_report_delivery import Scene


class Related(Scene):
    def setup_card(self, session_id, pip, status="accepted"):
        receipt = {"setup_id": identifier("setup"), "pip_id": pip["id"], "job_version": 1, "run_id": None,
                   "next_run_at": None, "accepted": True, "actor": "editor-user", "resolved_at": self.now}
        self.registry.db.execute("INSERT INTO pip_setup_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (receipt["setup_id"], self.workspace["id"], session_id, identifier("key")[:40], "digest", "{}", "digest",
             status, json.dumps(receipt) if status == "accepted" else None, self.now, self.now))

    def related(self, session_id):
        return pip_relations.related(self.registry, session_id)

    def test_a_job_it_gave_then_set_up_here_then_the_folder_strongest_first(self):
        chat = self.chat()
        asked = self.store.create(self.workspace["id"], "Billing audit", "Inspect billing.", "fixture", pip_type="rook")
        made_here = self.store.create(self.workspace["id"], "GST watchdog", "Check tax.", "fixture", pip_type="scout")
        self.finished(pip=asked, findings=[], requested_by=delivery.chat_identity(chat))
        self.setup_card(chat, made_here)
        listed = self.related(chat)
        self.assertEqual([(p["name"], p["why"]) for p in listed],
                         [("Billing audit", ["asked", "folder"]), ("GST watchdog", ["set_up", "folder"]),
                          ("ERP daily audit", ["folder"])])
        self.assertTrue(all(set(p) >= {"id", "name", "pip_type", "workspace_id", "why", "running", "needs_you"} for p in listed))

    def test_a_pip_of_another_folder_relates_only_through_a_job_or_a_setup(self):
        chat = self.chat()
        other = self.base / "elsewhere"
        other.mkdir()
        workspace = self.registry.resolve(other)
        far = self.store.create(workspace["id"], "Site check", "Check the site.", "fixture", pip_type="scout")
        self.assertNotIn(far["id"], [p["id"] for p in self.related(chat)])
        self.attach(chat, far)
        [entry] = [p for p in self.related(chat) if p["id"] == far["id"]]
        self.assertEqual(entry["why"], ["set_up"], "a 0.51 attachment counts as set up here, nothing more")

    def test_an_old_job_fades_and_an_archived_pip_relates_to_nothing(self):
        chat = self.chat()
        old_now = self.now
        self.now = "2026-09-01T10:00:00.000Z"
        self.finished(findings=[], requested_by=delivery.chat_identity(chat))
        self.now = old_now
        [entry] = self.related(chat)
        self.assertEqual(entry["why"], ["folder"], "a job more than 30 days old no longer relates")
        self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (self.pip["id"],))
        self.assertEqual(self.related(chat), [])

    def test_it_says_what_each_is_doing(self):
        chat = self.chat()
        binding = self.registry.binding(self.workspace["id"])
        run_id = identifier("run")
        self.registry.db.execute("""INSERT INTO pip_runs (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,
            manifest,status,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (run_id, self.pip["id"], self.workspace["id"], binding["id"], run_id, "pip-schedule",
             json.dumps({"run_kind": "audit"}), "running", self.now, self.now))
        [entry] = self.related(chat)
        self.assertIs(entry["running"], True)

    def test_an_unknown_session_relates_to_nothing_and_the_command_is_local(self):
        self.assertEqual(self.related("never-seen"), [])
        from dgc import pips
        self.assertIn("list_related_pips", pips.CONTROL_COMMANDS)
        chat = self.chat()
        result = pips.handle_control(self.cfg, {"type": "list_related_pips", "request_id": "r", "session_id": chat},
                                     "device_1", start_worker=False)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "local_only")


if __name__ == "__main__":
    unittest.main()
