"""Registry and direct packages may share runtime bytes, never unreviewed assets."""
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
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


class CarriedVoiceTests(unittest.TestCase):
    """DGC Voice rides inside the extension (dist/dgc-voice.vsix) and is held to the outer package's rules."""

    VOICE = ROOT / "editors/vscode-voice"

    def voice_vsix(self, *, replace=None, add=None, drop=(), kind="ui", version=None):
        package = json.loads((self.VOICE / "package.json").read_text(encoding="utf-8"))
        manifest = (
            '<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" '
            'xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>'
            f'<Identity Language="en-US" Id="dgc-voice" Version="{version or package["version"]}" Publisher="vibedgc" />'
            f'<Properties><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{kind}" /></Properties>'
            '</Metadata></PackageManifest>')
        members = {member: (self.VOICE / source).read_bytes() for member, source in guard.VOICE_STATIC_MEMBERS.items()}
        members["[Content_Types].xml"] = b"<Types/>"
        members["extension.vsixmanifest"] = manifest.encode()
        members.update(replace or {})
        members.update(add or {})
        for name in drop:
            members.pop(name)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, data in sorted(members.items()):
                info = zipfile.ZipInfo(name)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, data)
        return buffer.getvalue()

    def check(self, raw):
        return guard.validate_voice(raw, voice_root=self.VOICE, environment_values=[])

    def test_the_outer_package_must_carry_it(self):
        self.assertEqual(guard.VOICE_MEMBER, "extension/dist/dgc-voice.vsix")
        self.assertIn(guard.VOICE_MEMBER, guard.EXPECTED_MEMBERS)

    def test_the_reviewed_source_as_a_ui_extension_passes_with_its_version(self):
        version = json.loads((self.VOICE / "package.json").read_text(encoding="utf-8"))["version"]
        self.assertEqual(self.check(self.voice_vsix()), version)

    def test_anything_else_fails_closed(self):
        cases = [
            ("differs from reviewed source", self.voice_vsix(replace={"extension/extension.js": b"// not the reviewed code\n"})),
            ("added=['extension/test/recording.test.mjs']", self.voice_vsix(add={"extension/test/recording.test.mjs": b""})),
            ("missing=['extension/recording.js']", self.voice_vsix(drop=["extension/recording.js"])),
            ("disagrees with DGC Voice's package.json", self.voice_vsix(kind="workspace")),
            ("disagrees with DGC Voice's package.json", self.voice_vsix(version="9.9.9")),
            ("probable GitHub token", self.voice_vsix(replace={"extension/readme.md": b"ghp_" + b"a" * 30})),
            ("invalid DGC Voice VSIX ZIP", b"not a zip"),
        ]
        for expected, raw in cases:
            with self.subTest(expected=expected):
                with self.assertRaises(guard.ValidationError) as caught:
                    self.check(raw)
                self.assertIn(expected, str(caught.exception))
