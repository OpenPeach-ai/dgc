"""Image generation in the Python SDK: session.images (generators, update, add, set_key, test, generate, library),
and the CLI's images_* commands and events on the wire, answered by a real `dgc serve`."""
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

from image_fakes import FakeImages  # noqa: E402

from dgc_sdk import AsyncSession, DGCConfigError, DGCUnsupportedError, Images  # noqa: E402
from dgc_sdk.session import Session  # noqa: E402
from dgc_sdk.wire.editor_protocol import command_error, event_error  # noqa: E402

STATUS = {"generators": [{"id": "comfy", "name": "ComfyUI on gpu-box"}], "default": "comfy"}


class Wire:
    def __init__(self):
        self.calls = []

    def request(self, payload, response, **kwargs):
        self.calls.append((dict(payload), response))
        assert command_error(payload) is None, command_error(payload)
        if payload["type"] == "images_generate":
            answer = {"type": "images_result", "seq": 1, "request_id": payload["request_id"], "ok": True,
                      "text": "Made 1 image", "images": [{"path": "/home/me/app/assets/generated/fox.png"}],
                      "generator": "comfy", "model": "sdxl"}
        elif payload["type"] == "images_library":
            answer = {"type": "images_library", "seq": 1, "request_id": payload["request_id"], "images": [], "total": 0}
        else:
            answer = {"type": "images_status", "seq": 1, "request_id": payload["request_id"], "status": STATUS}
            if payload["type"] == "images_update":
                answer["change"] = f"did {payload['action']}"
                if payload["action"] == "test":
                    answer["tested"] = {"comfy": {"ok": True}}
        assert event_error(answer) is None, event_error(answer)
        return answer


def session(wire, caps):
    return Session(wire, {"capabilities": caps}, unhandled="deny", on_permission=None, on_plan=None,
                   on_question=None, isolated=False)


class SessionImages(unittest.TestCase):
    def test_needs_the_capability(self):
        with self.assertRaises(DGCUnsupportedError):
            session(Wire(), {}).images

    def test_each_call_is_one_valid_command(self):
        wire = Wire()
        images = session(wire, {"images": {"version": 1}}).images
        self.assertIsInstance(images, Images)
        self.assertEqual(images.generators(), STATUS)
        self.assertEqual(images.add("comfyui", base_url="gpu-box.local:8188")["change"], "did add_generator")
        images.set_key("fal", "fal-123")
        images.set_default("comfy")
        self.assertEqual(images.test("comfy"), {"comfy": {"ok": True}})
        made = images.generate("a red fox", count=2, save_to="art", approve=True)
        self.assertTrue(made["ok"])
        self.assertEqual(images.library(query="fox")["total"], 0)
        sent = [payload for payload, _ in wire.calls]
        self.assertEqual([p["type"] for p in sent], ["images_list", "images_update", "images_update", "images_update",
                                                       "images_update", "images_generate", "images_library"])
        self.assertEqual((sent[2]["action"], sent[2]["key"]), ("set_key", "fal-123"))
        self.assertEqual((sent[5]["count"], sent[5]["save_to"], sent[5]["approve"]), (2, "art", True))

    def test_a_key_goes_only_with_set_key_and_arguments_are_checked(self):
        images = session(Wire(), {"images": {"version": 1}}).images
        with self.assertRaises(DGCConfigError):
            images.update("add_generator", provider="fal", key="k")
        with self.assertRaises(DGCConfigError):
            images.update("dance")
        with self.assertRaises(DGCConfigError):
            images.update("edit_generator", generator="x", colour="red")
        with self.assertRaises(DGCConfigError):
            images.generate("")
        with self.assertRaises(DGCConfigError):
            images.generate("x", count=9)

    def test_async_parity(self):
        wire = Wire()
        async_session = AsyncSession(session(wire, {"images": {"version": 1}}))

        async def go():
            return await async_session.images.generators(), await async_session.images.generate("x")
        status, made = asyncio.run(go())
        self.assertEqual(status, STATUS)
        self.assertTrue(made["ok"])


class TheBackendOnTheWire(unittest.TestCase):
    """A real `dgc serve`: the capability, each images_* command answered by a valid event, a paid generator held for
    approve, and a key never sent back."""

    def test_commands_and_events(self):
        fake = FakeImages()
        self.addCleanup(fake.close)
        home = Path(tempfile.mkdtemp(prefix="dgc-images-wire-"))
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

        def until(predicate, timeout=60):
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

        def answer(request_id, kind=None):
            return until(lambda e: e.get("request_id") == request_id and (kind is None or e["type"] == kind))
        try:
            ready = until(lambda e: e["type"] == "ready")
            self.assertEqual(ready["capabilities"]["images"],
                             {"version": 1, "commands": ["images_list", "images_update", "images_generate",
                                                         "images_library"], "generators": 0})
            send({"type": "images_list", "request_id": "i1"})
            self.assertEqual(answer("i1", "images_status")["status"]["generators"], [])
            send({"type": "images_update", "request_id": "i2", "action": "add_generator", "provider": "comfyui",
                  "base_url": fake.url, "name": "ComfyUI here"})
            added = answer("i2", "images_status")
            self.assertTrue(added["change"].startswith("Added ComfyUI here"), added["change"])
            self.assertTrue(added["tested"]["comfyui-here"]["ok"])
            send({"type": "images_update", "request_id": "i3", "action": "add_generator", "provider": "fal",
                  "base_url": fake.url, "id": "fal"})
            answer("i3", "images_status")
            send({"type": "images_update", "request_id": "i4", "action": "set_key", "generator": "fal",
                  "key": "fal-wire-secret"})
            keyed = answer("i4", "images_status")
            self.assertTrue(next(g for g in keyed["status"]["generators"] if g["id"] == "fal")["has_key"])
            send({"type": "images_update", "request_id": "i5", "action": "edit_generator", "generator": "fal",
                  "key": "x"})
            self.assertEqual(answer("i5", "command_rejected")["reason"], "invalid_change")
            send({"type": "images_generate", "request_id": "i6", "prompt": "a fox", "generator": "comfyui-here"})
            made = answer("i6", "images_result")
            self.assertTrue(made["ok"], made)
            self.assertTrue(made["images"][0]["path"].startswith(str(home / ".dgc" / "images" / "sessions" / "sdk")),
                            "DGC's own folder unless save_to names a place in the project")
            send({"type": "images_generate", "request_id": "i7", "prompt": "a fox", "generator": "fal"})
            held = answer("i7", "images_result")
            self.assertEqual((held["ok"], held["error"]["kind"]), (False, "needs_approval"))
            self.assertEqual(held["card"]["provider"], "fal.ai")
            send({"type": "images_generate", "request_id": "i8", "prompt": "a fox", "generator": "fal",
                  "approve": True})
            self.assertTrue(answer("i8", "images_result")["ok"])
            send({"type": "images_library", "request_id": "i9"})
            self.assertEqual(answer("i9", "images_library")["total"], 2)
            self.assertNotIn("fal-wire-secret", json.dumps(events))
            self.assertNotIn("fal-wire-secret", (home / ".dgc" / "config.json").read_text())
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


if __name__ == "__main__":
    unittest.main()
