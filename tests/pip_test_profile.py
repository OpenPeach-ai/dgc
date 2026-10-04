"""Fixtures for a profile that already uses Pips.

Per-turn Pips bookkeeping (session association, turn records, verifier receipts) waits until the
profile's Pips registry exists (workspace_registry.in_use). These tests keep their registries in
their own temporary directories, so they declare the profile in use instead of relying on the
default location.
"""
from unittest.mock import patch


def pips_in_use(test):
    started = patch("dgc.workspace_registry.in_use", return_value=True)
    started.start()
    test.addCleanup(started.stop)
