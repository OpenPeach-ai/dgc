"""The Python running the tests, as Keep Pips running and the Pips service would run it.

Both refuse an interpreter that someone else could change (pip_service._executable): one reached through a folder
another user can write, or a file group- or world-writable or owned by another user. A service must never run code
someone else could swap. GitHub's runners keep their Python under /opt, writable by anyone, in files their tool
cache leaves group-writable (macOS: a framework folder the wheel group can write), so every test that previews a
service with the interpreter running it was refused there, correctly. These tests are about the service, not about
the runner's Python: on such a host, the interpreter running the tests is accepted as it is, and only it. Every
other interpreter, folder and file a test makes for itself is still checked exactly as in a release. On a host whose
interpreter passes the check, nothing is changed.
"""
from __future__ import annotations

import os
import sys
from unittest import mock

from dgc import pip_service


def trust_host_python(test) -> bool:
    """For one test: whether this host's interpreter needed it (and is now accepted, alone)."""
    try:
        pip_service._executable(sys.executable)
        return False
    except Exception:                                    # the host's own layout, never the test's subject
        pass
    host = os.path.realpath(sys.executable)
    real = pip_service._executable

    def executable(value):
        if os.path.realpath(str(value)) == host:
            return pip_service._path(value, "Python executable")
        return real(value)

    patcher = mock.patch.object(pip_service, "_executable", executable)
    patcher.start()
    test.addCleanup(patcher.stop)
    return True
