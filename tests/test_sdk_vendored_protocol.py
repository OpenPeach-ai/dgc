"""The SDK's vendored protocol copy must be the CLI's, byte for byte.

`sdk/python/dgc_sdk/wire/editor_protocol.py` is a verbatim copy of `dgc/editor_protocol.py`. An
installed dgc-sdk has no access to the CLI's module, so the copy is the only contract it can
validate against — and nothing kept the two in step.

It had fallen a whole release behind while still declaring `PROTOCOL_VERSION = 14`: the copy was
missing `ask_request`/`ask_resolved`, the `answers` and `spooled_images` prompt fields, `open_asks`
on `set_workspace_roots`, and the `ask_skip` and `ping` commands — everything CLI 0.42.0 added. An
SDK client would reject events the CLI legitimately sends and could not send those fields at all,
while both sides claimed to speak the same protocol version.

Its own docstring says "tests fail when either checked-in artifact drifts from this source". In the
vendored copy that was untrue until this test existed.
"""
from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
CLI = PROJECT / "dgc" / "editor_protocol.py"
VENDORED = PROJECT / "sdk" / "python" / "dgc_sdk" / "wire" / "editor_protocol.py"


class VendoredProtocolTests(unittest.TestCase):
    def test_the_copy_is_byte_identical_to_the_cli_module(self):
        self.assertEqual(
            hashlib.sha256(VENDORED.read_bytes()).hexdigest(),
            hashlib.sha256(CLI.read_bytes()).hexdigest(),
            "sdk/python/dgc_sdk/wire/editor_protocol.py has drifted from dgc/editor_protocol.py; "
            "copy the CLI's module over it — the SDK validates against this file alone")

    def test_both_declare_the_same_protocol_version(self):
        pattern = re.compile(r"^PROTOCOL_VERSION\s*=\s*(\d+)", re.M)
        cli = pattern.search(CLI.read_text(encoding="utf-8")).group(1)
        vendored = pattern.search(VENDORED.read_text(encoding="utf-8")).group(1)
        self.assertEqual(cli, vendored,
                         "the SDK claims a protocol version it does not implement")

    def test_the_copy_carries_the_commands_the_cli_declares(self):
        # A shape check on top of the hash: if someone relaxes the hash test, this still names
        # what went missing last time rather than passing silently.
        vendored = VENDORED.read_text(encoding="utf-8")
        for name in ("ask_request", "ask_resolved", "ask_skip", "ping",
                     "spooled_images", "open_asks", "answers"):
            with self.subTest(name=name):
                self.assertIn(f'"{name}"', vendored, f"the SDK's protocol copy is missing {name}")

    def test_the_vendored_module_imports_and_agrees_at_runtime(self):
        from dgc import editor_protocol as cli_module
        from dgc_sdk.wire import editor_protocol as sdk_module
        self.assertEqual(cli_module.PROTOCOL_VERSION, sdk_module.PROTOCOL_VERSION)
        for table in ("EVENT_FIELDS", "COMMAND_FIELDS"):
            with self.subTest(table=table):
                self.assertEqual(sorted(getattr(cli_module, table)), sorted(getattr(sdk_module, table)),
                                 f"the SDK's {table} differs from the CLI's, so it would accept or "
                                 "reject a different set of messages than the CLI actually sends")


if __name__ == "__main__":
    unittest.main()
