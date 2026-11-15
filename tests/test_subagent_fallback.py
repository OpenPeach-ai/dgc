"""A fallback model for sub-agents (0.52, his ask 14 Nov: "we need fallback model selector for sub agents too").

Main's fallback (fallback_*) is what a chat carries on with when its own model fails. Sub-agents get their own:
subagent_fallback_model, _base_url, _api_mode and _api_key, set in Settings > Sub-agents for every chat, or by a Work
session for itself in its model menu's Sub-agents tab (set_config scope=session), exactly as the agents model is: kept
with that session only, never its key, back when it is reopened, else following Settings live. A helper whose model
fails carries on with the sub-agents fallback; with none it uses Main's, as a helper with no agents model uses the main
model. A session's own fallback never makes its agents model its own (DGC Router still routes that). "Same as settings"
(reset_agents_model) takes `part` "model" or "fallback", or both when omitted. ready.capabilities.subagent_fallback says
DGC understands it; get_config sends the fallback only to an editor that asks (`fields`)."""
import json
import unittest

from dgc import sessions
from dgc.editor_protocol import COMMAND_FIELDS, EVENT_FIELDS
from tests import test_model_retry as retry
from tests import test_server_window as window

closed_port, stall = retry.closed_port, retry.stall

OWN = {"subagent_fallback_model": "own-backup", "subagent_fallback_base_url": "https://backup.example/v1",
       "subagent_fallback_api_mode": "chat_completions", "subagent_fallback_api_key": "sk-backup"}
FIELDS = ("subagent_fallback_model", "subagent_fallback_base_url", "subagent_fallback_api_mode",
          "subagent_fallback_api_key_set")


class HelperFallsBack(retry.RetryTestCase):
    def helper(self, depth=1, **settings):
        agent, ui = self.agent(**settings)
        agent.depth = depth
        return agent, ui

    def test_a_helper_whose_model_fails_carries_on_with_the_sub_agents_fallback(self):
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        agent, ui = self.helper(base_url=f"http://127.0.0.1:{closed_port()}/v1",
                                fallback_model="main-backup", fallback_base_url=f"http://127.0.0.1:{closed_port()}/v1",
                                subagent_fallback_model="helper-backup",
                                subagent_fallback_base_url=self.server.url + "/v1")
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual(agent.client.model, "helper-backup", "the sub-agents' fallback, never Main's")
        self.assertEqual(agent.client.base_url.rstrip("/"), self.server.url + "/v1")
        self.assertTrue(any("helper-backup" in line for line in ui.infos if "⤳" in line), ui.infos)

    def test_main_keeps_its_own_fallback(self):
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        agent, _ = self.helper(depth=0, base_url=f"http://127.0.0.1:{closed_port()}/v1",
                               fallback_model="main-backup", fallback_base_url=self.server.url + "/v1",
                               subagent_fallback_model="helper-backup",
                               subagent_fallback_base_url=f"http://127.0.0.1:{closed_port()}/v1")
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual(agent.client.model, "main-backup")

    def test_a_helper_with_no_fallback_of_its_own_uses_mains(self):
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        agent, _ = self.helper(base_url=f"http://127.0.0.1:{closed_port()}/v1",
                               fallback_model="main-backup", fallback_base_url=self.server.url + "/v1")
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual(agent.client.model, "main-backup", "as a helper with no agents model uses the main one")

    def test_its_key_goes_only_to_its_own_address(self):
        agent, _ = self.helper(subagent_fallback_model="helper-backup",
                               subagent_fallback_base_url="https://backup.example/v1")
        agent.config.set_runtime_secret("api_key", "sk-main")
        agent.config.set_runtime_secret("fallback_api_key", "sk-mains-fallback")
        self.assertEqual(agent._fallback_client("helper-backup").api_key, "", "no key: none, never the main one")
        agent.config.set_runtime_secret("subagent_fallback_api_key", "sk-backup")
        client = agent._fallback_client("helper-backup")
        self.assertEqual((client.base_url.rstrip("/"), client.api_key), ("https://backup.example/v1", "sk-backup"))
        agent.config.set("subagent_fallback_base_url", "https://elsewhere.example/v1", persist=False)
        self.assertEqual(agent._fallback_client("helper-backup").api_key, "",
                         "a new address never takes the old address's key")
        agent.config.set("subagent_fallback_base_url", "", persist=False)
        client = agent._fallback_client("helper-backup")
        self.assertEqual((client.base_url.rstrip("/"), client.api_key), (agent.config.base_url.rstrip("/"), "sk-main"),
                         "no address of its own: the main host, with the main key")
        agent.depth = 0
        client = agent._fallback_client("main-backup")
        self.assertEqual((client.base_url.rstrip("/"), client.api_key), (agent.config.base_url.rstrip("/"),
                                                                         "sk-mains-fallback"), "Main's is untouched")


class SessionAgentsFallback(window.IsolatedHome):
    host = window.TheEditorIsTold.host
    frames = window.TheEditorIsTold.frames

    def started(self):
        return self.host(model="qwen2.5-0.5b", base_url=self.server.url + "/v1", subagent_model="settings-coder",
                         subagent_fallback_model="settings-backup")

    def told(self, request_id):
        return [f for f in self.frames("agents_model") if f.get("request_id") == request_id]

    def choose_own(self, host, request_id="own", values=None):
        host.dispatch({"type": "set_config", "scope": "session", "request_id": request_id,
                       "values": dict(values or OWN)})
        self.assertFalse([f for f in self.frames("command_rejected") if f.get("request_id") == request_id],
                         self.frames("command_rejected"))

    def test_a_sessions_own_fallback_is_kept_with_it_never_its_key_and_its_agents_model_still_follows(self):
        host = self.started()
        self.assertEqual(host.default._ready_payload()["capabilities"].get("subagent_fallback"), 1,
                         "the editor offers it only when DGC says it understands it")
        settings = json.loads((self.user / "config.json").read_text())
        self.choose_own(host)
        config = host.default.config
        self.assertEqual((config.get("subagent_fallback_model"), config.get("subagent_fallback_base_url"),
                          config.get("subagent_fallback_api_key")),
                         ("own-backup", "https://backup.example/v1", "sk-backup"))
        self.assertFalse(config.agents_route_own(), "its agents model still follows Settings (and DGC Router)")
        kept = json.loads((self.user / "config.json").read_text())
        self.assertEqual({k: kept.get(k) for k in kept if k.startswith("subagent_fallback")},
                         {k: settings.get(k) for k in settings if k.startswith("subagent_fallback")},
                         "Settings' sub-agents fallback stays as it was")
        self.assertNotIn("sk-backup", json.dumps(kept))
        [said] = self.told("own")
        self.assertEqual((said["own"], said["fallback_own"], said["fallback_model"], said["fallback_base_url"],
                          said["fallback_api_mode"], said["settings_fallback_model"]),
                         (False, True, "own-backup", "https://backup.example/v1", "chat_completions", "settings-backup"))
        self.assertTrue(said["fallback_api_key_set"])
        saved = host.default.agent.session_file
        host.default.agent._persist()
        record = json.loads(saved.read_text())
        self.assertEqual(record["agents_fallback"], {"model": "own-backup", "base_url": "https://backup.example/v1",
                                                     "api_mode": "chat_completions"})
        self.assertNotIn("agents_route", record)
        self.assertNotIn("sk-backup", saved.read_text(), "a session file never holds a key")
        host.dispatch({"type": "new_session", "request_id": "fresh"})
        self.assertEqual(config.get("subagent_fallback_model"), "settings-backup", "a new session follows Settings")
        host.dispatch({"type": "resume_session", "path": str(saved), "saved_mode": True, "request_id": "back"})
        self.assertEqual((config.get("subagent_fallback_model"), config.get("subagent_fallback_base_url"),
                          config.get("subagent_fallback_api_mode")),
                         ("own-backup", "https://backup.example/v1", "chat_completions"), "reopened, its own again")
        self.assertEqual(config.get("subagent_fallback_api_key"), "", "the editor supplies its key again")
        host.dispatch({"type": "get_agents_model", "request_id": "q"})
        [again] = self.told("q")
        self.assertEqual((again["fallback_own"], again["fallback_api_key_set"]), (True, False))

    def test_a_session_following_settings_follows_a_new_fallback_and_one_with_its_own_keeps_it(self):
        host = self.started()
        config = host.default.config
        on_disk = json.loads((self.user / "config.json").read_text())
        (self.user / "config.json").write_text(json.dumps({**on_disk, "subagent_fallback_model": "newer-backup"}))
        config.save()
        self.assertEqual(config.get("subagent_fallback_model"), "newer-backup", "following Settings, live")
        self.choose_own(host)
        on_disk = json.loads((self.user / "config.json").read_text())
        (self.user / "config.json").write_text(json.dumps({**on_disk, "subagent_fallback_model": "newest-backup"}))
        config.save()
        self.assertEqual(config.get("subagent_fallback_model"), "own-backup", "its own bypasses Settings")

    def test_following_settings_never_takes_the_old_addresss_key_to_a_new_one(self):
        host = self.host(model="qwen2.5-0.5b", base_url=self.server.url + "/v1",
                         subagent_fallback_model="settings-backup",
                         subagent_fallback_base_url="https://old-backup.example/v1")
        config = host.default.config
        config.set_runtime_secret("subagent_fallback_api_key", "sk-old-host")
        on_disk = json.loads((self.user / "config.json").read_text())
        (self.user / "config.json").write_text(json.dumps({**on_disk,
                                                           "subagent_fallback_base_url": "https://new-backup.example/v1"}))
        config.save()
        self.assertEqual(config.get("subagent_fallback_base_url"), "https://new-backup.example/v1")
        self.assertEqual(config.get("subagent_fallback_api_key"), "", "the old address's key never goes to the new one")

    def test_same_as_settings_takes_the_part_it_names(self):
        host = self.started()
        config = host.default.config
        self.choose_own(host, "both", {**OWN, "subagent_model": "own-coder"})
        self.assertTrue(config.agents_route_own())
        host.dispatch({"type": "reset_agents_model", "part": "fallback", "request_id": "fb"})
        self.assertEqual(config.get("subagent_fallback_model"), "settings-backup")
        self.assertEqual(config.get("subagent_model"), "own-coder", "its own agents model stays")
        [said] = self.told("fb")
        self.assertEqual((said["own"], said["fallback_own"]), (True, False))
        self.choose_own(host, "again")
        host.dispatch({"type": "reset_agents_model", "part": "model", "request_id": "md"})
        self.assertEqual((config.get("subagent_model"), config.get("subagent_fallback_model")),
                         ("settings-coder", "own-backup"), "only the model follows Settings again")
        host.dispatch({"type": "reset_agents_model", "request_id": "all"})
        self.assertEqual((config.get("subagent_model"), config.get("subagent_fallback_model")),
                         ("settings-coder", "settings-backup"), "no part: both")
        host.default.agent._persist()
        record = json.loads(host.default.agent.session_file.read_text())
        self.assertNotIn("agents_fallback", record)
        host.dispatch({"type": "reset_agents_model", "part": "everything", "request_id": "bad"})
        self.assertTrue([f for f in self.frames("command_rejected") if f.get("command") == "reset_agents_model"],
                        "an unknown part is refused")
        self.assertEqual(config.get("subagent_fallback_model"), "settings-backup")

    def test_settings_changed_from_a_session_with_its_own_reach_settings_and_it_keeps_its_own(self):
        host = self.started()
        self.choose_own(host)
        host.dispatch({"type": "set_config", "request_id": "settings",
                       "values": {"subagent_fallback_model": "settings-2"}})
        self.assertFalse([f for f in self.frames("command_rejected") if f.get("request_id") == "settings"])
        self.assertEqual(json.loads((self.user / "config.json").read_text())["subagent_fallback_model"], "settings-2",
                         "Settings > Sub-agents saved")
        self.assertEqual(host.default.config.get("subagent_fallback_model"), "own-backup", "this session keeps its own")
        host.dispatch({"type": "get_agents_model", "request_id": "q"})
        [said] = self.told("q")
        self.assertEqual((said["fallback_own"], said["fallback_model"], said["settings_fallback_model"]),
                         (True, "own-backup", "settings-2"))

    def test_settings_key_reaches_the_other_open_chats_that_follow_settings(self):
        import time
        host = self.started()

        def open_chat(name, request_id):
            folder = self.root.parent / name
            (folder / ".git").mkdir(parents=True)
            host.dispatch({"type": "open_chat", "request_id": request_id, "cwd": str(folder)})
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                done = [f for f in self.frames() if f.get("request_id") == request_id
                        and f["type"] in ("chat_opened", "command_rejected")]
                if done:
                    self.assertEqual(done[-1]["type"], "chat_opened", done[-1])
                    return host.chats[done[-1]["chat_id"]]
                time.sleep(0.05)
            self.fail("no chat opened")

        def answered(request_id):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                done = [f for f in self.frames() if f.get("request_id") == request_id
                        and f["type"] in ("config", "command_rejected")]
                if done:
                    return done[-1]
                time.sleep(0.05)
            self.fail(f"no answer to {request_id}")
        follows, own = open_chat("follows", "o1"), open_chat("own", "o2")
        host.dispatch({"type": "set_config", "scope": "session", "chat_id": own.chat_id, "request_id": "mine",
                       "values": dict(OWN)})
        self.assertEqual(answered("mine")["type"], "config")
        host.dispatch({"type": "set_config", "request_id": "settings", "values": {
            "subagent_fallback_model": "new-backup", "subagent_fallback_base_url": "https://new-backup.example/v1",
            "subagent_fallback_api_key": "sk-new"}})
        self.assertEqual(answered("settings")["type"], "config")
        self.assertEqual((follows.config.get("subagent_fallback_base_url"),
                          follows.config.get("subagent_fallback_api_key")),
                         ("https://new-backup.example/v1", "sk-new"), "a chat following Settings has the new one and its key")
        self.assertEqual((own.config.get("subagent_fallback_base_url"), own.config.get("subagent_fallback_api_key")),
                         ("https://backup.example/v1", "sk-backup"), "a chat with its own keeps its own, and its key")

    def test_get_config_sends_it_only_when_asked(self):
        host = self.started()
        host.dispatch({"type": "get_config", "request_id": "plain"})
        [plain] = [f for f in self.frames("config") if f.get("request_id") == "plain"]
        for field in FIELDS:
            self.assertNotIn(field, plain, "an older editor rejects a field it doesn't know")
        host.dispatch({"type": "get_config", "request_id": "asked", "fields": list(FIELDS)})
        [asked] = [f for f in self.frames("config") if f.get("request_id") == "asked"]
        self.assertEqual((asked["subagent_fallback_model"], asked["subagent_fallback_base_url"],
                          asked["subagent_fallback_api_mode"], asked["subagent_fallback_api_key_set"]),
                         ("settings-backup", "", "", False))

    def test_a_bad_address_is_refused_and_nothing_changes(self):
        host = self.started()
        host.dispatch({"type": "set_config", "scope": "session", "request_id": "bad",
                       "values": {**OWN, "subagent_fallback_base_url": "https://user:secret@backup.example/v1"}})
        self.assertTrue([f for f in self.frames("command_rejected") if f.get("request_id") == "bad"])
        host.dispatch({"type": "set_config", "scope": "session", "request_id": "ftp",
                       "values": {**OWN, "subagent_fallback_base_url": "ftp://backup.example"}})
        self.assertTrue([f for f in self.frames("command_rejected") if f.get("request_id") == "ftp"])
        self.assertEqual(host.default.config.get("subagent_fallback_model"), "settings-backup")


class PipHelpers(unittest.TestCase):
    def test_a_pips_helpers_carry_on_with_the_pips_own_backup(self):
        from dgc import pips
        backup = {"model": "pip-backup", "base_url": "http://127.0.0.1:9/v1", "api_key": "k", "api_mode": ""}
        overrides = pips._worker_config_overrides({"api_key": "sk"}, backup)
        self.assertEqual(overrides["fallback_model"], "pip-backup")
        for key in ("subagent_fallback_model", "subagent_fallback_base_url", "subagent_fallback_api_key",
                    "subagent_fallback_api_mode"):
            self.assertEqual(overrides[key], "", f"{key}: Settings' sub-agents fallback never reaches a Pip's run")


class TheWire(unittest.TestCase):
    def test_the_fields_are_declared(self):
        self.assertEqual(set(COMMAND_FIELDS["reset_agents_model"]), {"request_id", "part"})
        self.assertEqual(COMMAND_FIELDS["reset_agents_model"]["part"].get("enum"), ["model", "fallback"])
        self.assertTrue({"fallback_own", "fallback_model", "fallback_base_url", "fallback_api_mode",
                         "fallback_api_key_set", "settings_fallback_model", "settings_fallback_base_url"}
                        <= set(EVENT_FIELDS["agents_model"]))
        for field in FIELDS:
            self.assertIn(field, EVENT_FIELDS["config"])
            self.assertFalse(EVENT_FIELDS["config"][field].get("required"), f"{field} must be opt-in")
        from dgc.headless import _CONFIG_OPT_IN_FIELDS
        self.assertTrue(set(FIELDS) <= _CONFIG_OPT_IN_FIELDS)
        from dgc.editor_protocol import LIST_MODELS_AT_ROLES
        self.assertIn("subagent_fallback", LIST_MODELS_AT_ROLES)

    def test_the_key_is_a_secret_bound_to_its_address(self):
        from dgc import config as config_module
        self.assertIn("subagent_fallback_api_key", config_module.SECRET_KEYS)
        self.assertEqual(config_module.SECRET_ENV["subagent_fallback_api_key"], "DGC_SUBAGENT_FALLBACK_API_KEY")
        self.assertEqual(config_module._PROVIDER_SECRET_ENDPOINTS["subagent_fallback_api_key"],
                         "subagent_fallback_base_url")
        self.assertIsNone(sessions._clean_agents_route({"model": "m", "base_url": "ftp://x", "api_mode": ""}))


if __name__ == "__main__":
    unittest.main()
