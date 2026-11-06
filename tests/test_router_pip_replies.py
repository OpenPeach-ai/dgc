"""A Pip's chat reply on DGC Router (reported 2026-11-02: every one failed at once with "Saved reply options do not
match the settings the reply ran with"). The worker a routed reply leases has its own fixed context (16K on a small
GPU) while the Pip's chat options ask for main DGC's window (64K): the reply records and checks the context it runs
with, through the real queue, controller and worker process, and every other reply is checked exactly as before.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_chat_options as options, pips
from dgc import router as R
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

BLOCK = {"enabled": True, "when_busy": "wait", "systems": [
    {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama", "jobs": ["pips"],
     "models": [{"name": "qwen3.5:9b", "workers": 1, "context": 16384}]},
    {"id": "gpu", "name": "GPU box", "base_url": "http://gpu-box.local:8080", "server": "llamacpp",
     "jobs": ["subagents", "pips"], "models": [{"name": "qwen3:8b", "workers": 1, "context": 32768}]}]}

# The real worker entry point, with only the provider adapter replaced: the reply says where it ran and with what
# context, which is what the Agent's client was given.
WORKER = r'''
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult
from dgc.pips import _worker_main
def chat(self, messages, tools=None, on_text=None, **kwargs):
    text = f"ran {self.model} at {self.base_url} with context {self.context_size}"
    if on_text:
        on_text(text)
    return ChatResult(content=text)
with patch.object(LLMClient, "chat", chat), patch.object(LLMClient, "prepare_model", return_value={}), \
     patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''


class RoutedReplies(unittest.TestCase):
    setUp_local = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        self.setUp_local()
        for item in (patch.object(R, "ROUTER", R.Router()), patch.object(R.Router, "ensure_health", lambda s, c: None)):
            item.start()
            self.addCleanup(item.stop)
        pips._ROUTER_RUNS.clear()
        self.cfg.data["router"] = copy.deepcopy(BLOCK)
        self.cfg.data["context_size"] = 65536              # main DGC's window: what a Pip's reply asks for
        self.commit()

    def pip(self, choice):
        return self.store.create(self.workspace["id"], "Backend Auditor", "Inspect correctness.", "device_1",
                                 model_choice=choice)

    def reply(self, pip, chat_options=None, text="Explain the source", key="message-1"):
        sent = pip_chat.send(self.store, pip["id"], text, key, "device_1", self.cfg, chat_options=chat_options)
        row = self.store.claim_next(admit=lambda run_id, manifest: pips._router_admit(self.cfg, run_id, manifest)
                                    is not False)
        self.assertEqual(row["id"], sent["run"]["id"])
        events = []
        original_process, original_event = subprocess.Popen, self.registry.event

        def process(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", WORKER]
            return original_process(argv, *args, **kwargs)

        def event(workspace_id, event_type, **kwargs):
            events.append((event_type, kwargs.get("payload")))
            return original_event(workspace_id, event_type, **kwargs)
        try:
            with patch.object(pips.subprocess, "Popen", side_effect=process), \
                 patch.object(self.registry, "event", side_effect=event):
                result = pips._execute_run(self.registry, row, self.cfg)
        finally:
            pips._router_release(row["id"])
        return result, events, json.loads(row["manifest"])

    def test_a_reply_on_any_pip_system_runs_with_its_workers_context(self):
        result, events, manifest = self.reply(self.pip({"mode": "router"}),
                                              {"context_size": 65536, "thinking": "off"})
        self.assertEqual(result["text"], "ran qwen3.5:9b at http://nas.local:11434/v1 with context 16384")
        routed = next(payload for kind, payload in events if kind == "pip_run_routed")
        self.assertEqual(routed, {"system": "NAS", "model": "qwen3.5:9b", "context": 16384},
                         "the run says where it ran, and with what context")
        self.assertEqual(manifest["chat_options"], {"context_size": 65536, "thinking": "off"},
                         "the stored reply keeps the Pip's own choice")
        self.assertEqual(options.saved(self.registry.db, manifest["pip_id"]),
                         {"context_size": 65536, "thinking": "off"}, "the prompt box still shows the Pip's choice")
        self.assertEqual(R.ROUTER.leases(), [], "its worker is given back")

    def test_the_reply_keeps_the_computer_that_answered(self):
        """Seen in testing: a Pip on DGC Router (any system) said nothing of which computer answered. The reply keeps
        the system and model it ran on, in words, for its details and the prompt box's chip (media pipsClient)."""
        def answered(choice, options, key):
            pip = self.pip(choice)
            result, _, _ = self.reply(pip, options, key=key)
            run_id = self.registry.db.execute("SELECT id FROM pip_runs WHERE pip_id=? ORDER BY rowid DESC LIMIT 1",
                                              (pip["id"],)).fetchone()[0]
            self.store.finish(run_id, result=result)          # what the controller does with the worker's answer
            [reply] = [m for m in pip_chat.list_messages(self.store, pip["id"])["messages"] if m["role"] == "assistant"]
            return reply["model"]
        self.assertEqual(answered({"mode": "router"}, {"context_size": 65536, "thinking": "off"}, "m1"),
                         "qwen3.5:9b on NAS (DGC Router)")
        self.assertEqual(answered({"mode": "router", "system": "gpu", "model": "qwen3:8b"},
                                  {"context_size": 8192, "thinking": "high"}, "m2"), "qwen3:8b on GPU box (DGC Router)")

    def test_a_reply_on_one_system_and_model(self):
        result, events, _ = self.reply(self.pip({"mode": "router", "system": "gpu", "model": "qwen3:8b"}),
                                       {"context_size": 8192, "thinking": "high"})
        self.assertEqual(result["text"], "ran qwen3:8b at http://gpu-box.local:8080/v1 with context 32768",
                         "the worker's fixed context, so its server never reloads the model")

    def test_a_pip_on_default_with_pips_run_on_the_router(self):
        self.cfg.data["pips_model"] = "router"
        result, _, manifest = self.reply(self.pip({"mode": "default"}), {"context_size": 65536, "thinking": "off"})
        self.assertEqual(manifest["model"], "router")
        self.assertEqual(result["text"], "ran qwen3.5:9b at http://nas.local:11434/v1 with context 16384")

    def test_a_reply_without_its_own_options(self):
        result, _, manifest = self.reply(self.pip({"mode": "router"}))
        self.assertNotIn("chat_options", manifest)
        self.assertEqual(result["text"], "ran qwen3.5:9b at http://nas.local:11434/v1 with context 16384")

    def test_the_history_is_prepared_for_the_smallest_window_the_reply_may_get(self):
        prepared = []
        original = pip_chat.prepare

        def prepare(*args, **kwargs):
            prepared.append(kwargs["context_size"])
            return original(*args, **kwargs)
        with patch.object(pip_chat, "prepare", prepare):
            self.reply(self.pip({"mode": "router"}), {"context_size": 65536, "thinking": "off"})
            self.reply(self.pip({"mode": "router", "system": "gpu", "model": "qwen3:8b"}),
                       {"context_size": 65536, "thinking": "off"}, key="message-2")
            self.reply(self.pip({"mode": "router", "system": "gpu", "model": "qwen3:8b"}),
                       {"context_size": 8192, "thinking": "off"}, key="message-3")
        self.assertEqual(prepared, [16384, 32768, 8192])


class StrictElsewhere(unittest.TestCase):
    """Validation is unchanged: a reply whose settings differ from its options still fails, routed or not."""

    def manifest(self, **settings):
        return {"run_kind": "conversation", "chat_options": {"context_size": 65536, "thinking": "off"},
                "model_settings": {"model": "m", "base_url": "http://x.local/v1", "context_size": 65536,
                                   "thinking": "off", "think_budget_tokens": 2048, "provider_capabilities": {},
                                   "max_tokens": 4096, "max_turns": 0, **settings}}

    def test_a_changed_context_is_still_refused(self):
        self.assertEqual(options.validate_manifest(self.manifest())["context_size"], 65536)
        with self.assertRaises(RegistryError) as raised:
            options.validate_manifest(self.manifest(context_size=16384))
        self.assertEqual(raised.exception.code, "invalid_chat_options")

    def test_the_routed_manifest_changes_only_a_router_runs_context(self):
        manifest = self.manifest()
        route = R.Route(lease_id="l", system_id="nas", system_name="NAS", model="qwen3.5:9b",
                        base_url="http://nas.local:11434", server="ollama", api_mode="", context=16384)
        routed = pips._routed_manifest(manifest, route, {**manifest["model_settings"], "context_size": 16384})
        self.assertEqual(routed["chat_options"], {"context_size": 16384, "thinking": "off"})
        self.assertEqual(options.validate_manifest(routed)["context_size"], 16384)
        self.assertEqual(manifest["chat_options"]["context_size"], 65536, "the caller's manifest is not changed")
        without = {key: value for key, value in manifest.items() if key != "chat_options"}
        self.assertNotIn("chat_options", pips._routed_manifest(without, route, manifest["model_settings"]))


if __name__ == "__main__":
    unittest.main()
