"""A flag meant for one scripted run must not become the user's standing configuration.

`dgc -p "..." --mode auto --trust` marked the workspace trusted AND wrote `mode: auto` into
config.json, so the next interactive launch ran in auto — full auto-approval — because of a flag
passed once to a script. `--think` and `--ultra` leaked the same way; only `--model`/`--base-url`
had been given `persist=_persist_flags`.

Trusting a folder is what triggered it: `mark_trusted` calls `config.save()`, and `save()` writes
every key this process changed since the baseline. Any other save in the process would have done
it too (a permission rule, a slash command), so the fix is at the source — the flags are declared
ephemeral on a one-shot run and no save may write them.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

PROJECT = Path(__file__).resolve().parents[1]

BASE = {"model": "fixture", "base_url": "http://127.0.0.1:1/v1", "mode": "default"}


class OneShotFlagPersistenceTests(unittest.TestCase):
    """Drives the real CLI as a subprocess: this bug lives in argument handling, not a helper."""

    def run_cli(self, *flags):
        home = tempfile.mkdtemp(prefix="dgc-oneshot-")
        work = Path(home) / "ws"
        work.mkdir()
        (Path(home) / ".dgc").mkdir()
        (Path(home) / ".dgc" / "config.json").write_text(json.dumps(BASE), encoding="utf-8")
        env = {**os.environ, "HOME": home, "USERPROFILE": home, "PYTHONPATH": str(PROJECT)}
        subprocess.run([sys.executable, "-m", "dgc", *flags], cwd=work, env=env,
                       capture_output=True, text=True, timeout=120)
        return json.loads((Path(home) / ".dgc" / "config.json").read_text(encoding="utf-8"))

    def test_mode_from_a_one_shot_run_is_not_saved(self):
        saved = self.run_cli("-p", "hi", "--mode", "auto", "--trust")
        self.assertEqual(saved.get("mode"), "default",
                         "a --mode passed to a one-shot run became the permanent permission mode")

    def test_trust_itself_is_still_saved(self):
        # The point of --trust. Suppressing the flags must not suppress the trust record.
        saved = self.run_cli("-p", "hi", "--mode", "auto", "--trust")
        self.assertTrue(saved.get("trusted_dirs"), "--trust must still persist the workspace")

    def test_think_and_ultra_do_not_leak_either(self):
        saved = self.run_cli("-p", "hi", "--mode", "auto", "--trust", "--think", "high", "--ultra")
        self.assertEqual(saved.get("mode"), "default")
        self.assertNotIn("thinking", saved, "--think leaked into the saved configuration")
        self.assertNotIn("ultra_mode", saved, "--ultra leaked into the saved configuration")

    def test_a_one_shot_run_without_trust_saves_nothing(self):
        saved = self.run_cli("-p", "hi", "--mode", "acceptEdits")
        self.assertEqual(saved.get("mode"), "default")


class EphemeralKeyTests(unittest.TestCase):
    """The mechanism, without spawning a process."""

    def setUp(self):
        # HOME is process-wide and the suite shares it. Leaving a test's temporary home behind
        # breaks every later test that resolves a session path against it — which is exactly what
        # the first version of this file did: four session tests failed hundreds of lines later.
        self._home = os.environ.get("HOME")
        self._userprofile = os.environ.get("USERPROFILE")
        self.addCleanup(self._restore_home)

    def _restore_home(self):
        for key, value in (("HOME", self._home), ("USERPROFILE", self._userprofile)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        import importlib
        import dgc.config as config_mod
        importlib.reload(config_mod)               # rebind USER_CONFIG to the restored home

    def config(self):
        from dgc.config import Config
        home = tempfile.mkdtemp(prefix="dgc-eph-")
        os.environ["HOME"] = os.environ["USERPROFILE"] = home
        Path(home, ".dgc").mkdir(parents=True)
        Path(home, ".dgc", "config.json").write_text(json.dumps(BASE), encoding="utf-8")
        import importlib
        import dgc.config as config_mod
        importlib.reload(config_mod)
        return config_mod.Config()

    def test_an_ephemeral_key_is_never_written(self):
        cfg = self.config()
        cfg.data["mode"] = "auto"
        cfg.mark_ephemeral("mode")
        cfg.data["model"] = "changed-on-purpose"
        cfg.save()
        on_disk = json.loads(Path(os.environ["HOME"], ".dgc", "config.json").read_text())
        self.assertEqual(on_disk.get("mode"), "default", "the ephemeral key was written")
        self.assertEqual(on_disk.get("model"), "changed-on-purpose",
                         "a real change beside it must still be saved")

    def test_it_still_applies_in_memory(self):
        # Ephemeral means "not persisted", not "not used" — the run still gets auto.
        cfg = self.config()
        cfg.data["mode"] = "auto"
        cfg.mark_ephemeral("mode")
        self.assertEqual(cfg.data["mode"], "auto")


if __name__ == "__main__":
    unittest.main()
