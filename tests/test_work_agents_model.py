"""A Work session's own agents model (0.52, his call 14 Nov: "user sets a unified setting for sub agents in the settings,
but each session needs to have this in its own settings too, which bypasses the main settings only for that session").

Settings > Sub-agents keeps the one agents model every chat follows. A Work session may choose its own in its model menu
(set_config scope=session with the subagent_* keys, as its fallback is chosen): kept with that session only, never its
key, back when it is reopened, and it wins over DGC Router (an explicit choice, as an agent file's model is). "Same as
settings" (reset_agents_model) drops it, and the session follows Settings again, live, as every session that never chose
one does. get_agents_model answers which it is (agents_model)."""
import json
import unittest
from unittest.mock import patch

from dgc import config as config_module, sessions
from dgc.config import Config
from dgc.editor_protocol import COMMAND_FIELDS, EVENT_FIELDS
from tests import test_server_window as window

OWN = {"subagent_model": "own-coder", "subagent_base_url": "https://agents.example/v1",
       "subagent_api_mode": "chat_completions", "subagent_api_key": "sk-agents"}


class SessionAgentsModel(window.IsolatedHome):
    host = window.TheEditorIsTold.host
    frames = window.TheEditorIsTold.frames

    def started(self):
        return self.host(model="qwen2.5-0.5b", base_url=self.server.url + "/v1", subagent_model="settings-coder")

    def told(self, request_id):
        return [f for f in self.frames("agents_model") if f.get("request_id") == request_id]

    def choose_own(self, host, request_id="own"):
        host.dispatch({"type": "set_config", "scope": "session", "request_id": request_id, "values": dict(OWN)})
        self.assertFalse([f for f in self.frames("command_rejected") if f.get("request_id") == request_id],
                         self.frames("command_rejected"))

    def test_a_sessions_agents_model_is_its_own_and_kept_with_it_never_its_key(self):
        host = self.started()
        self.assertEqual(host.default._ready_payload()["capabilities"].get("agents_model"), 1,
                         "the editor offers a session's own agents model only when DGC says it understands it")
        settings = json.loads((self.user / "config.json").read_text())
        self.choose_own(host)
        config = host.default.config
        self.assertEqual((config.get("subagent_model"), config.get("subagent_base_url")),
                         ("own-coder", "https://agents.example/v1"))
        kept = json.loads((self.user / "config.json").read_text())
        self.assertEqual({k: kept.get(k) for k in kept if k.startswith("subagent_")},
                         {k: settings.get(k) for k in settings if k.startswith("subagent_")},
                         "Settings' agents model stays as it was")
        [said] = self.told("own")
        self.assertEqual((said["own"], said["model"], said["base_url"], said["api_mode"], said["settings_model"]),
                         (True, "own-coder", "https://agents.example/v1", "chat_completions", "settings-coder"))
        self.assertTrue(said["api_key_set"])
        saved = host.default.agent.session_file
        host.default.agent._persist()
        record = json.loads(saved.read_text())
        self.assertEqual(record["agents_route"], {"model": "own-coder", "base_url": "https://agents.example/v1",
                                                  "api_mode": "chat_completions"})
        self.assertNotIn("sk-agents", saved.read_text(), "a session file never holds a key")
        host.dispatch({"type": "new_session", "request_id": "fresh"})
        self.assertEqual(config.get("subagent_model"), "settings-coder", "a new session follows Settings")
        host.dispatch({"type": "get_agents_model", "request_id": "q1"})
        self.assertFalse(self.told("q1")[0]["own"])
        host.dispatch({"type": "resume_session", "path": str(saved), "saved_mode": True, "request_id": "back"})
        self.assertEqual((config.get("subagent_model"), config.get("subagent_base_url"), config.get("subagent_api_mode")),
                         ("own-coder", "https://agents.example/v1", "chat_completions"), "reopened, it has its own again")
        self.assertEqual(config.get("subagent_api_key"), "", "the editor supplies its key again")
        host.dispatch({"type": "get_agents_model", "request_id": "q2"})
        [again] = self.told("q2")
        self.assertEqual((again["own"], again["api_key_set"]), (True, False))

    def test_same_as_settings_drops_its_own_and_it_follows_settings_again(self):
        host = self.started()
        self.choose_own(host)
        host.dispatch({"type": "reset_agents_model", "request_id": "same"})
        config = host.default.config
        self.assertEqual((config.get("subagent_model"), config.get("subagent_base_url")), ("settings-coder", ""))
        [said] = self.told("same")
        self.assertFalse(said["own"])
        host.default.agent._persist()
        self.assertNotIn("agents_route", json.loads(host.default.agent.session_file.read_text()))
        # Settings changed elsewhere (another window saved it): this session follows.
        on_disk = json.loads((self.user / "config.json").read_text())
        (self.user / "config.json").write_text(json.dumps({**on_disk, "subagent_model": "newer-coder"}))
        config.save()
        self.assertEqual(config.get("subagent_model"), "newer-coder")

    def test_a_session_with_its_own_keeps_it_when_settings_change(self):
        host = self.started()
        self.choose_own(host)
        config = host.default.config
        on_disk = json.loads((self.user / "config.json").read_text())
        (self.user / "config.json").write_text(json.dumps({**on_disk, "subagent_model": "newer-coder"}))
        config.save()
        self.assertEqual(config.get("subagent_model"), "own-coder", "its own choice bypasses Settings")

    def test_following_settings_never_takes_the_old_addresss_key_to_a_new_one(self):
        host = self.host(model="qwen2.5-0.5b", base_url=self.server.url + "/v1", subagent_model="settings-coder",
                         subagent_base_url="https://old-agents.example/v1")
        config = host.default.config
        config.set_runtime_secret("subagent_api_key", "sk-old-host")
        on_disk = json.loads((self.user / "config.json").read_text())
        (self.user / "config.json").write_text(json.dumps({**on_disk, "subagent_base_url": "https://new-agents.example/v1",
                                                           "subagent_model": "new-coder"}))
        config.save()
        self.assertEqual((config.get("subagent_model"), config.get("subagent_base_url")),
                         ("new-coder", "https://new-agents.example/v1"))
        self.assertEqual(config.get("subagent_api_key"), "", "the old address's key never goes to the new one")
        self.assertEqual(host.default.agent._subagent_client(None).api_key, "")

    def test_settings_changed_from_a_session_with_its_own_reach_settings_and_it_keeps_its_own(self):
        host = self.started()
        self.choose_own(host)
        host.dispatch({"type": "set_config", "request_id": "settings", "values": {"subagent_model": "settings-2"}})
        self.assertFalse([f for f in self.frames("command_rejected") if f.get("request_id") == "settings"])
        self.assertEqual(json.loads((self.user / "config.json").read_text())["subagent_model"], "settings-2",
                         "Settings > Sub-agents saved")
        self.assertEqual(host.default.config.get("subagent_model"), "own-coder", "this session keeps its own")
        host.dispatch({"type": "get_agents_model", "request_id": "q"})
        [said] = self.told("q")
        self.assertEqual((said["own"], said["model"], said["settings_model"]), (True, "own-coder", "settings-2"))

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
        def answered(request_id, kinds=("config", "command_rejected")):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                done = [f for f in self.frames() if f.get("request_id") == request_id and f["type"] in kinds]
                if done:
                    return done[-1]
                time.sleep(0.05)
            self.fail(f"no answer to {request_id}")
        follows, own = open_chat("follows", "o1"), open_chat("own", "o2")
        host.dispatch({"type": "set_config", "scope": "session", "chat_id": own.chat_id, "request_id": "mine",
                       "values": dict(OWN)})
        self.assertEqual(answered("mine")["type"], "config")
        self.assertTrue(own.config.agents_route_own())
        host.dispatch({"type": "set_config", "request_id": "settings", "values": {
            "subagent_model": "new-coder", "subagent_base_url": "https://new-agents.example/v1", "subagent_api_key": "sk-new"}})
        self.assertEqual(answered("settings")["type"], "config")
        self.assertEqual((follows.config.get("subagent_base_url"), follows.config.get("subagent_api_key")),
                         ("https://new-agents.example/v1", "sk-new"), "a chat following Settings has the new address and its key")
        self.assertEqual((own.config.get("subagent_base_url"), own.config.get("subagent_api_key")),
                         ("https://agents.example/v1", "sk-agents"), "a chat with its own keeps its own, and its key")

    def test_its_own_agents_model_wins_over_dgc_router(self):
        host = self.started()
        agent = host.default.agent
        with patch("dgc.router.subagent_route", return_value="ROUTED") as routed:
            self.assertEqual(agent._subagent_client(None, lease_for="agent_1"), "ROUTED", "Settings' agents: the Router")
            self.choose_own(host)
            client = agent._subagent_client(None, lease_for="agent_2")
        self.assertEqual(routed.call_count, 1, "a session's own choice is explicit: the Router isn't asked")
        self.assertEqual((client.model, client.base_url.rstrip("/")), ("own-coder", "https://agents.example/v1"))

    def test_a_bad_address_is_refused_and_nothing_changes(self):
        host = self.started()
        host.dispatch({"type": "set_config", "scope": "session", "request_id": "bad",
                       "values": {**OWN, "subagent_base_url": "https://user:secret@agents.example/v1"}})
        self.assertTrue([f for f in self.frames("command_rejected") if f.get("request_id") == "bad"])
        self.assertEqual(host.default.config.get("subagent_model"), "settings-coder")
        for bad in ({"model": "m", "base_url": "ftp://agents.example", "api_mode": "auto"},
                    {"model": "m", "base_url": "https://agents.example/v1"}):
            with self.subTest(bad=bad):
                self.assertIsNone(sessions._clean_agents_route(bad))


class TheWire(unittest.TestCase):
    def test_the_commands_and_the_event_are_declared(self):
        self.assertEqual(set(COMMAND_FIELDS["get_agents_model"]), {"request_id"})
        self.assertEqual(set(COMMAND_FIELDS["reset_agents_model"]), {"request_id", "part"})   # part: 0.52 fallback
        self.assertEqual(set(EVENT_FIELDS["agents_model"]),
                         {"request_id", "own", "model", "base_url", "api_mode", "api_key_set", "settings_model",
                          "settings_base_url",
                          # the sub-agents' fallback (tests/test_subagent_fallback.py)
                          "fallback_own", "fallback_model", "fallback_base_url", "fallback_api_mode",
                          "fallback_api_key_set", "settings_fallback_model", "settings_fallback_base_url"})


if __name__ == "__main__":
    unittest.main()
