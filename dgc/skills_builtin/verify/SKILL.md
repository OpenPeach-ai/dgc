---
name: verify
description: After a change, drive the affected flow end-to-end with bash to confirm it actually works at runtime — not just that it compiles. Claim success only on observed output.
---
Verify that the recent change actually works. Focus/flow (optional): $ARGUMENTS

Compiling is not working. Passing types is not working. You must exercise the real behavior and observe the real result.

1. Identify what changed and what it affects. Use `git diff`/`git status` with bash, or read the files you just edited. Trace outward to the entry point that exercises this code: a test, a CLI command, an HTTP endpoint, a page, a build step, a script.

2. Choose the tightest end-to-end check that proves the behavior:
   - a function/module → run its unit test, or invoke it from a short bash one-liner and print the result.
   - a CLI change → run the actual command with real args.
   - a server/endpoint → start it (background it with bash if it's long-running, then `bash_output`), then `curl` the endpoint and read the response body and status code.
   - a build/config → run the real build and check it produces the expected artifact.
   - a UI/logic path → run the flow that triggers it and inspect the output/logs.

3. Run it with bash and READ the output. Look at exit codes, response bodies, printed values, log lines — the concrete evidence. If you started a background process, capture its output with bash_output and stop it with bash_kill when done.

4. Check the failure and edge cases too, not only the happy path. Confirm errors surface the way they should.

5. Report exactly what you observed: the command you ran, the relevant output, and whether it matches the expected behavior. Quote the real output.

Rules:
- Only claim it works if you SAW it work. If you couldn't run it, say so and say why — never assume success.
- If the check fails, report the failure plainly; if the fix is small and obvious, offer to apply it (consider invoking the `debug` skill for a stubborn one).
