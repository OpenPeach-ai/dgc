"""Work's auto mode never shows an approval card (decided 17 Nov: "for work session in auto, just copy what codex
does, if it does it all, we do it all"); the model asks in the chat when it needs the user.

- A paid picture or video is made without a card; what it cost is in the result.
- A look on the user's network for model servers (router_find) and a Pip workflow's routing run in auto.
- What the user set to ask themselves -- their own ask rule, a mod's Ask, a generator's monthly limit they set, a new
  site in their own signed-in Chrome -- is HELD: nothing runs, no card shows, and the model is told to ask in one plain
  sentence in its reply and carry on with the rest. The same call made again in a later turn that the user's own
  message started runs (their answer was yes); in the same turn, or a turn DGC started by itself, it stays held.
- While something is held, the next turn the user starts carries one line saying what still waits on them.
- The system prompt says all this to the model in auto mode, and only there.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages  # noqa: E402
from test_subagents import Harness  # noqa: E402

from dgc import images  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402
from dgc.permissions import ALLOW  # noqa: E402

WAITING = "WAITING FOR THE USER"


class Case(unittest.TestCase):
    def setUp(self):
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.state = Path(tempfile.mkdtemp(prefix="dgc-auto-asks-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_SESSION_POLICY", None)
        from dgc import auto_holds                       # DGC's own editor on the wire (auto_holds.py)
        auto_holds.set_editor(True)
        self.addCleanup(auto_holds.set_editor, False)

    def harness(self, mode="auto", fal=False, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-auto-asks-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), mode=mode, **data)
        self.addCleanup(harness.close)
        if fal:
            harness.config.set_images({"generators": [{"id": "fal", "name": "fal FLUX schnell", "provider": "fal",
                                                       "base_url": self.fake.url, "model": "fal-ai/flux/schnell"}]},
                                      persist=False)
            harness.config.set_image_key("fal", "fal-key", persist=False)
        harness.agent._note_turn_origin(continuing=False)          # a turn the user's own message started
        return harness

    def cards(self, harness):
        return [f for f in harness.stream.frames() if f["type"] == "permission_request"]

    def spent(self):
        return [r for r in self.fake.requests if r["path"].startswith("/fal-ai/")]


class NoCard(Case):
    def test_a_paid_picture_is_made_without_a_card_and_says_its_price(self):
        harness = self.harness(fal=True)
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat", "size": "1024x1024"}))
        self.assertTrue(out.startswith("Made 1 image"), out)
        self.assertIn("$", out, "what it cost is in the result")
        self.assertEqual(self.cards(harness), [])
        self.assertEqual(len(self.spent()), 1)

    def test_in_default_mode_the_card_stays(self):
        harness = self.harness(mode="default", fal=True)
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat"}))
        self.assertIn("DENIED", out)
        self.assertEqual(len(self.cards(harness)), 1)
        self.assertEqual(self.spent(), [])

    def test_the_network_look_and_a_workflows_routing_run_in_auto(self):
        from dgc.permissions import ASK, PermissionEngine
        root = Path(tempfile.mkdtemp(prefix="dgc-auto-perms-"))
        rules = {"allow": [], "ask": [], "deny": []}
        for name in ("router_find", "pips_workflow"):
            decision, why = PermissionEngine("auto", rules, root).decide(name, {})
            self.assertEqual(decision, ALLOW, f"{name} in auto: {why}")
            self.assertEqual(PermissionEngine("default", rules, root).decide(name, {})[0], ASK, f"{name} still asks in default")


class Held(Case):
    def test_a_limit_the_user_set_holds_the_picture_until_their_next_message_says_yes(self):
        harness = self.harness(fal=True)
        block = images.settings(harness.config)
        block["generators"][0].update(asks=False, monthly_limit_usd=5)
        harness.config.set_images(block, persist=False)
        call = ToolCall("g1", "generate_image", {"prompt": "a cat", "model": "fal-ai/brand-new-model"})
        out = harness.agent._handle_call(call)
        self.assertIn(WAITING, out)
        self.assertIn("one plain sentence", out, "the model is told to ask in the chat")
        self.assertIn("carry on", out)
        self.assertEqual(self.cards(harness), [], "no card in auto mode")
        self.assertEqual(self.spent(), [])
        again = harness.agent._handle_call(ToolCall("g2", "generate_image", call.arguments))
        self.assertIn(WAITING, again, "the same turn can't answer it")
        harness.agent._note_turn_origin(continuing=True)              # a goal's own next cycle: not the user
        self.assertIn(WAITING, harness.agent._handle_call(ToolCall("g3", "generate_image", call.arguments)))
        harness.agent._note_turn_origin(continuing=False)             # the user's own next message
        made = harness.agent._handle_call(ToolCall("g4", "generate_image", call.arguments))
        self.assertTrue(made.startswith("Made 1 image"), made)
        self.assertEqual(self.cards(harness), [])
        self.assertEqual(len(self.spent()), 1)

    def test_the_users_own_ask_rule_holds_a_command_in_auto(self):
        harness = self.harness()
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        out = harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo held-by-rule"}))
        self.assertIn(WAITING, out)
        self.assertNotIn("held-by-rule\n", out.split(WAITING)[0], "it didn't run")
        self.assertEqual(self.cards(harness), [])
        harness.agent._note_turn_origin(continuing=False)
        ran = harness.agent._handle_call(ToolCall("u2", "bash", {"command": "echo held-by-rule"}))
        self.assertIn("held-by-rule", ran)
        self.assertNotIn(WAITING, ran)

    def test_a_turn_dgc_started_by_itself_never_answers_a_hold(self):
        harness = self.harness()
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo woken"}))
        harness.agent._woken_by = "wakeup"
        harness.agent._note_turn_origin(continuing=False)
        self.assertIn(WAITING, harness.agent._handle_call(ToolCall("u2", "bash", {"command": "echo woken"})))
        harness.agent._woken_by = ""

    def test_a_held_step_is_said_again_on_the_users_next_turn_until_it_is_answered(self):
        harness = self.harness()
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo pending-one"}))
        harness.agent._note_turn_origin(continuing=False)
        harness.agent._turn_notes_given = set()
        note = harness.agent._turn_notes()
        self.assertIn("Still waiting on the user", note)
        self.assertIn("echo pending-one", note)
        harness.agent._handle_call(ToolCall("u2", "bash", {"command": "echo pending-one"}))   # the answer: yes
        harness.agent._note_turn_origin(continuing=False)
        harness.agent._turn_notes_given = set()
        self.assertNotIn("Still waiting on the user", harness.agent._turn_notes(), "answered: nothing waits")


class TheirWords(Case):
    """Decided 17 Nov: what the user says counts ("its ok, don't ask, keep generating", "use my browser for things").
    The model says so with "user_said_yes" on the call; DGC takes it only in a turn the user's own message started."""

    def test_their_own_words_this_turn_release_a_hold_at_once(self):
        harness = self.harness()
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        self.assertIn(WAITING, harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo go-on"})))
        ran = harness.agent._handle_call(ToolCall("u2", "bash", {"command": "echo go-on", "user_said_yes": True}))
        self.assertIn("go-on", ran)
        self.assertNotIn(WAITING, ran)
        self.assertNotIn("user_said_yes", ran, "DGC's own word, never passed to the tool")

    def test_it_counts_for_nothing_in_a_turn_dgc_started(self):
        harness = self.harness()
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        harness.agent._woken_by = "wakeup"
        harness.agent._note_turn_origin(continuing=False)
        out = harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo woken", "user_said_yes": True}))
        self.assertIn(WAITING, out)
        harness.agent._woken_by = ""

    def test_their_signed_in_chrome_is_asked_about_once_for_the_whole_session(self):
        harness = self.harness()
        agent, secrets = harness.agent, harness.agent._secret_values()
        def ask(url, said_yes=False):
            args = {"signed_in": True, "action": "navigate", "url": url}
            return agent._auto_ask("browser", args, "the user's signed-in Chrome: each new site asks", "b1", args,
                                   secrets, said_yes)
        first = ask("https://shop.example")
        self.assertIn(WAITING, first)
        self.assertIn("once for the whole session", agent.system_prompt())
        agent._turn_notes_given = set()
        agent._note_turn_origin(continuing=False)
        self.assertIn("using your own signed-in Chrome for this session", agent._turn_notes())
        self.assertIsNone(ask("https://shop.example", said_yes=True), "\"use my browser for things\"")
        self.assertIsNone(ask("https://another.example"), "the rest of the session: no more asking, any site")
        self.assertIsNone(ask("https://third.example"))

    def test_a_helper_inherits_the_users_yes(self):
        harness = self.harness()
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        parent = harness.agent
        self.assertIn(WAITING, parent._handle_call(ToolCall("u1", "bash", {"command": "echo helper"})))
        child = type(parent).__new__(type(parent))
        child.__dict__.update({k: v for k, v in parent.__dict__.items()})
        child._parent_agent, child.depth = parent, 1
        child.__dict__.pop("_held_asks", None)
        parent._note_turn_origin(continuing=False)                     # the user said yes; the main agent re-briefs its helper
        secrets = parent._secret_values()
        self.assertIsNone(child._held_in_chat("bash", {"command": "echo helper"}, "rule", "c1", {"command": "echo helper"}, secrets),
                          "the helper's same step runs: the yes is the session's")


class NotTheEditor(Case):
    """A program on DGC's SDK in auto mode answers each permission request itself (on_permission), and the terminal
    shows its own prompt: with no editor on the wire, auto mode asks as it always did (auto_holds.py)."""

    def setUp(self):
        super().setUp()
        from dgc import auto_holds
        auto_holds.set_editor(False)

    def test_an_ask_rule_in_auto_still_sends_its_permission_request(self):
        harness = self.harness()
        harness.config.permissions = {"allow": [], "ask": ["Bash(echo*)"], "deny": []}
        harness.answer("permission_request", {"decision": "once"})
        out = harness.agent._handle_call(ToolCall("u1", "bash", {"command": "echo answered-in-code"}))
        self.assertIn("answered-in-code", out)
        self.assertNotIn(WAITING, out)
        self.assertEqual(len(self.cards(harness)), 1, "the program's own on_permission answers it")

    def test_a_paid_picture_in_auto_still_asks_the_program(self):
        harness = self.harness(fal=True)
        harness.answer("permission_request", {"decision": "no"})
        out = harness.agent._handle_call(ToolCall("g1", "generate_image", {"prompt": "a cat"}))
        self.assertIn("DENIED", out)
        self.assertEqual(self.spent(), [])

    def test_the_prompt_says_nothing_of_the_chat(self):
        self.assertNotIn("one plain sentence", self.harness().agent.system_prompt())


class Prompt(Case):
    def test_auto_mode_tells_the_model_to_ask_in_the_chat_and_carry_on(self):
        text = self.harness().agent.system_prompt()
        for words in ("waits for an approval card", "one plain sentence", "keep doing everything that doesn't depend on",
                      "still waiting on them", "the user's own messages"):
            self.assertIn(words, text)

    def test_other_modes_dont_say_it(self):
        self.assertNotIn("one plain sentence", self.harness(mode="default").agent.system_prompt())


if __name__ == "__main__":
    unittest.main()
