---
title: DGC SDK
description: Embed the DGC coding harness in applications and CI. Free, local, Apache-2.0. Not a hosted product.
---

# DGC SDK

The SDK is **free and local**. You do not pay DGC to embed it. Optional `Pricing` on a client is only so **your** app can attribute **model-token** spend (what a department’s LLM calls cost). It is not a fee for the SDK.

Current cut: **0.5.0**, protocol **v14**, CLI **0.41.3**, Linux.

```bash
python3 -m pip install dgc-sdk
# or from the repository: pip install -e sdk/python
```

Do not `pip install dgc`. That PyPI name is an unrelated clustering paper package.

```python
from dgc_sdk import DGC, Pricing, RuntimePolicy

dgc = DGC(
    state_dir="/var/lib/myapp/dgc",
    inherit_user_state=False,
    department="platform",
    pricing=Pricing(input_per_million=0.0, output_per_million=0.0),
    policy=RuntimePolicy(network="deny"),
)
session = dgc.session(cwd="/path/to/workspace", permissions={"mode": "default", "unhandled": "deny"})
result = session.run("Summarize this repository. Do not edit files.")
print(result.status, result.usage)
print(dgc.usage_report(department="platform"))
```

Isolation: each `DGC` owns one `state_dir` HOME. Host `~/.dgc` is not used unless you pass `inherit_user_state=True` (do not, in production embeds).

Source: [github.com/OpenPeach-ai/dgc](https://github.com/OpenPeach-ai/dgc) (`sdk/`).
