"""Image generation in ChatDGC (0.51): generate_image in a reply saves into the chat's folder with a sidecar, keeps the
picture with the chat (a card under the reply, and the Library's Images), remembers the generator for the chat, and a
paid generator puts a card with its price under the reply that makes nothing until the user sends it."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages, png  # noqa: E402
from test_chatdgc_made import Model  # noqa: E402
from test_images_config import Home  # noqa: E402

from dgc import config as C  # noqa: E402
from dgc import images  # noqa: E402
from dgc.chatdgc.engine import ChatEngine  # noqa: E402
from dgc.chatdgc.store import ChatStore  # noqa: E402
from dgc.shared_memory import SharedMemory  # noqa: E402


class ImagesInChat(unittest.TestCase):
    def setUp(self):
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.home = Home()
        self.home.__enter__()
        self.addCleanup(self.home.__exit__)
        self.config = self.home.config()
        folder = Path(tempfile.mkdtemp(prefix="chatdgc-images-"))
        self.world = {"script": [], "read": []}
        self.store = ChatStore(folder / "chat")
        self.engine = ChatEngine(self.config, self.store, searcher=lambda q: [], memory=SharedMemory(folder / "memory"),
                                 projects=lambda hidden: [], client_factory=lambda model: Model(self.world),
                                 plugins=lambda chat, said, taint: None)

    def setup(self, *names):
        rows = {"comfy": {"id": "comfy", "name": "ComfyUI on gpu-box", "provider": "comfyui",
                          "base_url": self.fake.url, "model": "sd_xl_turbo_1.0_fp16.safetensors", "size": "512x512"},
                "fal": {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
                        "model": "fal-ai/flux/schnell"}}
        self.config.set_images({"generators": [rows[n] for n in names]})
        if "fal" in names:
            self.config.set_image_key("fal", "fal-key")

    def say(self, text, *steps, chat=None, **kwargs):
        self.world["script"] += list(steps)
        chat = chat or self.engine.open()
        return chat, self.engine.send(chat["id"], text, search="off", **kwargs)

    def told(self, n=-1):
        return [m["content"] for m in self.world["read"][n]["messages"] if m["role"] == "tool"]

    def test_offered_in_every_reply_set_up_or_not(self):
        self.say("hi", {"parts": ["Hello."]})
        self.assertTrue({"generate_image", "list_image_generators"} <= set(self.world["read"][0]["tools"]))

    def test_made_kept_shown_in_the_library_and_remembered_for_the_chat(self):
        self.setup("comfy", "fal")
        live, shown = [], []

        def on_file(meta):
            live.append(meta)
            # The screen asks for the picture as its card appears, before the reply is saved with the chat.
            shown.append(self.engine.image(chat_id[0], meta["id"], limit=10_000_000))
        chat_id = [self.engine.open()["id"]]
        chat, reply = self.say("Draw a fox.", {"parts": ["Here."], "calls": [
            ("generate_image", {"prompt": "a red fox, watercolor", "generator": "comfy"})]},
            {"parts": [" A watercolor fox."]}, chat={"id": chat_id[0]}, on_file=on_file)
        self.assertTrue(shown and shown[0].startswith("data:image/png;base64,"), "its picture while the reply runs")
        [file] = reply["files"]
        self.assertEqual(live, [file])
        self.assertEqual((file["kind"], file["made"], file["format"]), ("image", True, "png"))
        self.assertEqual(file["generated"]["generator"], "comfy")
        self.assertIn("It shows under your reply, and it's in the Library.", self.told(1)[0])
        saved = Path(file["generated"]["path"])
        self.assertTrue(saved.is_file())
        self.assertEqual(saved.parent, images.directory() / "chats" / chat["id"], "the chat's own folder")
        self.assertEqual(json.loads(saved.with_suffix(".json").read_text())["prompt"], "a red fox, watercolor")
        found = self.store.library(kind="image")
        self.assertEqual([(f["name"], f["made"], f["type"]) for f in found["files"]], [(file["name"], True, "image")])
        self.assertTrue(self.engine.image(chat["id"], file["id"], limit=10_000_000).startswith("data:image/png;base64,"))
        self.assertEqual(self.engine.open(chat["id"])["image_generator"], "comfy", "remembered for this chat")
        self.say("Again, bluer.", {"parts": ["Sure."], "calls": [("generate_image", {"prompt": "a blue fox"})]},
                 {"parts": ["Done."]}, chat=chat)
        self.assertIn("ComfyUI on gpu-box", self.told(-2)[0] if len(self.told(-2)) else self.told()[0])
        history = "\n".join(str(m["content"]) for m in self.world["read"][-1]["messages"])
        self.assertIn("[You made an image here, shown to the user under this reply", history)

    def test_a_paid_generator_puts_a_card_with_its_price_and_makes_nothing_until_sent(self):
        self.setup("fal")
        cards = []
        chat, reply = self.say("Make me a logo.", {"parts": ["One moment."], "calls": [
            ("generate_image", {"prompt": "a minimal fox logo", "size": "1024x1024"})]},
            {"parts": [" There's a card."]}, on_action=cards.append)
        [card] = reply["actions"]
        self.assertEqual((card["kind"], card["plugin_name"], card["status"]), ("image", "fal FLUX schnell", "waiting"))
        self.assertEqual(card["price"], "about $0.003")
        self.assertIn("Nothing is made until the user sends it", self.told(1)[0])
        self.assertTrue(self.told(1)[0].startswith("A card is in the chat now: "), "never where it is (0.51: it sits in the reply)")
        self.assertIn("don't say where the card is", self.told(1)[0])
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [], "nothing spent")
        done = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.assertEqual(done["status"], "done")
        message = next(m for m in self.engine.open(chat["id"])["messages"] if m["id"] == reply["id"])
        self.assertEqual(len(message["files"]), 1, "the picture joined the reply")
        self.assertEqual(len([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")]), 1)

    def test_a_card_sent_after_the_limit_filled_up_makes_nothing(self):
        # The card was for a picture within this month's limit; another picture used that room before Send.
        self.setup("fal")
        block = images.settings(self.config)
        block["generators"][0]["monthly_limit_usd"] = 1
        self.config.set_images(block)
        chat, reply = self.say("Make me a logo.", {"calls": [("generate_image", {"prompt": "a fox logo"})]},
                               {"parts": ["A card."]})
        [card] = reply["actions"]
        self.assertNotIn("over_limit", card["card"])
        images.add_spend("fal", 0.999)
        done = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.assertEqual(done["status"], "failed")
        self.assertIn("would now pass this month's limit", done["error"])
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [], "nothing sent")

    def test_a_card_that_didnt_say_its_price_is_unknown_makes_nothing_under_a_limit(self):
        self.setup("fal")
        chat, reply = self.say("Make me a logo.", {"calls": [("generate_image", {"prompt": "a fox logo",
                                                                                 "model": "fal-ai/brand-new-model"})]},
                               {"parts": ["A card."]})
        [card] = reply["actions"]
        self.assertEqual(card["price"], "price unknown")
        self.assertNotIn("price_unknown", card["card"], "no limit yet: nothing to hold it to")
        block = images.settings(self.config)
        block["generators"][0]["monthly_limit_usd"] = 5
        self.config.set_images(block)
        done = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.assertEqual(done["status"], "failed")
        self.assertIn("doesn't know what fal FLUX schnell charges, and its card didn't say so", done["error"])
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [])

    def test_through_the_service_the_picture_joins_its_reply_on_screen(self):
        from dgc.chatdgc.service import ChatService
        from dgc.editor_protocol import event_error
        import time
        self.setup("fal")
        frames = []

        def emit(type, **fields):
            frame = {"type": type, "seq": len(frames), **fields}
            self.assertIsNone(event_error(frame), frame)
            frames.append(frame)
        service = ChatService(emit, self.config, engine=self.engine)
        self.addCleanup(service.close, 2.0)
        chat, reply = self.say("Make me a logo.", {"calls": [("generate_image", {"prompt": "a fox logo"})]},
                               {"parts": ["A card."]})
        card = reply["actions"][0]
        service.dispatch({"type": "chatdgc_action", "request_id": "a1", "conversation_id": chat["id"],
                          "message_id": reply["id"], "action_id": card["id"], "op": "run"})
        for _ in range(500):
            sent = [f for f in frames if f["type"] == "chatdgc_message" and f["message"]["id"] == reply["id"]]
            if sent:
                break
            time.sleep(0.01)
        self.assertTrue(sent, "the reply is sent again with its new picture")
        self.assertEqual([f["kind"] for f in sent[-1]["message"]["files"]], ["image"])

    def test_an_edit_uses_the_chats_own_image_by_name(self):
        self.setup("comfy")
        chat, reply = self.say("Draw a fox.", {"calls": [("generate_image", {"prompt": "a fox"})]}, {"parts": ["Here."]})
        name = reply["files"][0]["name"]
        _chat, again = self.say("Make it night.", {"calls": [("generate_image", {"prompt": "night", "images": [name]})]},
                                {"parts": ["Done."]}, chat=chat)
        self.assertEqual(len(again["files"]), 1)
        self.assertEqual(len(self.fake.uploads), 1, "the chat's image went up to ComfyUI for the edit")


if __name__ == "__main__":
    unittest.main()
