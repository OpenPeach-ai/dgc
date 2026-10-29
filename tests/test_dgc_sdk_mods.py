"""session(mods=[...]) (dgc_sdk, CLI 0.50+): the folders named in code run in that session's DGC, in their sandbox,
with no Allow stored anywhere (the developer named them), and a folder that isn't a mod is refused before anything
starts. dgc_sdk.mods is the library a Python mod imports."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_dgc_sdk as harness                               # noqa: E402  (its mock model and setUp)

from dgc_sdk import DGCConfigError                            # noqa: E402
from dgc_sdk import mods as dm                                # noqa: E402

MOD = """
import dgc_mod as dm
mod = dm.Mod()
@mod.command("ping")
def ping(args):
    return dm.Text("pong " + args)
mod.run()
"""


class SdkMods(unittest.TestCase):
    setUp = harness.SdkTests.setUp
    tearDown = harness.SdkTests.tearDown
    _client = harness.SdkTests._client

    def mod_folder(self) -> Path:
        folder = Path(tempfile.mkdtemp(prefix="dgc-sdk-mod-")) / "pinger"
        folder.mkdir()
        (folder / "main.py").write_text(textwrap.dedent(MOD))
        (folder / "dgc-mod.json").write_text(json.dumps({"name": "pinger", "version": "1.0.0", "entry": "main.py",
                                                         "title": "Pinger", "capabilities": {
                                                             "commands": [{"name": "ping"}]}}))
        return folder

    def test_a_session_runs_the_mods_its_code_names(self):
        folder = self.mod_folder()
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"}, mods=[folder])
            pinger = next(m for m in session.mods.list() if m["name"] == "pinger")
            self.assertEqual(pinger["state"], "running", pinger)
            self.assertEqual(session.mods.run("ping", "sdk"), {"mod": "Pinger", "tree": {"type": "Text",
                                                                                          "text": "pong sdk"}})

    def test_a_folder_that_isnt_a_mod_is_refused_first(self):
        with self._client() as dgc:
            with self.assertRaises(DGCConfigError):
                dgc.session(cwd=self.work, mods=[self.work])

    def test_the_authoring_library_builds_what_dgc_draws(self):
        self.assertEqual(dm.ask("careful"), {"decision": "ask", "reason": "careful"})
        self.assertEqual(dm.Bar([{"label": "a", "value": 1}], total=4),
                         {"type": "Bar", "segments": [{"label": "a", "value": 1}], "total": 4})


if __name__ == "__main__":
    unittest.main()
