---
name: debug
description: Systematically diagnose a failing test or wrong behavior — reproduce, hypothesize, instrument, narrow to root cause, fix, and confirm. No guess-and-check.
---
Diagnose this symptom: $ARGUMENTS

Work the problem methodically. Do NOT start editing code hoping something sticks — every change you make should be motivated by evidence.

1. Reproduce it first. Find and run the exact failing command with bash (the test, the script, the request). Capture the full error, stack trace, and exit code. If you cannot reproduce it, you cannot fix it — get a reliable repro before touching anything. For a flaky failure, run it several times.

2. Read the failure. Open the file:line named in the trace with read_file. Read the function that failed and the code that calls it. Use grep to trace where the bad value originates.

3. Form explicit hypotheses. Write down 1–3 concrete, testable guesses about the root cause ("X is null because Y never runs", "the loop skips the last element"). Rank them by likelihood.

4. Test the cheapest hypothesis. Add targeted instrumentation with edit_file — print/log the suspect variables, inputs, and branch conditions right before the failure point. Re-run with bash and read the actual values. Let the data confirm or kill the hypothesis; don't assume.

5. Narrow. Bisect the failing path — comment out, short-circuit, or add asserts to cut the search space in half each step. Keep going until you can point at the single line or condition that is wrong and explain WHY it produces the observed symptom.

6. Fix the root cause, not the symptom. Make the minimal edit that addresses the actual defect. Avoid masking it with a try/except or a special-case unless that genuinely IS the correct behavior.

7. Remove your instrumentation. Delete the temporary prints/logs you added.

8. Confirm. Re-run the original failing command and show it now passes. Then run the surrounding tests to check you didn't break a neighbor.

Report: the root cause in one or two sentences, the fix you made (file:line), and the command output proving it's resolved. If you get genuinely stuck after narrowing, report the smallest reproducing case and exactly what you've ruled out.
