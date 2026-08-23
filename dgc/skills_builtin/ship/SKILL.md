---
name: ship
description: Turn a finished, verified change into clean git history and a PR — self-review the diff, stage deliberately, write a conventional commit, and open the PR. Commit/push only when the user asks.
---
Ship the current change as reviewable history. Focus (optional): $ARGUMENTS

Only do this when the user asked you to commit, push, or open a PR. Otherwise stop and report the change is ready.

1. See the whole change. Run `git status` and `git diff` (and `git diff --staged`) with bash. Read EVERY hunk as a reviewer, not as the author. For anything nontrivial, invoke the `code-review` skill first and address what it finds before committing.

2. Clean the diff. Grep the changed files for debug leftovers and secrets: `grep -nE 'console\.log|println!|dbg!|TODO|FIXME|API_KEY|SECRET|password|token' <files>`. Remove stray debug output with edit_file. If any real credential is staged, STOP and tell the user — never commit it.

3. Branch if needed. Run `git branch --show-current`. If it prints `main` or `master`, create a feature branch first: `git checkout -b <type>/<short-topic>`. Never commit straight to the default branch.

4. Stage DELIBERATELY. Add only the files that belong in this change, by path: `git add <path> ...`. Never `git add -A` or `git add .`. If the diff does more than one logical thing, make more than one commit — stage and commit each part separately.

5. Commit with a conventional message: `type(scope): imperative summary` on line 1 (≤72 chars; type ∈ feat|fix|refactor|docs|test|chore|perf). Add a blank line, then a body that explains WHY the change was made, not what the diff already shows. Use `git commit -m "..." -m "..."` via bash.

6. Open the PR (only if the user asked to push/PR). Push with `git push -u origin HEAD`, then `gh pr create` with a body in three parts: Problem, Approach, How verified. Print the PR URL as your final output.

Rules:
- Commit or push ONLY when the user explicitly asked; a finished change is not consent.
- Never `git add -A`/`git add .`, never `git commit -a`, never `git push --force`.
- One logical change per commit — split the work rather than bundling unrelated edits.
- No secrets, no debug leftovers, no commented-out code in what you stage.
- Do not amend or rebase commits you did not create in this session.
