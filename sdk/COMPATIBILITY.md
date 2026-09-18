# DGC SDK compatibility

Frozen cut: **0.5.2** (`sdk-v0.5.2`).

| SDK | Protocol | CLI | Python | Node | Host proven |
| --- | --- | --- | --- | --- | --- |
| **0.5.2** | **v14** | **0.41.5** | **≥ 3.10** | **≥ 22** (strip-types) | **Linux** |

macOS and WSL are unproven. Native Windows is experimental.

The SDK launches `dgc serve` from this checkout (`DGC_PYTHON` → `.venv/bin/python`). It is not the unrelated PyPI package named `dgc`.

```bash
python3 -m pip install \
  "https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.2/dgc_sdk-0.5.2-py3-none-any.whl"
python3 -m pip install -e sdk/python
# Node: import sdk/typescript (package @vibedgc/sdk, not on npm yet)
```
