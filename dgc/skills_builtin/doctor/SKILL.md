---
name: doctor
description: Diagnose the DGC + project setup — run dgc doctor, check the model endpoint is reachable, verify model/context/permissions look sane, and suggest concrete fixes.
---
Diagnose the current DGC and project setup, then report what's healthy and what needs fixing. Target/focus (optional): $ARGUMENTS

1. Run the built-in diagnostics. Execute `dgc doctor` with bash and read its full output. This is the authoritative first check — note every warning or error it reports.

2. Inspect the config. Read `~/.dgc/config.json`. Check that these look sane and consistent with each other:
   - `base_url` — the OpenAI-compatible endpoint DGC is pointed at.
   - `model` — the model id in use.
   - `context_size` — plausible for that model (not tiny, not larger than the model supports).
   - `api_key` — present when the endpoint requires one (confirm it exists; never print its value).
   - any `fallback_model` / `subagent_model` / `subagent_base_url` entries.

3. Verify the endpoint is actually reachable. Hit the provider's `/models` list from bash, e.g. `curl -s $BASE_URL/models` (add `-H "Authorization: Bearer $KEY"` if a key is set). Confirm the request succeeds AND that the configured `model` appears in the returned list. A configured model that isn't served is the most common failure.

4. Sanity-check permissions. Read the `permissions` section of the config. Flag anything surprising — overly broad `allow` rules for destructive commands, or `deny` rules that would block normal work.

5. Report. Give a short status per area (diagnostics / endpoint / model / context / permissions): OK, WARN, or FAIL, with the evidence. For every WARN or FAIL, give a concrete fix the user can run:
   - endpoint unreachable → check the server is up, the URL/port, and network; re-run `dgc setup` or `/connect`.
   - model not in `/models` → pick a served model with `/model`, or pull/load it on the provider.
   - missing/blank api_key on a cloud endpoint → re-run `dgc setup` to enter it.
   - context_size off → set it to the model's real context window.

Do not change any config yourself unless the user asks — diagnose and recommend.
