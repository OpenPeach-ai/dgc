"""A backup model for Pips (Pips package 6, Pips API 76): one in Pips settings, each Pip's own choice, which runs get one,
and the one line said once an outage. The worker's switch itself: test_pip_chat (a real worker) and test_pip_brain (a
subscription at its limit)."""
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

    def test_nothing_to_set_up_one_backup_for_all_and_only_you_set_it(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 76)
        self.assertEqual(self.control("get_pips_backup"), {"backup": {"model": ""}}, "none by default: nothing changes")
        self.assertEqual(self.control("set_pips_backup", model="qwen3:8b"), {"backup": {"model": "qwen3:8b"}})
        self.assertEqual(pip_backup.pips_wide(self.registry), "qwen3:8b", "kept in the registry: the editor, CLI and runner all see it")
        for actor, model, code in (("device_1", "x", "local_only"), ("editor-user", "https://evil.example/v1", "invalid_request"),
                                   ("editor-user", 7, "invalid_request")):
            with self.subTest(actor=actor, model=model), self.assertRaises(RegistryError) as raised:
                self.control("set_pips_backup", actor=actor, model=model)
            self.assertEqual(raised.exception.code, code)
        self.assertEqual(self.control("set_pips_backup", model=""), {"backup": {"model": ""}}, "none again")

    def test_each_pip_follows_it_or_chooses_its_own_or_none(self):
        pip = self.pip()
        self.control("set_pips_backup", model="qwen3:8b")
        self.assertEqual(self.control("get_pip_backup", pip_id=pip["id"])["backup"],
                         {"pip_id": pip["id"], "model": None, "follows": "qwen3:8b", "backup": "qwen3:8b"})
        own = self.control("set_pip_backup", pip_id=pip["id"], model="llama3.3:70b")["backup"]
        self.assertEqual((own["model"], own["backup"]), ("llama3.3:70b", "llama3.3:70b"))
        none = self.control("set_pip_backup", pip_id=pip["id"], model="")["backup"]
        self.assertEqual((none["model"], none["backup"]), ("", ""), "none for this Pip")
        back = self.control("set_pip_backup", pip_id=pip["id"], model=None)["backup"]
        self.assertEqual((back["model"], back["backup"]), (None, "qwen3:8b"), "null follows Pips settings again")
        with self.assertRaises(RegistryError) as raised:
            self.control("set_pip_backup", actor="device_1", pip_id=pip["id"], model="x")
        self.assertEqual(raised.exception.code, "local_only")
        with self.assertRaises(RegistryError):
            self.control("get_pip_backup", pip_id="pip_" + "f" * 32)

    def test_which_runs_get_a_backup(self):
        pip = self.pip()
        row = {"pip_id": pip["id"], "id": "run_" + "a" * 32, "workspace_id": pip["workspace_id"]}
        own = {"model_settings": {"model": "fixture", "base_url": str(self.cfg.get("base_url")).rstrip("/")}}
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, own), "none set: none")
        pip_backup.set_pips_wide(self.registry, "backup-model", "editor-user")
        got = pip_backup.for_run(self.registry, self.cfg, row, own)
        self.assertEqual((got["model"], got["base_url"]), ("backup-model", str(self.cfg.get("base_url")).rstrip("/")))
        self.assertEqual(set(got), {"model", "base_url", "api_mode", "api_key"}, "DGC's own connection, read when the run starts")
        pip_backup.set_pips_wide(self.registry, "fixture", "editor-user")
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, own), "its own model is no backup for itself")
        brain = {"model_settings": {"model": "Claude Code", "brain": {"engine": "claude"}}}
        self.assertEqual(pip_backup.for_run(self.registry, self.cfg, row, brain)["model"], "fixture",
                         "a subscription's backup is a model DGC runs")
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, {"model_settings": {"model": "router", "router": {}}}),
                          "DGC Router moves a run itself")
        self.control("set_pip_backup", pip_id=pip["id"], model="")
        self.assertIsNone(pip_backup.for_run(self.registry, self.cfg, row, brain), "this Pip chose none")

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
        self.assertEqual(cli("backup", "none", shell=True)[0], 2, "but only you change it")
        code, text, err = cli("payments", "--json")
        self.assertEqual((code, json.loads(text)["payments"]["on"]), (0, False), err)
        self.assertEqual(cli("payments", "on", shell=True)[0], 2, "a chat never lets Pips pay")

    def test_the_cli_shows_and_sets_it(self):
        from dgc.pip_cli import _format, parser
        args = parser().parse_args(["backup", "follow", "--pip", "pip_x"])
        self.assertEqual((args.command, args.model, args.backup_pip), ("backup", "follow", "pip_x"))
        self.assertIn("Backup model for Pips: qwen3:8b", _format({"backup": {"model": "qwen3:8b"}}))
        self.assertIn("No backup model for Pips", _format({"backup": {"model": ""}}))


if __name__ == "__main__":
    unittest.main()
