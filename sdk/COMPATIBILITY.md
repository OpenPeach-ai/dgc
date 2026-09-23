# DGC SDK compatibility

| SDK | Protocol | CLI | Python | Node | Host proven |
| --- | --- | --- | --- | --- | --- |
| **0.6.8** | **v14** | **0.43.4** | **≥ 3.10** | **≥ 22** | **Linux** |
| 0.6.7 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.6 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.5 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.4 | v14 | 0.43.4 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.3 | v14 | 0.43.2 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.2 | v14 | 0.43.1 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.1 | v14 | 0.43.0 | ≥ 3.10 | ≥ 22 | Linux |
| 0.6.0 | v14 | 0.42.0 | ≥ 3.10 | ≥ 22 | Linux |
| 0.5.3 | v14 | 0.41.6 | ≥ 3.10 | ≥ 22 | Linux |
| 0.5.2 | v14 | 0.41.5 | ≥ 3.10 | ≥ 22 (source only, strip-types) | Linux |

macOS and WSL are unproven. Native Windows is experimental: custom tools need Unix sockets.

The SDK launches `dgc serve` from a DGC CLI install: the `runtime=` you pass, the Python named by
`DGC_PYTHON`, its own interpreter when that can import `dgc`, or the installed CLI (`dgc` on
`PATH`, `~/.local/bin/dgc`, the installer's versions directory). A runtime that speaks another
protocol is skipped with the reason; when none speaks v14, `DGC()` raises `DGCProtocolError`
saying whether the CLI or dgc-sdk needs updating. It is not the unrelated PyPI package named
`dgc`.

0.5.2 on PyPI was built from a later commit than tag `sdk-v0.5.2` and differs from the wheel on
that GitHub release (one comment line and the README). From 0.5.3 the PyPI files and the GitHub
release assets are the same bytes, built by one workflow from the tag.

```bash
python3 -m pip install dgc-sdk==0.6.8
npm install @vibedgc/sdk
```
