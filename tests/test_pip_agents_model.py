"""A Pip's own sub-agents model (0.52, Pips API 104).

set_pip_agents takes, beside `slots`, the model a Pip's sub-agents run on (a model on DGC's own connection or a saved
provider's; "This Pip's model" by default), their thinking, their context window and their fallback; list_pip_agents
says them. A sub-agent job's run runs on that model, with that thinking and window, and carries on with that fallback
in place of the Pip's. Every run of the Pip gives DGC's own helpers inside it the same settings. A subscription CLI and
DGC Router are refused; a removed provider refuses the job's run in plain words, never another provider. No key in a
run's manifest, a registry row or an event.

Real registry, real runs queued through PipStore, the real control seam; the worker's own start is its two seams
(pips._run_fallbacks, which reads what the worker gets beside its manifest, and pips._worker_config_overrides).
"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from dgc import pip_agents, pip_chat, pip_chat_options, pip_models, pips
from dgc.workspace_registry import RegistryError
from tests.test_pip_agents import RETRY, AgentWorld

AGENTS = "provider_" + "a" * 32
SPARE = "provider_" + "b" * 32
GONE = "provider_" + "e" * 32
AGENTS_KEY, SPARE_KEY, OWN_KEY = "sk-agents-secret-0001", "sk-spare-secret-0002", "sk-own-secret-0003"
SAVED = {AGENTS: {"name": "Agents host", "base_url": "https://agents.example/v1", "api_mode": "chat_completions",
                  "model": "agents-model", "api_key": AGENTS_KEY},
         SPARE: {"name": "Spare", "base_url": "https://spare.example/v1", "api_mode": "responses",
                 "model": "spare-model", "api_key": SPARE_KEY}}
DEFAULTS = {"model_choice": {"mode": "default"}, "thinking": "", "context_size": 0,
            "fallback": {"provider": "", "model": ""}}
NO_CLI = "It runs its own tools, so it can’t run DGC’s sub-agents."


class ModelWorld(AgentWorld):
    def setUp(self):
        super().setUp()
        self.pip_id = self.helper["id"]

    def saved(self):
        """The two saved providers, as Settings -> Models keeps them (their keys in secrets.json). On this Config's own
        class and on dgc.config.Config both: in the full suite an earlier test can leave the two apart, and the copy a
        Pip run takes (clone_for_root) must read the same providers."""
        import contextlib
        from dgc import config as config_module
        stack = contextlib.ExitStack()
        reader = lambda this, pid: dict(SAVED[pid]) if pid in SAVED else None  # noqa: E731
        for cls in {type(self.cfg), config_module.Config}:
            stack.enter_context(patch.object(cls, "saved_provider", reader))
        return stack

    def listed(self, model="agents-local"):
        """DGC's own connection lists these models (the catalog is never fetched in a test)."""
        return patch.object(pip_models, "_catalog", return_value=sorted({model, "fixture"}))

    def set(self, actor="editor-user", **fields):
        return self.control("set_pip_agents", actor=actor, pip_id=self.pip_id, **fields)

    def agents(self):
        return self.control("list_pip_agents", pip_id=self.pip_id)

    def job_manifest(self):
        job = pip_agents.start(self.store, self.cfg, self.pip_id, kind="fix", title="Fix it", brief="Fix the total.")
        return self.manifest(job["run_id"])

    def manifest(self, run_id):
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()[0])

    def run_row(self, run_id):
        return dict(self.registry.db.execute("SELECT * FROM pip_runs WHERE id=?", (run_id,)).fetchone())

    def chat_run(self, key="you-1"):
        answer = pip_chat.send(self.store, self.pip_id, "how is it going?", key, "editor-user", self.cfg)
        return answer["run"]["id"]


class WhatItKeepsAndSays(ModelWorld, unittest.TestCase):
    def test_list_pip_agents_says_the_defaults(self):
        listed = self.agents()
        self.assertEqual({k: listed[k] for k in DEFAULTS}, DEFAULTS)
        self.assertEqual((listed["agents"], listed["slots"]), ([], 1))

    def test_set_answers_all_five_and_keeps_them_in_its_own_row(self):
        with self.saved():
            said = self.set(model_choice={"mode": "provider", "provider": AGENTS, "model": "agents-model"},
                            thinking="high", context_size=131072, fallback={"provider": SPARE, "model": "spare-model"})
        expected = {"model_choice": {"mode": "provider", "provider": AGENTS, "model": "agents-model"}, "thinking": "high",
                    "context_size": 131072, "fallback": {"provider": SPARE, "model": "spare-model"}}
        self.assertEqual(said, {"slots": 1, **expected})
        row = self.registry.db.execute("SELECT value FROM metadata WHERE key=?", ("pip_agent_model:" + self.pip_id,)).fetchone()
        self.assertEqual(json.loads(row[0]), expected)
        listed = self.agents()
        self.assertEqual({k: listed[k] for k in expected}, expected)

    def test_slots_alone_answer_all_five_as_well(self):
        self.assertEqual(self.set(slots=4), {"slots": 4, **DEFAULTS})

    def test_a_field_not_given_keeps_its_value(self):
        self.set(thinking="low", context_size=65536)
        self.set(model_choice={"mode": "model", "model": "agents-local"})
        said = self.set(fallback={"provider": "", "model": "fb-local"})
        self.assertEqual((said["thinking"], said["context_size"], said["model_choice"]["model"], said["fallback"]["model"]),
                         ("low", 65536, "agents-local", "fb-local"))
        said = self.set(slots=2)
        self.assertEqual((said["slots"], said["thinking"], said["model_choice"]["mode"]), (2, "low", "model"))
        self.assertEqual(self.set(thinking="", context_size=0, model_choice={"mode": "default"},
                                  fallback={"provider": "", "model": ""}), {"slots": 2, **DEFAULTS}, "back to the Pip's")

    def test_an_unreadable_stored_value_reads_as_the_defaults(self):
        for value in ("not json", json.dumps([1]), json.dumps({"model_choice": {"mode": "subscription", "engine": "claude"},
                                                                "thinking": "max", "context_size": 5,
                                                                "fallback": {"engine": "codex", "model": ""}})):
            with self.subTest(value=value):
                with self.registry.transaction():
                    self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", ("pip_agent_model:" + self.pip_id, value))
                listed = self.agents()
                self.assertEqual({k: listed[k] for k in DEFAULTS}, DEFAULTS)


class WhatItRefuses(ModelWorld, unittest.TestCase):
    def refused(self, code, **fields):
        with self.assertRaises(RegistryError) as raised:
            self.set(**fields)
        self.assertEqual(raised.exception.code, code, str(raised.exception))
        return str(raised.exception)

    def test_a_subscription_cli_is_refused_in_its_own_words(self):
        for choice in ({"mode": "subscription", "engine": "claude"}, {"mode": "subscription", "engine": "codex", "model": "o5"}):
            with self.subTest(choice=choice):
                self.assertEqual(self.refused("invalid_model_choice", model_choice=choice), NO_CLI)

    def test_dgc_router_is_refused(self):
        for choice in ({"mode": "router"}, {"mode": "router", "system": "workstation", "model": "glm-5.3:cloud"}):
            with self.subTest(choice=choice):
                said = self.refused("invalid_model_choice", model_choice=choice)
                self.assertIn("DGC Router", said)

    def test_a_choice_of_another_shape_is_refused(self):
        for choice in ({"mode": "model"}, {"mode": "provider", "provider": "provider_nope", "model": "m"},
                       "default", None, {"mode": "default", "model": "x"}):
            with self.subTest(choice=choice):
                self.refused("invalid_model_choice", model_choice=choice)
        self.refused("invalid_model", model_choice={"mode": "model", "model": "https://evil.example/v1"})

    def test_thinking_is_one_of_its_words(self):
        for value in ("max", "OFF", "none", 1, None, True):
            with self.subTest(value=value):
                self.refused("invalid_request", thinking=value)
        for value in ("", "off", "low", "medium", "high", "xhigh"):
            with self.subTest(value=value):
                self.assertEqual(self.set(thinking=value)["thinking"], value)

    def test_context_size_is_zero_or_a_window_dgc_runs(self):
        for value in (True, False, 2047, 16_777_217, 4096.0, "4096", -1, 1, None):
            with self.subTest(value=value):
                self.refused("invalid_request", context_size=value)
        for value in (0, 2048, 1_048_577, 16_777_216):
            with self.subTest(value=value):
                self.assertEqual(self.set(context_size=value)["context_size"], value)

    def test_the_fallback_is_a_model_dgc_runs_itself(self):
        for value in ({"provider": "", "model": "x", "engine": "claude"}, {"provider": "", "model": "", "router": True},
                      {"provider": "provider_nope", "model": "x"}, {"provider": "", "model": "https://evil.example/v1"},
                      {"provider": "", "model": "x", "base_url": "http://x"}, "qwen3:8b", None, {"provider": 1, "model": "x"}):
            with self.subTest(value=value):
                self.refused("invalid_request", fallback=value)
        self.assertEqual(self.set(fallback={"provider": SPARE, "model": ""})["fallback"], {"provider": "", "model": ""},
                         "no model is none, whatever the provider")

    def test_at_least_one_field(self):
        self.refused("invalid_request")

    def test_one_bad_field_changes_nothing(self):
        self.refused("invalid_request", slots=9, thinking="high")
        self.refused("invalid_request", thinking="high", context_size=7)
        listed = self.agents()
        self.assertEqual((listed["slots"], listed["thinking"], listed["context_size"]), (1, "", 0))

    def test_only_you_set_them_on_this_computer(self):
        with self.assertRaises(RegistryError) as raised:
            self.set(actor="device_1", thinking="high")
        self.assertEqual(raised.exception.code, "local_only")
        self.assertEqual(self.agents()["thinking"], "")

    def test_the_command_takes_its_fields_and_the_api_says_so(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertEqual(PIPS_API_VERSION, 104)
        self.assertEqual(pips._COMMAND_ARGS["set_pip_agents"],
                         {"pip_id", "slots", "model_choice", "thinking", "context_size", "fallback"})


class ASubAgentJobRunsOnIt(ModelWorld, unittest.TestCase):
    def test_this_pips_model_leaves_the_jobs_run_exactly_as_before(self):
        before = self.job_manifest()["model_settings"]
        self.assertEqual(before["model"], "fixture")
        self.set(model_choice={"mode": "default"}, thinking="", context_size=0, fallback={"provider": "", "model": ""})
        self.assertEqual(self.job_manifest()["model_settings"], before)

    def test_a_model_on_dgcs_own_connection_with_its_thinking_and_window(self):
        self.set(model_choice={"mode": "model", "model": "agents-local"}, thinking="high", context_size=131072)
        with self.listed():
            manifest = self.job_manifest()
        settings = manifest["model_settings"]
        self.assertEqual((manifest["model"], settings["model"], settings["base_url"]),
                         ("agents-local", "agents-local", "http://localhost.invalid/v1"))
        self.assertEqual((settings["thinking"], settings["think_budget_tokens"], settings["context_size"]), ("high", 1536, 131072))
        self.assertNotIn("provider", settings)

    def test_a_saved_providers_model_pins_that_provider(self):
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": AGENTS, "model": "agents-model"})
            manifest = self.job_manifest()
        settings = manifest["model_settings"]
        self.assertEqual((settings["model"], settings["provider"], settings["base_url"], settings["api_mode"]),
                         ("agents-model", AGENTS, "https://agents.example/v1", "chat_completions"))
        self.assertEqual(pip_agents.view(self.registry.db, self.registry.db.execute(
            "SELECT * FROM pip_agent_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1").fetchone())["model"], "agents-model")

    def test_its_window_may_be_bigger_than_a_chats(self):
        self.set(context_size=4_000_000)
        self.assertEqual(self.job_manifest()["model_settings"]["context_size"], 4_000_000)

    def test_unset_thinking_and_window_keep_what_the_pips_own_options_give(self):
        pip_chat_options.save(self.registry, self.pip_id, {"context_size": 65536, "thinking": "low"})
        self.set(model_choice={"mode": "model", "model": "agents-local"})
        with self.listed():
            settings = self.job_manifest()["model_settings"]
        self.assertEqual((settings["model"], settings["thinking"], settings["context_size"]), ("agents-local", "low", 65536))
        self.set(thinking="xhigh")
        with self.listed():
            settings = self.job_manifest()["model_settings"]
        self.assertEqual((settings["thinking"], settings["think_budget_tokens"], settings["context_size"]), ("xhigh", 2048, 65536))

    def test_the_pips_own_runs_stay_on_its_model(self):
        self.set(model_choice={"mode": "model", "model": "agents-local"}, thinking="high", context_size=131072)
        settings = self.manifest(self.chat_run())["model_settings"]
        self.assertEqual((settings["model"], settings["thinking"]), ("fixture", "off"))
        self.assertNotEqual(settings["context_size"], 131072)

    def test_a_removed_provider_refuses_the_job_in_plain_words_never_another(self):
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": GONE, "model": "m"})
        with self.saved(), self.assertRaises(RegistryError) as raised:
            self.job_manifest()
        self.assertEqual(str(raised.exception), pip_models.PROVIDER_REMOVED)
        job = self.job()
        self.assertEqual((job["state"], job["run_id"]), ("failed", None), "never left queued with no run")
        self.assertIn("removed", job["said"])

    def test_a_fix_whose_sub_agents_provider_was_removed_says_so(self):
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": GONE, "model": "m"})
            self.allowed()
        fix = self.one()
        self.assertIn("removed from Settings", fix["message"])
        self.assertIsNone(self.store.claim_next(), "nothing ran on another provider")

    def test_a_retry_whose_provider_was_removed_ends_in_plain_words(self):
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": AGENTS, "model": "agents-model"})
            self.allowed()
            self.try_ends()
            self.check_ends(RETRY)
        self.assertEqual(self.job()["state"], "retry_due")
        self.send()                                           # the provider is gone now
        self.assertEqual(self.job()["state"], "failed")
        self.assertIn("removed", self.job()["said"])
        self.assertEqual(self.one()["state"], "failed")


class TheWorkerGetsItFromTodaysSettings(ModelWorld, unittest.TestCase):
    def own_key(self):
        self.cfg.set("api_key", OWN_KEY, persist=False)            # bound to DGC's own address, as Settings keeps it

    def test_nothing_set_gives_the_worker_nothing(self):
        self.assertIsNone(pip_agents.for_worker(self.registry, self.cfg, self.pip_id))
        self.set(model_choice={"mode": "default"}, thinking="", context_size=0)
        self.assertIsNone(pip_agents.for_worker(self.registry, self.cfg, self.pip_id))

    def test_its_thinking_and_window_alone(self):
        self.set(thinking="high", context_size=131072)
        self.assertEqual(pip_agents.for_worker(self.registry, self.cfg, self.pip_id),
                         {"subagent_thinking": "high", "subagent_context_size": 131072})

    def test_a_model_on_dgcs_own_connection(self):
        self.own_key()
        self.set(model_choice={"mode": "model", "model": "agents-local"})
        self.assertEqual(pip_agents.for_worker(self.registry, self.cfg, self.pip_id),
                         {"subagent_model": "agents-local", "subagent_base_url": "http://localhost.invalid/v1",
                          "subagent_api_mode": "chat_completions", "subagent_api_key": OWN_KEY})

    def test_a_saved_providers_model_and_a_fallback(self):
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": AGENTS, "model": "agents-model"},
                     fallback={"provider": SPARE, "model": "spare-model"}, thinking="low")
            got = pip_agents.for_worker(self.registry, self.cfg, self.pip_id)
        self.assertEqual(got, {"subagent_model": "agents-model", "subagent_base_url": "https://agents.example/v1",
                               "subagent_api_mode": "chat_completions", "subagent_api_key": AGENTS_KEY,
                               "subagent_thinking": "low",
                               "subagent_fallback_model": "spare-model", "subagent_fallback_base_url": "https://spare.example/v1",
                               "subagent_fallback_api_mode": "responses", "subagent_fallback_api_key": SPARE_KEY})

    def test_a_fallback_on_dgcs_own_connection(self):
        self.own_key()
        self.set(fallback={"provider": "", "model": "fb-local"})
        self.assertEqual(pip_agents.for_worker(self.registry, self.cfg, self.pip_id),
                         {"subagent_fallback_model": "fb-local", "subagent_fallback_base_url": "http://localhost.invalid/v1",
                          "subagent_fallback_api_mode": "chat_completions", "subagent_fallback_api_key": OWN_KEY})

    def test_a_removed_provider_leaves_the_runs_helpers_as_now(self):
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": GONE, "model": "m"}, thinking="high")
            self.assertIsNone(pip_agents.for_worker(self.registry, self.cfg, self.pip_id))
            self.set(model_choice={"mode": "default"}, fallback={"provider": GONE, "model": "m"})
            self.assertEqual(pip_agents.for_worker(self.registry, self.cfg, self.pip_id), {"subagent_thinking": "high"},
                             "a removed fallback provider: no fallback, never another")

    def test_the_overrides_without_agents_are_as_today(self):
        backup = {"model": "pip-backup", "base_url": "http://127.0.0.1:9/v1", "api_key": "k", "api_mode": ""}
        overrides = pips._worker_config_overrides({"api_key": "sk"}, backup)
        self.assertEqual(overrides["fallback_model"], "pip-backup")
        subagent = {k: v for k, v in overrides.items() if k.startswith("subagent_")}
        self.assertEqual(subagent, {"subagent_fallback_model": "", "subagent_fallback_base_url": "",
                                    "subagent_fallback_api_key": "", "subagent_fallback_api_mode": ""})

    def test_the_overrides_with_agents_set_the_helpers_route_address_before_key(self):
        agents = {"subagent_model": "agents-model", "subagent_base_url": "https://agents.example/v1",
                  "subagent_api_mode": "chat_completions", "subagent_api_key": AGENTS_KEY, "subagent_thinking": "low",
                  "subagent_context_size": 131072, "subagent_fallback_model": "spare-model",
                  "subagent_fallback_base_url": "https://spare.example/v1", "subagent_fallback_api_mode": "responses",
                  "subagent_fallback_api_key": SPARE_KEY, "mode": "bypassPermissions", "api_key": "stolen"}
        overrides = pips._worker_config_overrides({"api_key": "sk", "agents": agents}, {})
        for key, value in agents.items():
            if key.startswith("subagent_"):
                self.assertEqual(overrides[key], value, key)
        self.assertEqual((overrides["mode"], overrides["api_key"]), ("default", "sk"), "only its helpers' settings")
        order = list(overrides)
        self.assertLess(order.index("subagent_base_url"), order.index("subagent_api_key"))
        self.assertLess(order.index("subagent_fallback_base_url"), order.index("subagent_fallback_api_key"))

    def test_a_jobs_run_carries_on_with_the_agents_fallback_in_place_of_the_pips(self):
        from dgc import pip_backup
        pip_backup.set_own(self.registry, self.pip_id, "pip-backup", "editor-user")
        job_run = self.job_manifest()
        job_row = self.run_row(self.job()["run_id"])
        chat_row = self.run_row(self.chat_run())
        chat_run = self.manifest(chat_row["id"])
        backup, agents, own = pips._run_fallbacks(self.registry, self.cfg, job_row, job_run)
        self.assertEqual((backup["model"], agents, own), ("pip-backup", None, True), "none set: the Pip's, as today")
        with self.saved():
            self.set(fallback={"provider": SPARE, "model": "spare-model"})
            backup, agents, own = pips._run_fallbacks(self.registry, self.cfg, job_row, job_run)
            self.assertEqual((backup["model"], backup["provider"], backup["base_url"], backup["api_mode"], backup["api_key"]),
                             ("spare-model", SPARE, "https://spare.example/v1", "responses", SPARE_KEY))
            self.assertEqual(agents["subagent_fallback_model"], "spare-model")
            self.assertFalse(own, "what its own fallback does says nothing about the Pip's model")
            backup, agents, own = pips._run_fallbacks(self.registry, self.cfg, chat_row, chat_run)
            self.assertEqual((backup["model"], agents["subagent_fallback_model"], own), ("pip-backup", "spare-model", True),
                             "the Pip's own reply keeps its backup; its helpers follow the agents' fallback")
            self.set(fallback={"provider": GONE, "model": "m"})
            backup, _agents, _own = pips._run_fallbacks(self.registry, self.cfg, job_row, job_run)
            self.assertIsNone(backup, "a removed provider: no fallback, never the Pip's or another")

    def test_a_job_on_the_agents_own_model_keeps_the_pips_backup(self):
        from dgc import pip_backup
        pip_backup.set_own(self.registry, self.pip_id, "pip-backup", "editor-user")
        self.set(model_choice={"mode": "model", "model": "agents-local"})
        with self.listed():
            job_run = self.job_manifest()
        backup, agents, own = pips._run_fallbacks(self.registry, self.cfg, self.run_row(self.job()["run_id"]), job_run)
        self.assertEqual((backup["model"], agents["subagent_model"], own), ("pip-backup", "agents-local", False))


class TheRunnerHandsItToTheWorker(ModelWorld, unittest.TestCase):
    """The runner's side of a real run, stopped at the hand-off to its worker (no model, no worker): what goes over its
    stdin beside the manifest."""

    def handed(self, run_id):
        row = self.store.claim_next()
        self.assertEqual(row["id"], run_id)
        given = {}

        class Handed(Exception):
            pass

        def payload(value):
            given.update(value)
            raise Handed()
        with patch.object(pips, "_worker_payload", side_effect=payload):
            try:
                pips._execute_run(self.registry, row, self.cfg)
            except Handed:
                pass
        self.assertTrue(given, "the run reached its worker's hand-off")
        return given

    def test_a_jobs_worker_gets_its_model_its_fallback_and_its_helpers_settings(self):
        from dgc import pip_backup
        pip_backup.set_own(self.registry, self.pip_id, "pip-backup", "editor-user")
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": AGENTS, "model": "agents-model"},
                     fallback={"provider": SPARE, "model": "spare-model"}, thinking="low")
            job = pip_agents.start(self.store, self.cfg, self.pip_id, kind="fix", title="Fix it", brief="Fix the total.")
            given = self.handed(job["run_id"])
        self.assertEqual((given["manifest"]["model_settings"]["provider"], given["api_key"]), (AGENTS, AGENTS_KEY),
                         "its run on the provider, with that provider's own key")
        self.assertEqual((given["backup"]["model"], given["backup"]["api_key"]), ("spare-model", SPARE_KEY),
                         "the agents' fallback in place of the Pip's")
        self.assertEqual((given["agents"]["subagent_model"], given["agents"]["subagent_api_key"],
                          given["agents"]["subagent_thinking"], given["agents"]["subagent_fallback_model"]),
                         ("agents-model", AGENTS_KEY, "low", "spare-model"))
        for key in (AGENTS_KEY, SPARE_KEY):
            self.assertNotIn(key, json.dumps(given["manifest"]), "keys travel beside the manifest, never in it")

    def test_the_pips_own_reply_keeps_its_backup_and_its_helpers_follow_the_agents(self):
        from dgc import pip_backup
        pip_backup.set_own(self.registry, self.pip_id, "pip-backup", "editor-user")
        with self.saved():
            self.set(model_choice={"mode": "provider", "provider": AGENTS, "model": "agents-model"})
            given = self.handed(self.chat_run())
        self.assertEqual((given["manifest"]["model"], given["backup"]["model"]), ("fixture", "pip-backup"))
        self.assertEqual((given["agents"]["subagent_model"], given["agents"]["subagent_base_url"],
                          given["agents"]["subagent_api_key"]), ("agents-model", "https://agents.example/v1", AGENTS_KEY))

    def test_nothing_set_hands_the_worker_nothing_new(self):
        given = self.handed(self.chat_run())
        self.assertNotIn("agents", given)
        job = pip_agents.start(self.store, self.cfg, self.pip_id, kind="fix", title="Fix it", brief="Fix the total.")
        self.assertNotIn("agents", self.handed(job["run_id"]))


class NoKeyAnywhere(ModelWorld, unittest.TestCase):
    def test_no_key_in_a_manifest_a_stored_run_a_row_or_an_event(self):
        with self.saved():
            said = self.set(model_choice={"mode": "provider", "provider": AGENTS, "model": "agents-model"},
                            fallback={"provider": SPARE, "model": "spare-model"}, thinking="high")
            job_run = self.job_manifest()
            chat_id = self.chat_run()
            listed = self.agents()
        dump = "\n".join(self.registry.db.iterdump())
        for key in (AGENTS_KEY, SPARE_KEY):
            with self.subTest(key=key):
                self.assertNotIn(key, json.dumps(said))
                self.assertNotIn(key, json.dumps(listed))
                self.assertNotIn(key, json.dumps(job_run))
                self.assertNotIn(key, json.dumps(self.manifest(chat_id)))
                self.assertNotIn(key, dump, "the registry: runs, metadata, events")


if __name__ == "__main__":
    unittest.main()
