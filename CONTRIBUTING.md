# Contributing to DGC

Use Python 3.10 or newer and Node 22 for the editor extension. A normal setup is:

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
cd editors/vscode && npm ci && cd ../..
```

Before opening a pull request, run `DGC_ALLOW_DIRTY=1 scripts/preflight.sh`. The tree is expected to
stay free of credentials, generated VSIX files, model weights, downloaded benchmark datasets, and
benchmark API keys.

Security and correctness are release boundaries, not optional polish. New tools need permission-mode,
canonical-path, failure-status, and transcript tests. Provider changes need request and streaming
contract tests. UI changes should add a webview or protocol regression test where practical.

DGC is licensed under PolyForm Noncommercial 1.0.0. By contributing, you agree that your contribution
is distributed under that license.
