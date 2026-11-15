// Pictures for the agents model picker (0.52) and a Pip's one-line prompt box, in real Chromium:
//   node test/render-agents-model.mjs <out-dir> [<tree-before>]
// Work's model menu with the Agents row, the agents list open, the menu after the session chose its own, the agent map
// with a model on each row, and Settings › Sub-agents: dark and light, 300 and 700 px. A Pip's prompt box: dark at 300,
// 360 and 440 px, after (this tree) and, with <tree-before>, before. Not a test.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { openSettings } from "./support/settings-scene.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

const out = process.argv[2] || "agents-model-pictures", before = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
const SPARE = `provider_${"c".repeat(32)}`, OPEN = `provider_${"d".repeat(32)}`;
const ROUTES = [{ key: `provider_${"a".repeat(32)}`, label: "Ollama", kind: "native", base_url: "http://127.0.0.1:11434/v1", model: "qwen3.8:27b" },
  { key: SPARE, label: "Spare GPU box", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
  { key: OPEN, label: "Ollama Cloud", kind: "native", base_url: "https://ollama.com", model: "", allModels: true },
  { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude" },
  { key: "subscription_codex", label: "Codex", kind: "subscription", engine: "codex" }];
const AGENTS = (extra = {}) => ({ offered: true, own: false, model: "qwen3-coder", base_url: "", settings_model: "qwen3-coder", settings_base_url: "", router: false, ...extra });
const OWN = AGENTS({ own: true, model: "own-coder", base_url: "https://spare.example/v1" });
const models = (agents) => ({ type: "models", ids: ["qwen3.8:27b", "qwen3-coder", "deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], current: "qwen3.8:27b", routes: ROUTES,
  currentRouteKey: ROUTES[0].key, supportsEffort: true, fallback: { offered: true, model: "", base_url: "", engine: "", route_base: "http://127.0.0.1:11434/v1" }, agents });

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  const name = (what) => `${out}/${what}-${theme.split("-")[0]}-${width}.png`;
  const scene = await openMapScene(browser, { width, height: 760, theme, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
  const { page, post } = scene;
  // 1. The model menu, following Settings: the Agents row under the model and thinking.
  await page.click("#btn-model");
  await post(models(AGENTS()));
  await page.waitForSelector("#modelmenu .model-tabs");
  await page.waitForTimeout(150);
  await page.screenshot({ path: name("1-menu-agents-row") });
  // 2. The agents list: Same as settings first, the providers, Claude Code and Codex greyed with the reason.
  await page.click("#modelmenu [data-model-tab='agents']");
  await page.waitForSelector("#modelmenu [data-agents-same]");
  await page.waitForTimeout(150);
  await page.screenshot({ path: name("2-agents-list") });
  // 2b. One provider's models, to choose for agents.
  await page.click('#modelmenu [data-agents-provider="1"]');
  await post({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "own-coder", "qwen3-coder:30b"] });
  await page.waitForSelector("#modelmenu [data-agents-model]");
  await page.click('#modelmenu [data-agents-model="1"]');
  await post({ type: "agentsModel", ...OWN });
  await page.waitForTimeout(150);
  await page.screenshot({ path: name("2b-agents-provider-models") });
  // 3. The menu after the session chose its own.
  await page.click("#modelmenu [data-agents-providers]");
  await page.click("#modelmenu [data-agents-back]");
  await page.waitForTimeout(150);
  await page.screenshot({ path: name("3-menu-own") });
  await page.keyboard.press("Escape");
  // 4. The agent map: a model on each row (one agent DGC named a model for; the rest on the session's own).
  await scene.send({ type: "agent_updated", id: "sub-000000000003", state: "running", model: "deepseek-v4.1-flash:cloud" }).catch(() => {});
  await page.click("#agents-pill");
  await page.waitForTimeout(250);
  await page.screenshot({ path: name("4-agent-map") });
  if (scene.errors.length) console.log("page errors", name(""), scene.errors);
  await page.context().close?.();
  await page.close().catch(() => {});

  // 5. Settings › Models › Sub-agents.
  const settingsTheme = theme.startsWith("dark") ? "dark" : "light";
  const s = await openSettings(browser, { theme: settingsTheme, width, height: 900, section: "models", scale: 2,
    extra: { models_at: true, subagent_model: "own-coder", subagent_base_url: "https://spare.example/v1", subagent_api_mode: "chat_completions",
      subagent_window_settable: true, subagent_thinking_settable: true, subagent_thinking: "" } });
  await s.page.evaluate(([spare, open]) => window.postMessage({ type: "providerProfiles", defaultId: "provider_" + "a".repeat(32), profiles: [
    { id: "provider_" + "a".repeat(32), kind: "native", name: "Ollama", base_url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", api_mode: "auto" },
    { id: spare, kind: "native", name: "Spare GPU box", base_url: "https://spare.example/v1", model: "gpt-oss:120b", api_mode: "chat_completions" },
    { id: open, kind: "native", name: "Ollama Cloud", base_url: "https://ollama.com", model: "", api_mode: "ollama" },
    { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "" },
    { id: "subscription_codex", kind: "subscription", engine: "codex", name: "Codex", model: "" }] }, "*"), [SPARE, OPEN]);
  await s.page.waitForSelector("#subagent_from");
  await s.rest(200);
  await s.page.locator("#models-subagents").scrollIntoViewIfNeeded();
  await s.page.evaluate(() => document.querySelector("#models-subagents").scrollIntoView({ block: "start" }));
  await s.rest(150);
  await s.page.screenshot({ path: name("5-settings-sub-agents") });
  if (s.errors.length) console.log("settings errors", s.errors);
  await s.close();
}

// A Pip's prompt box, dark: before and after.
for (const [label, srcRoot] of [["after", undefined], ...(before ? [["before", before]] : [])]) for (const width of [300, 360, 440]) {
  const chat = await openChat(browser, { where: "side", theme: "dark", width, height: 420, api: 96, settings: true, level: "ask", scale: 2, ...(srcRoot ? { srcRoot } : {}) });
  await chat.p.waitForSelector("#chat-level .composer-level-name", { state: "attached" });
  await chat.p.waitForTimeout(200);
  const box = await chat.root.evaluate((scope) => { const r = scope.querySelector(".pip-composer").getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 12), width: document.documentElement.clientWidth, height: Math.min(innerHeight - Math.max(0, r.top - 12), r.height + 24) }; });
  await chat.p.screenshot({ path: `${out}/pip-composer-${label}-dark-${width}.png`, clip: box });
  await chat.close();
}
await browser.close();
console.log("pictures in", out);
