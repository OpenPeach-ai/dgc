---
name: plan
description: Before a non-trivial or multi-file change, read the real target files and write a bounded ≤6-step plan in plan mode, then execute exactly that — the rail that keeps a change from sprawling. Use whenever the task touches more than one file or is not a mechanical one-liner.
---
Plan the change before touching code. Task/focus (optional): $ARGUMENTS

A plan written before reading is a guess. Ground every step in a file you have actually opened.

1. Restate the task in ONE sentence — the concrete outcome, not the method. If you cannot say it in one sentence, the task is still fuzzy; ask or narrow it first.

2. Read the REAL files first. Use `grep` to find where the behavior lives (symbols, call sites, config keys), then `read_file` each target in full — the files you will edit AND the ones that call them. Do not plan around a file you have not opened.

3. Write the plan as ≤6 numbered steps — do NOT edit any file yet. Each step must name the exact file it touches and a one-line done-check (a test that passes, a value that prints, a symbol that now exists). Order the steps so each builds on the last. (If the user has switched you into plan mode with Shift+Tab, you are already read-only until the plan is approved — good; if not, just hold off on edits until step 6.)

4. Add an explicit "NOT doing" list — the scope guard. Name the tempting nearby changes (refactors, renames, unrelated bugs, extra files) that this task will NOT include. This list is as important as the steps.

5. Present the plan with `present_plan` and wait for approval. Do not write or edit any file while in plan mode.

6. On approval, load the steps into the todo tool (one todo per step) and execute in order with `edit_file`/`write_file`. Mark each todo done only after its done-check passes — run it with bash or `read_file`.

7. If reality contradicts the plan mid-execution (a file isn't shaped as assumed, a step is impossible, scope must grow), STOP. Do not improvise past it. Return to plan mode, revise the affected steps and the NOT-doing list, and re-present before continuing.

Rules:
- No editing before the plan is approved — plan mode is read-only.
- Every step names a real file you have read. No step may reference a file you only assumed exists.
- Never exceed 6 steps; if it needs more, the task is two tasks — plan the first, note the second in NOT-doing.
- When the plan breaks, revise the plan. Never silently work off-plan.
- Keep to the stated scope; a change the plan didn't list does not get made because it was convenient.
