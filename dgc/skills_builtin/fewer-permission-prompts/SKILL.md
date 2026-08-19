---
name: fewer-permission-prompts
description: Reduce permission friction — find the safe, read-only tool calls that keep prompting and propose tightly-scoped `/permissions allow` rules, never blanket allows of destructive commands.
---
Reduce permission-prompt friction for this session/project. Focus (optional): $ARGUMENTS

The aim is to auto-allow the SAFE, repetitive calls the user keeps approving, without ever weakening the guardrails on dangerous ones.

1. Find the repeat offenders. Look back over what has been running this session (and the project's typical workflow) for tool calls that prompt again and again but are inherently safe — almost always read-only bash commands and idempotent build/test invocations. Common examples:
   - `git status`, `git diff`, `git log`, `git show`, `git branch`
   - `ls`, `cat`, `grep`/`rg`, `find`, `head`, `tail`, `wc`
   - `npm run test`, `npm run lint`, `npm run build`, `pytest`, `cargo build`, `go test`
   - `node -v`, `python --version`, `which`, `env` reads
   If you're unsure what's been prompting, run `dgc doctor` and check the current rules with `/permissions`.

2. Propose specific, tightly-scoped rules. For each safe pattern, give the exact command to run and explain why it's safe. Use narrow globs, not wildcards on the whole tool:
   - `/permissions allow Bash(git status:*)`
   - `/permissions allow Bash(git diff:*)`
   - `/permissions allow Bash(git log:*)`
   - `/permissions allow Bash(npm run test:*)`
   - `/permissions allow Bash(npm run lint:*)`
   - `/permissions allow Bash(rg:*)` / `Bash(grep:*)`
   Scope to the subcommand (`git status:*`), never to the bare binary (`git:*`) — the latter would also allow `git push`, `git reset --hard`, etc.

3. Hard rules — never propose:
   - a blanket `Bash(*)` or `Bash(git:*)`-style allow,
   - any allow for a destructive/irreversible command: `rm`, `mv` over existing paths, `git push`, `git reset --hard`, `git clean`, `dd`, `chmod -R`, package publishes, `curl … | sh`, force-deploys, DB writes/migrations.
   These should stay in `ask` (or move to `deny`). Suggest `/permissions ask Tool(pattern)` or `/permissions deny Tool(pattern)` if any dangerous pattern is currently over-allowed.

4. Present the list for the user to apply. For each rule give: the `/permissions allow …` command, one line on what it covers, and why it's safe. Let the user confirm — do not silently change their permission config.
