---
name: providers
description: Point DGC at any OpenAI-compatible endpoint — local (ollama, llama.cpp, LM Studio, vLLM) or cloud (OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral) — pick a model, set a fallback, and run sub-agents on a different host.
---
Help the user connect DGC to a model provider. Topic (optional): $ARGUMENTS

DGC talks to anything that speaks the OpenAI-compatible API — one `/v1/chat/completions` + `/v1/models` surface — whether it runs on the user's own machine or in the cloud.

Connect a provider:
- Easiest path: run `dgc setup` for the interactive wizard (choose provider, base URL, key, model), or `/connect <preset|URL> [KEY]` in a session.
- `/connect` accepts a known preset name or a raw base URL. Provide the API key as the second arg when the endpoint needs one.
- LOCAL endpoints (usually no key needed):
  - ollama → `http://localhost:11434/v1`
  - llama.cpp server → `http://localhost:8080/v1`
  - LM Studio → `http://localhost:1234/v1`
  - vLLM → `http://localhost:8000/v1`
- CLOUD endpoints (API key required):
  - OpenAI → `https://api.openai.com/v1`
  - OpenRouter → `https://openrouter.ai/api/v1`
  - Groq → `https://api.groq.com/openai/v1`
  - DeepSeek → `https://api.deepseek.com/v1`
  - Together → `https://api.together.xyz/v1`
  - Mistral → `https://api.mistral.ai/v1`

Pick the model:
- Run `/model` to list the models the connected endpoint actually serves and choose one. For local providers, make sure the model is pulled/loaded first (e.g. `ollama pull <model>`). If `/model` shows nothing, the endpoint is unreachable or empty — run the `doctor` skill.

Set a fallback for resilience:
- In `~/.dgc/config.json`, set `fallback_model` (and `fallback_base_url` if the fallback lives on a different endpoint). DGC uses it when the primary is unreachable or errors — e.g. a local model as primary with a cloud model as fallback, or vice-versa.

Run SUB-AGENTS on a different host/model than the main loop:
- The `task` tool's sub-agents can use their own provider. Set `subagent_model`, `subagent_base_url`, and `subagent_api_key` in `~/.dgc/config.json` to route all sub-agents to another endpoint — e.g. keep the main loop on a big cloud model while fanning cheap parallel sub-tasks onto a fast local model (or the reverse).
- For finer control, define per-agent overrides in `.dgc/agents/*.md` — each agent file can pin its own model/endpoint.

After any connection change, verify it: run `dgc doctor` (or the `doctor` skill) to confirm the endpoint is reachable and the chosen model appears in `/models`. Never print or paste an API key into logs or chat.
