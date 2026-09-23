"""The generated protocol artifacts must match `dgc/editor_protocol.py`.

Three files are generated from that module: the public JSON Schema, the copy packaged inside the
wheel, and the TypeScript contract the VS Code extension validates every incoming event against.

**What happens when they drift is silent, and it happened on 2026-09-23.** `files_ready` was added
to the CLI and the artifacts were not regenerated, so `dgc serve` emitted a correct event and the
extension's `skipUnknownEvent` dropped it — deliberately, because killing the child over an unknown
type would be worse. The chat showed one grey line, "This extension skipped a backend event it does
not handle yet (files_ready)", and the whole feature did nothing.

Nothing caught it. The extension tests inject events straight into the webview, so they never reach
the host's schema check. The Python suite never ran the generator. `scripts/generate-editor-protocol.py
--check` would have caught it and is a release gate, but a release gate that only runs after the
feature work is done is a gate you discover late. This test moves it into the suite.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))


class GeneratedProtocolTests(unittest.TestCase):
    def test_every_generated_artifact_matches_the_source_module(self):
        from dgc.editor_protocol import generated_artifacts
        stale = []
        for path, expected in generated_artifacts(PROJECT).items():
            try:
                current = path.read_text()
            except OSError:
                current = None
            if current != expected:
                stale.append(path.relative_to(PROJECT).as_posix())
        self.assertEqual(stale, [],
                         "run `python3 scripts/generate-editor-protocol.py`. Until you do, the "
                         "extension validates events against a schema that does not know them and "
                         "SILENTLY DROPS anything new: " + ", ".join(stale))

    def test_the_checked_in_gate_agrees(self):
        """The script is what CI runs; keep this test and that gate from disagreeing."""
        result = subprocess.run([sys.executable, "scripts/generate-editor-protocol.py", "--check"],
                                cwd=PROJECT, capture_output=True, text=True, timeout=120)
        self.assertIn("are current", result.stdout + result.stderr,
                      f"the release gate disagrees with this test:\n{result.stdout}{result.stderr}")

    def test_the_typescript_contract_carries_every_event(self):
        """A shape check under the byte comparison: it names what went missing."""
        from dgc.editor_protocol import EVENT_FIELDS
        contract = (PROJECT / "editors" / "vscode" / "src" / "protocol.generated.ts").read_text()
        missing = sorted(name for name in EVENT_FIELDS if f'"{name}"' not in contract)
        self.assertEqual(missing, [],
                         "the extension would drop these events at the host, before any webview "
                         "code runs: " + ", ".join(missing))


if __name__ == "__main__":
    unittest.main()
