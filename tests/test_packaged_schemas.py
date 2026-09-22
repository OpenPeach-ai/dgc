"""The schemas that SHIP must be the schemas in the repo.

`schemas/` is the source of truth the tests and the extension read. `dgc/schemas/` is the copy
packaged into the wheel (`pyproject.toml`: `dgc = [..., "schemas/*.json"]`) and therefore the only
one an installed DGC can see. Nothing compared them, and they had already diverged — `schemas/`
carried an editor-protocol v2 file that the packaged set did not.

Same shape as the defect that made every CI job fail for a release: two artifacts that must agree,
one of them generated or hand-copied, and no gate between them. See tests/test_dependency_lock.py.
"""
from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "schemas"
PACKAGED = PROJECT / "dgc" / "schemas"


def _digests(directory: Path) -> dict[str, str]:
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(directory.glob("*.json"))}


class PackagedSchemaTests(unittest.TestCase):
    def test_every_source_schema_is_packaged(self):
        missing = sorted(set(_digests(SOURCE)) - set(_digests(PACKAGED)))
        self.assertEqual(missing, [], "an installed DGC can only see dgc/schemas/, so a schema "
                                      "that is not copied there does not ship: " + ", ".join(missing))

    def test_no_packaged_schema_is_unknown_to_the_repo(self):
        extra = sorted(set(_digests(PACKAGED)) - set(_digests(SOURCE)))
        self.assertEqual(extra, [], "dgc/schemas/ ships something schemas/ does not define: "
                                    + ", ".join(extra))

    def test_the_copies_are_byte_identical(self):
        source, packaged = _digests(SOURCE), _digests(PACKAGED)
        differing = sorted(name for name in source
                           if name in packaged and source[name] != packaged[name])
        self.assertEqual(differing, [], "a packaged schema has drifted from its source: "
                                        + ", ".join(differing))

    def test_the_current_protocol_version_is_among_them(self):
        from dgc.editor_protocol import PROTOCOL_VERSION
        name = f"editor-protocol-v{PROTOCOL_VERSION}.schema.json"
        self.assertIn(name, _digests(PACKAGED), "the protocol this build speaks must ship")
        declared = json.loads((PACKAGED / name).read_text(encoding="utf-8"))
        self.assertIn(str(PROTOCOL_VERSION), str(declared.get("$id", "")),
                      "the packaged schema names a different protocol version")


if __name__ == "__main__":
    unittest.main()
