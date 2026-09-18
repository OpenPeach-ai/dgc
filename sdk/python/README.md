# dgc-sdk

Python facade over a managed `dgc serve` process. Protocol v14 / CLI 0.41.5. Frozen 0.5.2.

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

Install the GitHub release wheel, or from this checkout: `pip install -e sdk/python`.
Do not `pip install dgc`.
