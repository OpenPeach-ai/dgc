"""A helper and a Pip fix run in their chat's mode as it is now, held for that chat or saved.

Reported on the 0.51.0 release candidate: a Work chat's chip said "auto", yet each Pip fix asked "Run apply_patch /
Helper: Fix what GST watchdog found" with Allow once, Always allow and Deny. Since 0.50.1 a mode chosen in a Work chat
is held for that chat, so every new chat starts in the saved Default and the user picks Auto after things have
started. A helper's config is a copy made when it starts: a fix pressed first and Auto chosen next went on asking at
every step (seen in real VS Code: eight Allow cards after the switch). The task tool's helpers did the same.

The rules that stay: no helper runs in plan mode (one running when its chat goes to plan asks instead); it rises to
acceptEdits or auto only where the chat's workspace is trusted; the user's ask and deny rules still apply; Default
still asks. Real Backend (frames through the protocol validator), real Git project, the real Config.clone_for_root;
only the model is scripted. Run with HOME pointed at a temporary folder.
"""
from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from dgc.llm import ChatResult, LLMClient, ToolCall
from tests.test_pip_fix import FixScene, wait_for
from tests.test_subagents import Script

PATCH = ("--- a/app/gst.py\n+++ b/app/gst.py\n@@ -1,2 +1,2 @@\n def total(x):\n-    return x\n"
         "+    return x * 118 // 100\n")
FIXED = "def total(x):\n    return x * 118 // 100\n"


class ModeScene(FixScene):
    """FixScene with the real clone_for_root, a trusted project, and every Allow card answered Allow once."""

    MODE = "default"
    TRUSTED = True

    def setUp(self):
        super().setUp()
        for item in self.patches:              # the real copy a helper gets, not the test fixture's
            item.stop()
        self.patches = []
        if self.TRUSTED:
            self.cfg.data["trusted_dirs"] = [str(self.root)]

    def make(self):
        backend = super().make()
        self.asked = []
        stop = threading.Event()
        self.addCleanup(stop.set)

        def respond():
            answered = set()
            while not stop.wait(0.02):
                for frame in self.wire.of("permission_request"):
                    if frame["id"] not in answered:
                        answered.add(frame["id"])
                        self.asked.append(frame)
                        backend.pending.resolve(frame["id"], {"decision": "once"})
        threading.Thread(target=respond, daemon=True).start()
        return backend

    def asked_for(self, name):
        return [frame for frame in self.asked if frame["name"] == name]

    # The user changes the chat's mode while its helper runs: from the editor's mode picker (held for this chat, as
    # `dgc serve` does it) or as the saved setting.
    def switch(self, backend, mode, how):
        if how == "held":
            backend.dispatch({"type": "set_mode", "mode": mode, "live": True, "request_id": f"mode-{mode}"})
            wait_for(lambda: any(f.get("request_id") == f"mode-{mode}" for f in self.wire.of("mode_changed")),
                     what="the mode change")
            self.assertIn("mode", backend.agent.config._held_keys, "held for this chat")
        elif how == "saved":
            backend.agent.set_mode(mode)
            self.assertNotIn("mode", getattr(backend.agent.config, "_held_keys", set()), "saved, not held")
        else:
            raise AssertionError(how)
        self.assertEqual(backend.agent.mode, mode)

    def fix_with(self, backend, *, switch_to=None, how="held"):
        """Start a fix whose fixer patches app/gst.py; `switch_to` changes the chat's mode once the fixer is running.
        Returns (the fix's last record, the system prompt of the fixer's last request)."""
        run = self.report(backend)
        prompts = []

        def route(messages, results, cancel):
            prompts.append(str(messages[0]["content"]))
            if not results:
                if switch_to:
                    self.switch(backend, switch_to, how)
                return ChatResult(tool_calls=[ToolCall("p1", "apply_patch", {"path": "app/gst.py", "patch": PATCH})])
            return ChatResult(content="Fixed the GST total.\nTESTS: not run — no tests here")
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", route)])):
            self.start(backend, run)
            row = self.ended(run)
        return row, prompts[-1]

    def helper_with(self, backend, *, switch_to=None, how="held"):
        """A turn that starts one task helper; the helper writes notes.txt. Returns the helper's write's tool_result."""
        prompts = []

        def child(messages, results, cancel):
            prompts.append(str(messages[0]["content"]))
            if not results:
                if switch_to:
                    self.switch(backend, switch_to, how)
                return ChatResult(tool_calls=[ToolCall("w1", "write_file", {"path": "notes.txt", "content": "seed\n"})])
            return ChatResult(content="Wrote notes.txt.")

        def parent(messages, results, cancel):
            # The chat's own transcript starts with its first message: this turn is from the last prompt on.
            asked = max(i for i, m in enumerate(messages) if m.get("role") == "user"
                        and "Delegate the notes" in str(m.get("content")))
            if not any(m.get("role") == "tool" for m in messages[asked:]):
                return ChatResult(tool_calls=[ToolCall("t1", "task", {"description": "write the notes",
                                                                      "prompt": "HELPER: write notes.txt"})])
            return ChatResult(content="Done.")
        turns = len(self.wire.of("turn_end"))
        with patch.object(LLMClient, "chat", Script([("HELPER:", child), ("Set up a daily audit", parent)])):
            backend.dispatch({"type": "prompt", "text": "Delegate the notes to a helper", "request_id": "p1"})
            wait_for(lambda: len(self.wire.of("turn_end")) > turns, 60, "the turn to end")
        writes = [f for f in self.wire.of("tool_result") if f["name"] == "write_file" and ":w1" in str(f.get("call_id"))]
        self.assertEqual(len(writes), 1, writes)
        return writes[0], prompts[-1]


class HeldAutoTests(ModeScene):
    def test_a_fix_runs_without_a_card_once_its_chat_is_set_to_auto_from_the_mode_picker(self):
        backend = self.make()
        row, prompt = self.fix_with(backend, switch_to="auto", how="held")
        self.assertEqual(self.asked_for("apply_patch"), [], "Auto held for the chat: the fixer's edit asks nothing")
        self.assertEqual(row["state"], "applied", row)
        self.assertEqual((self.root / "app" / "gst.py").read_text(), FIXED)
        self.assertIn("# Permission mode: auto", prompt, "and its prompt says the mode it runs in now")
        self.assertEqual(self.cfg.data["mode"], "auto")
        self.assertIn("mode", self.cfg._held_keys, "never saved as the user's mode")

    def test_a_task_helper_edits_without_a_card_once_its_chat_is_set_to_auto_from_the_mode_picker(self):
        backend = self.make()
        result, prompt = self.helper_with(backend, switch_to="auto", how="held")
        self.assertEqual(self.asked_for("write_file"), [], "Auto held for the chat: the helper's edit asks nothing")
        self.assertFalse(result.get("is_error"), result)
        self.assertIn("# Permission mode: auto", prompt)
        self.assertEqual([f["name"] for f in self.asked], ["task"], "only Default's own card for starting the helper")

    def test_a_chat_already_in_held_auto_asks_nothing_for_a_fix_or_a_helper(self):
        backend = self.make()
        self.switch(backend, "auto", "held")
        row, _prompt = self.fix_with(backend)
        self.helper_with(backend)
        self.assertEqual(self.asked, [])
        self.assertEqual(row["state"], "applied", row)


class SavedAutoTests(ModeScene):
    def test_a_fix_and_a_helper_run_without_a_card_once_auto_is_saved(self):
        backend = self.make()
        row, _prompt = self.fix_with(backend, switch_to="auto", how="saved")
        self.assertEqual(self.asked_for("apply_patch"), [])
        self.assertEqual(row["state"], "applied", row)
        backend.agent.set_mode("default")
        self.asked.clear()
        self.helper_with(backend, switch_to="auto", how="saved")
        self.assertEqual(self.asked_for("write_file"), [])

    def test_a_chat_saved_in_auto_from_the_start_asks_nothing(self):
        self.cfg.data["mode"] = "auto"
        backend = self.make()
        row, _prompt = self.fix_with(backend)
        self.helper_with(backend)
        self.assertEqual(self.asked, [])
        self.assertEqual(row["state"], "applied", row)


class StillAsksTests(ModeScene):
    def test_default_still_asks_for_a_fix_and_a_helper(self):
        backend = self.make()
        row, prompt = self.fix_with(backend)
        self.assertEqual(len(self.asked_for("apply_patch")), 1, "Default asks before the fixer's edit")
        self.assertEqual(row["state"], "applied", row)
        self.assertIn("# Permission mode: default", prompt)
        self.helper_with(backend)
        self.assertEqual(len(self.asked_for("write_file")), 1, "and before the helper's")

    def test_lowered_to_default_while_it_runs_it_asks_again(self):
        self.cfg.data["mode"] = "auto"
        backend = self.make()
        self.fix_with(backend, switch_to="default", how="held")
        self.assertEqual(len(self.asked_for("apply_patch")), 1, "the chat lowered to Default: the fixer asks")

    def test_an_ask_rule_still_asks_in_auto(self):
        self.cfg.permissions["ask"] = ["ApplyPatch", "Write"]
        backend = self.make()
        self.fix_with(backend, switch_to="auto", how="held")
        self.helper_with(backend)
        self.assertEqual(len(self.asked_for("apply_patch")), 1, "the user's ask rule beats Auto for a fix")
        self.assertEqual(len(self.asked_for("write_file")), 1, "and for a helper")
        self.assertEqual(self.asked_for("apply_patch")[0].get("choices"), ["once", "deny"],
                         "an ask rule's card offers no Always allow")

    def test_a_deny_rule_still_denies_in_auto(self):
        self.cfg.permissions["deny"] = ["ApplyPatch"]
        backend = self.make()
        row, _prompt = self.fix_with(backend, switch_to="auto", how="held")
        self.assertEqual(self.asked_for("apply_patch"), [])
        denied = [f for f in self.wire.of("tool_denied") if f["name"] == "apply_patch"]
        self.assertEqual(len(denied), 1)
        self.assertEqual((self.root / "app" / "gst.py").read_text(), "def total(x):\n    return x\n")
        self.assertEqual(row["state"], "unchanged", row)

    def test_a_running_fix_whose_chat_goes_to_plan_asks_and_is_never_in_plan(self):
        self.cfg.data["mode"] = "auto"
        backend = self.make()
        row, prompt = self.fix_with(backend, switch_to="plan", how="held")
        self.assertEqual(len(self.asked_for("apply_patch")), 1, "asked, as in Default, not refused as plan mode")
        self.assertEqual(row["state"], "applied", row)
        self.assertNotIn("# Permission mode: plan", prompt)


class UntrustedTests(ModeScene):
    TRUSTED = False

    def test_an_untrusted_workspace_never_raises_a_running_helper_to_auto(self):
        backend = self.make()
        run = self.report(backend)

        def route(messages, results, cancel):
            if not results:
                backend.agent.set_mode("auto", persist=False)     # not through the editor, which asks for trust
                return ChatResult(tool_calls=[ToolCall("p1", "apply_patch", {"path": "app/gst.py", "patch": PATCH})])
            return ChatResult(content="Fixed.\nTESTS: not run — none")
        with patch.object(LLMClient, "chat", Script([("Fix what Pip", route)])):
            self.start(backend, run)
            self.ended(run)
        self.assertEqual(len(self.asked_for("apply_patch")), 1, "not trusted: it stays in Default and asks")


if __name__ == "__main__":
    unittest.main()
