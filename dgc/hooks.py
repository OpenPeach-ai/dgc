"""Lifecycle hooks — run user-configured shell commands at agent events.

Config (~/.dgc/config.json or project .dgc/config.json):
    "hooks": {
      "PreToolUse":  [{"matcher": "bash", "command": "./scripts/guard.sh"}],
      "PostToolUse": [{"command": "./scripts/format.sh"}],
      "UserPromptSubmit": [{"command": "./scripts/log-prompt.sh"}]
    }
The event payload is passed to each command as JSON on stdin. A PreToolUse or
UserPromptSubmit hook that exits non-zero BLOCKS the action (its output is the reason);
PostToolUse output is appended to the tool result as feedback.
"""
from __future__ import annotations

import json
import subprocess


def run_hooks(event: str, payload: dict, config, cwd, timeout: int = 20) -> tuple[bool, str]:
    """Run configured hooks for `event`. Returns (blocked, combined_output)."""
    hooks = (config.get("hooks") or {}).get(event, []) or []
    tool = payload.get("tool")
    blocked = False
    outputs: list[str] = []
    for h in hooks:
        if not isinstance(h, dict):
            continue
        matcher = h.get("matcher")
        if matcher and matcher not in ("*", tool):
            continue
        cmd = h.get("command")
        if not cmd:
            continue
        try:
            p = subprocess.run(cmd, shell=True, input=json.dumps(payload), capture_output=True,
                               text=True, timeout=timeout, cwd=str(cwd), executable="/bin/bash")
        except subprocess.TimeoutExpired:
            outputs.append(f"[hook timed out: {cmd}]")
            continue
        except Exception as e:
            outputs.append(f"[hook error: {e}]")
            continue
        out = ((p.stdout or "") + (p.stderr or "")).strip()
        if p.returncode != 0:
            blocked = True
            outputs.append(out or f"[hook blocked, exit {p.returncode}]")
        elif out:
            outputs.append(out)
    return blocked, "\n".join(outputs)
