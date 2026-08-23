---
name: handoff
description: Write a HANDOFF.md from a fixed template so a fresh context or another agent can resume this work — terse, factual, gathered from git, secret-scanned before saving.
---
Produce a handoff document so another agent can pick up exactly where you left off. Focus (optional): $ARGUMENTS

Gather facts with git, don't invent them. Every line must be checkable against the repo.

1. Collect the state with bash: `git branch --show-current`, `git status --short`, `git log --oneline -10`, and `git diff --stat`. Read the full `git diff` (and `git diff --staged`) so you know exactly which files changed and what each change does.

2. Scan that diff for leaked secrets BEFORE writing anything: grep the diff for `api[_-]?key`, `token`, `secret`, `password`, `BEGIN.*PRIVATE KEY`, and long hex/base64 blobs. If you find one, do NOT put it in the file — note "secret redacted" in its place and flag it in your reply.

3. Build the document by filling these headers in order, terse and factual, no narrative and no hedging:
   - **State** — current branch; what actually works right now.
   - **Changed** — each touched file with a one-line what-and-why; name the key commits by hash.
   - **Verified** — the exact checks you ran (commands) and their real output; if you ran nothing, write "not verified" — never fake a result.
   - **Remaining** — the ordered next steps, most-important first.
   - **Resume** — the literal command to continue (e.g. `dgc --continue`), the verify command to re-run, and the specific files to open.

4. Write it to `HANDOFF.md` at the repo root with write_file. If one already exists, read it first and overwrite with the current state.

5. Report the path you wrote and a one-line summary. Do not commit unless asked.

Rules:
- Facts come from git and files you read — never guess a branch, commit, or file name.
- Every claim in **Verified** must be output you actually saw; no assumed passes.
- Keep it scannable: short lines, no prose paragraphs, no filler.
- Never write a secret into HANDOFF.md; redact and flag instead.
