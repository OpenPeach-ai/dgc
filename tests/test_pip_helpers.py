"""A Pip starts its own sub-agents (27 Nov).

Decided 27 Nov: a Pip uses its own sub-agents when a job is big enough, with no words of the user's asking for it (no
"delegate"), as Work's agent does. Its own chat turns and its routines' are offered start_subagent at every level; a
sub-agent's own turn, the Pip's check of one and a fix's turn never are. What its reply asks for (at most two) is kept
with that reply and starts on the next tick, in a slot of its sub-agents: a folder Pip's in a copy of its folder (the
change reaches the Pip's copy only once the Pip has checked it), a Pip with no folder's with its own tools (nothing to
merge). The Pip's check says what came back in its chat; DGC's own message stays out of sight.

Real registry, real runs claimed and finished through PipStore, the real chat send, the real worker (with a stand-in
model) for what it offers.
"""
from __future__ import annotations

import json
import os
import time
import unittest
from unittest.mock import patch

from dgc import pip_agents, pip_chat, pips
from dgc.workspace_registry import RegistryError
from tests.test_pip_agents import AgentWorld

ASK = [{"title": "Fix the discount in total", "brief": "app.py's total ignores the discount: apply it, run the tests, "
                                                       "and report what changed."}]
CHECKED = "It applied the discount in total and the tests pass.\nRESULT: PASS"


class HelperWorld(AgentWorld):
    def turn(self, pip=None, text="Tidy the totals for me"):
        """A chat turn of the Pip's own, claimed: (row, its manifest as the supervisor pins it when it starts)."""
        pip = pip or self.helper
        sent = pip_chat.send(self.store, pip["id"], text, "m-" + str(time.monotonic_ns()), "editor-user", self.cfg)
        row = self.store.claim_next()
        self.assertEqual(row["id"], sent["run"]["id"])
        return row, pip_agents.helper_runtime(self.registry, row, json.loads(row["manifest"]))

    def task_job(self):
        pip_agents.ensure(self.registry.db)
        return self.registry.db.execute("SELECT * FROM pip_agent_jobs WHERE kind='task' ORDER BY created_at DESC, rowid DESC "
                                        "LIMIT 1").fetchone()

    def last_dgc_message(self, pip_id):
        return self.registry.db.execute("SELECT text,request_key FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                        "ORDER BY seq DESC LIMIT 1", (pip_id,)).fetchone()


class OfferedInItsOwnTurns(HelperWorld, unittest.TestCase):
    def test_its_own_chat_turn_has_the_tool_at_every_level(self):
        from dgc import pip_levels as levels
        for level in (levels.ASK, levels.APPROVE, levels.FULL):
            with self.subTest(level=level):
                self.choose(level)
                row, manifest = self.turn()
                self.assertIn(pip_agents.HELPER_PIN, manifest, "no words of the user's are needed")
                self.store.finish(row["id"], result={"text": "ok"})

    def test_never_in_a_sub_agents_turn_or_the_pips_check_of_one(self):
        row, _ = self.turn()
        self.store.finish(row["id"], result={"text": "A sub-agent is on it.", "subagents": ASK})
        self.send()
        agent_row = self.store.claim_next()
        agent_manifest = json.loads(agent_row["manifest"])
        self.assertIn("agent", agent_manifest)
        self.assertNotIn(pip_agents.HELPER_PIN, pip_agents.helper_runtime(self.registry, agent_row, agent_manifest),
                         "a sub-agent never starts its own (no nesting)")
        (pip_agents.copy_root(self.registry, self.helper["id"], self.task_job()["copy"]) / "app.py").write_text(
            "def total(items, discount=0):\n    return sum(items) - discount\n")
        self.store.finish(agent_row["id"], result={"text": "Applied the discount; tests pass."})
        self.send()
        check_row = self.store.claim_next()
        check_manifest = json.loads(check_row["manifest"])
        self.assertNotIn(pip_agents.HELPER_PIN, pip_agents.helper_runtime(self.registry, check_row, check_manifest),
                         "the Pip's check of a sub-agent starts none")

    def test_the_worker_offers_it_with_the_pin_and_hands_it_to_the_supervisor(self):
        from dgc.llm import ChatResult, LLMClient, ToolCall
        row, manifest = self.turn()
        seen, calls = {}, []

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen.setdefault("tools", {t["function"]["name"] for t in tools or []})
            calls.append(messages[-1])
            if len(calls) == 1:
                return ChatResult(content="", tool_calls=[ToolCall("h1", pip_agents.HELPER_TOOL, dict(ASK[0]))],
                                  finish_reason="tool_calls")
            return ChatResult(content="A sub-agent is fixing the discount; I'll check its work.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        self.assertIn(pip_agents.HELPER_TOOL, seen["tools"])
        self.assertEqual(result["subagents"], ASK)
        unpinned = {k: v for k, v in manifest.items() if k != pip_agents.HELPER_PIN}
        seen.clear()
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", lambda client, messages, tools=None, **k: seen.setdefault(
                 "tools", {t["function"]["name"] for t in tools or []}) and ChatResult(content="ok")), \
             patch("dgc.agent.discover_skills", return_value={}):
            pips.execute_native(self.cfg, self.root, unpinned, lambda event: None)
        self.assertNotIn(pip_agents.HELPER_TOOL, seen["tools"], "only where the supervisor pinned it")

    def test_a_personal_pips_worker_offers_it_too_core_included(self):
        # (Live, 27 Nov: Core did a big comparison itself. Its turn must still be offered the tool: the model's call.)
        from dgc.llm import ChatResult, LLMClient
        for kind in ("core", None):
            with self.subTest(kind=kind):
                pip = self.store.create(self.registry.personal()["id"], "Core" if kind else "Planner", "",
                                        "editor-user", **({"pip_type": "core"} if kind else {}))
                row, manifest = self.turn(pip, "Compare five laptops across three reviews each")
                seen = {}
                with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                     patch.object(LLMClient, "chat", lambda client, messages, tools=None, **k: seen.setdefault(
                         "tools", {t["function"]["name"] for t in tools or []}) and ChatResult(content="ok")), \
                     patch("dgc.agent.discover_skills", return_value={}):
                    pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
                self.assertIn(pip_agents.HELPER_TOOL, seen["tools"])
                self.store.finish(row["id"], result={"text": "ok"})

    def test_one_reply_starts_two_at_most_and_a_bad_list_is_refused(self):
        self.assertEqual(pip_agents.helper_tool_result(ASK[0], 2)[0], None)
        self.assertIsNotNone(pip_agents.helper_tool_result(ASK[0], 1)[0])
        self.assertIsNone(pip_agents.helper_tool_result({"title": "", "brief": "x"}, 0)[0])
        self.assertIsNone(pip_agents.valid_helpers(ASK * 3))
        self.assertIsNone(pip_agents.valid_helpers([{"title": "x", "brief": "y", "copy": "elsewhere"}]))
        row, _ = self.turn()
        run = {"id": row["id"], "pip_id": self.helper["id"], "manifest": json.loads(row["manifest"])}
        with self.assertRaises(RegistryError):
            pip_agents.commit_helpers(self.store, run, {"subagents": ASK * 3})


class AFolderPipsHelper(HelperWorld, unittest.TestCase):
    def test_kept_with_the_reply_started_on_the_tick_in_a_copy_checked_then_merged(self):
        before = (self.root / "app.py").read_text()
        row, _ = self.turn()
        self.store.finish(row["id"], result={"text": "A sub-agent is fixing the discount; I'll check its work.",
                                             "subagents": ASK})
        job = self.task_job()
        self.assertEqual((job["state"], job["run_id"], job["copy"]), ("queued", None, None), "kept with the reply")
        self.send()
        job = self.task_job()
        self.assertEqual(job["state"], "working")
        self.assertRegex(job["copy"], r"^agents/[0-9a-f]{32}/shop$", "a copy of the Pip's folder, its own")
        agent_row = self.store.claim_next()
        self.assertEqual(json.loads(agent_row["manifest"])["agent"]["copy"], job["copy"])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages WHERE run_id=?",
                                                  (agent_row["id"],)).fetchone()[0], 0, "no chat rows of its own")
        (pip_agents.copy_root(self.registry, self.helper["id"], job["copy"]) / "app.py").write_text(
            "def total(items, discount=0):\n    return sum(items) - discount\n")
        self.store.finish(agent_row["id"], result={"text": "Applied the discount; tests pass."})
        self.assertEqual(self.task_job()["state"], "check_due")
        self.send()
        asked = self.last_dgc_message(self.helper["id"])
        self.assertTrue(asked["request_key"].startswith(pip_agents.CHECK_KEY))
        self.assertTrue(asked["text"].startswith("This message is from DGC, not the user. A sub-agent you started"),
                        "its own words: the chat's fix check (which hides the Pip's reply) reads another opening")
        self.assertIn("The job: Fix the discount in total", asked["text"])
        self.assertIn("+    return sum(items) - discount", asked["text"], "the change, as a diff")
        self.assertNotIn("FINDING", asked["text"], "no findings: it isn't a fix")
        check_row = self.store.claim_next()
        self.store.finish(check_row["id"], result={"text": CHECKED})
        self.assertEqual(self.task_job()["state"], "merged")
        self.assertIn("discount", (self.home() / "app.py").read_text(), "in the Pip's copy now")
        self.assertEqual((self.root / "app.py").read_text(), before, "the real folder untouched until it is applied")
        listed = pip_chat.list_messages(self.store, self.helper["id"])["messages"]
        reply = next(m for m in listed if m["role"] == "assistant" and m.get("run_id") == check_row["id"])
        self.assertEqual(reply["text"], "It applied the discount in total and the tests pass.",
                         "the Pip says what came back, without the line meant for DGC")
        dgc_said = next(m for m in listed if m["role"] == "user" and m.get("run_id") == check_row["id"])
        self.assertTrue(dgc_said.get("intro"), "no bubble for DGC's message")

    def test_retry_sends_it_back_to_carry_on_in_its_copy(self):
        row, _ = self.turn()
        self.store.finish(row["id"], result={"text": "On it.", "subagents": ASK})
        self.send()
        agent_row = self.store.claim_next()
        self.store.finish(agent_row["id"], result={"text": "Half done."})
        self.send()
        check_row = self.store.claim_next()
        self.store.finish(check_row["id"], result={"text": "Not yet: the tests weren't run.\nRESULT: RETRY — run the tests"})
        self.assertEqual(self.task_job()["state"], "retry_due")
        self.send()
        again = json.loads(self.store.claim_next()["manifest"])
        self.assertEqual(again["agent"]["try"], 2)
        self.assertIn("Carry on in your copy", again["conversation"]["text"])
        self.assertIn("run the tests", again["conversation"]["text"])


class APersonalPipsHelper(HelperWorld, unittest.TestCase):
    def test_no_folder_its_own_tools_checked_and_nothing_to_merge(self):
        personal = self.store.create(self.registry.personal()["id"], "Planner", "Plan trips", "editor-user")
        row, manifest = self.turn(personal, "Plan a weekend in Goa under 20,000 rupees")
        self.assertIn(pip_agents.HELPER_PIN, manifest)
        self.store.finish(row["id"], result={"text": "A sub-agent is comparing the flights.", "subagents": [
            {"title": "Compare the flights", "brief": "Find three return flights to Goa next weekend under 8,000 rupees."}]})
        self.send()
        job = self.task_job()
        self.assertEqual((job["state"], job["copy"]), ("working", None), "no folder: no copy")
        agent_row = self.store.claim_next()
        self.assertIn("agent", json.loads(agent_row["manifest"]))
        self.store.finish(agent_row["id"], result={"text": "Three flights: 6,900, 7,400 and 7,800 rupees."})
        self.send()
        asked = self.last_dgc_message(personal["id"])
        self.assertIn("What the sub-agent said:\nThree flights", asked["text"])
        self.assertNotIn("The change", asked["text"], "nothing of a copy to show")
        check_row = self.store.claim_next()
        self.store.finish(check_row["id"], result={"text": "It found three flights; the cheapest is 6,900.\nRESULT: PASS"})
        self.assertEqual(self.task_job()["state"], "merged")

    def test_its_retry_never_speaks_of_a_copy(self):
        personal = self.store.create(self.registry.personal()["id"], "Planner", "Plan trips", "editor-user")
        row, _ = self.turn(personal, "Plan a weekend in Goa")
        self.store.finish(row["id"], result={"text": "On it.", "subagents": [{"title": "Flights", "brief": "Find flights."}]})
        self.send()
        self.store.finish(self.store.claim_next()["id"], result={"text": "One flight."})
        self.send()
        self.store.finish(self.store.claim_next()["id"], result={"text": "Need three.\nRESULT: RETRY — find three"})
        self.send()
        again = json.loads(self.store.claim_next()["manifest"])
        self.assertNotIn("copy", again["conversation"]["text"])
        self.assertIn("Carry on from what you did so far", again["conversation"]["text"])


class NotFromTurnsThatArentItsOwn(HelperWorld, unittest.TestCase):
    def test_a_sub_agents_run_starts_none(self):
        row, _ = self.turn()
        run = {"id": row["id"], "pip_id": self.helper["id"],
               "manifest": {**json.loads(row["manifest"]), "agent": {"job_id": "pipagent_" + "b" * 32, "try": 1}}}
        pip_agents.commit_helpers(self.store, run, {"subagents": ASK})
        self.assertIsNone(self.task_job())


if __name__ == "__main__":
    unittest.main()
