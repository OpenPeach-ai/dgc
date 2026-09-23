"""The signed SDK checkout manifest must match the tree it claims to describe.

`sdk/sbom/SHA256SUMS` hashes every SDK source file and is signed. The publish workflow's FIRST
step verifies the tagged tree against it and refuses to build on a mismatch — so a stale manifest
does not produce a warning, it produces a tag that silently publishes nothing.

That has now cost three releases:

  - 0.6.0 and 0.6.1 were tagged with the manifest still recording 0.5.3. Neither ever reached
    PyPI or npm; the repo said 0.6.x while users could only install 0.5.3.
  - 0.6.5 was tagged after regenerating the manifest and THEN running
    `npm install --package-lock-only`, which rewrote `sdk/typescript/package-lock.json` — a file
    the manifest covers. It went stale in the second between signing and committing.

`make_sbom.py`'s own docstring says to run it "after every SDK source change, as the last step
before tagging". Nothing enforced that until this test. It is cheap: hashing 46 files.
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]


def _load(relative: str, name: str):
    spec = importlib.util.spec_from_file_location(name, PROJECT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CheckoutManifestTests(unittest.TestCase):
    def setUp(self):
        if not (PROJECT / "sdk" / "sbom" / "SHA256SUMS").is_file():
            self.skipTest("no checkout manifest in this tree")
        self.make_sbom = _load("sdk/scripts/make_sbom.py", "dgc_sdk_make_sbom_checkout")

    @staticmethod
    def _recorded() -> dict[str, str]:
        """The manifest as {relative path: sha256}. Its format is `<hash>  <path>` per line."""
        out = {}
        for line in (PROJECT / "sdk" / "sbom" / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
            parts = line.split(None, 1)
            if len(parts) == 2:
                out[parts[1].strip()] = parts[0].strip()
        return out

    def test_the_manifest_matches_the_tree(self):
        # The publish workflow runs exactly this comparison as its first step, and a mismatch
        # there is a tag that builds nothing. Running it here makes that a local failure instead.
        self.assertEqual(self.make_sbom.verify(), 0,
                         "run `python3 sdk/scripts/make_sbom.py` as the LAST step before "
                         "committing an SDK change -- after any npm install --package-lock-only")

    def test_no_recorded_file_has_changed(self):
        mismatches = []
        for relative, recorded in self._recorded().items():
            path = PROJECT / relative
            if not path.is_file():
                mismatches.append(f"{relative}: in the manifest, missing from the tree")
            elif self.make_sbom.sha256(path) != recorded:
                mismatches.append(f"{relative}: changed since the manifest was signed")
        self.assertEqual(mismatches, [], "\n  ".join([""] + mismatches))

    def test_every_sdk_source_file_is_covered(self):
        recorded = set(self._recorded())
        missing = sorted(str(f.relative_to(PROJECT)) for f in self.make_sbom.source_files()
                         if str(f.relative_to(PROJECT)) not in recorded)
        self.assertEqual(missing, [], "a new SDK file is not in the signed manifest: "
                                      + ", ".join(missing))

    def test_the_manifest_names_this_sdk_version(self):
        from dgc_sdk import _version
        text = (PROJECT / "sdk" / "sbom" / "cyclonedx.json").read_text(encoding="utf-8")
        self.assertIn(_version.__version__, text,
                      "the SBOM describes a different SDK version than the package declares")


if __name__ == "__main__":
    unittest.main()
