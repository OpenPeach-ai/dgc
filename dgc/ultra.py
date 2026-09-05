"""DGC Ultra execution profile.

Ultra is an orchestration policy, not a provider-specific reasoning enum.  Native routes use the
deepest portable DGC effort (xhigh); delegated CLIs receive their strongest supported effort plus
the same bounded, permission-preserving multi-agent guidance.
"""
from __future__ import annotations


def enabled(config) -> bool:
    return bool(config.get("ultra_mode", False))


def worker_limit(config) -> int:
    try:
        return max(1, min(8, int(config.get("max_parallel_tasks", 4))))
    except (TypeError, ValueError):
        return 4


def native_effort(config, current: str) -> str:
    """Raise a native turn to DGC's deepest portable wire-level reasoning effort."""
    if not enabled(config):
        return current
    order = {"off": 0, "low": 1, "medium": 2, "high": 3, "xhigh": 4}
    return "xhigh" if order.get(str(current), 0) < order["xhigh"] else str(current)


def delegated_effort(config, engine_key: str, current: str, supports_effort: bool) -> str:
    """Select the strongest vendor effort without leaking an unsupported value to local APIs."""
    if not enabled(config) or not supports_effort:
        return current
    # Ultra is DGC's orchestration profile, not a vendor wire enum. Codex exposes Extra High as
    # ``xhigh``; sending a made-up ``ultra`` config value can survive startup validation only to
    # fail when the selected model is called. Other supported effort-flag CLIs use ``max`` as
    # DGC's strongest existing pass-through.
    return "xhigh" if engine_key == "codex" else "max"


def delegated_prompt(config, prompt: str, mode: str) -> str:
    """Add trusted Ultra policy only to the vendor wire prompt, never the persisted user message."""
    if not enabled(config):
        return prompt
    workers = worker_limit(config)
    return (
        "<dgc-ultra-policy>\n"
        "DGC Ultra is active for this turn. Use extended reasoning and proactively split genuinely "
        f"independent work into parallel sub-agents when that improves quality or latency (up to {workers}). "
        "Keep coupled edits serial, reconcile all child results, and verify the integrated result before "
        "finishing. Do not delegate trivial work merely to use the quota. The current DGC permission mode "
        f"remains {mode}; Ultra does not grant additional filesystem, shell, or network authority.\n"
        "</dgc-ultra-policy>\n\n" + prompt
    )


def summary(config) -> str:
    return f"Ultra · xhigh reasoning · up to {worker_limit(config)} parallel agents"
