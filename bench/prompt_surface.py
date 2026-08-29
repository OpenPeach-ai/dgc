#!/usr/bin/env python3
"""Measure DGC's endpoint-free benchmark prompt and tool-schema request surface.

The probe builds the same timed native-Ollama/auto profile used by ``run_bench.py`` in a temporary
project, activates tools and bundled skills from the canonical exercise prompt, and reports the
provider-visible character/token estimate. It never prepares a model or contacts an endpoint.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import skills as skills_module  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import DEFAULTS, Config  # noqa: E402
from run_bench import PROMPT  # noqa: E402


class _QuietUI:
    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


def _isolated_config(root: Path) -> Config:
    config = object.__new__(Config)
    config.project_root = root
    config.project_dir = root / ".dgc"
    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update({
        "base_url": "http://127.0.0.1:11434",
        "api_key": "benchmark-placeholder",
        "model": "qwen3.8:27b-q4km",
        "api_mode": "ollama",
        "mode": "auto",
        "thinking": "off",
        "suggest": False,
        "logo_animation": False,
        "artifact_autostart": False,
        "background": "inherit",
        "show_reasoning": False,
        "max_turns": 40,
        "context_size": 32_768,
        "turn_budget_s": 585,
        "verify_before_done": True,
        "verify_command": "pytest -q",
        "request_timeout": 300,
        "mcp_servers": {},
        "hooks": {},
    })
    config._stored_secrets = {}
    config._env_secret_keys = set()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


def _section_sizes(prompt: str) -> list[dict[str, int | str]]:
    sections: list[dict[str, int | str]] = []
    title = "prefix"
    lines: list[str] = []
    for line in prompt.splitlines(keepends=True):
        if line.startswith("# "):
            if lines:
                text = "".join(lines)
                sections.append({
                    "name": title, "chars": len(text), "tokens_4c": (len(text) + 3) // 4,
                })
            title, lines = line.strip(), [line]
        else:
            lines.append(line)
    if lines:
        text = "".join(lines)
        sections.append({
            "name": title, "chars": len(text), "tokens_4c": (len(text) + 3) // 4,
        })
    return sections


def run_probe() -> dict:
    with tempfile.TemporaryDirectory(prefix="dgc-prompt-surface-") as raw:
        root = Path(raw)
        # User-installed skills are intentionally excluded: this probe measures the shipped
        # candidate, not ambient state in the operator's HOME. Bundled skills remain discoverable.
        old_user_skills = skills_module.USER_SKILLS
        skills_module.USER_SKILLS = root / ".isolated-user-skills"
        try:
            agent = Agent(_isolated_config(root), _QuietUI())
        finally:
            skills_module.USER_SKILLS = old_user_skills
        try:
            user_prompt = PROMPT.format(
                sol="solution.py", test="solution_test.py", testcmd="pytest -q",
                instr="Implement the documented exercise behavior for all valid inputs.")
            agent._activate_tool_intents(user_prompt, replace=True)
            agent._activate_skill_intents(user_prompt, replace=True)
            system_prompt = agent.system_prompt()
            schemas = agent._tool_schemas()
            compact_schemas = json.dumps(schemas, separators=(",", ":"), default=str)
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]
            return {
                "schema_version": 1,
                "kind": "dgc_prompt_surface",
                "profile": "benchmark_auto_native_ollama",
                "user_chars": len(user_prompt),
                "system_chars": len(system_prompt),
                "system_tokens_4c": (len(system_prompt) + 3) // 4,
                "schema_chars": len(compact_schemas),
                "schema_tokens_4c": (len(compact_schemas) + 3) // 4,
                "estimated_wire_tokens": agent.client.estimate_input_tokens(messages, schemas),
                "system_sections": _section_sizes(system_prompt),
                "active_skills": [skill.name for skill in agent._skill_catalog()],
                "tools": [{
                    "name": schema["function"]["name"],
                    "chars": len(json.dumps(schema, separators=(",", ":"), default=str)),
                } for schema in schemas],
                "interpretation": (
                    "Endpoint-free request-surface estimate; not generation latency or coding quality."
                ),
            }
        finally:
            agent.mcp.stop_all()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit compact JSON")
    args = parser.parse_args(argv)
    report = run_probe()
    print(json.dumps(report, separators=(",", ":"), sort_keys=True)
          if args.json else json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
