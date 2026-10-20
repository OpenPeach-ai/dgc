"""A Pip's eyes and cursor (pip_eyes, Pips API 53): only a model that sees gets them; a text-only one says so in
one line with a card of choices; points in either scale land where the model meant; payments ask every time."""
import base64
import json
import os
import threading
import types
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_computer, pip_eyes, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

# A real 4x3 JPEG: what the computer hands the worker after look.
JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/"
    "2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAADAAQDASIAAhEBAxEB/8QA"
    "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK"
    "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG"
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC"
    "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE"
    "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=")


class PointsTests(unittest.TestCase):
    def test_each_model_is_asked_in_its_own_scale(self):
        # Measured 2026-10-20: Qwen3's vision models answer on 0-1000 across the image even when asked for pixels.
        for model, expected in (("qwen3-vl:8b", "thousandths"), ("qwen3.8:27b-q4km", "thousandths"),
                                ("qwen3.5:122b", "thousandths"), ("deepseek-v4.1-flash:cloud", "pixels"),
                                ("qwen2.5vl:7b", "pixels"), ("glm-5.3:cloud", "pixels")):
            with self.subTest(model=model):
                self.assertEqual(pip_eyes.convention_for(model), expected)
        own = pip_computer.schema("own", "thousandths")["function"]["description"]
        self.assertIn("0-1000 scale", own)
        self.assertIn("pixels in the latest screenshot", pip_computer.schema("own", "pixels")["function"]["description"])

    def test_points_land_where_the_model_meant_and_an_answer_in_the_other_scale_is_caught(self):
        seen = {}
        self.assertEqual(pip_eyes.to_pixels([(500, 500)], 1280, 800, "thousandths", seen), [(640.0, 400.0)])
        self.assertEqual(pip_eyes.to_pixels([(640, 400)], 1280, 800, "pixels", {}), [(640.0, 400.0)])
        # Asked for pixels, it answered on 0-1000 (y past the bottom of an 800-pixel screen): from now on, that scale.
        self.assertEqual(pip_eyes.to_pixels([(115, 883)], 1280, 800, "pixels", seen), [(147.2, 706.4)])
        self.assertEqual(seen["convention"], "thousandths")
        self.assertEqual(pip_eyes.to_pixels([(500, 500)], 1280, 800, "pixels", seen), [(640.0, 400.0)])
        # Asked for 0-1000, it answered in pixels (x past 1000, inside the screen): pixels from now on.
        other = {}
        self.assertEqual(pip_eyes.to_pixels([(1140, 104)], 1280, 800, "thousandths", other), [(1140.0, 104.0)])
        self.assertEqual(other["convention"], "pixels")
        # A drag's two points move together.
        self.assertEqual(pip_eyes.to_pixels([(100, 100), (200, 900)], 1280, 800, "pixels", {}),
                         [(128.0, 80.0), (256.0, 720.0)])


class ToolTests(unittest.TestCase):
    def test_only_a_pip_that_can_see_gets_the_cursor(self):
        enum = lambda eyes: pip_computer.schema(eyes)["function"]["parameters"]["properties"]["op"]["enum"]
        for op in ("look", "click_at", "double_click_at", "right_click_at", "drag", "scroll_at", "hover_at", "upload"):
            self.assertIn(op, enum("own"))
            self.assertIn(op, enum("relay"))
        # drag also works by ref (ref onto to), so a text-only Pip keeps it, with no points to give.
        self.assertEqual([op for op in enum(None) if op in pip_computer.POINT_OPS], ["drag"])
        self.assertIn("look", enum(None), "a text-only Pip can still ask to look: that is how it says it can't see")
        self.assertIn("upload", enum(None), "a file field by ref needs no eyes")
        self.assertNotIn("x", pip_computer.schema(None)["function"]["parameters"]["properties"])
        self.assertIn("question", pip_computer.schema("relay")["function"]["parameters"]["properties"])

    def test_the_cards_words(self):
        self.assertEqual(pip_eyes.line("glm-5.3:cloud"), "**glm-5.3:cloud can't see images.**")
        self.assertEqual(pip_eyes.labels("glm-5.3:cloud", "deepseek-v4.1-flash:cloud"), {
            "relay": "Use deepseek-v4.1-flash:cloud to see, keep glm-5.3:cloud for the rest",
            "switch": "Switch this Pip to deepseek-v4.1-flash:cloud", "off": "Not now"})
        long = pip_eyes.labels("a" * 60, "b" * 60)
        self.assertTrue(all(len(v) <= 80 for v in long.values()), long)
        pip_chat.validate_choices(list(long.values()))
        pip_chat.validate_choices(list(pip_eyes.labels("glm-5.3:cloud", "qwen3-vl:8b").values()))


class FakeBrowser:
    """What Host._point needs from a BoxedBrowser, recording what it was asked to do."""

    def __init__(self):
        self.did, self.current_url, self.display_dir = [], "https://shop.example/", None

    def css_viewport(self):
        return 1280.0, 900.0

    def element_at(self, x, y):
        return 'button "Add to cart"'

    def click_at(self, x, y, *, button="left", count=1):
        self.did.append(("click", round(x, 1), round(y, 1), button, count))

    def drag(self, x1, y1, x2, y2):
        self.did.append(("drag", round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)))

    def scroll_at(self, x, y, dy):
        self.did.append(("scroll", round(x, 1), round(y, 1), round(dy, 1)))

    def hover_at(self, x, y):
        self.did.append(("hover", round(x, 1), round(y, 1)))

    def pump(self, seconds):
        pass

    def screen_offset(self):
        return None

    def evaluate_json(self, expression):
        return json.dumps([self.current_url, "Shop"])

    def screenshot_jpeg(self, quality=60):
        return JPEG

    def screenshot_for_model(self, mark=None):
        self.marked = mark
        return {"data": JPEG, "width": 1138, "height": 800, "scale": 800 / 900, "masked": 1}


def fake_host(tmp):
    host = types.SimpleNamespace(browser=FakeBrowser(), shot=None, pointer=None, _pointer_seq=0, frames_dir=tmp,
                                 frames=0, _queued=[], waiting=[], run_id="run_" + "a" * 32)
    for name in ("_point", "_look", "_geometry", "_css_point", "_show_pointer", "_page_said", "_frame", "_held_text"):
        setattr(host, name, getattr(pip_computer.Host, name).__get__(host))
    host.POINT_VERBS = pip_computer.Host.POINT_VERBS
    host._record_held = lambda: []
    return host


class HostTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)

    def test_a_click_by_position_lands_on_the_page_and_answers_with_a_new_screen(self):
        host = fake_host(self.dir)
        first = host._look()
        self.assertEqual((first["width"], first["height"]), (1138, 800))
        self.assertEqual(base64.b64decode(first["image"]), JPEG)
        self.assertIn("blacked out", first["text"], "the model is told secret fields are hidden")
        said = host._point("click_at", {"x": 569, "y": 400})
        # The screenshot is 800/900 of the page: (569, 400) there is (640.1, 450) on the page.
        self.assertEqual(host.browser.did, [("click", 640.1, 450.0, "left", 1)])
        self.assertIn('Clicked at 569, 400: button "Add to cart"', said["text"])
        self.assertIn("image", said)
        self.assertEqual(host.browser.marked["kind"], "click_at", "the new screen marks where the mouse is")
        self.assertEqual((host.pointer["x"], host.pointer["y"], host.pointer["kind"]), (640.1, 450.0, "click_at"))
        row = json.loads((self.dir / "index.jsonl").read_text().splitlines()[-1])
        self.assertEqual(row["pointer"], {"kind": "click_at", "x": 640.1, "y": 450.0})
        host._point("drag", {"x": 100, "y": 100, "to_x": 300, "to_y": 200})
        self.assertEqual(host.browser.did[-1], ("drag", 112.5, 112.5, 337.5, 225.0))
        self.assertEqual((host.pointer["from_x"], host.pointer["x"]), (112.5, 337.5))
        host._point("double_click_at", {"x": 10, "y": 10})
        host._point("right_click_at", {"x": 10, "y": 10})
        host._point("scroll_at", {"x": 10, "y": 10, "dy": 400})
        self.assertEqual(host.browser.did[-3:], [("click", 11.2, 11.2, "left", 2), ("click", 11.2, 11.2, "right", 1),
                                                 ("scroll", 11.2, 11.2, 450.0)])

    def test_a_point_off_the_screen_or_not_a_number_is_refused(self):
        host = fake_host(self.dir)
        host._look()
        for args in ({"x": 1200, "y": 10}, {"x": 10, "y": 801}, {"x": -1, "y": 0}, {"x": "10", "y": 5}, {"x": True, "y": 1}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                host._point("click_at", args)
        self.assertEqual(host.browser.did, [])

    def test_the_timeline_says_where_only_to_an_editor_that_asks(self):
        from pathlib import Path
        state = self.dir / "state"
        run = "run_" + "b" * 32
        folder = state / "runs" / run / "artifacts" / "computer"
        folder.mkdir(parents=True)
        (folder / "index.jsonl").write_text(
            json.dumps({"frame": "0001.jpg", "label": "open https://shop.example", "url": "https://shop.example/", "at": "t"}) + "\n"
            + json.dumps({"frame": "0002.jpg", "label": "Clicked at 5, 6: canvas.", "url": "u", "at": "t",
                          "pointer": {"kind": "click_at", "x": 5.0, "y": 6.0}}) + "\n")
        old = pip_computer.frames(state, run)
        self.assertEqual([sorted(r) for r in old], [["at", "frame", "label", "url"]] * 2, "an older editor sees exactly what it knows")
        new = pip_computer.frames(state, run, pointers=True)
        self.assertNotIn("pointer", new[0])
        self.assertEqual(new[1]["pointer"], {"kind": "click_at", "x": 5.0, "y": 6.0})

    def test_an_upload_gives_the_page_a_private_copy_of_a_real_file_in_files_and_nothing_else(self):
        import os
        root = self.dir / "computer"
        files = root / "home" / "Files"
        (files / "From chat").mkdir(parents=True)
        (files / "From chat" / "photo.jpg").write_bytes(JPEG)
        (root / "home" / ".browser").mkdir()
        (root / "home" / ".browser" / "Cookies").write_text("session=secret")
        os.symlink("../../.browser/Cookies", files / "From chat" / "cookies.jpg")
        host = fake_host(self.dir)
        host.root, chosen = root, []
        host.browser.set_files = lambda paths, ref="", point=None: chosen.append((paths, ref, point)) or "chooser"
        host._record_held, host._read = (lambda: []), (lambda: "page text")
        host._upload = pip_computer.Host._upload.__get__(host)
        said = host._upload({"path": "From chat/photo.jpg", "ref": "e7"})
        [(paths, ref, point)] = chosen
        self.assertEqual(ref, "e7")
        self.assertRegex(paths[0], r"^/home/pip/\.dgc-uploads/[0-9a-f]{16}/photo\.jpg$")
        copy = root / "home" / paths[0][len("/home/pip/"):]
        self.assertEqual(copy.read_bytes(), JPEG, "the page gets exactly the file that was checked")
        self.assertIn("Choosing a file sends nothing", said)
        for bad in ("From chat/cookies.jpg", "../.browser/Cookies", "From chat", "nothing.jpg"):
            with self.subTest(path=bad), self.assertRaises((ValueError, RegistryError)):
                host._upload({"path": bad, "ref": "e7"})
        self.assertEqual(len(chosen), 1, "a link, a folder or a path outside Files never reaches the page")

    def test_a_page_drawn_on_a_canvas_is_said_so_with_its_text(self):
        for share, said in ((0.4, True), (0.05, False)):
            browser = types.SimpleNamespace(snapshot=lambda: {"url": "https://tees.example/", "title": "Tees", "lines": ["- button \"Add text\" [e5]"]},
                                            evaluate_json=lambda expression, share=share: share)
            host = types.SimpleNamespace(browser=browser, _check_for_human=lambda data, text: False)
            host._drawn_share = pip_computer.Host._drawn_share.__get__(host)
            text = pip_computer.Host._read(host)
            self.assertIn('Add text', text)
            self.assertEqual("drawn on a canvas" in text, said)
            self.assertEqual(host.visual, said)

    def test_a_live_frame_says_its_own_size_and_where_the_cursor_is(self):
        # A headless 1280x900 window shows a 1280x813 page: the user's clicks and the Pip's cursor are placed by
        # the frame's own size, not the configured one.
        import threading as _threading
        browser = types.SimpleNamespace(start=lambda: None, screenshot_jpeg=lambda quality=60: JPEG, viewport=(1280, 900),
                                        current_url="https://tees.example/")
        host = types.SimpleNamespace(lock=_threading.RLock(), run_id="run_x", browser=browser, last_used=0,
                                     pointer={"kind": "drag", "x": 2.0, "y": 1.0, "seq": 1})
        view = pip_computer._host_view(host, "frame", {})
        self.assertEqual((view["width"], view["height"]), (4, 3))
        self.assertEqual(view["pointer"]["kind"], "drag")

    def test_the_live_view_asks_where_the_cursor_is_without_a_frame(self):
        host = types.SimpleNamespace(run_id="run_x", pointer={"kind": "click_at", "x": 1.0, "y": 2.0, "seq": 3},
                                     browser=types.SimpleNamespace(start=lambda: self.fail("no browser for a pointer")))
        self.assertEqual(pip_computer._host_view(host, "pointer", {}),
                         {"ok": True, "watching": True, "pointer": {"kind": "click_at", "x": 1.0, "y": 2.0, "seq": 3}})
        self.assertIn("pointer", pip_computer.VIEW_OPS)


CATALOG = ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud", "qwen3-vl:8b"]


def catalog_setup(self):
    """The fixture, with the user's connection offering these models (no network in a test)."""
    fixtures.LocalPipsTests.setUp(self)
    started = patch("dgc.pip_models._catalog", return_value=list(CATALOG))
    started.start()
    self.addCleanup(started.stop)


class EyesStoreTests(unittest.TestCase):
    setUp = catalog_setup

    def pip(self, model=None):
        return self.store.create(self.registry.personal()["id"], "Tees", None, "editor-user", pip_type="lens",
                                 model_choice={"mode": "model", "model": model} if model else {"mode": "default"},
                                 computer_plan={"schema_version": 1})

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def reply_with_card(self, pip, model="glm-5.3:cloud", vision="deepseek-v4.1-flash:cloud", photos=None):
        run = pip_chat.send(self.store, pip["id"], "Make my tee", "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        claimed = self.store.claim_next()
        self.assertEqual(claimed["id"], run["id"])
        card = {"model": model, "vision_model": vision, **({"photos": photos} if photos else {})}
        self.store.finish(run["id"], result={"text": pip_eyes.line(model),
                                             "choices": list(pip_eyes.labels(model, vision).values()), "eyes": card})
        return run

    def test_a_tap_on_use_it_to_see_is_kept_for_the_pip_and_its_next_run_is_told(self):
        pip = self.pip("glm-5.3:cloud")
        self.reply_with_card(pip)
        latest = pip_chat.list_messages(self.store, pip["id"])["messages"][-1]
        self.assertEqual(latest["text"], "**glm-5.3:cloud can't see images.**")
        self.assertEqual(latest["choices"], ["Use deepseek-v4.1-flash:cloud to see, keep glm-5.3:cloud for the rest",
                                             "Switch this Pip to deepseek-v4.1-flash:cloud", "Not now"])
        sent = pip_chat.send(self.store, pip["id"], latest["choices"][0], "k-tap", "editor-user", self.cfg)
        self.assertEqual(pip_eyes.saved(self.registry.db, pip["id"]), {"choice": "relay", "vision_model": "deepseek-v4.1-flash:cloud"})
        row = self.store.claim_next()
        self.assertEqual(row["id"], sent["run"]["id"])
        with patch.object(pip_eyes, "sees", return_value=False):
            pinned = pip_eyes.pin(self.registry, row, {"run_kind": "conversation", "model": "glm-5.3:cloud"}, self.cfg)
        self.assertEqual(pinned["computer_eyes"]["decided"], "relay")
        self.assertEqual(pinned["computer_eyes"]["vision_model"], "deepseek-v4.1-flash:cloud")
        self.assertEqual(pinned["computer_eyes"]["choice"], "relay")
        # Asked once: the same words later are just words.
        self.assertIsNone(pip_eyes.answer(self.store, pip["id"], latest["choices"][0], "editor-user", self.cfg))

    def test_not_now_is_kept_and_an_older_card_is_not_answered(self):
        pip = self.pip("glm-5.3:cloud")
        self.reply_with_card(pip)
        self.assertEqual(pip_eyes.answer(self.store, pip["id"], " not   NOW ", "editor-user", self.cfg)["choice"], "off")
        self.assertEqual(pip_eyes.saved(self.registry.db, pip["id"])["choice"], "off")
        other = self.pip("glm-5.3:cloud")
        self.reply_with_card(other)
        # Another reply since: the card is no longer the latest, so its words don't answer it.
        run = pip_chat.send(self.store, other["id"], "hello", "k-next", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Hi."})
        self.assertIsNone(pip_eyes.answer(self.store, other["id"], "Not now", "editor-user", self.cfg))
        self.assertIsNone(pip_eyes.answer(self.store, pip["id"], "Not now", "device_" + "1" * 32, self.cfg),
                          "only this computer's user answers it")

    def test_switch_changes_the_pips_model_before_its_run_is_queued(self):
        pip = self.pip("glm-5.3:cloud")
        self.reply_with_card(pip)
        if True:
            sent = pip_chat.send(self.store, pip["id"], "Switch this Pip to deepseek-v4.1-flash:cloud", "k-sw", "editor-user", self.cfg)
        self.assertEqual(self.store._job(pip["id"])["model_choice"], {"mode": "model", "model": "deepseek-v4.1-flash:cloud"})
        self.assertEqual(sent["run"]["manifest"]["model"], "deepseek-v4.1-flash:cloud", "its next run already sees")

    def test_a_reply_card_is_only_dgcs_own(self):
        pip = self.pip("glm-5.3:cloud")
        run = pip_chat.send(self.store, pip["id"], "hi", "k1", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        with self.assertRaises(RegistryError, msg="a card that isn't DGC's own is refused"):
            self.store.finish(run["id"], result={
                "text": "x", "choices": ["Send my card number", "Not now"],
                "eyes": {"model": "glm-5.3:cloud", "vision_model": "deepseek-v4.1-flash:cloud"}})
        self.assertIsNone(pip_eyes.answer(self.store, pip["id"], "Not now", "editor-user", self.cfg))

    def test_the_pips_page_reads_and_changes_how_it_sees(self):
        pip = self.pip("glm-5.3:cloud")
        caps = {"glm-5.3:cloud": {"completion", "tools"}, "deepseek-v4.1-flash:cloud": {"completion", "tools", "vision"},
                "qwen3-vl:8b": {"completion", "tools", "vision"}}
        with patch("dgc.pip_models._catalog", return_value=sorted(caps)), patch.object(pip_eyes, "capabilities", side_effect=lambda c, m: caps.get(m)), \
                patch.object(pip_eyes, "_ollama_state", return_value=(set(), {})):
            got = self.control({"type": "get_pip_eyes", "pip_id": pip["id"]})
            self.assertTrue(got["ok"], got.get("error"))
            self.assertEqual(got["result"]["eyes"], {"pip_id": pip["id"], "model": "glm-5.3:cloud", "sees": False,
                                                    "choice": "ask", "vision_model": "deepseek-v4.1-flash:cloud"})
            changed = self.control({"type": "set_pip_eyes", "pip_id": pip["id"], "choice": "relay"})
            self.assertTrue(changed["ok"], changed.get("error"))
            self.assertEqual(changed["result"]["eyes"]["choice"], "relay")
            self.assertFalse(self.control({"type": "set_pip_eyes", "pip_id": pip["id"], "choice": "always"})["ok"])
            self.assertFalse(self.control({"type": "get_pip_eyes", "pip_id": pip["id"]}, actor="device_" + "1" * 32)["ok"])

    def test_the_model_that_sees_for_it_is_the_users_own_same_provider_first(self):
        caps = {"glm-5.3:cloud": {"completion", "tools"}, "qwen3-vl:8b": {"completion", "tools", "vision"},
                "qwen2.5vl:7b": {"completion", "vision"}, "deepseek-v4.1-flash:cloud": {"completion", "tools", "vision"},
                "nomic-embed-text:latest": {"embedding"}}
        with patch("dgc.pip_models._catalog", return_value=sorted(caps)), patch.object(pip_eyes, "capabilities", side_effect=lambda c, m: caps.get(m)), \
                patch.object(pip_eyes, "_ollama_state", return_value=(set(), {"qwen3-vl:8b": 6, "qwen2.5vl:7b": 5})):
            self.assertEqual(pip_eyes.pick(self.cfg, "glm-5.3:cloud"), "deepseek-v4.1-flash:cloud")
            self.assertEqual(pip_eyes.pick(self.cfg, "qwen2.5:14b"), "qwen3-vl:8b", "local first, and it must use tools")


class PaymentTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def test_a_payment_is_never_always_allowed(self):
        from dgc import pip_action_grants as grants
        pip = self.store.create(self.registry.personal()["id"], "Shop", None, "editor-user", pip_type="lens",
                                computer_plan={"schema_version": 1})
        summary = {"method": "POST", "host": "shop.example", "path": "/api/pay", "fields": [], "more_fields": 0,
                   "body_bytes": 40, "payment": True, "page": "https://shop.example/checkout"}
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO pip_computer_actions VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,NULL,NULL,NULL)",
                ("compact_" + "1" * 32, pip["id"], pip["workspace_id"], None, "host_1", "req-1", json.dumps(summary),
                 pip_computer._digest(summary), None, "2026-10-01T10:00:00.000Z", "2099-01-01T00:00:00.000Z"))
        with self.assertRaises(RegistryError) as refused:
            pip_computer.approve_always(self.registry, "compact_" + "1" * 32, pip_computer._digest(summary), "editor-user")
        self.assertEqual(refused.exception.code, "asks_every_time")
        # Even a grant for the same site and path never sends a payment by itself.
        plain = {**summary, "payment": False}
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO pip_computer_actions VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,NULL,NULL,NULL)",
                ("compact_" + "2" * 32, pip["id"], pip["workspace_id"], None, "host_1", "req-2", json.dumps(plain),
                 pip_computer._digest(plain), None, "2026-10-01T10:00:00.000Z", "2099-01-01T00:00:00.000Z"))
            grants.add_computer_grant(self.registry, "compact_" + "2" * 32, "editor-user")
        host = types.SimpleNamespace(state_directory=self.registry.directory, pip_id=pip["id"], workspace_id=pip["workspace_id"],
                                     run_id=None, id="host_1", waiting=[], frames_dir=None, frames=0,
                                     browser=types.SimpleNamespace(current_url="https://shop.example/checkout"))
        held = types.SimpleNamespace(request_id="req-3", summary=lambda: dict(summary))
        host._queued = [held]
        host._frame = lambda label: None
        made = pip_computer.Host._record_held(host)
        status = self.registry.db.execute("SELECT status FROM pip_computer_actions WHERE id=?", (made[0],)).fetchone()[0]
        self.assertEqual(status, "pending", "a payment waits for the user however it was clicked")


class WorkerTests(unittest.TestCase):
    """The worker: a model that sees gets each screen as an image; one that can't says so in one line."""
    setUp = catalog_setup

    def run_turn(self, model, eyes, replies, *, sees, images=None, visual=False):
        from dgc.llm import ChatResult, LLMClient, ToolCall
        pip = self.store.create(self.registry.personal()["id"], "Tees", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "model", "model": model}, computer_plan={"schema_version": 1})
        run = pip_chat.send(self.store, pip["id"], "Put Hello on my tee", "k1", "editor-user", self.cfg, images=images)["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        asked = []

        def act(op, args):
            asked.append((op, dict(args)))
            if op in ("look",) + pip_computer.POINT_OPS:
                return {"text": f"Your screen now (1280x800 pixels) after {op}.", "image": base64.b64encode(JPEG).decode(),
                        "width": 1280, "height": 800}
            return {"text": "page text", **({"visual": True} if visual else {})}
        socket = pip_computer.RunSocket(types.SimpleNamespace(act=act), "run_" + "c" * 32)
        self.addCleanup(socket.close)
        manifest = {**raw, "computer_socket": socket.pin(), "computer_eyes": eyes}
        if images:
            manifest["conversation_image_paths"] = [str(p) for p in pip_chat.image_paths(self.registry.directory, pip["id"], raw["conversation"]["images"])]
        seen = []
        queue = list(replies)

        def chat(client, messages, tools=None, **kwargs):
            seen.append({"messages": json.loads(json.dumps(messages, default=str)), "tools": tools})
            step = queue.pop(0)
            if isinstance(step, dict):
                return ChatResult(content="", tool_calls=[ToolCall(id=f"call_{len(seen)}", name="computer", arguments=step)])
            return ChatResult(content=step)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.vision.has_vision", return_value=sees), \
                patch.object(LLMClient, "vision_supported", new=property(lambda self: sees)), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        return result, seen, asked

    def test_a_model_that_sees_gets_each_screen_and_acts_by_position(self):
        eyes = {"choice": "ask", "vision_model": None, "convention": "thousandths"}
        result, seen, asked = self.run_turn("qwen3-vl:8b", eyes, [{"op": "look"}, {"op": "click_at", "x": 500, "y": 250}, "Done: Hello is on."],
                                            sees=True)
        self.assertEqual(result["text"], "Done: Hello is on.")
        computer_tool = next(t for t in seen[0]["tools"] if t["function"]["name"] == "computer")
        self.assertIn("click_at", computer_tool["function"]["parameters"]["properties"]["op"]["enum"])
        self.assertIn("0-1000 scale", computer_tool["function"]["description"])
        # The screen it looked at came back to it as an image, labelled with its scale.
        after_look = json.dumps(seen[1]["messages"])
        self.assertIn("image_url", after_look)
        self.assertIn("your computer's screen after look (points are 0-1000 across it)", after_look)
        # 500, 250 on 0-1000 across a 1280x800 screen is the pixel (640, 200).
        self.assertEqual(asked[1], ("click_at", {"x": 640.0, "y": 200.0}))
        self.assertNotIn("eyes", result)

    def test_a_model_that_cannot_see_says_so_in_one_line_with_the_choices(self):
        eyes = {"choice": "ask", "vision_model": "deepseek-v4.1-flash:cloud", "convention": "pixels",
                "vision_convention": "pixels"}
        result, seen, asked = self.run_turn("glm-5.3:cloud", eyes, [{"op": "look"}, "this is never asked"], sees=False)
        computer_tool = next(t for t in seen[0]["tools"] if t["function"]["name"] == "computer")
        self.assertNotIn("click_at", computer_tool["function"]["parameters"]["properties"]["op"]["enum"])
        self.assertEqual(len(seen), 1, "its turn ends at the card")
        self.assertEqual(asked, [], "nothing was shown to a model that can't see")
        self.assertEqual(result["text"], "**glm-5.3:cloud can't see images.**")
        self.assertEqual(result["choices"], list(pip_eyes.labels("glm-5.3:cloud", "deepseek-v4.1-flash:cloud").values()))
        self.assertEqual(result["eyes"], {"model": "glm-5.3:cloud", "vision_model": "deepseek-v4.1-flash:cloud"})

    def test_a_canvas_page_a_text_only_model_worked_around_still_asks_once_after_what_it_said(self):
        # A text-only model may never ask to look: it reads, does what text allows, and says it couldn't check.
        eyes = {"choice": "ask", "vision_model": "deepseek-v4.1-flash:cloud", "convention": "pixels"}
        said = "I added the text. I pressed the up arrow a few times, but I have no way to check where it sits."
        result, seen, asked = self.run_turn("glm-5.3:cloud", eyes, [{"op": "read"}, said], sees=False, visual=True)
        self.assertEqual(result["text"], said + "\n\n**glm-5.3:cloud can't see images.**", "what it did stays, the line follows")
        self.assertEqual(result["choices"], list(pip_eyes.labels("glm-5.3:cloud", "deepseek-v4.1-flash:cloud").values()))
        plain, _, _ = self.run_turn("glm-5.3:cloud", eyes, [{"op": "read"}, "Your order total is $24."], sees=False)
        self.assertNotIn("eyes", plain, "a page its text shows asks nothing")
        told, _, _ = self.run_turn("glm-5.3:cloud", eyes, [{"op": "read"}, "My model can't see images, so I couldn't check the design."],
                                   sees=False)
        self.assertIn("eyes", told, "saying it can't see asks too")
        off = {**eyes, "choice": "off"}
        quiet, _, _ = self.run_turn("glm-5.3:cloud", off, [{"op": "read"}, said], sees=False, visual=True)
        self.assertNotIn("eyes", quiet, "after Not now it never asks again")

    def test_photos_for_a_model_that_cannot_see_bring_the_card_without_a_model_request(self):
        dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        eyes = {"choice": "ask", "vision_model": "deepseek-v4.1-flash:cloud", "convention": "pixels"}
        result, seen, _ = self.run_turn("glm-5.3:cloud", eyes, [], sees=False, images=[dot])
        self.assertEqual(seen, [], "no answer about photos it never saw")
        self.assertEqual(result["text"], "**glm-5.3:cloud can't see images.**")
        self.assertEqual(result["eyes"]["photos"][0]["mime"], "image/png")

    def test_after_use_it_to_see_the_photos_go_to_the_model_that_sees_and_points_come_back_in_words(self):
        dot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        from dgc.llm import ChatResult, LLMClient
        pip = self.store.create(self.registry.personal()["id"], "Bills", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "model", "model": "glm-5.3:cloud"}, computer_plan={"schema_version": 1})
        first = pip_chat.send(self.store, pip["id"], "What does this bill say?", "k1", "editor-user", self.cfg, images=[dot])["run"]
        self.store.claim_next()
        items = first["manifest"]["conversation"]["images"]
        self.store.finish(first["id"], result={"text": pip_eyes.line("glm-5.3:cloud"),
                                               "choices": list(pip_eyes.labels("glm-5.3:cloud", "deepseek-v4.1-flash:cloud").values()),
                                               "eyes": {"model": "glm-5.3:cloud", "vision_model": "deepseek-v4.1-flash:cloud", "photos": items}})
        tap = pip_chat.send(self.store, pip["id"], "Use deepseek-v4.1-flash:cloud to see, keep glm-5.3:cloud for the rest",
                            "k2", "editor-user", self.cfg)["run"]
        row = self.store.claim_next()
        with patch.object(pip_eyes, "sees", return_value=False):
            manifest = pip_eyes.pin(self.registry, row, json.loads(self.registry.db.execute(
                "SELECT manifest FROM pip_runs WHERE id=?", (tap["id"],)).fetchone()[0]), self.cfg)
        self.assertEqual(manifest["computer_eyes"]["decided"], "relay")
        self.assertEqual(len(manifest["computer_eyes"]["photos"]), 1, "the photos it couldn't see come with the answer")
        looked, seen = [], []
        def look(agent, route, images, question, *, attachments=False):
            looked.append((route.model, route.kind, len(images), attachments))
            return True, "A clinic bill for 1,200 rupees."
        def chat(client, messages, tools=None, **kwargs):
            seen.append(json.dumps(messages, default=str))
            return ChatResult(content="It is a clinic bill for 1,200 rupees.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.vision.has_vision", return_value=False), patch("dgc.vision.look", side_effect=look), \
                patch.object(LLMClient, "vision_supported", new=property(lambda self: False)), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        self.assertEqual(looked, [("deepseek-v4.1-flash:cloud", "pip", 1, True)], "the model that sees looked at the photo")
        self.assertIn("deepseek-v4.1-flash:cloud sees for you", seen[0])
        self.assertIn("A clinic bill for 1,200 rupees.", seen[0], "its report reaches the text-only model")
        self.assertEqual(result["text"], "It is a clinic bill for 1,200 rupees.")

    def test_not_now_means_it_works_from_the_text(self):
        eyes = {"choice": "off", "vision_model": "deepseek-v4.1-flash:cloud", "convention": "pixels"}
        result, seen, asked = self.run_turn("glm-5.3:cloud", eyes, [{"op": "look"}, "I read the page instead."], sees=False)
        self.assertIn("without seeing", json.dumps(seen[1]["messages"]))
        self.assertEqual(result["text"], "I read the page instead.")
        self.assertNotIn("choices", result)


if __name__ == "__main__":
    unittest.main()


# --------------------------------------------------------------------------- against a real Chromium in its box

from dgc import pip_computer_box as box  # noqa: E402

SHOP = "shop.dgc-eyes-test.example"
PAY = "pay.other-eyes-test.example"           # another site: its frame runs in its own process
SECRETS = """<!doctype html><title>Checkout</title><body style="margin:0;font:16px sans-serif;background:#fff">
<div style="padding:20px"><input id="email" name="email" value="ada@example.com" style="width:300px;background:#fff;border:1px solid #ccc"><br><br>
<input id="pw" type="password" name="password" value="hunter2-secret" style="width:300px"><br><br>
<input id="pw2" name="new_password" value="visible-secret-99" style="width:300px"><br><br>
<input id="cc" name="cardnumber" autocomplete="cc-number" value="4242 4242 4242 4242" style="width:300px"><br><br>
<input id="plain" name="notes" value="4111111111111111" style="width:300px"><br><br>
<input id="cvc" name="cvc" value="123" style="width:80px"><br><br>
<iframe id="pay" src="http://PAY/otp" style="width:420px;height:60px;border:0"></iframe></div></body>"""
OTP = """<!doctype html><body style="margin:0;font:16px sans-serif;background:#fff"><input id="code" autocomplete="one-time-code" value="987654" style="width:200px"></body>"""
DRAG = """<!doctype html><title>Drag</title><body style="margin:0">
<canvas id="c" width="600" height="300" style="position:absolute;left:20px;top:20px"></canvas>
<div id="item" draggable="true" style="position:absolute;left:700px;top:40px;width:100px;height:40px;background:#fc0">Drag me</div>
<div id="zone" style="position:absolute;left:700px;top:200px;width:200px;height:100px;border:2px dashed #888">Drop here</div>
<input id="file" type="file" style="display:none"><button id="pick" style="position:absolute;left:20px;top:400px;width:160px;height:40px"
 onclick="document.getElementById('file').click()">Upload a photo</button>
<form method="post" action="/order"><input type="hidden" name="item" value="tee"><button id="buy" style="position:absolute;left:220px;top:400px;width:120px;height:40px">Buy now</button></form>
<a id="away" href="http://PAY/otp" style="position:absolute;left:380px;top:410px">Another site</a>
<script>
window.log = {down: null, moves: 0, up: null, dropped: '', contextmenu: 0, dbl: 0, wheel: 0, chosen: ''};
const c = document.getElementById('c');
c.addEventListener('mousedown', e => { log.down = [e.offsetX, e.offsetY]; });
c.addEventListener('mousemove', e => { if (e.buttons) log.moves++; });
c.addEventListener('mouseup', e => { log.up = [e.offsetX, e.offsetY]; });
c.addEventListener('contextmenu', e => { e.preventDefault(); log.contextmenu++; });
c.addEventListener('dblclick', () => { log.dbl++; });
c.addEventListener('wheel', e => { log.wheel += e.deltaY; });
document.getElementById('item').addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'item'));
const z = document.getElementById('zone');
z.addEventListener('dragover', e => e.preventDefault());
z.addEventListener('drop', e => { e.preventDefault(); log.dropped = e.dataTransfer.getData('text/plain'); });
document.getElementById('file').addEventListener('change', async e => {
  const f = e.target.files[0]; log.chosen = f.name + ':' + f.size;
  const form = new FormData(); form.append('photo', f); fetch('/upload', {method: 'POST', body: form});
});
</script></body>"""


def _serve():
    import http.server
    received = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body = {"/otp": OTP, "/drag": DRAG}.get(self.path, SECRETS).replace("PAY", f"{PAY}:{self.server.server_address[1]}").encode()
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            received.append(self.path)
            self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, received


@unittest.skipUnless(box.capability().get("available") or os.environ.get("DGC_REQUIRE_CHROMIUM"),
                     "needs Linux, bubblewrap and a Chromium build")
class RealEyesTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        temp = tempfile.TemporaryDirectory(prefix="pe-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "home" / "Files").mkdir(parents=True)
        self.server, self.received = _serve()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]
        self.base = f"http://{SHOP}:{port}"
        policy = lambda host, p, **kw: ["127.0.0.1"] if host in (SHOP, PAY) and p == port else []
        self.proxy = box.EgressProxy(Path(f"/tmp/pe-{os.getpid()}-{id(self)}.sock"), policy=policy)
        self.proxy.start()
        self.addCleanup(self.proxy.stop)
        self.held = []
        self.browser = box.BoxedBrowser(self.root / "home", self.proxy.path, chrome=box.find_chrome(),
                                        log_path=self.root / "box.log", on_write=self.held.append)
        self.addCleanup(self.browser.close)

    def brightness(self, jpeg: bytes, points):
        """The model's screenshot, decoded by the browser itself: how bright it is at each (x, y)."""
        return self.browser.evaluate_json("""(async () => {
          const bin = atob(%s), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const pic = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
          const c = new OffscreenCanvas(pic.width, pic.height), g = c.getContext('2d'); g.drawImage(pic, 0, 0);
          return %s.map(([x, y]) => { const d = g.getImageData(x, y, 1, 1).data; return Math.round((d[0] + d[1] + d[2]) / 3); });
        })()""" % (json.dumps(base64.b64encode(jpeg).decode()), json.dumps(points)))

    def test_passwords_and_card_fields_are_black_in_what_the_model_sees(self):
        self.assertEqual(self.browser.navigate(self.base + "/"), "loaded")
        self.browser.pump(1.0)
        shot = self.browser.screenshot_for_model()
        self.assertLessEqual((shot["width"], shot["height"]), (1280, 800))
        centres = json.loads(self.browser.evaluate_json("JSON.stringify(['email','pw','pw2','cc','plain','cvc','pay'].map(id => {"
                                                        " const r = document.getElementById(id).getBoundingClientRect();"
                                                        " return [r.left + Math.min(r.width / 2, 60), id === 'pay' ? r.top + 10 : r.top + r.height / 2]; }))"))
        # The one-time code sits inside the other site's frame, at its top left.
        points = [[round(x * shot["scale"]), round(y * shot["scale"])] for x, y in centres]
        light = self.brightness(shot["data"], points)
        self.assertGreater(light[0], 150, "the email field is shown")
        for name, value in zip(("password", "shown password", "card number", "a card number in a plain field", "security code",
                                "a one-time code in another site's frame"), light[1:]):
            self.assertLess(value, 40, f"{name} is blacked out")
        self.assertGreaterEqual(shot["masked"], 6)
        # What the user's own live view and the approval card show is unchanged: not blacked out.
        self.assertGreater(self.brightness(self.browser.screenshot_jpeg(), [[round(x), round(y)] for x, y in centres[1:2]])[0], 150)

    def test_drags_clicks_scrolls_and_an_upload_reach_the_page_and_the_upload_waits(self):
        self.assertEqual(self.browser.navigate(self.base + "/drag"), "loaded")
        self.browser.drag(120, 120, 420, 270)
        self.browser.click_at(220, 130, button="right")
        self.browser.click_at(230, 140, count=2)
        self.browser.scroll_at(300, 150, 240)
        self.browser.drag(750, 60, 800, 250)          # an HTML drag-and-drop: Chrome's drag, finished at the zone
        self.browser.pump(0.5)
        log = json.loads(self.browser.evaluate_json("JSON.stringify(window.log)"))
        self.assertGreaterEqual(log["moves"], 10, "a drag moves in steps, so a canvas editor sees it")
        self.assertEqual((log["contextmenu"], log["dbl"], log["wheel"], log["dropped"]), (1, 1, 240, "item"))
        # The Pip's right click reaches the page, never opening the browser's own menu on the computer's screen.
        self.browser.evaluate_json("(() => { window.__menus = []; addEventListener('contextmenu', e => __menus.push(e.defaultPrevented)); return 1; })()")
        self.browser.click_at(700, 300, button="right")      # off the canvas: no page handler cancels it
        self.browser.pump(0.3)
        self.assertEqual(self.browser.evaluate_json("window.__menus"), [True], "DGC cancelled the browser's menu")
        self.browser.evaluate_json("(() => { document.body.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true})); return 1; })()")
        self.assertEqual(self.browser.evaluate_json("window.__menus"), [True, False], "only for that click: the user's menu is theirs")
        self.assertEqual(self.browser.element_at(100, 420), 'button "Upload a photo"')
        (self.root / "home" / "Files" / "photo.jpg").write_bytes(JPEG)
        self.assertEqual(self.browser.set_files(["/home/pip/Files/photo.jpg"], point=(100, 420)), "chooser")
        end = __import__("time").monotonic() + 10
        while not self.held and __import__("time").monotonic() < end:
            self.browser.pump(0.3)
        self.assertEqual(json.loads(self.browser.evaluate_json("JSON.stringify(window.log)"))["chosen"], f"photo.jpg:{len(JPEG)}")
        self.assertEqual([h.summary()["path"] for h in self.held], ["/upload"], "the page's upload waits for the user")
        self.assertEqual(self.received, [], "nothing was sent")

    def test_a_click_by_position_is_held_like_any_other_and_careful_mode_still_asks_for_a_new_site(self):
        self.assertEqual(self.browser.navigate(self.base + "/drag"), "loaded")
        self.browser.click_at(280, 420)                 # "Buy now", by position
        end = __import__("time").monotonic() + 10
        while not self.held and __import__("time").monotonic() < end:
            self.browser.pump(0.3)
        self.assertEqual([(h.method, h.summary()["path"]) for h in self.held], [("POST", "/order")], "the submit waits")
        self.assertEqual(self.received, [])
        self.browser.drop(self.held[0].request_id)
        self.held.clear()
        self.assertEqual(self.browser.navigate(self.base + "/drag"), "loaded")    # a dropped submit leaves an error page
        # Careful mode: the link to another site, clicked by position, waits for the user like any new site.
        self.browser.site_gate = lambda url: PAY not in url
        self.browser.click_at(400, 418)
        end = __import__("time").monotonic() + 10
        while not self.held and __import__("time").monotonic() < end:
            self.browser.pump(0.3)
        self.assertTrue(self.held and self.held[0].site, "a new site waits, however it was clicked")
        self.assertEqual(self.held[0].summary()["host"], PAY)

    def test_how_much_of_a_page_is_drawn_on_canvases(self):
        self.assertEqual(self.browser.navigate(self.base + "/drag"), "loaded")
        host = types.SimpleNamespace(browser=self.browser)
        share = pip_computer.Host._drawn_share(host)
        width, height = self.browser.evaluate_json("[innerWidth, innerHeight]")
        self.assertAlmostEqual(share, 600 * 300 / (width * height), places=3)
        self.assertGreater(share, pip_computer.VISUAL_SHARE)
