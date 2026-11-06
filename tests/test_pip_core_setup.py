"""Core's suggested Personal Pips remain human-reviewed setup cards."""
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_core_setup, pip_flows, pip_setup
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class CoreSetupTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def candidate(self, name="Crypto Market Research"):
        return {"name": name, "goal": "Research crypto markets each morning with dated public sources.",
                "character": "lens", "schedule": None, "reason": "The user asked Core to create a research Pip."}

    def queued_reply(self, pip, key="core-setup"):
        sent = pip_chat.send(self.store, pip["id"], "Set up a Personal Pip for crypto research.", key,
                             "editor-user", self.cfg)
        run = self.store.claim_next()
        self.assertEqual(run["id"], sent["run"]["id"])
        return run

    def test_core_drafts_three_personal_pips_without_creating_or_scheduling_them(self):
        core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        run = self.queued_reply(core)
        candidates = [self.candidate("Crypto Market Research"),
                      {**self.candidate("Daily Blog Writer"), "character": "quill"},
                      {**self.candidate("Blog Image Designer"), "character": "scout"}]
        self.store.finish(run["id"], result={"text": "I prepared three Pips for your review.",
                                              "core_setup_drafts": candidates})
        personal = self.registry.personal()["id"]
        cards = pip_setup.list_pending(self.registry, personal)
        self.assertEqual({card["name"] for card in cards}, {item["name"] for item in candidates})
        self.assertTrue(all(card["source_policy"] == "personal" and card["status"] == "pending" for card in cards))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pips WHERE workspace_id=?", (personal,)).fetchone()[0], 1)
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_schedule_state").fetchone()[0], 0)
        selected = next(card for card in cards if card["name"] == "Crypto Market Research")
        with self.assertRaises(RegistryError):
            pip_setup.review(self.registry, selected["id"], personal, selected["digest"],
                             "core_setup", self.cfg, True)
        accepted = pip_setup.review(self.registry, selected["id"], personal, selected["digest"],
                                    "local-user", self.cfg, True)
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual(self.store._job(accepted["receipt"]["pip_id"])["name"], "Crypto Market Research")
        self.assertEqual(len(pip_setup.list_pending(self.registry, personal)), 2)

    def test_a_non_core_pip_cannot_save_core_setup_candidates(self):
        other = self.store.create(self.registry.personal()["id"], "Gmail", None, "editor-user", pip_type="lens")
        run = self.queued_reply(other, "other-setup")
        with self.assertRaises(RegistryError):
            self.store.finish(run["id"], result={"text": "A draft.", "core_setup_drafts": [self.candidate()]})
        self.assertEqual(pip_setup.list_pending(self.registry, self.registry.personal()["id"]), [])

    def test_accepted_core_team_prefills_a_workflow_only_after_all_cards_are_reviewed(self):
        core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        run = self.queued_reply(core)
        candidates = [self.candidate("Research"), self.candidate("Writer"), self.candidate("Image")]
        self.store.finish(run["id"], result={"text": "Review the team.", "core_setup_drafts": candidates})
        workspace = self.registry.personal()["id"]
        cards = sorted(pip_setup.list_pending(self.registry, workspace), key=lambda card: card["name"])
        self.assertEqual(pip_flows.core_suggestions(self.store, workspace), [])
        for card in cards:
            pip_setup.review(self.registry, card["id"], workspace, card["digest"],
                             "local-user", self.cfg, True)
        suggestions = pip_flows.core_suggestions(self.store, workspace)
        self.assertEqual(len(suggestions), 1)
        self.assertEqual([pip["name"] for pip in suggestions[0]["pips"]],
                         ["Research", "Writer", "Image"])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM pip_flows").fetchone()[0], 0,
                         "Core's suggestion never starts a route")
        pip_flows.create(self.store, "Daily post", [pip["pip_id"] for pip in suggestions[0]["pips"]],
                         ["Write a draft.", "Plan an image."], "reviewed", "local-console", self.cfg)
        self.assertEqual(pip_flows.core_suggestions(self.store, workspace), [])

    def test_core_cannot_use_an_unattended_or_hidden_turn_to_create_setup_cards(self):
        core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        run = self.store.enqueue(core["id"], "task", "editor-user", self.cfg)
        with self.assertRaises(RegistryError):
            pip_core_setup.commit(self.store, run, {"core_setup_drafts": [self.candidate()]})

    def test_invalid_candidate_or_duplicate_names_never_creates_a_card(self):
        core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        run = self.queued_reply(core)
        with self.assertRaises(RegistryError):
            self.store.finish(run["id"], result={"text": "Drafts.",
                "core_setup_drafts": [self.candidate(), self.candidate("crypto market research")]})
        self.assertEqual(pip_setup.list_pending(self.registry, self.registry.personal()["id"]), [])

    def test_worker_tool_keeps_credentials_out_and_limits_count(self):
        self.assertEqual(pip_core_setup.validate(self.candidate())["character"], "lens")
        with self.assertRaises(RegistryError):
            pip_core_setup.validate({**self.candidate(), "goal": "Use API key sk-secret"}, secrets=("sk-secret",))
        self.assertEqual(pip_core_setup.MAX_PER_REPLY, 3)

    def test_native_core_offers_the_tool_and_returns_review_candidates(self):
        from dgc import pips, pip_notes
        from dgc.llm import ChatResult, LLMClient, ToolCall
        core = self.store.create(self.registry.personal()["id"], "Core", None, "editor-user", pip_type="core")
        run = self.queued_reply(core)
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        raw = pip_notes.runtime(self.registry, run, raw)
        turns = []
        def chat(client, messages, tools=None, **kwargs):
            turns.append(messages)
            self.assertIn(pip_core_setup.TOOL, [tool["function"]["name"] for tool in tools])
            if len(turns) == 1:
                return ChatResult(content="", tool_calls=[ToolCall("core1", pip_core_setup.TOOL, self.candidate())])
            self.assertIn("Proposal prepared", json.dumps(messages))
            return ChatResult(content="I prepared the research Pip for you to review.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, raw, lambda event: None)
        self.assertEqual(result["core_setup_drafts"], [self.candidate()])
        self.store.finish(run["id"], result=result)
        self.assertEqual(len(pip_setup.list_pending(self.registry, self.registry.personal()["id"])), 1)


if __name__ == "__main__":
    unittest.main()
