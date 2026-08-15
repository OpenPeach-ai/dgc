---
name: commit
description: Stage and commit current changes with a conventional commit message. Use when the user asks to commit.
---

Create a git commit for the current changes. $ARGUMENTS

1. Run `git status` and `git diff` / `git diff --staged` to understand what changed.
2. Stage the relevant files (never `git add -A` blindly; skip secrets and build output).
3. Write a conventional commit message: `type(scope): subject`, imperative, ≤72 chars.
4. Commit and show the result with `git log -1 --stat`.
