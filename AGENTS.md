# DGC — agent & contributor guide

DGC is an interactive coding-agent CLI for the models you run. Pure Python 3.10+, deps `rich`, `prompt_toolkit`, `requests`. This file is loaded into DGC's own system prompt when you run it inside this repo (dogfooding), and is the orientation for anyone — human or agent — working on it.

## Layout

```
dgc/
  config.py        global config + owner-only secrets, provider presets and model defaults
  llm.py           Responses + Chat Completions adapters, streaming, reasoning and tool fallback
  permissions.py   fail-closed modes/rules plus canonical external-directory approval
  workspace.py     canonical project-boundary resolution used by filesystem consumers
  attachments.py   exact bounded @path text/image input shared by classic CLI and TUI
  codeintel.py     bounded static symbols/diagnostics plus optional one-shot stdio LSP queries
  tools.py         read/map/search/intelligence, atomic patch/edit/write, process, web, skill and memory tools
  agent.py         deterministic tool loop, transcript repair, usage, convergence and compaction
  sessions.py      scoped UUID sessions with atomic private persistence
  editor_protocol.py authoritative editor command/event contract and schema generator
  headless.py      versioned NDJSON service used by editor clients
  acp.py           stable ACP v1 multi-session adapter
  cli.py           REPL, slash commands, banner, streaming render, approvals, `dgc setup` / `dgc doctor`
  memory.py        DGC.md load/add
  skills.py        exact bounded SKILL.md discovery/parsing + adaptive prompt matching
tests/run_tests.py security, protocol, unit and mock-server end-to-end checks
bench/             reproducible same-model harness comparison and edit-quality tooling
editors/vscode/    VS Code/Cursor client, webview and tests
schemas/           generated reviewable wire schemas (regenerate, never hand-edit)
install.sh         curl|bash installer (fetches a tarball, venvs, symlinks `dgc`)
site/              vibedgc.com landing page (index.html) + the files it serves (install.sh, dgc.tar.gz)
```

## Run & test

```bash
python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/python tests/run_tests.py      # must stay green
.venv/bin/dgc doctor                      # checks the configured endpoint
```

## Conventions

- No new runtime dependencies without good reason — the three-dep footprint is a feature.
- Keep provider-specific wire behavior in the provider layer. Official OpenAI uses Responses by
  default, detected Ollama endpoints use native chat, and other compatible/local endpoints use
  Chat Completions unless configured otherwise.
- Permission decisions are evaluated **deny → ask → allow**; never weaken that ordering.
- Every filesystem tool must resolve through `workspace.py`; an external path requires its own approval.
- Arbitrary shell is never intrinsically read-only. Do not add command-string allowlists that can be
  bypassed by redirection, substitutions, wrappers, project configuration, or interpreters.
- Preserve native tool-call/result groups during transcript repair and compaction.
- Keep the CLI's output legible: tool calls, diffs, and approvals are the primary UI.
- Config keys live in `config.py::DEFAULTS`; persist through `Config.set`.

## Releasing

See `docs/RELEASING.md`. Releases come from clean, reviewed Git commits and the tag workflow builds
and attests the exact archive. Never force-push `main`, publish a working-tree snapshot, or rebuild
different bytes for different channels.
