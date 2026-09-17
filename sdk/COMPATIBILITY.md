# DGC SDK compatibility

| SDK | Protocol | CLI | Python | Node | Host proven |
| --- | --- | --- | --- | --- | --- |
| **0.5.0** | **v14** | **0.41.3** | **≥ 3.10** | **≥ 22** (strip-types) | **Linux** |

macOS and WSL are unproven. Native Windows is experimental.

The SDK launches `dgc serve` from this checkout (`DGC_PYTHON` → `.venv/bin/python`). It is not the unrelated PyPI package named `dgc`.

Install from this repository until a public index cut exists:

```bash
python3 -m pip install -e sdk/python
# Node: import sdk/typescript (package @vibedgc/sdk)
```
