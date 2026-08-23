---
name: security-review
description: Audit a change for SECURITY defects specifically — trace untrusted input to dangerous sinks and check injection, authz, path traversal, SSRF, XSS, secrets, and crypto against the real changed lines. Use when the change touches input handling, auth, queries, the filesystem, outbound requests, or dependencies.
---
Security-review the change. Report defects; do NOT fix them unless asked. Focus (optional): $ARGUMENTS

1. Get the diff. Run `git diff` (and `git diff --stat`) with bash, or read the files you just edited. List every file the change adds or touches. Add a todo item per file with the todo tool so nothing is skipped.

2. Map the attack surface. For each changed file, use read_file and grep to find where UNTRUSTED input enters: request params/body/headers/cookies, CLI args, file contents, env vars, and responses from external APIs. Then grep for DANGEROUS sinks in the same files: SQL string-building, `exec`/`spawn`/shell, `eval`/`Function`/template render, filesystem paths (`fs.`, `open(`, `readFile`, `path.join` on input), outbound requests (`fetch`/`http`/`axios` to a computed URL), and deserializers (`pickle`, `yaml.load`, `JSON.parse` of signed data, `unserialize`).

3. Trace source → sink. For each sink, grep backward for the variables it uses and confirm whether untrusted input reaches it WITHOUT validation, parameterization, or escaping. Only flag a path where you read both the source line and the sink line.

4. Check the classic classes against REAL lines: SQL/command/template injection; path traversal (`../`, unrooted paths); SSRF (user-controlled URL host); XSS (`innerHTML`, `dangerouslySetInnerHTML`, unescaped template output); missing or wrong authz on every NEW route/action (grep the added handler for its auth/permission check — a route with no check is a finding); secrets in code/logs/history (grep for keys, tokens, passwords; run `git log -p -S<token>` via bash if you suspect one); weak/misused crypto (`md5`, `sha1` for passwords, static IV/key, `Math.random` for tokens); unsafe deserialization.

5. Review dependencies. If the diff changes a lockfile or manifest (`package.json`, `requirements.txt`, `go.mod`, …), run `npm audit`/`pip-audit`/`gh api` via bash where available, and flag new packages, version bumps with known CVEs, and any added token/scope that is broader than the feature needs.

6. Report each finding as: SEVERITY (critical/high/medium/low) — `file:line` — the untrusted source, the sink it reaches, a concrete one-line exploit scenario, and the fix. Rank most-severe first. If you found nothing, say so and name what you checked.

Rules:
- Point ONLY at lines you actually read with read_file. Never report a finding from a filename or a guess.
- Do NOT auto-apply fixes. Describe the fix; edit_file only if the user explicitly asks.
- A new route or action with no authz check is a finding, not an assumption — flag it.
- Prefer a real tool result (`npm audit`, a grep hit, a `git log` match) over suspicion; if you could not run a check, say so.
