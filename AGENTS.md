# DGC — agent & contributor guide

DGC is an interactive coding-agent CLI for the models you run. Pure Python 3.10+, deps `rich`, `prompt_toolkit`, `requests`. This file is loaded into DGC's own system prompt when you run it inside this repo (dogfooding), and is the orientation for anyone — human or agent — working on it.

## Layout

```
dgc/
  config.py        global (~/.dgc/config.json) + project (.dgc/) config, PROVIDERS presets
  llm.py           OpenAI-compatible streaming client; <think> tags; native + text tool-call fallback
  permissions.py   modes (default/acceptEdits/plan/auto), allow/ask/deny rules, compound-command matching
  tools.py         tool schemas + executors (read/write/edit/bash/glob/grep/web_fetch/todo/skill/…)
  agent.py         system prompt, tool loop, thinking levels, context compaction
  cli.py           REPL, slash commands, banner, streaming render, approvals, `dgc setup` / `dgc doctor`
  memory.py        DGC.md load/add
  skills.py        SKILL.md discovery/parsing
tests/run_tests.py units + mock-server end-to-end
install.sh         curl|bash installer (fetches a tarball, venvs, symlinks `dgc`)
site/              daguccicode.com landing page (index.html) + the files it serves (install.sh, dgc.tar.gz)
```

## Run & test

```bash
python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/python tests/run_tests.py      # must stay green
.venv/bin/dgc doctor                      # checks the configured endpoint
```

## Conventions

- No new runtime dependencies without good reason — the three-dep footprint is a feature.
- The endpoint contract is **OpenAI-compatible** (`/v1/chat/completions`, `/v1/models`). New providers = a preset in `config.py::PROVIDERS`, not new client code.
- Permission decisions are evaluated **deny → ask → allow**; never weaken that ordering.
- Keep the CLI's output legible: tool calls, diffs, and approvals are the primary UI.
- Config keys live in `config.py::DEFAULTS`; persist through `Config.set`.

## Releasing

`install.sh` pulls `dgc.tar.gz` from `DGC_BASE_URL` (default `https://daguccicode.com`).
Releases are cut by the maintainer from the source repo.
