---
name: code-review
description: Review a diff, PR, or set of changes for correctness bugs first, then reuse/simplification/efficiency cleanups — ranked by severity with file:line.
---
Review the changes at: $ARGUMENTS (a path, "the current diff", a branch, or a PR). If no target is given, review the current uncommitted diff.

Read the ACTUAL changed code — do not review from the description alone.
- If the target is a diff/PR/branch, run `git diff`, `git diff --stat`, `git log -p -1`, or `git show <ref>` with bash to see exactly what changed.
- If the target is a path, use glob/grep to locate the files and read_file to open them.
- For each nontrivial change, read enough surrounding context (callers, callees, types) to judge it. Use grep to find every call site of a changed function or signature.

Then reason about how the code could actually FAIL. Work through concrete scenarios, not vibes:
- Off-by-one, boundary, and empty/null/None cases; missing early returns.
- Error paths: unhandled exceptions, ignored return codes, swallowed errors, partial writes.
- Concurrency/ordering: races, await/async misuse, shared mutable state.
- Resource handling: unclosed files/handles/connections, leaks, unbounded growth.
- Security: unvalidated input, injection, path traversal, secrets in code/logs.
- Contract drift: a changed signature/return shape whose callers weren't updated (grep to confirm).
- Logic that contradicts the surrounding code's existing invariants.

Only AFTER correctness, look at quality:
- Duplication that could reuse an existing helper (grep to confirm the helper exists).
- Needless complexity that could be simplified without changing behavior.
- Obvious inefficiency (redundant work in a loop, repeated I/O, N+1 queries).

Report findings ranked by severity: Critical, then Major, then Minor. For each finding give:
- `path:line` — a one-line title
- what breaks and the concrete scenario that triggers it
- a specific suggested fix

Rules:
- Every finding must point at a real line you read. Do not speculate about code you didn't open.
- Do NOT nitpick pure style (formatting, naming preferences, quote style) — the formatter owns that.
- If you find nothing serious, say so plainly rather than inventing filler.
- Do NOT edit files during review. Offer to apply fixes only if the user asks; then make the edits with edit_file.
