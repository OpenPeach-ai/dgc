---
name: refactor
description: Restructure code without changing its behavior — lock behavior with tests first, then apply one small behavior-preserving transform at a time, re-verifying after each. Use for renames, extractions, inlining, moves, and dedup, never for behavior changes.
---
Refactor this without changing behavior. Target (optional): $ARGUMENTS

Refactoring means the code does the SAME thing after as before. Behavior change is a different task — if the request mixes the two, do the behavior change separately and say so.

1. Lock behavior FIRST. Find and run the existing tests for the target with bash (the test file, the suite, the command). Read the output. If the target code has no tests covering it, you are refactoring blind — invoke the `write-tests` skill with the skill tool to add characterization tests that pin the CURRENT observable behavior, then run them. Do NOT touch the code until you have a GREEN suite.

2. Plan the transforms. Read the target with read_file. List the individual behavior-preserving moves you'll make — one per line, each ONE of: rename, extract function, inline, move, or dedupe. Put them in the todo tool. Never bundle several into one step.

3. Do ONE transform. Apply exactly one move with edit_file. When you rename or move a symbol, grep for EVERY call site and update all of them in the same step — a missed reference is a break.

4. Re-verify immediately. Run the tests, the type-check, and the linter with bash. Read the output. Green → commit this step with git via bash and move to the next todo. RED → you broke behavior: undo THIS step with git via bash (`git checkout -- <files>` or `git stash`), do not stack fixes on a broken tree. Return to a green state before trying again.

5. Repeat step 3–4 for each planned transform, one at a time. Small verified steps only.

6. Confirm the surface is unchanged. Grep the public API — exported names, function signatures, return shapes. It must be identical. If something HAD to change, state exactly what and why.

7. Finish with a runtime smoke: invoke the `verify` skill with the skill tool to drive the affected flow end-to-end and confirm it still works.

Rules:
- NEVER refactor on red. No green suite → write characterization tests first (`write-tests` skill).
- One transform per step, re-verify after each. No behavior changes — if you need one, stop and flag it.
- On a failure, revert that single step with git (`git checkout`/`git stash`). Do not pile fixes onto a broken tree.
- Update every call site in the same step as the rename/move. A stale reference is a bug.
