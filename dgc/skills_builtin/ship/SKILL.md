---
name: ship
description: Prepare an authorized commit, push or pull request from a finished change, with deliberate staging, useful review context and verified release scope.
---
Prepare reviewable history for: $ARGUMENTS

Read the repository's contribution/release instructions, current branch and both staged and unstaged
changes. Use git_diff where available, then inspect surrounding code for the relevant risks. Preserve
pre-existing and concurrent work. Follow the repository's branch policy; do not rewrite shared history.

Review source, tests, generated output and package contents that will actually be committed. Look for
accidental debug output, private files, captures and credentials. Use available secret scanners in
redacted mode; report finding type and location without echoing a matched value. Do not pass secret
values to grep, Git history searches, command arguments or PR text. A keyword match alone is not a leak.

Run the checks appropriate to this change and read their results. Fix confirmed problems within the
authorized task. Do not turn an unrelated failing baseline into a false green check or hide it.
Stage the intended paths or hunks explicitly after reviewing them; verify the staged diff before
committing. Group coupled changes together and unrelated changes separately.

Use the project's commit convention. Explain the concrete problem and resulting behavior in the PR,
then give relevant validation and limitations. Prefer a body file or structured API field for multiline
text so shell quoting cannot alter it. Keep internal paths, account details and private logs out.

Existing authorization to commit, push or create a PR remains valid. Complete authorized steps without
asking again. If publication was not requested, finish preparation and report readiness before that
external action. Check the remote and target branch before pushing; never force-push as routine recovery.
Do not send review comments, merge, tag or publish packages beyond the user's authorized scope.

After an authorized push/PR, verify the returned commit or URL and CI state. A local build does not
prove a published release exists. Report the actual artifact or PR and checks, including pending CI.
