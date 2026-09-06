---
name: refactor
description: Restructure code without changing its behavior — lock behavior with tests first, then apply one small behavior-preserving transform at a time, re-verifying after each. Use for renames, extractions, inlining, moves, and dedup, never for behavior changes.
---
Refactor this without changing behavior. Target (optional): $ARGUMENTS

Refactoring means the code does the SAME thing after as before. Behavior change is a different task — if the request mixes the two, do the behavior change separately and say so.

1. Establish the relevant baseline. Read and run the existing checks for the target. Add characterization coverage when the refactor's risk warrants it and behavior is otherwise unprotected; do not add tests merely to mirror a mechanical edit. Record unrelated pre-existing failures so new regressions can be distinguished. Do not treat an unavailable or unrelated failing suite as proof that all useful work must stop.

2. Plan the transforms. Read the target with read_file. List the individual behavior-preserving moves you'll make — one per line, each ONE of: rename, extract function, inline, move, or dedupe. Put them in the todo tool. Never bundle several into one step.

3. Do ONE transform. Apply exactly one move with edit_file. When you rename or move a symbol, grep for EVERY call site and update all of them in the same step — a missed reference is a break.

4. Re-verify immediately with the relevant tests, type-check, or linter. Read the output. Green → move to the next todo; commit only when the user or repository workflow calls for it, using explicit reviewed paths. Red → inspect the regression and correct or reverse only your transform. Preserve the user's starting content and concurrent edits; broad checkout, reset, or stash commands are not a safe automatic undo.

5. Repeat step 3–4 for each planned transform, one at a time. Small verified steps only.

6. Confirm the surface is unchanged. Grep the public API — exported names, function signatures, return shapes. It must be identical. If something HAD to change, state exactly what and why.

7. Finish with a runtime smoke: invoke the `verify` skill with the skill tool to drive the affected flow end-to-end and confirm it still works.

Rules:
- Resolve failures caused by the refactor before calling it verified. Disclose existing failures and untested behavior; never weaken assertions to manufacture a passing baseline.
- One transform per step, re-verify after each. No behavior changes — if you need one, stop and flag it.
- On a failure, inspect the regression and restore only the affected transform if needed. Preserve pre-existing and concurrent user changes.
- Update every call site in the same step as the rename/move. A stale reference is a bug.
