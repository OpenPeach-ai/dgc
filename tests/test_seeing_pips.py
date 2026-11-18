"""A Pip's chat: a model that can see, found on every connection a Pip can reach (dgc/seeing.py through pip_eyes).

The Pip's model can't see. The model that can is found on its own connection, the Sub-agents model or a saved
provider DGC keeps for Pips; the card offers it (as a question card for a screen that draws one); at Do it all
nothing is asked, it looks, and the reply says in one line which model looked. Settings' choice counts for a Pip that
never chose, and the newer word wins.
"""
import json
import os
import sys
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_eyes, pip_levels, pip_questions, pips, questions, seeing
from tests import test_pip_eyes as eyes_tests
from tests.test_seeing import FakeHosts, SEES, TEXT

DOT = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
PROVIDER = "provider_" + "e" * 32
# The Pip's own connection lists these (no network): none of them sees.
CAPS = {"deepseek-v4.1-flash:cloud": {"completion", "tools"}, "glm-5.3:cloud": {"completion", "tools"},
        "qwen3-vl:8b": {"completion", "tools"}}


class SeeingPipsTests(unittest.TestCase):
    setUp = eyes_tests.catalog_setup

    @classmethod
    def setUpClass(cls):
        cls.hosts = FakeHosts()

    @classmethod
    def tearDownClass(cls):
        cls.hosts.close()

    def provider(self, catalog, *, name="Ollama Cloud", key="key-cloud"):
        """A saved provider DGC keeps for Pips, on the fake host."""
        prefix = f"pp{len(self.hosts.catalogs) + 1}"
        self.hosts.catalogs[prefix] = catalog
        record = {"name": name, "base_url": self.hosts.url(prefix), "api_mode": "ollama", "model": next(iter(catalog)),
                  "api_key": key}
        # On the class: a run's own copy of the settings (a provider's view) reads the same saved providers. (Both the
        # fixture's class and today's dgc.config one: another test may have loaded the module again.)
        for cls in {type(self.cfg), sys.modules["dgc.config"].Config}:
            for target, value in (("saved_provider_names", lambda cfg: [{"id": PROVIDER, "name": name, "host": "cloud.invalid"}]),
                                  ("saved_provider", lambda cfg, ident: dict(record) if ident == PROVIDER else None)):
                started = patch.object(cls, target, value)
                started.start()
                self.addCleanup(started.stop)
        return record

    def own_caps(self, caps=CAPS):
        started = patch.object(pip_eyes, "capabilities", side_effect=lambda c, m: caps.get(m))
        started.start()
        self.addCleanup(started.stop)
        seeing.forget()
        self.addCleanup(seeing.forget)

    def pip(self, model="glm-5.3:cloud", choice=None):
        return self.store.create(self.registry.personal()["id"], "Tees", None, "editor-user", pip_type="lens",
                                 model_choice=choice or {"mode": "model", "model": model},
                                 computer_plan={"schema_version": 1})

    def pinned(self, pip, text="What does this say?", images=None, key="k1"):
        run = pip_chat.send(self.store, pip["id"], text, key, "editor-user", self.cfg, images=images)["run"]
        row = self.store.claim_next()
        self.assertEqual(row["id"], run["id"])
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        return run, pip_eyes.pin(self.registry, row, manifest, self.cfg)

    # --- the search ------------------------------------------------------------------------------

    def test_a_model_on_a_saved_provider_is_found_and_the_run_looks_with_it_there(self):
        self.own_caps()
        record = self.provider({"vis-cloud": SEES})
        pip = self.pip()
        status = pip_eyes.status(self.store, pip["id"], self.cfg)
        self.assertEqual((status["sees"], status["vision_model"]), (False, "vis-cloud"))
        self.assertEqual(sorted(status), ["choice", "model", "pip_id", "sees", "vision_model"],
                         "the Pip page's answer keeps its shape (an older editor reads exactly these)")
        _, manifest = self.pinned(pip)
        eyes = manifest["computer_eyes"]
        self.assertEqual(eyes["vision_model"], "vis-cloud")
        self.assertEqual(eyes["vision_route"], {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"})
        self.assertNotIn("key-cloud", json.dumps(manifest), "a key is never in a run's manifest")
        pip_eyes.validate_pin(eyes)
        # The worker reaches it on that provider, with that provider's key only.
        conn = pip_eyes.look_connection(self.cfg, eyes["vision_route"], on_provider=False)
        self.assertEqual((conn.base_url, conn.api_key), (record["base_url"], "key-cloud"))
        self.assertIsNone(pip_eyes.look_connection(self.cfg, {"kind": "provider", "id": "provider_" + "f" * 32,
                                                              "name": "Removed"}, on_provider=False))

    def test_a_worker_gets_the_looks_route_in_its_payload_and_looks_with_it(self):
        # A Pip's worker has an empty private home: the look's address and key come with its payload, read where the
        # user's settings are, as its own model's key does (the live check of 18 Nov caught a worker that couldn't).
        self.own_caps()
        record = self.provider({"vis-cloud": SEES})
        manifest = {"computer_eyes": {"choice": "relay", "vision_model": "vis-cloud", "convention": "pixels",
                                      "vision_route": {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"}}}
        route = pip_eyes.worker_route(self.cfg, manifest)
        self.assertEqual(route, {"base_url": record["base_url"], "api_mode": "ollama", "api_key": "key-cloud",
                                 "name": "Ollama Cloud", "kind": "provider"})
        self.assertIsNone(pip_eyes.worker_route(self.cfg, {"computer_eyes": {"choice": "ask", "vision_model": None}}))
        conn = pip_eyes.worker_connection(route)
        self.assertEqual((conn.base_url, conn.api_key, conn.name), (record["base_url"], "key-cloud", "Ollama Cloud"))
        self.assertIsNone(pip_eyes.worker_connection({"base_url": "file:///etc", "api_mode": "", "api_key": "", "name": "x",
                                                      "kind": "provider"}))
        # The worker's own settings know no saved provider: it looks with the payload's route.
        pip = self.pip()
        with self.registry.transaction():
            pip_levels.write_level(self.registry, pip["id"], "full", "editor-user")
        run, pinned = self.pinned(pip, images=[DOT])
        pinned["conversation_image_paths"] = [str(p) for p in pip_chat.image_paths(
            self.registry.directory, pip["id"], pinned["conversation"]["images"])]
        looked = []

        def look(agent, route, images, question, *, attachments=False):
            looked.append((route.kind, route.conn.base_url, route.conn.api_key))
            return True, "A sign reading OPEN."
        from dgc.llm import ChatResult, LLMClient
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(pips, "_EYES_ROUTE", route), patch.object(type(self.cfg), "saved_provider", lambda cfg, ident: None), \
                patch.object(sys.modules["dgc.config"].Config, "saved_provider", lambda cfg, ident: None), \
                patch.object(LLMClient, "chat", lambda client, messages, tools=None, **kw: ChatResult(content="It says OPEN.")), \
                patch("dgc.agent.discover_skills", return_value={}), patch("dgc.vision.has_vision", return_value=False), \
                patch("dgc.vision.look", side_effect=look), \
                patch.object(LLMClient, "vision_supported", new=property(lambda self: False)), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, pinned, lambda e: None)
        self.assertEqual(looked, [("connection", record["base_url"], "key-cloud")])
        self.assertTrue(result["text"].endswith("*vis-cloud looked at the picture.*"), result["text"])

    def test_a_pip_on_a_saved_provider_searches_that_provider_first(self):
        self.own_caps({"qwen3-vl:8b": {"completion", "tools", "vision"}})
        self.provider({"txt-cloud": TEXT, "vis-cloud": SEES})
        pip = self.pip(choice={"mode": "provider", "provider": PROVIDER, "model": "txt-cloud"})
        found = pip_eyes.find(self.cfg, "txt-cloud", {"mode": "provider", "provider": PROVIDER, "model": "txt-cloud"})
        self.assertEqual((found.model, found.connection.key), ("vis-cloud", f"provider:{PROVIDER}"))
        self.assertFalse(pip_eyes.sees(self.cfg, "txt-cloud", self.store._job(pip["id"])["model_choice"]),
                         "whether its model sees is asked of its own provider")

    # --- Do it all -------------------------------------------------------------------------------

    def test_at_do_it_all_nothing_is_asked_it_looks_and_the_reply_says_which_model_looked(self):
        self.own_caps()
        self.provider({"vis-cloud": SEES})
        pip = self.pip()
        with self.registry.transaction():
            pip_levels.write_level(self.registry, pip["id"], "full", "editor-user")
        run, manifest = self.pinned(pip, images=[DOT])
        eyes = manifest["computer_eyes"]
        self.assertEqual((eyes["choice"], eyes["vision_model"], eyes.get("auto")), ("relay", "vis-cloud", True))
        self.assertEqual(pip_eyes.saved(self.registry.db, pip["id"])["choice"], "ask", "nothing is remembered for it")
        looked = []

        def look(agent, route, images, question, *, attachments=False):
            looked.append((route.model, route.kind, route.conn.base_url if route.conn else ""))
            return True, "A sign reading OPEN."
        from dgc.llm import ChatResult, LLMClient
        manifest["conversation_image_paths"] = [str(p) for p in pip_chat.image_paths(
            self.registry.directory, pip["id"], manifest["conversation"]["images"])]
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", lambda client, messages, tools=None, **kw: ChatResult(content="It says OPEN.")), \
                patch("dgc.agent.discover_skills", return_value={}), patch("dgc.vision.has_vision", return_value=False), \
                patch("dgc.vision.look", side_effect=look), \
                patch.object(LLMClient, "vision_supported", new=property(lambda self: False)), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        self.assertEqual(looked[0][:2], ("vis-cloud", "connection"))
        self.assertIn("/pp", looked[0][2], "it looked on the saved provider")
        self.assertEqual(result["text"], "It says OPEN.\n\n*vis-cloud looked at the picture.*")
        self.assertNotIn("eyes", result)
        self.assertNotIn("choices", result)

    # --- the card --------------------------------------------------------------------------------

    def test_a_screen_that_draws_question_cards_gets_the_choices_as_one_and_its_answer_counts(self):
        self.own_caps()
        self.provider({"vis-cloud": SEES})
        pip = self.pip()
        eyes = {"choice": "ask", "vision_model": "vis-cloud", "convention": "pixels", "vision_convention": "pixels",
                "vision_route": {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"}}
        result, seen, _ = self.run_turn_with(pip, eyes, questions_drawn=True)
        self.assertEqual(seen, [], "no answer about photos it never saw")
        self.assertEqual(result["text"], "**glm-5.3:cloud can't see images.**")
        self.assertNotIn("choices", result)
        card = result["questions"][0]
        self.assertEqual([o["label"] for o in card["options"]],
                         ["Use vis-cloud to see, keep glm-5.3:cloud for the rest", "Switch this Pip to vis-cloud", "Not now"])
        self.assertIn("on Ollama Cloud", card["question"])
        # The reply is kept with its card; the user's answer on the card is their next message, and it is the answer.
        self.store.finish(self.current_run, result=result)
        reply = pip_chat.list_messages(self.store, pip["id"])["messages"][-1]
        answered = pip_questions.answer(self.store, pip["id"], reply["id"], "k-answer", "editor-user", self.cfg,
                                        answers={card["id"]: {"selected": [0], "other": ""}})
        self.assertTrue(answered["run"])
        saved = pip_eyes.saved(self.registry.db, pip["id"])
        self.assertEqual(saved, {"choice": "relay", "vision_model": "vis-cloud"})
        self.assertEqual(pip_eyes.saved_route(self.registry.db, pip["id"]),
                         {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"})

    def test_switch_to_a_model_on_a_saved_provider_moves_the_pip_onto_that_provider(self):
        self.own_caps()
        self.provider({"vis-cloud": SEES})
        pip = self.pip()
        eyes = {"choice": "ask", "vision_model": "vis-cloud", "convention": "pixels",
                "vision_route": {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"}}
        result, _, _ = self.run_turn_with(pip, eyes)
        self.assertEqual(result["choices"], ["Use vis-cloud to see, keep glm-5.3:cloud for the rest",
                                             "Switch this Pip to vis-cloud", "Not now"])
        self.store.finish(self.current_run, result=result)
        record = self.cfg.saved_provider(PROVIDER)
        with patch("dgc.pip_models._catalog", side_effect=lambda c: ["vis-cloud"] if c.get("base_url") == record["base_url"]
                   else list(eyes_tests.CATALOG)):
            pip_chat.send(self.store, pip["id"], "Switch this Pip to vis-cloud", "k-sw", "editor-user", self.cfg)
        self.assertEqual(self.store._job(pip["id"])["model_choice"],
                         {"mode": "provider", "provider": PROVIDER, "model": "vis-cloud"})

    def test_settings_choice_counts_for_a_pip_that_never_chose_and_the_newer_word_wins(self):
        self.own_caps()
        self.provider({"vis-cloud": SEES})
        pip = self.pip()
        self.cfg.data["seeing"] = {"choice": "relay", "model": "vis-cloud", "at": 1.0,
                                   "connection": {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"}}
        status = pip_eyes.status(self.store, pip["id"], self.cfg)
        self.assertEqual((status["choice"], status["vision_model"]), ("relay", "vis-cloud"))
        _, manifest = self.pinned(pip)
        self.assertEqual(manifest["computer_eyes"]["choice"], "relay")
        self.assertEqual(manifest["computer_eyes"]["vision_route"]["id"], PROVIDER)
        pip_eyes.set_choice(self.store, pip["id"], "off", "editor-user", self.cfg)
        self.assertEqual(pip_eyes.status(self.store, pip["id"], self.cfg)["choice"], "off", "the Pip's own newer word")
        self.cfg.data["seeing"] = {**self.cfg.data["seeing"], "at": 4102444800.0}      # Settings changed later still
        self.assertEqual(pip_eyes.status(self.store, pip["id"], self.cfg)["choice"], "relay")

    # --- a turn, as the Pips worker runs it -------------------------------------------------------

    def run_turn_with(self, pip, eyes, *, questions_drawn=False):
        from dgc.llm import ChatResult, LLMClient
        run = pip_chat.send(self.store, pip["id"], "What does this say?", "k1", "editor-user", self.cfg, images=[DOT],
                            **({"questions": True} if questions_drawn else {}))["run"]
        self.store.claim_next()
        self.current_run = run["id"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        manifest = {**raw, "computer_eyes": eyes,
                    "conversation_image_paths": [str(p) for p in pip_chat.image_paths(
                        self.registry.directory, pip["id"], raw["conversation"]["images"])]}
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(messages)
            return ChatResult(content="never")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.vision.has_vision", return_value=False), \
                patch.object(LLMClient, "vision_supported", new=property(lambda self: False)), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        return result, seen, raw


if __name__ == "__main__":
    unittest.main()
