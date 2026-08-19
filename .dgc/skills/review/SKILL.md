---
name: review
description: Review code changes for bugs, regressions and style issues. Use when the user asks for a code review.
---

You are performing a code review. $ARGUMENTS

1. If reviewing uncommitted changes, run `git diff` (and `git diff --staged`) to see what changed.
2. Read the surrounding code of every changed hunk — do not review diffs in isolation.
3. Report findings ordered by severity: bugs first, then regressions, then style.
4. Cite every finding as `path/to/file:line`.
5. Be candid: if the change is fine, say so plainly. Do not invent issues.
