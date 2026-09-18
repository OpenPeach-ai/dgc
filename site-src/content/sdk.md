---
title: DGC SDK
description: Embed the DGC coding harness in applications and CI. Free, local, Apache-2.0. Not a hosted product.
---

# DGC SDK

The SDK is **free and local**. You do not pay DGC to embed it. Optional `Pricing` on a client is only so **your** app can attribute **model-token** spend (what a department’s LLM calls cost). It is not a fee for the SDK.

Frozen cut: **0.5.2**, protocol **v14**, CLI **0.41.3**, Linux. GitHub tag [`sdk-v0.5.2`](https://github.com/OpenPeach-ai/dgc/releases/tag/sdk-v0.5.2) (not `v0.5.2`, which is a historical CLI tag).

```bash
python3 -m pip install \
  "https://github.com/OpenPeach-ai/dgc/releases/download/sdk-v0.5.2/dgc_sdk-0.5.2-py3-none-any.whl"
```

Or from a clone of this repository:

```bash
python3 -m pip install -e sdk/python
```

The wheel is the embed client. It still needs a DGC runtime that can run `python -m dgc serve` (this repository or CLI **0.41.3**). Set `DGC_PYTHON` if `python3` cannot import `dgc`.

Do not `pip install dgc`. That PyPI name is an unrelated clustering paper package. This SDK is not on PyPI or npm yet.

```python
from dgc_sdk import DGC, Pricing, RuntimePolicy

dgc = DGC(
    state_dir="/var/lib/myapp/dgc",
    inherit_user_state=False,
    department="platform",
    pricing=Pricing(input_per_million=0.0, output_per_million=0.0),
    policy=RuntimePolicy(network="deny", deny_tools=("write_file",)),
)
session = dgc.session(cwd="/path/to/workspace", permissions={"mode": "default", "unhandled": "deny"})
result = session.run("Summarize this repository. Do not edit files.")
print(result.status, result.usage)
print(dgc.usage_report(department="platform"))
```

Isolation: each `DGC` owns one `state_dir` HOME. Host `~/.dgc` is not used unless you pass `inherit_user_state=True` (do not, in production embeds).

`RuntimePolicy(deny_tools=("write_file",))` is compiled into isolated deny rules and holds in every permission mode, including `auto`. Write-tool denies also block bash file-writes (redirects, `tee`, `cp` / `mv`).

TypeScript lives in `sdk/typescript` (`@vibedgc/sdk`, Node ≥ 22 with strip-types). Usage, audit, and retry helpers are Python-first.

Source: [github.com/OpenPeach-ai/dgc](https://github.com/OpenPeach-ai/dgc) (`sdk/`).
