---
name: write-tests
description: Add meaningful regression or missing coverage using the project's test framework and observable contract, rather than copying implementation details into assertions.
---
Write tests for: $ARGUMENTS

Read the target, callers and nearby tests. Identify promised inputs, outputs, side effects, failures
and lifecycle ordering. Use the existing runner and fixtures; add a dependency only when the task
requires a capability the project does not have, following its normal dependency policy.

Choose the lowest level that exercises the real contract. Use unit tests for pure logic, actual
filesystem/protocol integration for boundaries and client flows for user interactions. Prefer a few
cases that catch plausible breakage over getters, internal spelling checks or a coverage-percentage goal.
Use disposable files and synthetic credentials; do not depend on private user state or live production.

Run each new test and inspect failures. Check whether the expectation, fixture or implementation is
wrong; do not weaken a correct expectation to fit a bug. For a tests-only request, report an exposed
product defect and leave a faithful reproducer. If fixing is authorized, correct the product and rerun.

Where a test might be vacuous, use a controlled negative case or temporary mutation in an isolated copy
to show it catches the defect. Do not mutate the user's working tree merely to satisfy a ritual. Restore
only changes owned by the check and stop its processes. Test public behavior while allowing focused
internal tests when they are the practical way to establish an otherwise inaccessible invariant.

Report the contracts covered, actual results and relevant gaps. Keep deterministic checks independent
of timing and live services unless the boundary itself requires them; label optional integration runs.
