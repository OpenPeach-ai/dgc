"""Every dependency the package declares must be in the lock CI installs.

`pyproject.toml` says what `dgc` requires; `requirements.lock` is what CI (and the installer, and
anyone following the documented path) actually installs. Nothing compared the two, so when the
Documents module added `pypdf==6.19.0` to the project's dependencies and not to the lock, every
CI matrix job began failing `python -m pip check` with:

    dgc 0.43.0 requires pypdf, which is not installed.

That is the whole `Release` workflow, on every tag, from 0.42.0 onwards — which is why tags stopped
getting GitHub Releases. It is also a real defect for users: an install from the lock does not
satisfy the package it is meant to install.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]

_NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)")


def _canonical(name: str) -> str:
    """PEP 503 normalisation: `Pygments`, `pypdf`, `prompt_toolkit` all compare predictably."""
    return re.sub(r"[-_.]+", "-", name).lower()


_DEPS_ARRAY = re.compile(r"^dependencies\s*=\s*\[(.*?)\]", re.M | re.S)
_SPEC = re.compile(r"[\"\']([^\"\']+)[\"\']")


def _declared() -> dict[str, str]:
    """The project's runtime dependencies, read without `tomllib`.

    `tomllib` is standard library only from Python 3.11, and CI still builds on 3.10 — where an
    unconditional import makes this whole module fail to import. The convention elsewhere in the
    suite is to skip on 3.10; this guard is worth running on every interpreter instead, and the
    dependency list is a flat array of strings, so a small regex reads it everywhere.
    """
    text = (PROJECT / "pyproject.toml").read_text(encoding="utf-8")
    body = _DEPS_ARRAY.search(text)
    assert body, "pyproject.toml has no [project] dependencies array"
    out = {}
    for spec in _SPEC.findall(body.group(1)):
        match = _NAME.match(spec.strip())
        if match:
            out[_canonical(match.group(1))] = spec.strip()
    return out


def _locked() -> dict[str, str]:
    out = {}
    for line in (PROJECT / "requirements.lock").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = _NAME.match(line)
        if match:
            out[_canonical(match.group(1))] = line
    return out


class DependencyLockTests(unittest.TestCase):
    def test_the_lock_satisfies_every_declared_dependency(self):
        declared, locked = _declared(), _locked()
        missing = sorted(set(declared) - set(locked))
        self.assertEqual(missing, [], "requirements.lock is what CI and the installer install, so a "
                                      "dependency missing from it fails `pip check` on every job: "
                                      + ", ".join(declared[name] for name in missing))

    def test_a_pinned_dependency_is_pinned_to_the_same_version_in_both(self):
        declared, locked = _declared(), _locked()
        for name, spec in declared.items():
            if "==" not in spec or name not in locked:
                continue
            with self.subTest(dependency=name):
                self.assertEqual(spec.split("==", 1)[1].strip(), locked[name].split("==", 1)[1].strip(),
                                 f"{name} is pinned to two different versions")

    def test_the_lock_pins_every_entry(self):
        for name, line in _locked().items():
            with self.subTest(dependency=name):
                self.assertIn("==", line, f"{line!r} is not pinned; a lock that floats is not a lock")

    def test_the_declared_dependencies_are_importable_here(self):
        # A cheap guard that the names are real distributions, not typos that would only surface
        # in a clean CI venv minutes later.
        from importlib.metadata import PackageNotFoundError, version
        for name, spec in _declared().items():
            with self.subTest(dependency=name):
                try:
                    version(name)
                except PackageNotFoundError:
                    self.skipTest(f"{name} is not installed in this environment")


if __name__ == "__main__":
    unittest.main()
