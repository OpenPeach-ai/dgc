---
name: code-review
description: Review a diff, pull request or set of changes for concrete correctness defects, ranked by impact with file and line evidence.
---
Review the changes at: $ARGUMENTS (a path, "the current diff", a branch, or a PR). If no target is given, review the current uncommitted diff.

Read the ACTUAL changed code — do not review from the description alone.
- For local changes, prefer `git_diff` where available: uncommitted, staged, working, merge-base or commit views. State the selected comparison. Subscription routes use their own inspection tools. Do not weaken plan mode to run shell inspection; Git commands may execute repository filters or other configuration.
- For a PR, establish its current head and base, inspect the actual diff and relevant checks through an available authenticated client. Remote fetching and shell commands retain their normal permissions.
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

Report confirmed findings first, in descending priority. Calibrate severity to actual impact:
- P0 / critical: broadly blocking or irreversible harm, supported without special assumptions.
- P1 / high: a serious broken workflow or security boundary with a concrete reachable trigger.
- P2 / medium: an ordinary functional regression or incorrect edge case.
- P3 / low: a smaller evidenced defect worth fixing.

For each finding, use a concise title and one paragraph with `path:line`, the trigger, observed or
statically established behavior, and impact. Suggest a focused fix only when it helps. A failing
assertion does not automatically make a defect critical. Do not fill every priority category.

Rules:
- Every finding must point at a real line you read. Do not speculate about code you didn't open.
- Do NOT nitpick pure style (formatting, naming preferences, quote style) — the formatter owns that.
- Establish language/runtime behavior before asserting it. If you cannot verify an exception type
  or edge-case result from the code or an allowed check, omit that claim rather than guess.
- Preserve an established contract when suggesting a fix. Do not recommend weakening a regression
  test unless the user explicitly requested changing the behavior it protects.
- Missing tests alone are not defects. Mention only coverage gaps material to the actual change;
  do not add speculative cases for unsupported inputs or unrequested behavior.
- If no concrete bugs are found, say so plainly rather than inventing filler.
- A review-only request produces findings. If the user already requested fixes, implement and verify the confirmed issues within that scope; do not ask again merely because this skill was loaded.
