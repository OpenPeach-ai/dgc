"""The Python Pips SDK rejects malformed option types and oversized spool writes."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from dgc_sdk.errors import DGCConfigError
from dgc_sdk.pips import Pips


class PipShapeTests(unittest.TestCase):
    def _pips(self, spool=""):
        session = SimpleNamespace(
            _isolated=False, _policy=None, _permission_mode="default",
            sandbox=SimpleNamespace(requirement="off", active=False),
            _ready={"capabilities": {"pips_supported": True, "pips_enabled": True,
                                      "pips_api_version": 67, "image_spool": True,
                                      "image_spool_dir": spool}},
        )
        return Pips(session)

    def test_unhashable_options_are_config_errors(self):
        pips = self._pips()
        for command, params in (
            ("set_pip_eyes", {"choice": {}}),
            ("set_pip_computer_apps", {"choice": {}}),
            ("set_pip_level", {"level": {}}),
            ("set_pip_artifacts", {"report_as": {}}),
            ("send_pip_message", {"spooled_images": [{"name": "a", "media_type": {}}]}),
        ):
            with self.subTest(command=command), self.assertRaises(DGCConfigError):
                pips.mutate(command, params, approved=True)

    def test_spool_rejects_bytes_above_two_megabytes(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(DGCConfigError):
                self._pips(directory).spool(b"x" * (2 * 1024 * 1024 + 1))
            self.assertEqual(list(Path(directory).iterdir()), [])
