---
name: verify
description: Verify a code or interface change through the affected runtime boundary and report observed results, including failure paths and environment limits.
---
Verify the affected behavior: $ARGUMENTS

Read the change and locate the entry point users actually exercise. Use the project's existing check
commands and fixtures. Match test depth to risk: a pure transformation can be a unit check; filesystem,
protocol or service integration needs the relevant boundary; user interaction needs the actual client.
A successful build proves buildability, not every runtime claim.

Choose checks that could detect the claimed regression. Exercise relevant failure, cancellation and
recovery states as well as success. Use synthetic data and temporary workspaces. Live external writes
must stay within the user's authorization; use a local test double when appropriate and label that
coverage honestly. Confirm dependency/tool availability before attempting browser or remote-service runs.

Read exit codes and results, not only command submission. If you start a test server or background
process, track its handle and stop your own process afterward. Preserve unrelated processes and files.
Keep credentials, user sessions and raw private logs out of reports and artifacts.

If a check fails, distinguish a product defect, invalid fixture, environment limitation or existing
baseline failure. Correct confirmed issues when implementation/fixes are already authorized, then
rerun the affected checks. Do not widen tests just to accumulate counts or repeatedly rerun unchanged
failures without new evidence.

Report the behavior observed, relevant command/check and result. Distinguish stubbed, real local and
live provider coverage. If a check could not run, give its specific limitation. Do not claim browser
rendering from source inspection or a deployed release from a local build.
