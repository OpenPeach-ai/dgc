// What the model picker's tests and pictures tell the panel: this session's models, its providers, its fallback and its
// sub-agents (the `models` message of src/panel.ts). Not a *.test.mjs file.
export const SPARE = `provider_${"c".repeat(32)}`;
export const ROUTES = [{ key: `provider_${"a".repeat(32)}`, label: "Ollama", kind: "native", base_url: "http://127.0.0.1:11434/v1", model: "qwen3.8:27b" }, { key: SPARE, label: "Spare GPU box", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
  { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude", hints: ["fable", "opus", "sonnet", "haiku"], versions: { opus: "claude-opus-5-5" },
    fixed: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], cli_default_model: "", cli_default_listed: true }];
export const IDS = ["codellama:13b", "deepseek-v4-pro:cloud", "glm-5.3:cloud", "gpt-oss:120b-32k", "qwen2.5:14b", "qwen3.8:27b", "a-model-with-a-very-long-name-that-goes-on:120b-instruct-q8_0"];
export const modelsMessage = (more = {}) => ({ type: "models", ids: IDS, current: "deepseek-v4-pro:cloud", base: "http://127.0.0.1:11434/v1", routes: ROUTES, currentRouteKey: ROUTES[0].key, supportsEffort: true,
  fallback: { offered: true, model: "glm-5.3:cloud", base_url: "", engine: "", route_base: "http://127.0.0.1:11434/v1" },
  agents: { offered: true, own: false, model: "", base_url: "", settings_model: "", settings_base_url: "", router: false, thinking: "", thinking_settable: true, context_size: 0, context_settable: true, ...more } });
/** The same session on Claude Code: its nicknames, the version one of them ran as, and the fixed versions. */
export const claudeMessage = (current = "opus") => ({ type: "models", ids: ROUTES[2].hints, current, subscription: true, supportsEffort: true, label: "Claude Code", cliDefaultModel: "", cliDefaultListed: true,
  routes: ROUTES, currentRouteKey: ROUTES[2].key, fallback: { offered: false }, agents: { offered: false } });
/** `count` more saved providers, for a rail with more than fit. */
export const manyRoutes = (count) => [...ROUTES, ...[["OpenAI", "https://api.openai.com/v1"], ["Anthropic", "https://api.anthropic.com/v1"], ["OpenRouter", "https://openrouter.ai/api/v1"], ["Groq", "https://api.groq.com/openai/v1"],
  ["DeepSeek", "https://api.deepseek.com/v1"], ["Mistral", "https://api.mistral.ai/v1"], ["LM Studio", "http://localhost:1234/v1"], ["Ollama Cloud", "https://ollama.com/v1"], ["Together", "https://api.together.xyz/v1"], ["vLLM", "http://localhost:8000/v1"]]
  .slice(0, count).map(([label, base_url], i) => ({ key: `provider_${String(i).repeat(32).slice(0, 32)}`, label, kind: "native", base_url, model: "" , allModels: true })),
  { key: "subscription_codex", label: "Codex", kind: "subscription", engine: "codex", hints: ["gpt-5.6-sol", "gpt-5.6-luna"], versions: {}, fixed: [], cli_default_model: "gpt-5.6-sol", cli_default_listed: true }];

// ---- a Pip's chat: more of list_pip_models' answer (one-pips-scene's `catalog`), the model picker's connections -----
const hex = (c) => c.repeat(32);
export const PIP_HOME = "provider_" + hex("a"), PIP_CLOUD = "provider_" + hex("b"), PIP_KEYED = "provider_" + hex("c");
export const PIP_MODELS = [{ id: "m", name: "m" }, { id: "qwen3-coder:480b", name: "qwen3-coder:480b" }, { id: "glm-5.3:cloud", name: "glm-5.3:cloud" }];
export const PIP_CATALOG = { subscriptions: [{ engine: "claude", name: "Claude Code", models: ["fable", "opus", "sonnet", "haiku"], versions: { opus: "claude-opus-5-5" }, fixed: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
    { engine: "codex", name: "Codex", models: ["gpt-5.6-sol"] }],
  providers: [{ id: PIP_HOME, name: "Ollama", default: true, models: ["m", "qwen3-coder:480b", "glm-5.3:cloud"], mark: "ollama", badge: "" },
    { id: PIP_CLOUD, name: "Ollama Cloud", default: false, models: ["kimi-k3:cloud"], mark: "ollama", badge: "cloud" },
    { id: PIP_KEYED, name: "Anthropic API", default: false, models: ["claude-opus-5-5"], mark: "anthropic", badge: "key" }],
  router: { enabled: true, systems: [{ id: "nas", name: "NAS", online: true, models: [{ name: "qwen3.5:9b", context_window: 16384 }] }] } };
/** Twelve connections for a Pip: eight more saved providers. */
export const PIP_CATALOG_MANY = { ...PIP_CATALOG, providers: [...PIP_CATALOG.providers, ...[["OpenAI", "openai", "key"], ["OpenRouter", "openrouter", "key"], ["Groq", "groq", "key"], ["DeepSeek", "deepseek", "key"], ["Mistral", "mistral", "key"],
  ["LM Studio", "lmstudio", ""], ["NAS workstation", "", ""], ["vLLM", "vllm", ""]].map(([name, mark, badge], i) => ({ id: "provider_" + hex(String(i)), name, default: false, models: [`${name.toLowerCase().replace(/\s+/g, "-")}-model`], mark, badge }))] };
