# dgc-sdk

Python facade over a managed `dgc serve` process. Protocol v14 / CLI 0.41.5. Frozen 0.5.2.

```bash
python3 -m pip install dgc-sdk
```

That installs **this** package (`import dgc_sdk`). It is not PyPI `dgc` (an unrelated clustering library). Until the index has this release, use the GitHub wheel:

```bash
python3 -m pip install \
  "https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.2/dgc_sdk-0.5.2-py3-none-any.whl"
```

```python
from pathlib import Path
from dgc_sdk import DGC, QuestionAnswer, define_tool

with DGC(state_dir=Path("/tmp/dgc-sdk-state"), model="demo-model",
         base_url="http://127.0.0.1:11434/v1") as dgc:
    session = dgc.session(
        cwd=".",
        permissions={"mode": "default", "unhandled": "deny"},
        on_permission=lambda req: "deny",
        on_question=lambda req: {req.questions[0].id: QuestionAnswer(selected=(0,))}
        if req.questions else "dismiss",
    )
    result = session.run("Summarize this repository. Do not edit files.")
    print(result.status, result.final_text)
    session.close()
    restored = dgc.resume(latest=True, cwd=".", permissions={"mode": "default", "unhandled": "deny"})
    print(restored.session_id, restored.history().get("items") and "history ok")
```

From a clone: `pip install -e sdk/python`. The wheel still needs a DGC runtime (`python -m dgc serve`, CLI 0.41.5). Set `inherit_user_state=False` in production.
