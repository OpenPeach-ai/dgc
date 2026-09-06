---
name: loop
description: Complete a multi-step task through small, verified changes while preserving the user's existing work. Use for an explicit convergence or iterate-until-done request.
---
Converge on: $ARGUMENTS

1. Read the relevant files and inspect the current working tree. Record existing modifications and
   the starting check results. A commit hash alone does not capture uncommitted user work.
2. Define the outcome and the checks that would establish it. Use the todo tool for the required
   steps. Do not replace the user's objective with a narrower test that is easier to pass.
3. Make one coherent change, including coupled call sites when needed. Use the existing project
   conventions and DGC's file tools so edits retain their normal checkpoint and permission boundary.
4. Run the relevant check and read its output. On a regression, inspect and correct the change you
   just made. If undoing is appropriate, restore only your exact changes while preserving the
   starting content and concurrent edits. Never use a broad reset, checkout, stash, or cleanup as
   an automatic recovery step.
5. Continue with the next required action. Do not repeatedly run an unchanged failing command or
   rerun a passing check without a new change or unresolved concern. Commit only when requested or
   required by the repository workflow; stage the reviewed paths explicitly.
6. Finish with the outcome, relevant checks, and remaining limitations. If a standing DGC goal is
   active, report completion through update_goal only after the entire objective is achieved, with
   a concise summary and concrete evidence. For an external blocker, record its evidence and explain
   what is needed to continue. A passing partial check is not whole-goal completion.

DGC automatically continues an explicitly active goal across work cycles and stops on user pause,
failure, completion, a blocker, or repeated lack of progress. A normal task does not create a goal.
Use /goal review to inspect the saved status and evidence; pause, resume, and clear are user controls.
