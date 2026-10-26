"""The Python running the tests, as Keep Pips running and the Pips service would run it.

Both refuse an interpreter reached through a folder another user can write (pip_service._safe_chain): a service
must never run code someone else could swap. GitHub's runners keep their Python under /opt, which is writable by
anyone, so every test that previews a service with this interpreter was refused there, correctly. The tests are
about the service, not about the runner's /opt: on such a host they let the check pass for this interpreter's own
folders (where it is called from and where it really is) and nowhere else, so every folder a test makes for itself
is still checked exactly as in a release. On a host whose interpreter passes, nothing is changed.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest import mock

from dgc import pip_service


def trust_host_python(test) -> bool:
    """For one test: whether this host's interpreter needed it (and the check now passes for its folders only)."""
    try:
        pip_service._executable(sys.executable)
        return False
    except Exception:                                    # the host's own layout, never the test's subject
        pass
    own = {Path(sys.executable).parent, Path(os.path.realpath(sys.executable)).parent,
           Path(os.path.realpath(os.path.dirname(sys.executable)))}
    real = pip_service._safe_chain

    def checked(path, *args, **kwargs):
        if Path(path) in own:
            return None
        return real(path, *args, **kwargs)

    patcher = mock.patch.object(pip_service, "_safe_chain", checked)
    patcher.start()
    test.addCleanup(patcher.stop)
    return True
