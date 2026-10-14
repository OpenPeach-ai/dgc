"""`python -m dgc.troupe_job SPEC`: one scheduled troupe (dgc/troupe_routines.py), run to its end in a process of its
own on a snapshot of a project's committed code, with the user's DGC home and model.

SPEC is a JSON file: {root, order, items, out}. The answer goes to `out`: {report, tokens, state}. Nobody is there to
ask, so the agents are unattended (a step that would ask is refused) and the folder runs in `default` mode: a scheduled
troupe only reads.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def run(spec: dict) -> dict:
    from . import troupe_agent
    from .agent import Agent
    from .cli import UI
    from .config import Config
    config = Config(project_root=Path(spec["root"]))
    config.hold("mode", "default")
    ui = UI()
    ui.non_interactive = True
    agent = Agent(config, ui)
    try:
        report = troupe_agent.start(agent, {**spec["order"], "items": list(spec["items"])}, None)
    finally:
        try:
            agent.mcp.stop_all()
        except Exception:                        # noqa: BLE001 -- the report is what matters now
            pass
    runs = list(getattr(agent, "_troupes", {}).values())
    tokens = int(agent.usage_totals.get("input_tokens", 0) or 0) + int(agent.usage_totals.get("output_tokens", 0) or 0)
    return {"report": report, "tokens": tokens, "state": runs[-1].state if runs else "failed"}


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python -m dgc.troupe_job SPEC", file=sys.stderr)
        return 2
    spec = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    try:
        result = run(spec)
    except Exception as error:                   # noqa: BLE001 -- said in the Pip's chat, not lost in a log
        result = {"report": f"The troupe could not run: {type(error).__name__}: {error}"[:600], "tokens": 0,
                  "state": "failed"}
    Path(spec["out"]).write_text(json.dumps(result), encoding="utf-8")
    return 0 if result["state"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
