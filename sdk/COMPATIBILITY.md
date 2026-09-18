# DGC SDK compatibility

| SDK | Protocol | CLI | Python | Node | Host proven |
| --- | --- | --- | --- | --- | --- |
| **0.5.3** | **v14** | **0.41.6** | **≥ 3.10** | **≥ 22** | **Linux** |
| 0.5.2 | v14 | 0.41.5 | ≥ 3.10 | ≥ 22 (source only, strip-types) | Linux |

macOS and WSL are unproven. Native Windows is experimental: custom tools need Unix sockets.

The SDK launches `python -m dgc serve` from a DGC CLI install: the Python named by `DGC_PYTHON`,
the `runtime=` you pass, or its own interpreter when that can import `dgc`. It is not the
unrelated PyPI package named `dgc`.

0.5.2 on PyPI was built from a later commit than tag `sdk-v0.5.2` and differs from the wheel on
that GitHub release (one comment line and the README). From 0.5.3 the PyPI files and the GitHub
release assets are the same bytes, built by one workflow from the tag.

```bash
python3 -m pip install dgc-sdk==0.5.3
npm install https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.3/vibedgc-sdk-0.5.3.tgz
```
