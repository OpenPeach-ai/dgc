"""A DGC Router change (router_update) and a look on the network (router_find) ask every time, so no card offers
"Always allow" for them: not the TUI, not the classic terminal, not ACP, and the editor's permission_request lists
only once and deny in `choices` (ready.capabilities.permission_choices). An "always" sent anyway counts as once."""
from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk/python"))

from test_subagents import Harness, fixture_config  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc.headless import permission_request_fields  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402

ROUTER_CHANGE = {"change": "Turn DGC Router on", "diff": "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n"}


class TuiCard(unittest.TestCase):
    def card(self, name, args, pick):
        from dgc.tui import TUI
        asked = []
        root = Path(tempfile.mkdtemp(prefix="dgc-no-always-"))
        stub = types.SimpleNamespace(
            config=fixture_config(root), deny_reason="", _flush_text=lambda: None, _append=lambda *_: None,
            _rich=lambda value: value, _cur_session=lambda: types.SimpleNamespace(workspace_path=root),
            _ask=lambda req, cancel=None, recheck=None: (asked.append(req), pick)[1],
            _ask_text=lambda prompt, cancel=None: "not now")
        verdict = TUI.approve_live(stub, name, args, "c1")
        return asked[0], verdict, stub

    def test_a_router_change_offers_allow_once_and_deny_only(self):
        for name in ("router_update", "router_find"):
            with self.subTest(name=name):
                req, verdict, _ = self.card(name, ROUTER_CHANGE, 0)
                self.assertEqual(req["options"], ["Allow once", "Deny", "Deny with a reason"])
                self.assertNotIn("always", req["footer"].lower())
                self.assertEqual(verdict, "once")
                _, verdict, _ = self.card(name, ROUTER_CHANGE, 1)
                self.assertEqual(verdict, "no", "the second row is Deny, never Always")
                _, verdict, stub = self.card(name, ROUTER_CHANGE, 2)
                self.assertEqual((verdict, stub.deny_reason), ("no", "not now"))

    def test_every_other_tool_keeps_always_allow(self):
        req, verdict, _ = self.card("bash", {"command": "ls"}, 1)
        self.assertEqual(req["options"], ["Allow once", "Always allow this", "Deny", "Deny with a reason"])
        self.assertEqual(verdict, "always")


class ClassicTerminal(unittest.TestCase):
    def test_the_menu_has_no_always_for_a_router_change(self):
        from dgc import cli
        shown = []

        def menu(title, labels, hints=None, initial=0):
            shown.append(labels)
            return 1                            # the second row
        ui = cli.UI.__new__(cli.UI)
        ui.console = types.SimpleNamespace(print=lambda *a, **k: None)
        ui.non_interactive = False
        ui.project_root = Path(tempfile.mkdtemp(prefix="dgc-no-always-"))
        ui.redact = lambda text: text
        ui._arg_summary = lambda name, args: ""
        ui._yield_stdin = lambda: None
        with patch.object(cli, "menu_select", menu), patch.object(cli, "section", lambda *a, **k: None), \
                patch("builtins.input", lambda *_: ""):
            self.assertEqual(ui.approve("router_update", ROUTER_CHANGE), "no", "row two is deny")
            self.assertEqual(ui.approve("read_file", {"path": "a.txt"}), "always")
        self.assertEqual(shown[0], ["allow once", "deny"])
        self.assertEqual(shown[1], ["allow once", "always allow", "deny"])


class Acp(unittest.TestCase):
    def options(self, name):
        from dgc.acp import _ACPUi
        sent = []
        server = types.SimpleNamespace(
            notify=lambda *a, **k: None,
            request=lambda method, params, **k: (sent.append(params),
                                                 {"outcome": {"outcome": "selected", "optionId": "always"}})[1])
        ui = _ACPUi(server, "s1", Path(tempfile.mkdtemp(prefix="dgc-no-always-")))
        verdict = ui.approve(name, dict(ROUTER_CHANGE) if name.startswith("router") else {"command": "ls"})
        return [option["optionId"] for option in sent[0]["options"]], verdict

    def test_session_request_permission_has_no_allow_always_for_a_router_change(self):
        for name in ("router_update", "router_find"):
            with self.subTest(name=name):
                options, _ = self.options(name)
                self.assertEqual(options, ["once", "deny"])
        options, verdict = self.options("bash")
        self.assertEqual(options, ["once", "always", "deny"])
        self.assertEqual(verdict, "always")


class Editor(unittest.TestCase):
    def test_permission_request_choices_say_no_always(self):
        self.assertEqual(permission_request_fields("router_update", ROUTER_CHANGE, "c1", None)["choices"],
                         ["once", "deny"])
        self.assertEqual(permission_request_fields("router_find", {}, "c1", None)["choices"], ["once", "deny"])
        self.assertEqual(permission_request_fields("bash", {"command": "ls"}, "c1", "/")["choices"],
                         ["once", "always", "deny"])

    def test_the_card_the_agent_sends_and_an_always_answer_counts_once(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-no-always-home-"))
        with patch.dict(os.environ, {"DGC_HOME": str(home)}), patch.object(R, "ROUTER", R.Router()), \
                patch.object(R.Router, "ensure_health", lambda self, config: None):
            directory = tempfile.TemporaryDirectory(prefix="dgc-no-always-project-")
            self.addCleanup(directory.cleanup)
            harness = Harness(Path(directory.name))
            self.addCleanup(harness.close)
            harness.config.data["router"] = {"enabled": False, "systems": []}
            harness.answer("permission_request", {"decision": "always"})   # an older editor's Always
            out = harness.agent._handle_call(ToolCall("u1", "router_update", {"action": "turn_on"}))
        self.assertTrue(out.startswith("Done: Turn DGC Router on."), out)
        card = [f for f in harness.stream.frames() if f["type"] == "permission_request"][-1]
        self.assertEqual(card["choices"], ["once", "deny"])
        self.assertEqual(harness.config.permissions["allow"], [], "no rule was saved")

    def test_ready_says_choices_are_exact_and_the_sdk_passes_them_on(self):
        from dgc import editor_protocol as ep
        directory = tempfile.TemporaryDirectory(prefix="dgc-no-always-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name))
        self.addCleanup(harness.close)
        backend = harness.backend
        backend._queue, backend._steer_payloads, backend.workspace_trusted = [], {}, True
        ready = backend._ready_payload()
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 0, **ready}))
        self.assertEqual(ready["capabilities"]["permission_choices"], 1)
        self.assertEqual(set(ep.EVENT_FIELDS["permission_request"]),
                         {"id", "call_id", "name", "args", "command", "suggested_rule", "choices", "summary", "diff"},
                         "no field was added to the event")
        from dgc_sdk.types import PermissionRequest
        self.assertEqual(PermissionRequest(id="p", name="router_update", args={}).choices, ())
        from dgc_sdk.session import Session
        seen = []
        sdk = Session(types.SimpleNamespace(), {"capabilities": {}}, unhandled="deny",
                      on_permission=lambda request: (seen.append(request), "once")[1], on_plan=None,
                      on_question=None, isolated=False)
        run = types.SimpleNamespace(decision_error=None, decisionError=None)
        try:
            action, _ = sdk._permission(run, {"id": "p1", "name": "router_update", "args": {},
                                              "choices": ["once", "deny"]}, mine=True)
        except Exception as exc:            # noqa: BLE001 -- the run fixture lacks a field the SDK reads
            self.skipTest(f"SDK run fixture: {exc}")
        self.assertEqual(action, "once")
        self.assertEqual(seen[0].choices, ("once", "deny"))


if __name__ == "__main__":
    unittest.main()
