"""pips-10, slice 2b (0.52, D9): a picture or video generator's key, asked for on a card in a Pip's chat.

A Personal Pip asked for a picture or a video with a generator that has no key yet, or whose key the provider turned
away, used to stop with "paste the whole key again in Settings → Models → Images". Now its chat shows the same key card
as a site's key (pip_keys), of kind "generator": the user pastes the key there and it is kept where Settings keeps that
generator's key (secrets.json, bound to the generator's address), for all of DGC; the Pip never sees it and carries on.
Removing the card on the Pip's page leaves the generator's key in Settings."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from image_fakes import FakeImages  # noqa: E402

from dgc import images, pip_chat, pip_images, pip_keys, pips  # noqa: E402
from dgc.redaction import secret_values  # noqa: E402
from dgc.workspace_registry import RegistryError, WorkspaceRegistry  # noqa: E402
from tests import test_pips_local as fixtures  # noqa: E402

KEY = "fal_live_0123456789abcdefKEYKEY"


def user_home(case, generators):
    """The user's own DGC files, in this test's temp home: a generator key saved from a card is written where Settings
    keeps keys (secrets.json), and that must never be the real home's."""
    from dgc import config as config_module
    home = Path(case.base) / "user-dgc"
    home.mkdir(exist_ok=True)
    for name, value in (("USER_HOME", home), ("USER_CONFIG", home / "config.json"), ("USER_SECRETS", home / "secrets.json")):
        patcher = mock.patch.object(config_module, name, value)
        patcher.start()
        case.addCleanup(patcher.stop)
    config_module.Config(project_root=Path(case.root)).set_images({"generators": generators})


class GeneratorKeyCard(unittest.TestCase):
    setUp_pips = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        self.setUp_pips()
        self.fake = FakeImages()
        self.addCleanup(self.fake.close)
        self.pip = self.store.create(self.registry.personal()["id"], "Ava", "Draw what I ask", "editor-user")
        fal = {"id": "fal", "name": "fal FLUX schnell", "provider": "fal", "base_url": self.fake.url,
               "model": "fal-ai/flux/schnell", "asks": False}
        self.cfg.set_images({"generators": [fal]}, persist=False)
        user_home(self, [fal])

    def session(self, run_id="run_" + "a" * 32):
        session = pip_images.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run_id)
        session.user_turn, session.user_message = True, "Yes please"
        return session

    def draw(self):
        return self.session().call("generate_image", {"prompt": "a red fox"})

    def control(self, command, actor="editor-user", **fields):
        with mock.patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def cards(self):
        return self.control("list_pip_keys", pip_id=self.pip["id"])["keys"]

    def everything_kept(self) -> str:
        db = self.registry.db
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        return json.dumps({t: [list(map(str, row)) for row in db.execute(f"SELECT * FROM {t}")] for t in tables})

    def test_no_key_raises_one_generator_card_instead_of_sending_the_user_to_settings(self):
        said = self.draw()
        self.assertIn("below your reply", said)
        self.assertIn("fal FLUX schnell", said)
        self.assertNotIn("Settings → Models → Images → fal FLUX schnell → Edit", said, "not the old way any more")
        cards = self.cards()
        self.assertEqual(len(cards), 1)
        card = cards[0]
        self.assertEqual((card["kind"], card["generator"], card["status"], card["refused"]),
                         ("generator", "fal", "requested", False))
        self.assertEqual(card["name"], "fal FLUX schnell key")
        self.assertIn("pictures", card["why"])
        self.assertIn("already below your reply", self.draw(), "asking again keeps one card")
        self.assertEqual(len(self.cards()), 1)
        self.assertEqual([r for r in self.fake.requests if r["path"].startswith("/fal-ai/")], [], "nothing was sent")

    def test_saving_keeps_it_with_the_generator_for_all_of_dgc_and_the_pip_carries_on(self):
        self.draw()
        card = self.cards()[0]
        with mock.patch("dgc.pip_chat.continue_after_key") as carry:
            answered = self.control("save_pip_key", pip_id=self.pip["id"], key_id=card["id"], value=KEY)
        self.assertEqual(answered["key"]["status"], "saved")
        self.assertNotIn(KEY, json.dumps(answered))
        self.assertEqual(self.cfg.image_key("fal"), KEY, "kept where Settings keeps fal's key")
        self.assertIn(KEY, secret_values(self.cfg))
        self.assertNotIn(KEY, self.everything_kept(), "never in the Pips registry or its events")
        carry.assert_called_once()
        told = pip_chat.KEY_SAVED_GENERATOR.format(name="fal FLUX schnell")
        self.assertIn("again", told)
        said = self.draw()
        self.assertTrue(said.startswith("Made 1 image"), said)

    def test_a_key_the_provider_turns_away_puts_the_card_back(self):
        self.cfg.set_image_key("fal", "fal-old", persist=False)
        self.fake.mode["fal"] = "bad_key"
        said = self.draw()
        self.assertIn("below your reply", said)
        card = self.cards()[0]
        self.assertEqual((card["kind"], card["status"], card["refused"]), ("generator", "requested", True))

    def test_removing_the_card_leaves_the_generators_key_in_settings(self):
        self.draw()
        card = self.cards()[0]
        with mock.patch("dgc.pip_chat.continue_after_key"):
            self.control("save_pip_key", pip_id=self.pip["id"], key_id=card["id"], value=KEY)
        self.control("remove_pip_key", pip_id=self.pip["id"], key_id=card["id"])
        self.assertEqual(self.cards(), [])
        self.assertEqual(self.cfg.image_key("fal"), KEY, "the key stays: it is the user's own setting")

    def test_its_list_says_a_card_asks_for_a_missing_key_not_settings(self):
        # Live check, 11 Nov: told "no key yet (the user adds it in Settings...)" by list_image_generators, the Pip
        # sent the user to Settings and never tried, so the card never came. The Pip's list says the card asks.
        listed = self.session().call("list_image_generators", {})
        self.assertIn("fal FLUX schnell", listed)
        self.assertNotIn("Settings → Models → Images", listed)
        self.assertIn("card", listed)
        self.assertIn("generate_image", listed)

    def test_a_site_card_and_a_generator_card_never_mix(self):
        self.draw()
        site = pip_keys.request(self.registry, self.cfg, self.pip["id"], self.pip["workspace_id"], None,
                                {"name": "Weather key", "why": "Read the forecast", "host": "api.weather.example"})
        self.assertIn("below your reply", site)
        kinds = sorted(c["kind"] for c in self.cards())
        self.assertEqual(kinds, ["generator", "site"])
        said = pip_keys.fetch(self.registry, self.cfg, self.pip["id"], "https://fal.example/x")
        self.assertIn("no key for", said, "a generator card is no site's key")


class VideoGeneratorKeyCard(unittest.TestCase):
    """The same for a video generator (pip_videos)."""
    setUp_pips = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        self.setUp_pips()
        from video_fakes import FakeVideos
        from dgc import videos
        self.fake = FakeVideos()
        self.addCleanup(self.fake.close)
        ctx = videos.fresh_jobs()
        ctx.__enter__()
        self.addCleanup(ctx.__exit__, None, None, None)
        self.pip = self.store.create(self.registry.personal()["id"], "Ava", "Make clips", "editor-user")
        wan = {"id": "fal-wan", "name": "fal Wan 2.2", "provider": "fal", "base_url": self.fake.url,
               "model": "fal-ai/wan/v2.2-5b/text-to-video", "makes": "videos", "asks": False}
        self.cfg.set_images({"generators": [wan]}, persist=False)
        user_home(self, [wan])

    def test_its_video_list_says_the_same(self):
        from dgc import pip_videos
        session = pip_videos.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], "run_" + "d" * 32)
        listed = session.call("list_video_generators", {})
        self.assertIn("fal Wan 2.2", listed)
        self.assertNotIn("Settings → Models → Images", listed)
        self.assertIn("generate_video", listed)

    def test_no_key_for_a_video_generator_raises_its_card(self):
        from dgc import pip_videos
        def session(run):
            s = pip_videos.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run)
            s.user_turn, s.user_message = True, "Yes, make it"
            return s
        asked = session("run_" + "b" * 32).call("generate_video", {"prompt": "a felt ball rolls"})
        self.assertIn("ask the user", asked, "every video asks first, key or not")
        said = session("run_" + "c" * 32).call("generate_video", {"prompt": "a felt ball rolls", "confirm": True})
        self.assertIn("below your reply", said)
        cards = pip_keys.listing(self.registry, self.pip["id"])["keys"]
        self.assertEqual([(c["kind"], c["generator"]) for c in cards], [("generator", "fal-wan")])
        self.assertIn("videos", cards[0]["why"])


if __name__ == "__main__":
    unittest.main()


class GeneratorKeyReachesDisk(unittest.TestCase):
    """Live check, 11 Nov: the editor hands Pips commands a non-persisting view of its config (clone_for_root), so a
    generator key saved from a Pip's card stayed in that view only: not in secrets.json, so neither the runner that
    makes the picture nor the next DGC saw it. It must be saved where Settings saves it."""

    def setUp(self):
        import tempfile
        from dgc import config as config_module
        self.home = Path(tempfile.mkdtemp(prefix="dgc-genkey-")).resolve()
        (self.home / "dgc").mkdir()
        for name, value in (("USER_HOME", self.home / "dgc"), ("USER_CONFIG", self.home / "dgc" / "config.json"),
                            ("USER_SECRETS", self.home / "dgc" / "secrets.json")):
            patcher = mock.patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.config_module = config_module
        project = self.home / "project"
        project.mkdir()
        user = config_module.Config(project_root=project)
        user.set_images({"generators": [{"id": "fal", "name": "fal FLUX schnell", "provider": "fal",
                                         "base_url": "http://127.0.0.1:9", "model": "fal-ai/flux/schnell"}]})
        self.view = config_module.Config(project_root=project).clone_for_root(project)   # what the editor hands Pips
        self.project = project

    def test_saved_from_a_non_persisting_view_it_is_on_disk_for_every_dgc(self):
        self.assertFalse(self.view._persist)
        pip_keys.save_generator_key(self.view, "fal", KEY)
        self.assertEqual(self.view.image_key("fal"), KEY, "this view sees it now")
        fresh = self.config_module.Config(project_root=self.project)
        self.assertEqual(fresh.image_key("fal"), KEY, "and every other DGC, the runner included, from secrets.json")
        self.assertEqual(json.loads(self.config_module.USER_SECRETS.read_text()).get("image_key_fal"), KEY)
