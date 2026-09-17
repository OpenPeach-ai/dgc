# SDK examples (local)

These run against a DGC checkout. They are not published packages.

```bash
PYTHONPATH=sdk/python:. python3 examples/sdk/hello_run.py /path/to/workspace
PYTHONPATH=sdk/python:. python3 examples/sdk/app_session.py /path/to/workspace
PYTHONPATH=sdk/python:. python3 examples/sdk/resume_run.py /path/to/workspace
PYTHONPATH=sdk/python:. python3 examples/sdk/ci_review.py /path/to/checkout
PYTHONPATH=sdk/python:. python3 examples/sdk/ci_edit.py /path/to/checkout
node --experimental-strip-types examples/sdk/hello_run.mjs /path/to/workspace

# Local workbench (loopback UI: stream / approve / deny / stop / resume)
PYTHONPATH=sdk/python:. python3 examples/sdk/workbench.py --host 0.0.0.0 --port 8765 --mock --workspace /path/to/workspace
# open http://<this-host>:8765/ on the LAN (loopback still works)
```

CI recipes print JSON. Exit codes: 0 accepted, 1 rejected, 2 usage, 3 permission-blocked, 4 timeout, 5 failed.
