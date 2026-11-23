"""The Library's Images (0.52; decided 15 Nov): every image from Work, ChatDGC and Pips says who made it, and the model
can keep an image on purpose with ONE module (dgc.image_keep) every surface reaches: Work's keep_image tool (a picture
in the project, or an https image), ChatDGC's and a Pip's (an https image; a Pip's read by the controller under careful
mode). Kept images sit beside the generated ones in the images index, marked kept, with their title and why."""
import base64
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


class Home(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="dgc-keep-")))
        patcher = mock.patch.dict(os.environ, {"DGC_HOME": str(self.tmp / "home")})
        patcher.start()
        self.addCleanup(patcher.stop)
        from dgc import images
        self.images = images
        patch_dir = mock.patch.object(images, "directory", return_value=self.tmp / "home" / "images")
        patch_dir.start()
        self.addCleanup(patch_dir.stop)


class MadeBy(Home):
    def test_every_image_row_says_who_made_it(self):
        from dgc import images
        for surface, where in (("work", {"project": "/p", "session": "20261115-042907-4479cb11"}),
                               ("chat", {"chat": "chat_1", "chat_title": "Garden plan"}),
                               ("pip", {"pip": "pip_x", "run": "run_1"})):
            path = self.tmp / f"{surface}.png"
            path.write_bytes(PNG)
            images._index({"path": str(path), "surface": surface, "prompt": surface, "created_at": "2026-11-15T00:00:00Z", **where})
        with mock.patch("dgc.artifact_service.maker_name", side_effect=lambda kind, ident: {"session": "Deep research", "pip": "Tile checker"}.get(kind, "")):
            rows = {r["surface"]: r for r in images.library()["images"]}
        self.assertEqual(rows["work"]["made_by"], {"kind": "session", "id": "20261115-042907-4479cb11", "name": "Deep research"})
        self.assertEqual(rows["chat"]["made_by"], {"kind": "chat", "id": "chat_1", "name": "Garden plan"}, "the chat's own title")
        self.assertEqual(rows["pip"]["made_by"], {"kind": "pip", "id": "pip_x", "name": "Tile checker"})


class KeepModule(Home):
    def test_keep_saves_it_beside_the_generated_ones_marked_kept(self):
        from dgc import image_keep
        kept = image_keep.keep(PNG, title="Tile layout sketch", why="the user's chosen layout", source="https://a.example/x.png",
                               surface="work", where={"project": "/p", "session": "s1"})
        self.assertTrue(Path(kept["path"]).is_file())
        row = self.images.library()["images"][0]
        self.assertTrue(row["kept"])
        self.assertEqual((row["title"], row["why"], row["surface"], row["session"]), ("Tile layout sketch", "the user's chosen layout", "work", "s1"))
        sidecar = json.loads(Path(kept["path"]).with_suffix(".json").read_text())
        self.assertTrue(sidecar["kept"])
        self.assertEqual(sidecar["source"], "https://a.example/x.png")

    def test_only_images_are_kept(self):
        from dgc import image_keep
        with self.assertRaises(image_keep.KeepError):
            image_keep.keep(b"%PDF-1.7 not an image", title="x", why="", source="", surface="work", where={})

    def test_from_url_reads_an_image_and_refuses_anything_else(self):
        from dgc import image_keep
        with mock.patch("dgc.tools._fetch_public", return_value=("https://a.example/p.png", "image/png", PNG, "")):
            data, final = image_keep.from_url("https://a.example/p.png", {})
        self.assertEqual((data, final), (PNG, "https://a.example/p.png"))
        with mock.patch("dgc.tools._fetch_public", return_value=("https://a.example/", "text/html", b"<html>", "utf-8")), \
                self.assertRaises(image_keep.KeepError):
            image_keep.from_url("https://a.example/", {})

    def test_an_address_carrying_a_saved_secret_is_never_fetched(self):
        from dgc import image_keep
        with mock.patch("dgc.leak_guard.carries_secret", return_value=True), mock.patch("dgc.tools._fetch_public") as fetch, \
                self.assertRaises(image_keep.KeepError):
            image_keep.from_url("https://a.example/?k=secret", {})
        fetch.assert_not_called()

    def test_one_schema(self):
        from dgc import image_keep
        params = image_keep.SCHEMA["function"]["parameters"]
        self.assertEqual(image_keep.SCHEMA["function"]["name"], "keep_image")
        self.assertEqual(params["required"], ["source", "title"])


class WorkTool(Home):
    def agent(self):
        from dgc.agent import Agent
        from dgc.config import Config
        root = self.tmp / "proj"
        (root / "img").mkdir(parents=True, exist_ok=True)
        (root / "img" / "chart.png").write_bytes(PNG)
        (root / ".secret").mkdir(exist_ok=True)
        (root / ".secret" / "logo.png").write_bytes(PNG)
        cfg = Config(root)
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})

        class Quiet:
            def __getattr__(self, name):
                return lambda *a, **k: None
        os.environ.pop("DGC_SESSION_POLICY", None)
        agent = Agent(cfg, Quiet())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def test_offered_read_only_and_never_published(self):
        from dgc import permissions
        agent = self.agent()
        self.assertIn("keep_image", {s["function"]["name"] for s in agent._tool_schemas()})
        self.assertNotIn("keep_image", permissions.DISPLAY)
        self.assertIn("keep_image", permissions.READ_ONLY_TOOLS, "it keeps into DGC's own store: nothing in the project changes")
        with mock.patch("dgc.permissions.session_policy", return_value=object()):
            self.assertNotIn("keep_image", {s["function"]["name"] for s in agent._tool_schemas()})

    def test_a_project_picture_is_kept_with_this_session_as_maker(self):
        agent = self.agent()
        said = agent._keep_image_tool({"source": "img/chart.png", "title": "Sales chart", "why": "asked to keep it"}, "c1")
        self.assertIn("Sales chart", said)
        row = self.images.library()["images"][0]
        self.assertEqual((row["surface"], row["kept"], row["title"]), ("work", True, "Sales chart"))

    def test_a_private_or_outside_file_is_refused(self):
        agent = self.agent()
        for source in (".secret/logo.png", "../outside.png", "/etc/hostname"):
            with self.subTest(source=source):
                self.assertTrue(agent._keep_image_tool({"source": source, "title": "x"}, "c").startswith("error"))
        self.assertEqual(self.images.library()["total"], 0)


class PipAndChat(Home):
    def test_a_pip_keeps_an_https_image_through_the_controller_under_careful_mode(self):
        from dgc import pip_app_links

        class Taint:
            def __init__(self, carried):
                self.value = carried

            def carried(self, text, said=None):
                return ["x"] if self.value else []
        run = pip_app_links.RunSocket.__new__(pip_app_links.RunSocket)
        run.taint, run.said, run.config, run.pip_id, run.run_id = Taint(False), "", {}, "pip_x", "run_1"
        with mock.patch("dgc.image_keep.from_url", return_value=(PNG, "https://a.example/p.png")):
            said = run._keep_image({"source": "https://a.example/p.png", "title": "Kept by the Pip"})
        self.assertIn("Kept by the Pip", said)
        row = self.images.library()["images"][0]
        self.assertEqual((row["surface"], row["pip"], row["kept"]), ("pip", "pip_x", True))
        run.taint = Taint(True)
        with mock.patch("dgc.image_keep.from_url") as fetch:
            self.assertTrue(run._keep_image({"source": "https://a.example/?q=read", "title": "x"}).startswith("error"))
        fetch.assert_not_called()
        self.assertIn("keep_image", pip_app_links.KEEP_OPS)

    def test_chatdgc_keeps_an_https_image_as_this_chats(self):
        from dgc.chatdgc import images as chat_images
        self.assertIn("keep_image", chat_images.NAMES)
        self.assertIn("keep_image", {t["function"]["name"] for t in chat_images.TOOLS})
        chat = {"id": "chat_1", "title": "Garden plan"}
        call = SimpleNamespace(name="keep_image", arguments={"source": "https://a.example/p.png", "title": "Raised bed"})
        with mock.patch("dgc.image_keep.from_url", return_value=(PNG, "https://a.example/p.png")):
            said = chat_images.call(SimpleNamespace(config={}), chat, call, [], 0, None, [], None)
        self.assertIn("Raised bed", said)
        row = self.images.library()["images"][0]
        self.assertEqual((row["surface"], row["chat"], row["kept"]), ("chat", "chat_1", True))


if __name__ == "__main__":
    unittest.main()
