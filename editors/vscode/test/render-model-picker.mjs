// Pictures of the model picker (17 Nov; media/shared/modelpicker.js) on its three surfaces, as the pages draw it:
//   node test/render-model-picker.mjs <out-dir> [filter]
// Work, ChatDGC and a Pip's chat at 300, 440, 700 and 1100 px, dark and light, with twelve connections and with two,
// while searching, on Claude Code's rows (nickname, version, fixed versions) and on Ollama's two sections; Work's and
// a Pip's Sub-agents tab; a row's ⋯ open. One sheet per surface too (sheet-<surface>.png). Not a *.test.mjs file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { openChatDgc } from "./support/uir2a-scene.mjs";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";
import { ROUTES, SPARE, manyRoutes, modelsMessage, claudeMessage, PIP_CATALOG, PIP_CATALOG_MANY, PIP_MODELS } from "./support/model-menu-scene.mjs";

const out = process.argv[2] || "/tmp/model-picker-pictures", only = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const WIDTHS = [300, 440, 700, 1100], THEMES = ["dark", "light"], made = [];
const want = (name) => !only || name.includes(only);
const shot = async (page, name) => { await page.waitForTimeout(220); await page.screenshot({ path: join(out, `${name}.png`) }); made.push(name); };
const LISTS = { [SPARE]: ["gpt-oss:120b", "gpt-oss:20b", "own-coder"] };
const listFor = (key) => LISTS[key] || [`${key.slice(9, 13)}-large`, `${key.slice(9, 13)}-small`, "opus-compatible-xl"];

// ---- Work --------------------------------------------------------------------------------------------------------------
async function work(width, theme, kind) {
  const s = await openMapScene(browser, { width, height: 760, theme: `${theme}-modern`, open: false, capabilities: { agents_model: 1, model_fallback: 1 } }), { page, post } = s;
  page.on("pageerror", (e) => console.log("page error", kind, width, theme, String(e)));
  const tag = `${width}-${theme}`;
  const open = async (message) => { await page.click("#btn-model"); await post(message); await page.waitForSelector(".dgc-mp .dgc-mp-row"); };
  const answer = async () => { for (const m of await page.evaluate(() => window.__posted.filter((x) => x.type === "providerModels").map((x) => x.id))) await post({ type: "providerModels", id: m, ids: listFor(m) }); };
  try {
    if (kind === "12") { await open({ ...modelsMessage(), routes: manyRoutes(8) }); await shot(page, `work-12-connections-${tag}`); }
    if (kind === "2") { await open({ ...modelsMessage(), routes: [ROUTES[0], ROUTES[2]] }); await shot(page, `work-2-connections-${tag}`); }
    if (kind === "claude") { await open({ ...claudeMessage("opus"), routes: manyRoutes(8), currentRouteKey: "subscription_claude" }); await shot(page, `work-claude-code-${tag}`); }
    if (kind === "search") { await open({ ...modelsMessage(), routes: manyRoutes(8) }); await page.click(".dgc-mp-q"); await page.keyboard.type("opus"); await answer(); await shot(page, `work-searching-${tag}`); }
    if (kind === "agents") { await open(modelsMessage({ thinking: "medium", context_size: 65536 })); await page.click('.dgc-mp-tab[data-tab="agents"]'); await shot(page, `work-sub-agents-${tag}`);
      await page.click(`.dgc-mp-conn[data-rail="${SPARE}"]`); await answer(); await shot(page, `work-sub-agents-models-${tag}`); }
    if (kind === "fallback") { await open(modelsMessage()); await page.hover('.dgc-mp-row[data-value="qwen3.8:27b"]'); await page.click('.dgc-mp-item:has(.dgc-mp-row[data-value="qwen3.8:27b"]) .dgc-mp-more'); await shot(page, `work-fallback-choices-${tag}`); }
  } finally { await page.close(); }
}

// ---- ChatDGC -----------------------------------------------------------------------------------------------------------
const hex = (c) => c.repeat(32);
const CHAT_PROFILES = [["Ollama", "ollama", ""], ["Claude Code", "anthropic", "cli", "claude"], ["Anthropic API", "anthropic", "key"], ["Codex", "openai", "cli", "codex"], ["OpenAI API", "openai", "key"], ["Ollama Cloud", "ollama", "cloud"],
  ["OpenRouter", "openrouter", "key"], ["Groq", "groq", "key"], ["DeepSeek", "deepseek", "key"], ["LM Studio", "lmstudio", ""], ["Mistral", "mistral", "key"], ["NAS workstation", "", ""]]
  .map(([name, mark, badge, engine], i) => (engine ? { id: `subscription_${engine}`, name, kind: "subscription", engine, model: "", mark, badge } : { id: `provider_${hex("abcdef0123456789"[i])}`, name, kind: "native", model: "", mark, badge }));
const CHAT_MODELS = { Ollama: ["qwen3.8:27b", "gemma3:27b", "llava:13b", "qwen3-coder:30b", "deepseek-v4.1-flash:cloud", "glm-5.3:cloud"], "Anthropic API": ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"], "OpenAI API": ["gpt-5.6", "gpt-5.6-mini", "gpt-4o"],
  "Ollama Cloud": ["kimi-k3:cloud", "qwen3.8:480b-cloud"], OpenRouter: ["anthropic/claude-opus-5-5", "google/gemini-3-pro"], Groq: ["llama-3.3-70b-versatile", "gpt-oss-120b"], DeepSeek: ["deepseek-chat", "deepseek-reasoner"],
  "LM Studio": ["qwen3-14b-mlx"], Mistral: ["mistral-large-latest", "pixtral-large"], "NAS workstation": ["Qwen/Qwen3-Coder-30B"], Codex: ["", "gpt-5.6-sol", "gpt-5.6-luna"], "Claude Code": ["", "fable", "opus", "sonnet", "haiku"] };
const CLI = { versions: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" }, fixed: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] };
async function chat(width, theme, kind) {
  const x = await openChatDgc(browser, { width, height: 760, theme: `${theme}-modern`, turns: 1 });
  x.page.on("pageerror", (e) => console.log("page error", kind, width, theme, String(e)));
  const tag = `${width}-${theme}`, profiles = kind === "2" ? CHAT_PROFILES.slice(0, 2) : CHAT_PROFILES, on = kind === "claude" ? "subscription:claude:opus" : `provider:${profiles[0].id}:qwen3.8:27b`;
  try {
    await x.send({ type: "fallbackOffered", on: true });
    for (const p of profiles) await x.send({ type: "models", ids: CHAT_MODELS[p.name], current: on, profiles, defaultId: profiles[0].id, providerId: p.id, ...(p.engine === "claude" ? { cli: CLI } : {}) });
    await x.page.evaluate((v) => { const pick = document.getElementById("cd-model"); if (![...pick.options].some((o) => o.value === v)) pick.append(new Option(v, v)); pick.value = v; pick.dispatchEvent(new Event("change")); }, on);
    await x.page.click("#cd-model-pill"); await x.page.waitForSelector(".dgc-mp .dgc-mp-row");
    if (kind === "12") await shot(x.page, `chatdgc-12-connections-${tag}`);
    if (kind === "2") await shot(x.page, `chatdgc-2-connections-${tag}`);
    if (kind === "claude") await shot(x.page, `chatdgc-claude-code-${tag}`);
    if (kind === "search") { await x.page.click(".dgc-mp-q"); await x.page.keyboard.type("opus"); await shot(x.page, `chatdgc-searching-${tag}`); }
  } finally { await x.page.close(); }
}

// ---- a Pip's chat --------------------------------------------------------------------------------------------------------
async function pip(width, theme, kind) {
  const many = { ...PIP_CATALOG_MANY, providers: PIP_CATALOG_MANY.providers.slice(0, 9) };          // 9 saved + DGC Router + Claude Code + Codex = 12
  const two = { subscriptions: [PIP_CATALOG.subscriptions[0]], providers: [PIP_CATALOG.providers[0]] };
  const x = await openOnePips(browser, { width, height: 760, theme: `${theme}-modern`, where: width >= 600 ? "tab" : "side", api: 97, faces: true,
    scene: { sub: true, fix: "none", posts: false, waiting: false, attention: false, models: PIP_MODELS, catalog: kind === "2" ? two : many } });
  x.page.on("pageerror", (e) => console.log("page error", kind, width, theme, String(e)));
  const tag = `${width}-${theme}`;
  try {
    await x.openPip(GST); await x.page.waitForTimeout(300); await x.click("#chat-model"); await x.waitIn(".dgc-mp .dgc-mp-row"); await x.page.waitForTimeout(250);
    if (kind === "12") await shot(x.page, `pip-12-connections-${tag}`);
    if (kind === "2") await shot(x.page, `pip-2-connections-${tag}`);
    if (kind === "claude") { await x.click('.dgc-mp-conn[data-rail="subscription:claude"]'); await shot(x.page, `pip-claude-code-${tag}`); }
    if (kind === "search") { await x.inPips((root) => root.querySelector(".dgc-mp-q").focus()); await x.page.keyboard.type("opus"); await shot(x.page, `pip-searching-${tag}`); }
    if (kind === "agents") { await x.click('.dgc-mp-tab[data-tab="agents"]'); await shot(x.page, `pip-sub-agents-${tag}`); }
  } finally { await x.close(); }
}

const SURFACES = { work, chatdgc: chat, pip };
for (const [name, draw] of Object.entries(SURFACES)) for (const theme of THEMES) {
  for (const width of WIDTHS) if (want(`${name}-12-connections-${width}-${theme}`)) await draw(width, theme, "12");
  for (const width of [300, 700]) for (const kind of ["2", "claude", "search", ...(name === "chatdgc" ? [] : ["agents"]), ...(name === "work" ? ["fallback"] : [])]) {
    const label = { 2: "2-connections", claude: "claude-code", search: "searching", agents: "sub-agents", fallback: "fallback-choices" }[kind];
    if (want(`${name}-${label}-${width}-${theme}`)) await draw(width, theme, kind);
  }
}

// One sheet per surface: every picture of it, small, with its name.
for (const name of Object.keys(SURFACES)) {
  const mine = made.filter((m) => m.startsWith(name + "-")); if (!mine.length) continue;
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
  const cells = mine.map((m) => `<figure><img src="data:image/png;base64,${readFileSync(join(out, `${m}.png`)).toString("base64")}"><figcaption>${m}</figcaption></figure>`).join("");
  await page.setContent(`<style>body{margin:0;padding:16px;background:#111;color:#ddd;font:12px system-ui;display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}figure{margin:0}img{display:block;height:380px;border:1px solid #333}figcaption{padding-top:4px}</style>${cells}`);
  await page.screenshot({ path: join(out, `sheet-${name}.png`), fullPage: true });
  await page.close();
}
writeFileSync(join(out, "pictures.txt"), made.join("\n") + "\n");
console.log(`${made.length} pictures in ${out}`);
await browser.close();
