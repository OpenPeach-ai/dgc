---
name: debug
description: Diagnose a failing test, regression, crash or incorrect behavior using reproducible evidence, then fix and verify the cause within the requested scope.
---
Investigate the symptom: $ARGUMENTS

Find the actual entry point, failing command and expected result. Try a small reproducible case in an
isolated fixture. Capture the relevant error, exit code and timing without dumping private inputs or
whole logs. For intermittent failures, preserve one observation with its diagnostics; resampling a
changing process/state can make the assertion disagree with its own evidence.

Read the failure path and callers. Form concrete hypotheses and choose observations that distinguish
them. Use bounded instrumentation only when needed; log types, counts and synthetic identifiers instead
of credentials or user content. Do not change expected behavior just to make the test pass.

Narrow concurrency failures using event/request identities and lifecycle ordering, not arbitrary sleeps.
Check cleanup, cancellation, partial success, retries and the owner of each state transition. Avoid
broad source disabling or destructive resets as debugging shortcuts.

Fix the demonstrated cause, preserving existing work and contracts. If the environment cannot reproduce
the original report, a confirmed static defect plus a meaningful regression can justify a scoped fix;
state which part remains unverified rather than refusing all progress or claiming the original is solved.

Remove temporary instrumentation. Rerun the failing flow and the checks affected by the change. Report
cause, fix and observed evidence. If diagnosis remains incomplete, give the smallest case, what has been
ruled out and the specific missing observation needed next.
