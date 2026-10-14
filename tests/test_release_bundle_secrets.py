"""The release gate's credential check (scripts/release_bundle.py): real key shapes are refused, words are not."""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_bundle_under_test", ROOT / "scripts" / "release_bundle.py")
release_bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_bundle)


class SecretMarkerTests(unittest.TestCase):
    def test_key_shapes_are_found(self):
        for key in (b"AKIA" + b"ABCDEFGHIJKLMNOP", b"sk-" + b"a" * 30, b"github_pat_" + b"b" * 30, b"ghp_" + b"c" * 36,
                    b"re_" + b"d" * 30, b"-----BEGIN RSA PRIVATE KEY-----"):
            for text in (key, b"token = '" + key + b"'", b"x\n" + key + b"\n"):
                with self.subTest(text=text):
                    self.assertTrue(release_bundle.SECRET_RE.search(text))

    def test_a_word_that_contains_a_prefix_is_not_a_key(self):
        """The 0.48 build was refused over this runtime constant: "befo-re_and_after..." read as a Resend key."""
        for text in (b"'observed_before_and_after_not_execution_attestation'", b"desk-" + b"e" * 30,
                     b"mask-" + b"f" * 30, b"score_" + b"g" * 30):
            with self.subTest(text=text):
                self.assertIsNone(release_bundle.SECRET_RE.search(text))

    def test_the_runtime_tree_has_no_marker(self):
        found = [str(path.relative_to(ROOT)) for path in sorted((ROOT / "dgc").rglob("*.py"))
                 if release_bundle.SECRET_RE.search(path.read_bytes())]
        self.assertEqual(found, [], "the release gate would refuse these files")


if __name__ == "__main__":
    unittest.main()
