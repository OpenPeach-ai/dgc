"""`dgc doctor` is a gate, so its exit code has to mean something.

It printed `✗ cannot reach <endpoint>` and exited 0, which makes `dgc doctor && dgc -p "…"` in a
script or CI step proceed into a run that cannot work. It also printed the unqualified green
"ready" when the configured model was not in the server's list — the same line a correct setup
gets, for a setup whose very first turn asks for a model the server has never heard of.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from dgc import cli as cli_mod                            # noqa: E402
from dgc.llm import LLMClient                             # noqa: E402


class _Config:
    """Only what run_doctor reads."""
    base_url = "http://127.0.0.1:59999/v1"
    api_key = ""
    model = "fixture-model"

    def __init__(self, **data):
        self.data = {"mode": "default", "context_size": 32768, **data}

    def get(self, key, default=None):
        return self.data.get(key, default)


class DoctorExitCodeTests(unittest.TestCase):
    def _run(self, *, models=None, raises=None, **data):
        code, _printed = self._run_capturing(models=models, raises=raises, **data)
        return code

    def _run_capturing(self, *, models=None, raises=None, **data):
        """(exit code, everything printed). The wording is half of what doctor promises."""
        config = _Config(**data)
        printed = []

        def list_models(_self):
            if raises is not None:
                raise raises
            return models or []

        class _Console:
            def print(self, *args, **kwargs):
                printed.append(" ".join(str(a) for a in args))

        with patch.object(LLMClient, "list_models", list_models), \
                patch.object(cli_mod, "Console", lambda *a, **k: _Console()):
            code = cli_mod.run_doctor(config)
        return code, "\n".join(printed)

    def test_an_unreachable_endpoint_exits_nonzero(self):
        code = self._run(raises=ConnectionError("connection refused"))
        self.assertEqual(code, 1,
                         "a script gating on `dgc doctor` was told everything was fine")

    def test_a_working_setup_exits_zero(self):
        self.assertEqual(self._run(models=["fixture-model", "other"]), 0)

    def test_a_model_the_server_does_not_offer_is_not_plain_ready(self):
        # Reachable, so not a hard failure — a proxy may serve a model it does not list — but it
        # must not print the same unqualified "ready" a correct setup gets. Asserting only the
        # exit code (as the first version of this test did) checks nothing: the OLD code also
        # returned 0 here, and the whole point is the wording.
        code, printed = self._run_capturing(models=["something-else"])
        self.assertEqual(code, 0, "reachable is not a failure")
        self.assertIn("warning", printed.lower(),
                      "a setup whose model the server does not have was called plainly ready")

    def test_a_correct_setup_says_plainly_ready(self):
        code, printed = self._run_capturing(models=["fixture-model"])
        self.assertEqual(code, 0)
        self.assertIn("ready", printed.lower())
        self.assertNotIn("warning", printed.lower())

    def test_an_unreachable_endpoint_says_not_ready(self):
        code, printed = self._run_capturing(raises=ConnectionError("refused"))
        self.assertEqual(code, 1)
        self.assertIn("not ready", printed.lower(),
                      "it printed the reason and then no verdict at all")

    def test_doctor_returns_a_code_at_all(self):
        # It returned None, which SystemExit treats as success however bad the news was.
        self.assertIsInstance(self._run(models=["fixture-model"]), int)


class DoctorWordingTests(unittest.TestCase):
    def test_the_unreachable_path_says_not_ready(self):
        source = (cli_mod.__file__)
        with open(source, encoding="utf-8") as handle:
            text = handle.read()
        start = text.index("def run_doctor(")
        body = text[start:text.index("\ndef ", start + 10)]
        self.assertIn("not ready[/bold red] — the endpoint could not be reached", body,
                      "it printed the reason and then no verdict at all")
        self.assertIn("ready, with one warning", body,
                      "a model the server does not list must not read as plainly ready")

    def test_the_command_propagates_the_code(self):
        with open(cli_mod.__file__, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("raise SystemExit(run_doctor(cfg))", text,
                      "the exit code has to reach the shell to be worth anything")


if __name__ == "__main__":
    unittest.main()


class ReadmeDependencyCountTests(unittest.TestCase):
    """The README's dependency count is a promise about what installing DGC pulls in."""

    def test_the_readme_names_the_dependencies_it_actually_has(self):
        import re
        from pathlib import Path
        root = Path(__file__).resolve().parents[1]
        block = re.search(r"dependencies\s*=\s*\[(.*?)\]",
                          (root / "pyproject.toml").read_text(encoding="utf-8"), re.S)
        names = [re.split(r"[=<>~!\[]", dep)[0].strip()
                 for dep in re.findall(r'"([^"]+)"', block.group(1))]
        readme = (root / "README.md").read_text(encoding="utf-8")
        words = {3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight"}
        self.assertIn(f"{words.get(len(names), len(names))} dependencies", readme,
                      f"the README's count disagrees with pyproject.toml ({len(names)}: {names})")
        for name in names:
            self.assertIn(f"`{name}`", readme, f"{name} installs with DGC and the README omits it")
