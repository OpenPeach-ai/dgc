"""Images in a Pip's chat: checked like the main chat's, kept once by digest, listed with their
message, fetched one at a time, and handed to the Pip's model as image parts."""
import base64
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_chat, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
DOT = "data:image/png;base64," + base64.b64encode(PNG).decode()
OTHER = "data:image/png;base64," + base64.b64encode(PNG + b"\0").decode()


# A photo-sized image: far over every other Pips request's 16-32 KiB budget, under the 2 MB limit.
PHOTO = "data:image/png;base64," + base64.b64encode(PNG + b"\0" * 1_400_000).decode()


class PipChatImageTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def pip(self):
        return self.store.create(self.registry.personal()["id"], "Gmail", None, "editor-user", pip_type="lens")

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_an_image_is_kept_once_listed_with_its_message_and_fetched_back(self):
        pip = self.pip()
        sent = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "What is this?",
                             "idempotency_key": "k1", "images": [DOT]})
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual(sent["result"]["message"]["images"], [{"index": 0, "mime": "image/png", "bytes": len(PNG)}])
        kept = list(pip_chat.image_directory(self.registry.directory, pip["id"]).iterdir())
        self.assertEqual(len(kept), 1)
        self.assertEqual(oct(kept[0].stat().st_mode & 0o777), "0o600")
        [message] = pip_chat.list_messages(self.store, pip["id"])["messages"]
        self.assertEqual(message["images"][0]["index"], 0)
        got = self.control({"type": "get_pip_message_image", "pip_id": pip["id"], "message_id": message["id"], "index": 0})
        self.assertTrue(got["ok"], got.get("error"))
        self.assertEqual(got["result"]["image"], DOT)

    def test_a_photo_sized_image_passes_the_whole_transport_and_nothing_else_grows(self):
        from dgc.headless import _bounded_pips_command
        pip = self.pip()
        request = {"type": "send_pip_message", "pip_id": pip["id"], "text": "What is this?",
                   "idempotency_key": "k1", "images": [PHOTO], "request_id": "r1"}
        bounded = _bounded_pips_command({"type": "pips_control", "request": request})
        self.assertEqual(bounded["request"]["images"], [PHOTO])
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            sent = pips.handle_control(self.cfg, bounded["request"], "editor-user", start_worker=False)
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual(sent["result"]["message"]["images"][0]["bytes"], len(PNG) + 1_400_000)
        for name, changed in (("over 2 MB in all", {"images": [PHOTO, PHOTO]}),
                              ("five images", {"images": [DOT] * 5}),
                              ("not an image", {"images": ["data:text/plain;base64,aGk="]}),
                              ("a long text still has its limit", {"text": "x" * 40000}),
                              ("another command gets no image budget", {"type": "run_pip", "images": [PHOTO]})):
            with self.subTest(name):
                with self.assertRaises(RegistryError):
                    _bounded_pips_command({"type": "pips_control", "request": {**request, **changed}})
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            for changed in ({"images": [PHOTO, PHOTO]}, {"text": "x" * 20000}):
                refused = pips.handle_control(self.cfg, {**request, "idempotency_key": "k2", **changed}, "editor-user", start_worker=False)
                self.assertFalse(refused["ok"])

    def test_an_image_only_message_reads_as_one(self):
        pip = self.pip()
        sent = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "", "idempotency_key": "k1", "images": [DOT]})
        self.assertTrue(sent["ok"], sent.get("error"))
        self.assertEqual(sent["result"]["message"]["text"], pip_chat.IMAGE_ONLY_TEXT)

    def test_what_is_not_a_small_real_image_is_refused_and_nothing_is_kept(self):
        pip = self.pip()
        fake = "data:image/png;base64," + base64.b64encode(b"not a png at all").decode()
        big = "data:image/png;base64," + base64.b64encode(PNG + b"\0" * (pip_chat.MAX_CHAT_IMAGE_BYTES)).decode()
        for images in ([fake], ["https://example.com/a.png"], [DOT] * 5, [big]):
            with self.subTest(n=len(images)):
                refused = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "hi",
                                        "idempotency_key": "k-" + str(len(images[0])), "images": images})
                self.assertFalse(refused["ok"])
        self.assertFalse(pip_chat.image_directory(self.registry.directory, pip["id"]).exists()
                         and any(pip_chat.image_directory(self.registry.directory, pip["id"]).iterdir()))
        self.assertEqual(pip_chat.list_messages(self.store, pip["id"])["messages"], [])

    def test_a_retry_key_binds_its_images(self):
        pip = self.pip()
        first = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Look", "idempotency_key": "k1", "images": [DOT]})
        again = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Look", "idempotency_key": "k1", "images": [DOT]})
        self.assertEqual(again["result"]["run"]["id"], first["result"]["run"]["id"], "the same request")
        other = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Look", "idempotency_key": "k1", "images": [OTHER]})
        self.assertFalse(other["ok"], "the same key with another image is another request")

    def test_an_image_is_only_fetched_from_its_own_pip(self):
        pip, other = self.pip(), self.store.create(self.registry.personal()["id"], "Travel", None, "editor-user", pip_type="scout")
        self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Look", "idempotency_key": "k1", "images": [DOT]})
        self.control({"type": "send_pip_message", "pip_id": other["id"], "text": "Look", "idempotency_key": "k1", "images": [DOT]})
        [message] = pip_chat.list_messages(self.store, pip["id"])["messages"]
        refused = self.control({"type": "get_pip_message_image", "pip_id": other["id"], "message_id": message["id"], "index": 0})
        self.assertFalse(refused["ok"])

    def test_the_runner_hands_the_worker_the_kept_paths_not_the_bytes(self):
        pip = self.pip()
        pip_chat.send(self.store, pip["id"], "What is this?", "k1", "user", self.cfg, images=[DOT])
        row = self.store.claim_next()
        seen = []

        def capture(value):
            seen.append(value)
            raise RegistryError("stop", "Captured.")
        with patch.object(pips, "_worker_payload", side_effect=capture), self.assertRaises(RegistryError):
            pips._execute_run(self.registry, row, self.cfg)
        manifest = seen[0]["manifest"]
        [path] = manifest["conversation_image_paths"]
        self.assertEqual(path, str(pip_chat.image_directory(self.registry.directory, pip["id"]) / (manifest["conversation"]["images"][0]["sha256"] + ".png")))
        self.assertNotIn(base64.b64encode(PNG).decode(), json.dumps(seen[0]))

    def test_the_pips_model_receives_the_image_and_a_changed_file_is_not_used(self):
        from dgc.llm import LLMClient, ChatResult
        pip = self.pip()
        run = pip_chat.send(self.store, pip["id"], "What is this?", "k1", "user", self.cfg, images=[DOT])["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        self.assertNotIn(base64.b64encode(PNG).decode(), json.dumps(raw), "the bytes never ride in the manifest")
        paths = [str(p) for p in pip_chat.image_paths(self.registry.directory, pip["id"], raw["conversation"]["images"])]
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(messages)
            return ChatResult(content="A tiny white dot.")
        def go(manifest):
            with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                    patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                    patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
                return pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        go({**raw, "conversation_image_paths": paths})
        user = [m for m in seen[0] if m["role"] == "user"][-1]
        parts = user["content"] if isinstance(user["content"], list) else []
        self.assertIn({"type": "image_url", "image_url": {"url": DOT}}, parts)
        import shutil, tempfile
        elsewhere = os.path.join(tempfile.mkdtemp(dir=self.root), "copy.png")
        shutil.copyfile(paths[0], elsewhere)
        with self.assertRaises(RegistryError):
            go({**raw, "conversation_image_paths": [elsewhere]})
        with open(paths[0], "ab") as tamper:
            tamper.write(b"x")
        with self.assertRaises(RegistryError):
            pip_chat.image_paths(self.registry.directory, pip["id"], raw["conversation"]["images"])
        with self.assertRaises(RegistryError):
            go({**raw, "conversation_image_paths": paths})
        with self.assertRaises(RegistryError):
            go({**raw, "conversation_image_paths": ["/etc/passwd"]})


if __name__ == "__main__":
    unittest.main()
