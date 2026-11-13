"""A test run alone (`python -m unittest tests.test_x`) never touches the developer's real ~/.dgc.

tests/run_tests.py redirects HOME before any dgc module is imported, so the whole suite is hermetic. A single test
module run on its own skipped that, and wrote into the real home: seen 13 Nov 2026 on a developer's machine, about
8,400 temporary projects' sessions in ~/.dgc/sessions and 168 temporary Pips workspaces, which then filled "All
projects". This package is imported before any test module in it, so the same redirection happens here, but only
when HOME is still the account's own (the suite runner's redirection, or one a test run was given, is left alone).
"""
import os
import tempfile

try:
    import pwd
    _ACCOUNT_HOME = os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)
except (ImportError, KeyError, OSError):          # Windows has no pwd: compare with the home Python would use
    _ACCOUNT_HOME = os.path.realpath(os.path.expanduser("~"))

if os.path.realpath(os.environ.get("HOME") or _ACCOUNT_HOME) == _ACCOUNT_HOME:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)
    os.environ.pop("DGC_HOME", None)
    os.environ.setdefault("DGC_CONTAINER_CLI", "")
