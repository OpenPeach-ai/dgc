"""Registry and direct packages may share runtime bytes, never unreviewed assets."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("extension_pair_guard", ROOT / "scripts/check-extension-vsix.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ExtensionPairTests(unittest.TestCase):
    def validate(self, changed):
        registry = {name: b"same" for name in guard.EXPECTED_MEMBERS}
        selfhost = {**registry, **{name: b"changed" for name in changed}}
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / "a.vsix", Path(directory) / "b.vsix"
            a.write_bytes(b"registry"); b.write_bytes(b"selfhost")
            with patch.object(guard, "validate_artifact", side_effect=[registry, selfhost]):
                return guard.validate_pair(a, b, extension_root=ROOT / "editors/vscode",
                                           version="0.25.1", source_commit="a" * 40)

    def test_identical_runtime_still_requires_distinct_distribution_provenance(self):
        self.assertEqual(set(self.validate({"extension/dist/build.json"})),
                         {"registry_sha256", "selfhost_sha256"})
        with self.assertRaises(guard.ValidationError):
            self.validate(set())

    def test_flavor_specific_code_is_allowed_but_other_assets_are_not(self):
        self.validate({"extension/dist/build.json", "extension/dist/extension.js"})
        for member in guard.EXPECTED_MEMBERS - {"extension/dist/build.json", "extension/dist/extension.js"}:
            with self.subTest(member=member), self.assertRaises(guard.ValidationError):
                self.validate({"extension/dist/build.json", member})
