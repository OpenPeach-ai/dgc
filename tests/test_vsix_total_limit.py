"""The VSIX validator must stop before decompressing past its total member budget."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "scripts/check-extension-vsix.py"
SPEC = importlib.util.spec_from_file_location("check_extension_vsix", SOURCE)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class FakeZip:
    reads = 0

    def __init__(self, path):
        self.infos = [SimpleNamespace(filename=f"member{i}.bin", file_size=4 * 1024 * 1024,
                                      external_attr=0o100644 << 16, compress_type=CHECKER.zipfile.ZIP_DEFLATED,
                                      flag_bits=0) for i in range(5)]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def infolist(self):
        return self.infos

    def read(self, info):
        FakeZip.reads += 1
        return b""


class VSIXTotalLimitTests(unittest.TestCase):
    def test_rejects_before_decompressing_member_past_total_limit(self):
        FakeZip.reads = 0
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "candidate.vsix"
            path.write_bytes(b"fixture")
            with patch.object(CHECKER.zipfile, "ZipFile", FakeZip), \
                    patch.object(CHECKER, "EXPECTED_MEMBERS", {f"member{i}.bin" for i in range(5)}), \
                    patch.object(CHECKER, "_scan_credentials"):
                with self.assertRaisesRegex(CHECKER.ValidationError, "oversized uncompressed VSIX"):
                    CHECKER.validate_artifact(path, extension_root=Path(temp), version="0.34.0",
                                              source_commit="a" * 40, flavor="registry")
        self.assertEqual(FakeZip.reads, 4)


if __name__ == "__main__":
    unittest.main()
