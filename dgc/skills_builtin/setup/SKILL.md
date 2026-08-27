---
name: setup
description: Connect DGC to a working model, fix a broken connection, or cut permission-prompt friction — provider/endpoint config, health diagnosis, and scoped allow rules.
---
Get DGC connected to a model and running smoothly. Section (optional — `connect`, `diagnose`, `permissions`): $ARGUMENTS

DGC talks to any OpenAI-compatible endpoint (`/v1/chat/completions` + `/v1/models`), local or cloud. Work the section the user needs; when unsure, start with (B).

## (A) CONNECT a provider/model
1. Run `dgc setup` (interactive wizard) or `/connect <preset|URL>` in-session. Never put a key in a command or chat message: cloud presets use a masked prompt; automation uses `DGC_API_KEY`/`--api-key-env`. Local endpoints usually need no key: ollama `http://localhost:11434/v1`, llama.cpp `http://localhost:8080/v1`, LM Studio `http://localhost:1234/v1`, vLLM `http://localhost:8000/v1`. Cloud endpoints include OpenAI `https://api.openai.com/v1`, OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`, DeepSeek `https://api.deepseek.com/v1`, Together `https://api.together.xyz/v1`, and Mistral `https://api.mistral.ai/v1`.
2. Pick the model with `/model` (lists what the endpoint actually serves). For local, pull/load it first (e.g. `ollama pull <model>`). Empty list → endpoint unreachable; go to (B).
3. Add resilience: in `~/.dgc/config.json` set `fallback_model` (+ `fallback_base_url` if on another host), and put that host's credential in `DGC_FALLBACK_API_KEY`. DGC never forwards the main provider key to another host. A different host auto-detects its transport; set `fallback_api_mode` only to override it. For sub-agents on a different host/model, set `subagent_model`/`subagent_base_url` globally and provide the credential through `DGC_SUBAGENT_API_KEY`; use `subagent_api_mode` only for a transport override, or pin per-agent `api_mode`/`api_key_env` fields in `.dgc/agents/*.md`.

## (B) DIAGNOSE
4. Run `dgc doctor` with bash and read the full output — this is the authoritative check; note every warn/error.
5. Read `~/.dgc/config.json` and confirm `base_url`, `model`, and `context_size` are sane and consistent. Check only whether `DGC_API_KEY` is set or whether the protected `~/.dgc/secrets.json` contains an `api_key` entry when the endpoint needs one; never print either value.
6. Verify reachability from bash: `curl -s $BASE_URL/models` (add `-H "Authorization: Bearer $KEY"` if keyed). Confirm the request succeeds AND the configured `model` appears in the list — a served-but-missing model is the top failure. Report OK/WARN/FAIL per area with a concrete fix: unreachable → check server/port/network, re-run `dgc setup`; model absent → `/model` or pull it; blank cloud key → re-run `dgc setup`; bad context → set the model's real window.

## (C) FEWER PROMPTS
7. Find the safe, repetitive calls that keep prompting (read-only bash, idempotent build/test): `git status/diff/log/show/branch`, `ls`, `cat`, `grep`/`rg`, `find`, `npm run test/lint/build`, `pytest`. For each, propose a tightly-scoped allow rule — the `:*` suffix is a prefix match, so it covers the whole subcommand: `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(npm run test:*)`, `Bash(rg:*)`. Present the list with one line of why each is safe. The user applies them by choosing **"always allow"** the next time that command prompts, or by adding each string to the `"allow"` array under `permissions` in `~/.dgc/config.json`. Run `/permissions` to show the current rules — but it only DISPLAYS; do not tell the user to run `/permissions allow …` (there is no such command). Never edit their config yourself.

Rules:
- Never print or paste an API key into logs, chat, or config output.
- Do not change config or permissions yourself — diagnose and propose; the user applies.
- After any connection change, re-run `dgc doctor` to confirm the endpoint is reachable and the model appears.
- Never propose a blanket `Bash(*)` or bare-binary `Bash(git:*)` allow, or any allow for a destructive command (`rm`, `git push`, `git reset --hard`, `git clean`, `dd`, publishes, `curl … | sh`, DB migrations) — those stay in `ask` or `deny`.
