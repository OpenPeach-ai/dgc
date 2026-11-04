"""DGC Router in the Python SDK: session.router.status() / .update() / .probe() / .find() / .set_key(), system= on a run
(its helpers' system), the Pips API 70 router choice, and the CLI's router_* commands and events on the wire."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_dgc_sdk_pips import CAPS, Wire as PipsWire, session as pips_session  # noqa: E402

from dgc_sdk import AsyncSession, DGCConfigError, DGCUnsupportedError, Router  # noqa: E402
from dgc_sdk.session import Session  # noqa: E402
from dgc_sdk.wire.editor_protocol import command_error, event_error  # noqa: E402

STATUS = {"enabled": True, "when_busy": "wait", "systems": [], "workers": {"total": 0, "free": 0, "busy": 0},
          "line": ""}


class Wire:
    def __init__(self):
        self.calls = []

    def request(self, payload, response, **kwargs):
        self.calls.append((dict(payload), response))
        assert command_error(payload) is None, command_error(payload)
        if payload["type"] == "router_suggest":
            assert response == "router_suggestion", response
            answer = {"type": "router_suggestion", "seq": 1, "request_id": payload["request_id"],
                      "suggestion": {"system": payload["system"], "workers": 2, "models": [], "applicable": True}}
            assert event_error(answer) is None, event_error(answer)
            return answer
        answer = {"type": "router_status", "seq": 1, "request_id": payload["request_id"], "status": STATUS}
        if payload["type"] == "router_update":
            answer["change"] = "Turn DGC Router on"
        if payload["type"] == "router_probe":
            answer["probe"] = {"system": payload["system"], "results": {}}
        if payload["type"] == "router_find":
            answer["found"] = {"network": "10.9.8.0/24", "ports": [11434], "found": []}
        if payload["type"] == "router_hardware":
            answer["change"] = "Read NAS's hardware from dgc node at http://nas.local:8577."
        assert event_error(answer) is None, event_error(answer)
        return answer


ROUTER_051 = {"version": 1, "commands": ["router_status", "router_update", "router_probe", "router_find",
                                         "router_hardware", "router_suggest"]}


def session(wire, caps):
    return Session(wire, {"capabilities": caps}, unhandled="deny", on_permission=None, on_plan=None,
                   on_question=None, isolated=False)


class SessionRouter(unittest.TestCase):
    def test_needs_the_capability(self):
        with self.assertRaises(DGCUnsupportedError):
            session(Wire(), {}).router
        with self.assertRaises(DGCUnsupportedError):
            session(Wire(), {}).stream("hello", system="nas")

    def test_each_call_is_one_valid_command(self):
        wire = Wire()
        router = session(wire, {"router": {"version": 1}}).router
        self.assertIsInstance(router, Router)
        self.assertEqual(router.status(), STATUS)
        self.assertEqual(router.update("turn_on")["change"], "Turn DGC Router on")
        router.add_system("gpu-box.local", name="GPU box", jobs=["subagents"], models=["qwen3:8b"])
        router.set_key("gpu-box", "sk-123")
        self.assertEqual(router.probe("gpu-box", checks=["speed"])["system"], "gpu-box")
        self.assertEqual(router.find()["network"], "10.9.8.0/24")
        router.prefer("nas", "qwen3.5:9b")
        sent = [payload for payload, _ in wire.calls]
        self.assertEqual([p["type"] for p in sent], ["router_status", "router_update", "router_update",
                                                       "router_update", "router_probe", "router_find", "router_update"])
        self.assertEqual(sent[2]["action"], "add_system")
        self.assertEqual(sent[2]["jobs"], ["subagents"])
        self.assertEqual((sent[3]["action"], sent[3]["key"]), ("set_key", "sk-123"))
        self.assertEqual((sent[6]["action"], sent[6]["system"], sent[6]["model"]), ("prefer", "nas", "qwen3.5:9b"))

    def test_a_context_by_name(self):
        """0.51: the SDK reads a context as Settings and dgc router do: 16384, "16K", "16k" or "16,384"."""
        wire = Wire()
        router = session(wire, {"router": ROUTER_051}).router
        router.update("set_model", system="nas", model="qwen3:8b", context="16K")
        router.update("set_model", system="nas", model="qwen3:8b", context="24,576")
        router.add_system("gpu-box.local", context="8k")
        router.suggest("nas", context="32k")
        sent = [payload for payload, _ in wire.calls]
        self.assertEqual([p.get("context") for p in sent], [16384, 24576, 8192, 32768])
        for bad in ("1k", "lots", True, 16.5, "nan", "inf", "infk", "nank", "1e5", "-16K"):
            with self.assertRaises(DGCConfigError, msg=repr(bad)):
                router.update("set_model", system="nas", model="qwen3:8b", context=bad)

    def test_a_key_goes_only_with_set_key_and_fields_are_checked(self):
        router = session(Wire(), {"router": {"version": 1}}).router
        with self.assertRaises(DGCConfigError):
            router.update("add_system", base_url="nas.local", key="sk-1")
        with self.assertRaises(DGCConfigError):
            router.update("dance")
        with self.assertRaises(DGCConfigError):
            router.update("edit_system", system="nas", colour="red")

    def test_hardware_and_suggest_are_new_commands_and_a_new_event(self):
        wire = Wire()
        router = session(wire, {"router": ROUTER_051}).router
        self.assertIn("dgc node", router.set_hardware("nas", "http://nas.local:8577", token="dgcn_x")["change"])
        router.set_hardware("nas")                                   # read it now
        router.set_hardware("nas", "")                               # stop it
        self.assertEqual(router.suggest("nas", context=16384)["workers"], 2)
        router.update("apply_suggestion", system="nas", context=16384)
        sent = [payload for payload, _ in wire.calls]
        self.assertEqual([p["type"] for p in sent], ["router_hardware"] * 3 + ["router_suggest", "router_update"])
        self.assertEqual((sent[0]["url"], sent[0]["token"]), ("http://nas.local:8577", "dgcn_x"))
        self.assertNotIn("url", sent[1])
        self.assertEqual(sent[2]["url"], "")
        self.assertEqual(sent[3]["context"], 16384)
        self.assertEqual(sent[4]["action"], "apply_suggestion")
        with self.assertRaises(DGCConfigError):
            router.update("set_hardware", system="nas")           # it has its own command: the token's path
        with self.assertRaises(DGCConfigError):
            router.suggest("nas", context="16 tokens")     # "16k" is read as 16,384 since 0.51 (test_a_context_by_name)

    def test_an_older_cli_says_so_before_sending(self):
        wire = Wire()
        router = session(wire, {"router": {"version": 1, "commands": ["router_status", "router_update",
                                                                        "router_probe", "router_find"]}}).router
        with self.assertRaises(DGCUnsupportedError):
            router.set_hardware("nas", "http://nas.local:8577")
        with self.assertRaises(DGCUnsupportedError):
            router.suggest("nas")
        self.assertEqual(wire.calls, [])

    def test_the_protocol_adds_commands_and_an_event_and_changes_none(self):
        from dgc_sdk.wire.editor_protocol import COMMAND_FIELDS, EVENT_FIELDS
        self.assertEqual(set(COMMAND_FIELDS["router_hardware"]), {"request_id", "system", "url", "token"})
        self.assertEqual(set(COMMAND_FIELDS["router_suggest"]), {"request_id", "system", "context"})
        self.assertEqual(set(EVENT_FIELDS["router_suggestion"]), {"request_id", "suggestion"})
        self.assertEqual(set(EVENT_FIELDS["router_status"]), {"request_id", "status", "change", "probe", "found"})
        self.assertEqual(set(EVENT_FIELDS["router_changed"]), {"status", "why"})
        self.assertNotIn("hardware_url", COMMAND_FIELDS["router_update"], "router_update's command is as it was")
        self.assertIsNotNone(command_error({"type": "router_update", "request_id": "r", "action": "set_hardware",
                                            "hardware_url": "x"}))

    def test_async_parity(self):
        wire = Wire()
        sync = session(wire, {"router": {"version": 1}})
        async_session = AsyncSession(sync)

        async def go():
            return await async_session.router.status(), await async_session.router.update("turn_off")
        status, change = asyncio.run(go())
        self.assertEqual(status, STATUS)
        self.assertEqual(change["change"], "Turn DGC Router on")
        hardware = AsyncSession(session(wire, {"router": ROUTER_051}))

        async def more():
            return (await hardware.router.set_hardware("nas", "nas.local:9100"),
                    await hardware.router.suggest("nas"))
        changed, suggestion = asyncio.run(more())
        self.assertIn("hardware", changed["change"])
        self.assertEqual(suggestion["workers"], 2)


class PipsRouterChoice(unittest.TestCase):
    def test_refused_before_api70_checked_then_sent(self):
        choice = {"mode": "router", "system": "nas", "model": "qwen3.5:9b"}
        wire = PipsWire()
        old = pips_session(wire, caps={**CAPS, "pips_api_version": 69})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 70"):
            old.pips.mutate("create_pip", {"workspace_id": "ws", "name": "Inbox", "goal": "Help",
                                           "model_choice": choice}, approved=True)
        self.assertFalse(wire.calls)
        current = pips_session(wire, caps={**CAPS, "pips_api_version": 70})
        with self.assertRaises(DGCConfigError):
            current.pips.mutate("create_pip", {"workspace_id": "ws", "name": "Inbox", "goal": "Help",
                                               "model_choice": {"mode": "router", "system": "nas"}}, approved=True)
        sent = current.pips.mutate("create_pip", {"workspace_id": "ws", "name": "Inbox", "goal": "Help",
                                                  "model_choice": choice}, approved=True)
        self.assertEqual(sent["request"]["model_choice"], choice)
        current.pips.mutate("create_pip", {"workspace_id": "ws", "name": "Any", "goal": "Help",
                                           "model_choice": {"mode": "router"}}, approved=True)


class TheBackendOnTheWire(unittest.TestCase):
    """A real `dgc serve`: the capability, every router_* command answered by a valid router_status, and router_changed
    once the client has asked."""

    def test_commands_and_events(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-router-wire-"))
        project = home / "project"
        project.mkdir()
        (project / ".git").mkdir()
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({"base_url": "http://127.0.0.1:9/v1", "model": "m",
                                                               "pips_enabled": False}))
        env = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")}
        env.update(HOME=str(home), PYTHONPATH=str(ROOT))
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=project, env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        events = []

        def send(command):
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def until(predicate, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                events.append(event)
                self.assertIsNone(event_error(event), event)
                if predicate(event):
                    return event
            self.fail(f"no matching event; saw {[e.get('type') for e in events][-12:]}")
        try:
            ready = until(lambda e: e["type"] == "ready")
            self.assertEqual(ready["capabilities"]["router"]["commands"],
                             ["router_status", "router_update", "router_probe", "router_find", "router_hardware",
                              "router_suggest", "router_thinking"])
            self.assertFalse(ready["capabilities"]["router"]["enabled"])
            self.assertNotIn("router_status", {t["name"] if isinstance(t, dict) else t for t in ready.get("tools", [])})
            send({"type": "router_status", "request_id": "r1"})
            first = until(lambda e: e["type"] == "router_status" and e.get("request_id") == "r1")
            self.assertEqual(first["status"]["systems"], [])
            send({"type": "router_update", "request_id": "r2", "action": "turn_on"})
            changed = until(lambda e: e["type"] == "router_status" and e.get("request_id") == "r2")
            self.assertEqual(changed["change"], "Turn DGC Router on. There are no systems yet: add one with add_system.")
            self.assertTrue(changed["status"]["enabled"])
            until(lambda e: e["type"] == "router_changed")
            send({"type": "router_update", "request_id": "r3", "action": "turn_on", "key": "sk-1"})
            refused = until(lambda e: e["type"] == "command_rejected" and e.get("request_id") == "r3")
            self.assertEqual(refused["reason"], "key_not_here")
            send({"type": "router_probe", "request_id": "r4", "system": "nope"})
            refused = until(lambda e: e["type"] == "command_rejected" and e.get("request_id") == "r4")
            self.assertIn("no system", refused["message"])
            saved = json.loads((home / ".dgc" / "config.json").read_text())
            self.assertTrue(saved["router"]["enabled"])
        finally:
            try:
                send({"type": "shutdown"})
                proc.wait(timeout=20)
            except Exception:                  # noqa: BLE001
                proc.kill()
                proc.wait()
            for stream in (proc.stdin, proc.stdout):
                try:
                    stream.close()
                except OSError:
                    pass


class HardwareOnTheWire(unittest.TestCase):
    """A real `dgc serve`: router_hardware sets up a dgc node readout with its token (kept in secrets.json, never sent
    back), router_suggest answers router_suggestion, and apply_suggestion makes it the settings."""

    def test_hardware_suggest_and_apply(self):
        from router_fakes import FakeServer
        import router_hw_fixtures as F
        home = Path(tempfile.mkdtemp(prefix="dgc-router-hw-wire-"))
        project = home / "project"
        project.mkdir()
        (project / ".git").mkdir()
        (home / ".dgc").mkdir()
        with FakeServer("ollama") as ollama, F.FakeHardware("dgc_node", token="dgcn_wire_t") as fake:
            (home / ".dgc" / "config.json").write_text(json.dumps({
                "base_url": "http://127.0.0.1:9/v1", "model": "m", "pips_enabled": False,
                "router": {"enabled": False, "systems": [{"id": "gpu", "name": "GPU box", "base_url": ollama.url,
                                                          "server": "ollama",
                                                          "models": [{"name": "qwen3:8b", "context": 32768}]}]}}))
            env = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")}
            env.update(HOME=str(home), PYTHONPATH=str(ROOT))
            proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=project, env=env,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            events = []

            def send(command):
                proc.stdin.write(json.dumps(command) + "\n")
                proc.stdin.flush()

            def until(predicate, timeout=30):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    line = proc.stdout.readline()
                    if not line:
                        break
                    event = json.loads(line)
                    events.append(event)
                    self.assertIsNone(event_error(event), event)
                    if predicate(event):
                        return event
                self.fail(f"no matching event; saw {[e.get('type') for e in events][-12:]}")
            try:
                ready = until(lambda e: e["type"] == "ready")
                self.assertEqual(ready["capabilities"]["permission_choices"], 1)
                send({"type": "router_probe", "request_id": "p1", "system": "gpu", "checks": ["models"]})
                probed = until(lambda e: e["type"] == "router_status" and e.get("request_id") == "p1")
                self.assertIn("suggest", probed["probe"])
                send({"type": "router_hardware", "request_id": "h1", "system": "gpu", "url": fake.url,
                      "token": "dgcn_wire_t"})
                done = until(lambda e: e["type"] == "router_status" and e.get("request_id") == "h1")
                self.assertIn("RTX 4090 · 18 of 24 GB · 34% · 61°C · 288 W", done["change"])
                hardware = done["status"]["systems"][0]["hardware"]
                self.assertEqual((hardware["source"], hardware["has_token"]), ("node", True))
                self.assertNotIn("dgcn_wire_t", json.dumps(done))
                send({"type": "router_suggest", "request_id": "s1", "system": "gpu", "context": 16384})
                suggestion = until(lambda e: e["type"] == "router_suggestion" and e.get("request_id") == "s1")
                plan = suggestion["suggestion"]["models"][0]
                self.assertEqual((plan["basis"], plan["context"]), ("memory", 16384))
                self.assertIn("fit in 24 GB", plan["line"])
                send({"type": "router_update", "request_id": "a1", "action": "apply_suggestion", "system": "gpu",
                      "context": 16384})
                applied = until(lambda e: e["type"] == "router_status" and e.get("request_id") == "a1")
                self.assertIn("Applied: GPU box · qwen3:8b", applied["change"])
                send({"type": "router_suggest", "request_id": "s2", "system": "nowhere"})
                refused = until(lambda e: e["type"] == "command_rejected" and e.get("request_id") == "s2")
                self.assertEqual(refused["reason"], "unknown_system")
            finally:
                try:
                    send({"type": "shutdown"})
                    proc.wait(timeout=20)
                except Exception:              # noqa: BLE001
                    proc.kill()
                    proc.wait()
                for stream in (proc.stdin, proc.stdout):
                    try:
                        stream.close()
                    except OSError:
                        pass
        secrets = json.loads((home / ".dgc" / "secrets.json").read_text())
        self.assertEqual(secrets["router_key_gpu:hardware"], "dgcn_wire_t")
        self.assertNotIn("dgcn_wire_t", (home / ".dgc" / "config.json").read_text())
        saved = json.loads((home / ".dgc" / "config.json").read_text())["router"]["systems"][0]
        self.assertEqual(saved["hardware"], {"source": "node", "url": fake.url})
        self.assertEqual(saved["models"][0]["context"], 16384)


if __name__ == "__main__":
    unittest.main()
