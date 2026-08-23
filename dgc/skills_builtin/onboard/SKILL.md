---
name: onboard
description: Before changing an unfamiliar codebase, build an accurate mental model of it — what it does, how it builds/tests/runs, and the files that matter — and optionally save that map to DGC.md. Use at the START of work in a repo you don't yet understand.
---
Build a mental model of this codebase before touching it. Focus (optional): $ARGUMENTS

Do NOT edit code. Your job is to understand and report, then offer to save the map.

1. Survey top-down. With bash, `ls` the repo root and `git log --oneline -10`. Then read_file on the orientation docs if present: README, AGENTS.md, DGC.md, CONTRIBUTING, docs/. Read the build manifests: package.json, pyproject.toml/setup.py, go.mod, Cargo.toml, pom.xml, Makefile. These name the languages, frameworks, dependencies, and the real build/test/run commands (check `scripts`, `[tool.*]`, Makefile targets).

2. Map the layout. `ls` the main source dir. Identify the seams: the entry point (main/index/cli/server bootstrap), where routes or handlers live, the core domain logic, and where config + secrets are read (grep with bash for `env`, `process.env`, `os.environ`, `getenv`, `config`). Note the test dir and how tests are laid out.

3. Trace ONE representative flow end-to-end. Pick a real path (e.g. a CLI command, an HTTP request, a core function). Start at the entry point with read_file, then follow the calls: grep for each function/handler name with bash, read_file the definition, repeat until you reach the domain logic and back out. Keep it to one flow — depth over breadth.

4. Nail down the exact commands. From the manifests, state the precise install, build, test, and run commands (not "npm test" if it's really `pnpm test:unit`). If unsure, read the scripts/Makefile — do not guess.

5. Report a one-screen orientation: (a) what the project does in 1-2 lines, (b) the directory layout, (c) the exact build/test/run commands, (d) the 5-10 files that matter, each with a one-line role, (e) the safe place to start for the task at hand.

6. Offer to persist it: ask if you should write the orientation to DGC.md with write_file (DGC reads DGC.md/AGENTS.md as memory). If yes, write a concise version — commands, key files, gotchas — not a wall of prose.

Rules:
- Read before you claim. Every file and command you cite must come from a file you actually read, never memory or assumption.
- Do NOT edit any code, config, or manifest in this skill — read_file and grep only; write_file only DGC.md, and only when the user agrees.
- Trace exactly ONE flow deeply; resist mapping everything. If the repo is huge, scope to $ARGUMENTS.
- State the real build/test/run commands verbatim from the manifests; if you cannot find them, say so plainly.
