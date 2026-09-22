# dgc-sdk

Run the DGC coding agent inside your own Python application or CI job. Version **0.6.2**, editor
protocol v14, pairs with DGC CLI **0.43.1**. Python 3.10+, proven on Linux.

```bash
python3 -m pip install dgc-sdk==0.6.2
```

This installs `import dgc_sdk`. It is not the unrelated PyPI project `dgc`.

The SDK drives a `dgc serve` process from a DGC CLI install, which it finds on its own (`dgc` on
`PATH`, `~/.local/bin/dgc`, or the installer's versions directory). Install the CLI:

```bash
curl -fsSL https://vibedgc.com/install.sh | bash
```

To pin a different install, set `DGC_PYTHON` to its Python, for example
`export DGC_PYTHON="$(dirname "$(readlink -f "$(command -v dgc)")")/python"`.

Point `DGC_MODEL` and `DGC_BASE_URL` at an OpenAI-compatible endpoint (for example a local Ollama
at `http://127.0.0.1:11434/v1`), then run this from the repository you want summarized:

```python
import os
import tempfile

from dgc_sdk import DGC

with DGC(
    state_dir=tempfile.mkdtemp(prefix="dgc-sdk-"),
    model=os.environ["DGC_MODEL"],          # for example "qwen3:8b"
    base_url=os.environ["DGC_BASE_URL"],    # for example "http://127.0.0.1:11434/v1"
    api_key=os.environ.get("DGC_API_KEY"),  # only when the endpoint needs a key
) as dgc:
    session = dgc.session(cwd=".", permissions={"mode": "plan", "unhandled": "deny"})
    result = session.run("Summarize this repository in two sentences. Do not edit files.")
    print(result.status, result.final_text)
    if result.error:
        print("error:", result.error)
```

It prints `completed` and the summary. Each `DGC` client keeps its conversations, checkpoints and
logs in `state_dir`, an isolated HOME; your own `~/.dgc` is not touched, and an SDK-created
temporary `state_dir` is removed on `close()`.

For untrusted input (a pull request, a cloned repo) the workspace cannot grant the session
capabilities: its own `.dgc/permissions.json` allow rules and `.dgc/agents` are ignored unless you
pass `trust_workspace=True`. Add a `RuntimePolicy` to sandbox the shell and confine the file tools,
and see the security model in [docs/SDK.md](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.6.2/docs/SDK.md#security-model).

- Guide and full API reference: [docs/SDK.md](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.6.2/docs/SDK.md)
- Runnable examples: [examples/sdk](https://github.com/OpenPeach-ai/dgc/tree/sdk-v0.6.2/examples/sdk)
- Changes: [sdk/CHANGELOG.md](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.6.2/sdk/CHANGELOG.md)
- Verifying this package against its GitHub release: [docs/SDK.md#verifying-a-release](https://github.com/OpenPeach-ai/dgc/blob/sdk-v0.6.2/docs/SDK.md#verifying-a-release)

Licensed under Apache-2.0.
