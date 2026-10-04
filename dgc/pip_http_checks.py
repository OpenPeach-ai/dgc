"""Fixed loopback HTTP probe, separate from network-free shell execution.

The controller validates a reserved invocation; it is never resolved on PATH.
The worker uses no project code, proxy settings, credentials or redirect handler.
Only status and a bounded byte count are retained, never response body data.
"""
from __future__ import annotations
import re
from urllib.parse import urlsplit
from .workspace_registry import RegistryError

NETWORK = 'loopback_http_v1'
PROBE = 'dgc-http-check'
MAX_BODY = 65536
WALL_SECONDS = 10


def validate_test(test):
    def fail():
        raise RegistryError('invalid_execution', 'Local HTTP checks require ["dgc-http-check", "http://127.0.0.1:PORT/path", "200"] and cwd=".". Use an explicit unprivileged port and one expected status. No query, credentials, redirects or external hosts.')
    if type(test) is not dict or set(test) != {'argv', 'cwd'} or test['cwd'] != '.': fail()
    argv = test['argv']
    if type(argv) is not list or len(argv) != 3 or not all(type(a) is str for a in argv) or argv[0] != PROBE: fail()
    url, status = argv[1:]
    if len(url) > 1024 or re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{3,4})/[A-Za-z0-9_./-]*', url) is None: fail()
    parts = urlsplit(url)
    try: port = parts.port
    except ValueError: fail()
    if not 1024 <= port <= 65535 or '..' in parts.path or '//' in parts.path or re.fullmatch('[1-5][0-9]{2}', status) is None: fail()
    return {'argv': list(argv), 'cwd': '.'}


# Executed with isolated system Python and an empty, explicitly supplied env.
# All authority is in this fixed program, never source copied from the project.
# macOS rejects a finite RLIMIT_AS; there the runner's sampled footprint guard bounds memory.
WORKER = r'''
import http.client, resource, socket, sys
from urllib.parse import urlsplit
if sys.platform.startswith('linux'):
    resource.setrlimit(resource.RLIMIT_AS, (536870912, 536870912))
resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
p = urlsplit(sys.argv[1])
conn = http.client.HTTPConnection('127.0.0.1', p.port, timeout=3)
try:
    conn.request('GET', p.path, headers={'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'close', 'User-Agent': 'DGC-Pulse-local-check/1'})
    response = conn.getresponse()
    declared = response.length
    if declared is not None and declared > 65536:
        print('FAIL: declared response body exceeds 65536 bytes; body discarded.')
        sys.exit(1)
    total = 0
    while total <= 65536:
        chunk = response.read1(min(8192, 65537-total))
        if not chunk: break
        total += len(chunk)
    if total > 65536:
        print('FAIL: response body exceeds 65536 bytes; body discarded.')
        sys.exit(1)
    if response.length not in (None, 0):
        print('FAIL: truncated response body; body discarded.')
        sys.exit(1)
    passed = response.status == int(sys.argv[2])
    print(('PASS' if passed else 'FAIL') + ': HTTP ' + str(response.status) + '; expected ' + sys.argv[2] + '; body bytes ' + str(total) + '; body discarded. Redirects are not followed.')
    sys.exit(0 if passed else 1)
except (OSError, http.client.HTTPException, ValueError):
    print('FAIL: local HTTP connection failed, timed out, or returned an invalid response.')
    sys.exit(1)
finally:
    conn.close()
'''
