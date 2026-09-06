---
name: handoff
description: Save a concise, factual continuation document with the task, current changes, validation and remaining work so another developer can resume accurately.
---
Prepare the handoff for: $ARGUMENTS

Collect the user's objective and constraints, current branch and changes, and the relevant observed
results. Inspect staged and unstaged changes with git_diff when available. Distinguish work from this
task from pre-existing edits. Do not infer test success or publication from a commit message.

Use the requested destination; otherwise HANDOFF.md is suitable when saving a file is requested.
Read an existing document and preserve relevant human notes while updating stale task state. A request
to generate a handoff can be fulfilled directly; do not introduce a second approval for that same file.
If the user only requests a chat summary, do not create persistent project instructions.

Include the objective, current behavior, important changed components/commits, observed checks,
remaining steps and a practical resumption point. Use repo-relative paths and verified command syntax.
Clearly label pending checks and blockers. Keep conversation history only when it explains a decision.

Exclude credentials, private account data, local machine paths and raw sensitive logs. Use redacted
scanner findings or presence-only checks when needed; never print a suspected secret to find it.
Do not add the handoff to a public commit unless that publication is in scope. Report where it was saved
and what still needs work; a handoff is not evidence that the goal is complete.
