"""A fallback model for Pips (Pips package 6, Pips API 76; D14): each Pip's own provider and model, what new Pips start
with, which runs get one, and the one line said once an outage. The worker's switch itself: test_pip_chat (a real worker) and test_pip_brain (a
subscription at its limit)."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_backup, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class BackupTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def control(self, command, actor="editor-user", **fields):
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def pip(self):
        return self.store.create(self.registry.personal()["id"], "Ava", "Pay my bills", "editor-user")

    PROVIDER = "provider_" + "c" * 32

    def test_new_pips_start_with_the_last_fallback_you_chose_and_only_you_set_it(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 76)
        none = {"provider": "", "model": ""}
        self.assertEqual(self.control("get_pips_backup"), {"backup": none}, "none by default: nothing changes")
        before = self.pip()
        self.assertEqual(self.control("set_pips_backup", model="qwen3:8b", provider=self.PROVIDER),
                         {"backup": {"provider": self.PROVIDER, "model": "qwen3:8b"}})
        after = self.store.create(self.registry.personal()["id"], "Max", "Plans", "editor-user")
        self.assertEqual(pip_backup.chosen(self.registry, after["id"]), {"provider": self.PROVIDER, "model": "qwen3:8b"},
                         "a new Pip starts with it")
        self.assertEqual(pip_backup.chosen(self.registry, before["id"]), none, "a Pip made before never follows it")
        for actor, fields, code in (("device_1", {"model": "x"}, "local_only"),
                                    ("editor-user", {"model": "https://evil.example/v1"}, "invalid_request"),
                                    ("editor-user", {"model": 7}, "invalid_request"),
                                    ("editor-user", {"model": "x", "provider": "provider_nope"}, "invalid_request")):
            with self.subTest(actor=actor, fields=fields), self.assertRaises(RegistryError) as raised:
                self.control("set_pips_backup", actor=actor, **fields)
            self.assertEqual(raised.exception.code, code)
        self.assertEqual(self.control("set_pips_backup", model=""), {"backup": none}, "none again")

    def test_each_pip_has_its_own_provider_and_model_and_never_changes_anothers(self):
        # D14: chosen with the ⋯ beside a model in the Pip's own picker: one provider and one model, so it is clear which
        # of your providers it falls back to. Choosing it for one Pip never changes another's.
        pip, other = self.pip(), self.store.create(self.registry.personal()["id"], "Max", "Plans", "editor-user")
        self.control("set_pip_backup", pip_id=other["id"], model="llama3.3:70b")
        own = self.control("set_pip_backup", pip_id=pip["id"], model="gpt-oss:120b", provider=self.PROVIDER)["backup"]
        self.assertEqual(own, {"pip_id": pip["id"], "provider": self.PROVIDER, "model": "gpt-oss:120b"})
        self.assertEqual(self.control("get_pip_backup", pip_id=other["id"])["backup"],
                         {"pip_id": other["id"], "provider": "", "model": "llama3.3:70b"}, "the other Pip's is unchanged")
        self.assertEqual(pip_backup.pips_wide(self.registry), {"provider": self.PROVIDER, "model": "gpt-oss:120b"},
                         "and the next new Pip starts with it")
        for value in ("", None):
            with self.subTest(value=value):
                gone = self.control("set_pip_backup", pip_id=pip["id"], model=value, provider=self.PROVIDER)["backup"]
                self.assertEqual((gone["provider"], gone["model"]), ("", ""), "none for this Pip")
        with self.assertRaises(RegistryError) as raised:
            self.control("set_pip_backup", actor="device_1", pip_id=pip["id"], model="x")
        self.assertEqual(raised.exception.code, "local_only")
        with self.assertRaises(RegistryError):
            self.control("get_pip_backup", pip_id="pip_" + "f" * 32)

    def test_which_runs_get_a_fallback(self):
        pip = self.pip()
        row = {"pip_id": pip["id"], "id": "run_" + "a" * 32, "workspace_id": pip["workspace_id"]}
        base = str(self.cfg.get("base_url")).rstrip("/")
        own = {"model_settings": {"model": "fixture", "base_url": base}}
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, own), "none set: none")
        pip_backup.set_own(self.registry, pip["id"], "backup-model", "editor-user")
        got = pip_backup.for_run(self.registry, self.cfg, row, own)
        self.assertEqual((got["model"], got["provider"], got["base_url"]), ("backup-model", "", base), "DGC's own connection")
        self.assertEqual(set(got), {"model", "provider", "base_url", "api_mode", "api_key"})
        saved = {"name": "Spare", "base_url": "https://spare.example/v1", "api_mode": "chat", "model": "m", "api_key": "sk-spare"}
        with patch.object(type(self.cfg), "saved_provider", lambda this, pid: dict(saved) if pid == self.PROVIDER else None):
            pip_backup.set_own(self.registry, pip["id"], "gpt-oss:120b", "editor-user", self.PROVIDER)
            got = pip_backup.for_run(self.registry, self.cfg, row, own)
            self.assertEqual((got["model"], got["provider"], got["base_url"], got["api_mode"], got["api_key"]),
                             ("gpt-oss:120b", self.PROVIDER, "https://spare.example/v1", "chat", "sk-spare"),
                             "on the saved provider it names, with that provider's own key")
            on_it = {"model_settings": {"model": "gpt-oss:120b", "provider": self.PROVIDER}}
            self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, on_it), "its own model is no fallback for itself")
            brain = {"model_settings": {"model": "Claude Code", "brain": {"engine": "claude"}}}
            self.assertEqual(pip_backup.for_run(self.registry, self.cfg, row, brain)["base_url"], "https://spare.example/v1",
                             "a subscription's fallback is a model DGC runs")
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, own), "a removed provider: no fallback, never another")
        pip_backup.set_own(self.registry, pip["id"], "fixture", "editor-user")
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, own), "its own model is no fallback for itself")
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, {"model_settings": {"model": "router", "router": {}}}),
                          "DGC Router moves a run itself")
        self.control("set_pip_backup", pip_id=pip["id"], model="")
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, brain), "this Pip chose none")

    def test_claude_code_codex_or_dgc_router_can_be_its_fallback(self):
        # 9 Nov, your call.
        pip = self.pip()
        got = self.control("set_pip_backup", pip_id=pip["id"], model="", engine="claude")["backup"]
        self.assertEqual((got["engine"], got["model"]), ("claude", ""), "Claude Code's own default")
        got = self.control("set_pip_backup", pip_id=pip["id"], model="gpt-5.6-sol", engine="codex")["backup"]
        self.assertEqual((got["engine"], got["model"]), ("codex", "gpt-5.6-sol"))
        got = self.control("set_pip_backup", pip_id=pip["id"], model="", router=True)["backup"]
        self.assertIs(got["router"], True)
        got = self.control("set_pip_backup", pip_id=pip["id"], model="Workstation/glm-5.3:cloud", router=True)["backup"]
        self.assertEqual(got["model"], "Workstation/glm-5.3:cloud")
        for fields in ({"engine": "kimi", "model": ""}, {"router": True, "model": "no-slash"}):
            with self.subTest(fields=fields), self.assertRaises(RegistryError):
                self.control("set_pip_backup", pip_id=pip["id"], **fields)
        row = {"pip_id": pip["id"], "id": "run_" + "d" * 32, "workspace_id": pip["workspace_id"]}
        own = {"model_settings": {"model": "fixture", "base_url": str(self.cfg.get("base_url")).rstrip("/")}}
        self.assertEqual(pip_backup.for_run(self.registry, self.cfg, row, own),
                         {"router": {"system": "Workstation", "model": "glm-5.3:cloud"}, "model": "DGC Router"})
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, {"model_settings": {"model": "r", "router": {}}}),
                          "a Router run moves itself")
        pip_backup.set_own(self.registry, pip["id"], "", "editor-user", engine="claude")
        with patch("dgc.pip_brain.available", return_value=""):
            got = pip_backup.for_run(self.registry, self.cfg, row, own)
            self.assertEqual((got["brain"]["engine"], got["model"]), ("claude", "Claude Code"))
            on_it = {"model_settings": {"model": "claude", "brain": {"engine": "claude", "model": "", "effort": ""}}}
            self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, on_it), "its own CLI is no fallback for itself")
        with patch("dgc.pip_brain.available", return_value="Claude Code is not signed in"):
            self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, own), "signed out: no fallback")

    def test_a_router_fallback_is_leased_when_asked_and_released_with_its_run(self):
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from dgc import router as router_mod
        route = SimpleNamespace(model="glm-5.3:cloud", client_url="http://ws:11434/v1", client_api_mode="chat_completions", key="k-ws")
        row = {"id": "run_" + "e" * 32}
        backup = {"router": {"system": "", "model": ""}, "model": "DGC Router"}
        folder = Path(tempfile.mkdtemp())
        released = []
        with patch.object(router_mod.ROUTER, "acquire", return_value=(route, "")), \
                patch.object(router_mod.ROUTER, "release", side_effect=released.append):
            pips._backup_route_lease(self.cfg, row, {"job": {"name": "Tees"}}, backup, folder)
            left = json.loads((folder / "backup-route.json").read_text())
            self.assertEqual(left, {"model": "glm-5.3:cloud", "base_url": "http://ws:11434/v1", "api_mode": "chat_completions", "api_key": "k-ws"})
            self.assertEqual(oct((folder / "backup-route.json").stat().st_mode & 0o777), "0o600")
            self.assertEqual(backup["model"], "glm-5.3:cloud", "what the worker will say it switched to")
            pips._router_release(f"{row['id']}:fallback")
        self.assertEqual(released, [route], "released with its run")
        with patch.object(router_mod.ROUTER, "acquire", return_value=(None, "")):
            pips._backup_route_lease(self.cfg, row, {}, {"router": {}, "model": "DGC Router"}, folder)
        self.assertIn("none", json.loads((folder / "backup-route.json").read_text()))

    def test_its_chat_says_the_fallback_answers_until_its_own_model_is_back(self):
        from dgc import pip_chat
        pip = self.pip()
        backup = {"model": "backup-model", "provider": "", "base_url": "http://x", "api_mode": "auto", "api_key": ""}
        row = {"pip_id": pip["id"], "id": "run_" + "e" * 32, "workspace_id": pip["workspace_id"]}
        self.assertNotIn("fallback_on", pip_chat.list_messages(self.store, pip["id"]))
        pip_backup.used(self.registry, row, backup, "backup-model")
        self.assertEqual(pip_chat.list_messages(self.store, pip["id"])["fallback_on"]["model"], "backup-model")
        self.assertEqual(self.control("get_pip_backup", pip_id=pip["id"])["backup"]["on"]["model"], "backup-model")
        pip_backup.answered_itself(self.registry, row)
        self.assertNotIn("fallback_on", pip_chat.list_messages(self.store, pip["id"]))

    def test_said_once_an_outage_and_only_for_the_backup_it_was_given(self):
        pip = self.pip()
        backup = {"model": "backup-model", "base_url": "http://x", "api_mode": "auto", "api_key": ""}
        rows = [{"pip_id": pip["id"], "id": f"run_{n}" + "b" * 31, "workspace_id": pip["workspace_id"]} for n in range(4)]
        pip_backup.used(self.registry, rows[0], backup, "some-other-model")
        self.assertEqual(pip_backup.line_for(self.registry.db, rows[0]["id"]), "", "only the backup it was given counts")
        pip_backup.used(self.registry, rows[1], backup, "backup-model")
        pip_backup.used(self.registry, rows[2], backup, "backup-model")
        self.assertEqual(pip_backup.line_for(self.registry.db, rows[1]["id"]), "Its own model didn't answer; backup-model did")
        self.assertEqual(pip_backup.line_for(self.registry.db, rows[2]["id"]), "", "the rest of the outage is quiet")
        pip_backup.answered_itself(self.registry, rows[3])
        self.assertIsNone(pip_backup.out(self.registry, pip["id"]))
        pip_backup.used(self.registry, rows[0], backup, "backup-model")
        self.assertTrue(pip_backup.line_for(self.registry.db, rows[0]["id"]), "a new outage says so again")

    def test_the_terminal_reaches_them_and_a_chats_shell_only_reads(self):
        # Both commands go through the CLI's own dispatcher (a missing route was a KeyError: `dgc pips payments` too).
        import contextlib
        import io
        import json
        import os
        from dgc import pip_cli, sandbox
        self.cfg.data["pips_enabled"] = True

        def cli(*argv, shell=False):
            out, err = io.StringIO(), io.StringIO()
            with patch.dict(os.environ, {sandbox.AGENT_SHELL: "1"} if shell else {}), contextlib.redirect_stdout(out), \
                    contextlib.redirect_stderr(err):
                code = pip_cli.handle_command(self.cfg, list(argv))
            return code, out.getvalue(), err.getvalue()
        code, text, err = cli("backup", "qwen3:8b", "--json")
        self.assertEqual((code, json.loads(text)["backup"]["model"]), (0, "qwen3:8b"), err)
        code, text, _ = cli("backup", "--json", shell=True)
        self.assertEqual((code, json.loads(text)["backup"]["model"]), (0, "qwen3:8b"), "a chat may read it")
        pip = self.pip()
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            code, text, err = cli("backup", "gpt-oss:120b", "--pip", pip["id"], "--provider", self.PROVIDER, "--json")
        self.assertEqual((code, json.loads(text)["backup"]["provider"]), (0, self.PROVIDER), err)
        self.assertEqual(cli("backup", "none", shell=True)[0], 2, "but only you change it")
        # Changed on purpose (agreed 13 Nov): the day's count is retired; `payments` is all Pips together, in dollars.
        code, text, err = cli("payments", "--json")
        self.assertEqual((code, json.loads(text)["payments"]["usd_per_day"]), (0, None), err)
        self.assertEqual(cli("payments", "50", shell=True)[0], 2, "a chat never changes how much Pips pay")
        self.assertEqual(cli("payments", "--pip", pip["id"], "--usd", "20", shell=True)[0], 2, "nor a Pip's limit")
        self.assertEqual(cli("payments", "--pip", pip["id"], "allow", shell=True)[0], 2, "nor lets a Pip pay")
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            code, text, err = cli("payments", "50", "--json")
            self.assertEqual((code, json.loads(text)["payments"]["usd_per_day"]), (0, 50), err)
            code, text, err = cli("payments", "--pip", pip["id"], "--usd", "20", "--json")
            self.assertEqual((code, json.loads(text)["limits"]["usd_per_day"]), (0, 20), err)
            code, text, err = cli("payments")
            self.assertIn("up to $50.00 a day", text)
            code, text, err = cli("payments", "--pip", pip["id"])
        self.assertEqual(code, 0, err)
        self.assertIn("asks you before every payment", text)

    def test_the_cli_shows_and_sets_it(self):
        from dgc.pip_cli import _format, parser
        args = parser().parse_args(["backup", "none", "--pip", "pip_x", "--provider", self.PROVIDER])
        self.assertEqual((args.command, args.model, args.backup_pip, args.backup_provider), ("backup", "none", "pip_x", self.PROVIDER))
        self.assertIn("New Pips start with the fallback qwen3:8b", _format({"backup": {"provider": "", "model": "qwen3:8b"}}))
        self.assertIn("New Pips start with no fallback", _format({"backup": {"provider": "", "model": ""}}))
        self.assertIn("This Pip's fallback: qwen3:8b on a saved provider",
                      _format({"backup": {"pip_id": "pip_x", "provider": self.PROVIDER, "model": "qwen3:8b"}}))
        self.assertIn("This Pip has no fallback", _format({"backup": {"pip_id": "pip_x", "provider": "", "model": ""}}))

    def test_the_cli_sets_claude_code_codex_or_dgc_router_too(self):
        from dgc.pip_cli import _backup_request, _format, parser
        ask = lambda *words: _backup_request(parser().parse_args(["backup", *words]))
        self.assertEqual(ask("--pip", "pip_x", "--engine", "claude"),
                         {"type": "set_pip_backup", "pip_id": "pip_x", "model": "", "provider": "", "engine": "claude"})
        self.assertEqual(ask("gpt-5.6-sol", "--engine", "codex"),
                         {"type": "set_pips_backup", "model": "gpt-5.6-sol", "provider": "", "engine": "codex"})
        self.assertEqual(ask("--pip", "pip_x", "--router", "Workstation/glm-5.3:cloud"),
                         {"type": "set_pip_backup", "pip_id": "pip_x", "model": "Workstation/glm-5.3:cloud", "provider": "", "router": True})
        self.assertEqual(ask("--pip", "pip_x"), {"type": "get_pip_backup", "pip_id": "pip_x"})
        self.assertEqual(ask("none"), {"type": "set_pips_backup", "model": "", "provider": ""})
        self.assertEqual(ask("qwen3:8b", "--provider", self.PROVIDER),
                         {"type": "set_pips_backup", "model": "qwen3:8b", "provider": self.PROVIDER})
        self.assertIn("This Pip's fallback: Claude Code.", _format({"backup": {"pip_id": "pip_x", "provider": "", "model": "", "engine": "claude"}}))
        self.assertIn("New Pips start with the fallback DGC Router.", _format({"backup": {"provider": "", "model": "", "router": True}}))
        self.assertIn("Codex · gpt-5.6-sol", _format({"backup": {"provider": "", "model": "gpt-5.6-sol", "engine": "codex"}}))


if __name__ == "__main__":
    unittest.main()
