// What the model menu's tests and pictures tell the panel: this session's models, its providers, its fallback and its
// sub-agents (the `models` message of src/panel.ts). Not a *.test.mjs file.
export const SPARE = `provider_${"c".repeat(32)}`;
export const ROUTES = [{ key: `provider_${"a".repeat(32)}`, label: "Ollama", kind: "native", base_url: "http://127.0.0.1:11434/v1", model: "qwen3.8:27b" }, { key: SPARE, label: "Spare GPU box", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
  { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude" }];
export const IDS = ["codellama:13b", "deepseek-v4-pro:cloud", "glm-5.3:cloud", "gpt-oss:120b-32k", "qwen2.5:14b", "qwen3.8:27b", "a-model-with-a-very-long-name-that-goes-on:120b-instruct-q8_0"];
export const modelsMessage = (more = {}) => ({ type: "models", ids: IDS, current: "deepseek-v4-pro:cloud", routes: ROUTES, currentRouteKey: ROUTES[0].key, supportsEffort: true,
  fallback: { offered: true, model: "glm-5.3:cloud", base_url: "", engine: "", route_base: "http://127.0.0.1:11434/v1" },
  agents: { offered: true, own: false, model: "", base_url: "", settings_model: "", settings_base_url: "", router: false, thinking: "", thinking_settable: true, context_size: 0, context_settable: true, ...more } });
