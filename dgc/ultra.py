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
    if engine_key == "codex" and current == "max":
        current = "xhigh"
    if not enabled(config) or not supports_effort:
        return current
    # Ultra is DGC's orchestration profile, not a vendor wire enum. Codex exposes Extra High as
    # ``xhigh``; sending a made-up ``ultra`` config value can survive startup validation only to
    # fail when the selected model is called. Other supported effort-flag CLIs use ``max`` as
    # DGC's strongest existing pass-through.
    return "xhigh" if engine_key == "codex" else "max"


def delegated_prompt(config, prompt: str, mode: str) -> str:
    """Apply shared response guidance and optional Ultra policy on the vendor wire only."""
    from .agent import _tool_intents
    from .goals import AUTO_RESUME_MARKER, CYCLE_MARKER
    from .presentation import delegated_presentation
    # A goal cycle's prompt is DGC's, carrying the whole objective, so it is never the user's ask.
    asks_for_options = ("options" in _tool_intents(prompt) and CYCLE_MARKER not in prompt
                        and AUTO_RESUME_MARKER not in prompt)
    prompt = delegated_presentation(prompt)
    if asks_for_options:
        # The vendor CLI runs headless, so DGC's picker (and the CLI's own question tool) cannot
        # reach the user. Said only when the user asked to choose; otherwise nothing is added.
        prompt = ("<dgc-options-note>\nThe user asked to choose from options. DGC's options picker "
                  "is not available while a subscription CLI runs this turn, and no question tool "
                  "can reach the user here. List the options as a numbered list and ask the user "
                  "to reply with their choice.\n</dgc-options-note>\n\n" + prompt)
    if not enabled(config):
        return prompt
    workers = worker_limit(config)
    return (
        "<dgc-ultra-policy>\n"
        "DGC Ultra is an orchestration profile, not a token-saving mode. It stays on for fast "
        "cloud models as well as local ones. Split independent work into parallel sub-agents "
        f"(up to {workers}) instead of doing those chunks in the parent. Delegate whenever the "
        "turn has more than one independent chunk (map more than one area, backend vs UI, "
        "unrelated bugs, a long test/deploy/SSH battery beside other work). Keep coupled edits "
        "serial, reconcile all child results, and verify the integrated result before finishing. "
        "For work that will take more than a short wait and does not block the rest of this "
        "turn, set task.background true so the child continues after you finish speaking; DGC "
        "starts a new turn when it lands. Do not keep independent work in the parent to save "
        "tokens or round-trips. Skip sub-agents only for a short question or a single coupled "
        f"file edit. The current DGC permission mode remains {mode}; Ultra does not grant "
        "additional filesystem, shell, or network authority.\n"
        "</dgc-ultra-policy>\n\n" + prompt
    )


def summary(config) -> str:
    return f"Ultra · xhigh reasoning · up to {worker_limit(config)} parallel agents"
