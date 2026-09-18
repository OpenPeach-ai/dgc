"""Run SDK test modules against the installed dgc-sdk wheel and dgc runtime, never this checkout.

    python tests/sdk_installed.py tests/test_dgc_sdk.py tests/test_sdk_examples.py ...

CI runs this with a clean, non-editable venv. `dgc_sdk` and `dgc` are imported from that venv
before any test module loads, so a module that puts the checkout on sys.path still gets the
installed packages (Python caches the first import). Only this process is affected: the runtime
and tool-bridge children start fresh interpreters, which is what the job exists to exercise.
"""
from __future__ import annotations

import importlib
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _outside_checkout(module_name: str) -> Path:
    module = importlib.import_module(module_name)
    origin = Path(module.__file__ or "").resolve()
    if origin.is_relative_to(ROOT):
        raise SystemExit(f"{module_name} was imported from the checkout ({origin}); "
                         "run this from a venv with the built wheel installed, outside the checkout")
    return origin


def main(paths: list[str]) -> int:
    os.environ["DGC_SDK_TEST_INSTALLED"] = "1"
    sys.path[:] = [entry for entry in sys.path
                   if entry and not Path(entry).resolve().is_relative_to(ROOT)]
    sdk_origin = _outside_checkout("dgc_sdk")
    _outside_checkout("dgc")
    print(f"dgc_sdk from {sdk_origin.parent}", flush=True)
    tests_dir = str(ROOT / "tests")
    sys.path.insert(0, tests_dir)   # sibling imports such as `import test_dgc_sdk as base`
    suite = unittest.TestSuite()
    for path in paths:
        module = importlib.import_module(Path(path).stem)
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
    if Path(sys.modules["dgc_sdk"].__file__ or "").resolve() != sdk_origin:
        raise SystemExit("a test module replaced the installed dgc_sdk")
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
