// The model picker alone on a page with DGC's tokens (media/shared/modelpicker.js): what its own tests and pictures
// drive. Each surface's picker (Work, ChatDGC, a Pip's chat) has its own scene; this one is the module by itself, so
// its layout, its keys and its data shapes are tested once.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const css = ["media/shared/tokens.css", "media/shared/dialog.css", "media/shared/menu.css", "media/shared/tip.css", "media/shared/modelpicker.css"].map(read).join("\n");
const js = ["media/shared/menu.js", "media/shared/icons.js", "media/shared/tip.js", "media/shared/modelpicker.js"].map(read).join("\n;\n");

const THEMES = {
  dark: { cls: "vscode-dark", vars: "--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-input-background:#313131;--vscode-focusBorder:#0078d4;--vscode-font-size:13px;" },
  light: { cls: "vscode-light", vars: "--vscode-sideBar-background:#f8f8f8;--vscode-editor-background:#ffffff;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-focusBorder:#005fb8;--vscode-font-size:13px;" },
};

/** Claude Code, the Anthropic API, Ollama (local and cloud) and more: `count` connections, the first `count` of these. */
export function sampleView(count = 12, more = {}) {
  const P = "DgcModelPicker";
  return `(() => {
    const P = window.${P}, conn = (id, name, from, rows, extra = {}) => ({ id, name, ...P.markOf(from), loaded: true, sections: [{ title: "", rows }], ...extra });
    const plain = (ids, current) => ids.map((id) => ({ value: id, name: id, caps: P.facts(id), current: id === current }));
    const claude = P.claudeRows({ hints: ["fable", "opus", "sonnet", "haiku"], versions: { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" },
      fixed: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-1"], current: "opus", value: (n) => "claude:" + n });
    const ollama = plain(["deepseek-v4.1-flash:cloud", "gemma3:27b", "glm-5.3:cloud", "llava:13b", "qwen3-coder:30b", "qwen3.8:32b"], "").map((r) => ({ ...r, id: r.value }));
    const all = [
      conn("claude", "Claude Code", { engine: "claude" }, [], { current: true, sections: [{ title: "", rows: [{ value: "claude:", name: "CLI default", desc: "Whatever Claude Code is set to use" }, ...claude.followed] }, { title: "Fixed versions", rows: claude.fixed }], footer: [{ id: "typed", label: "Enter another model…", icon: "edit" }] }),
      conn("anthropic", "Anthropic API", { base_url: "https://api.anthropic.com/v1" }, plain(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"], "")),
      conn("ollama", "Ollama", { base_url: "http://localhost:11434/v1" }, [], { sections: P.ollamaSections(ollama) }),
      conn("codex", "Codex", { engine: "codex" }, plain(["gpt-5.6-sol", "gpt-5.6-luna"], "")),
      conn("openai", "OpenAI API", { base_url: "https://api.openai.com/v1" }, plain(["gpt-5.6", "gpt-5.6-mini", "gpt-4o"], "")),
      conn("ollamacloud", "Ollama Cloud", { base_url: "https://ollama.com/v1" }, plain(["kimi-k3:cloud", "qwen3.8:480b-cloud"], "")),
      conn("openrouter", "OpenRouter", { base_url: "https://openrouter.ai/api/v1" }, plain(["anthropic/claude-opus-5-5", "google/gemini-3-pro", "mistralai/magistral-medium"], "")),
      conn("groq", "Groq", { base_url: "https://api.groq.com/openai/v1" }, plain(["llama-3.3-70b-versatile", "gpt-oss-120b"], "")),
      conn("deepseek", "DeepSeek", { base_url: "https://api.deepseek.com/v1" }, plain(["deepseek-chat", "deepseek-reasoner"], "")),
      conn("lmstudio", "LM Studio", { base_url: "http://localhost:1234/v1" }, plain(["qwen3-14b-mlx"], "")),
      conn("mistral", "Mistral", { base_url: "https://api.mistral.ai/v1" }, plain(["mistral-large-latest", "pixtral-large"], "")),
      conn("nas", "NAS workstation", { base_url: "http://10.0.0.40:9000/v1" }, [], { loaded: false }),
      conn("qwen", "Qwen Code", { engine: "qwen" }, plain(["qwen3-coder-plus"], "")),
      conn("vllm", "vLLM", { base_url: "http://localhost:8000/v1" }, plain(["Qwen/Qwen3-Coder-30B"], "")),
    ].slice(0, ${count});
    return { title: "Model", connections: all,
      thinking: { levels: [["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"], ["ultra", "Ultra"]].map(([value, label]) => ({ value, label })), value: "high" },
      footer: [{ id: "settings", label: "Add provider in Settings…", icon: "add" }], ...${JSON.stringify(more)} };
  })()`;
}

/** A page with the picker's module and DGC's tokens, a model button, and `window.picked`: what the picker called. */
export async function pickerPage(browser, { width = 440, height = 720, theme = "dark", motion = "reduce", contrast = false } = {}) {
  const t = THEMES[theme] || THEMES.dark;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, deviceScaleFactor: 2, forcedColors: contrast ? "active" : "none", colorScheme: theme === "light" ? "light" : "dark" });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html style="${t.vars}"><head><meta charset="utf-8"><style>${css}
    html, body { height: 100%; margin: 0; } body { background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, sans-serif; --sans: system-ui, sans-serif; }
    #page { padding: 16px; } #btn { height: 28px; border-radius: 6px; }</style></head>
    <body class="${t.cls}"><div id="page"><p>The page under the picker.</p><button id="btn" type="button">deepseek-v4.1-flash:cloud</button></div><script>${js}</script></body></html>`);
  await page.evaluate(() => {
    window.DgcTip?.install({ look: "tip" });
    window.picked = [];
    window.openPicker = (view) => {
      const on = {};
      for (const name of ["pick", "thinking", "select", "search", "action", "tab", "setting", "close", "pageThinking", "pageWindow", "back", "done"]) on[name] = (...args) => window.picked.push([name, ...args.map((a) => (a && typeof a === "object" ? (a.value ?? a.id ?? JSON.parse(JSON.stringify(a, (k, v) => (k === "trigger" ? undefined : v)))) : a))]);
      window.view = { trigger: document.getElementById("btn"), ...view };
      window.picker = window.DgcModelPicker.open(document.body, window.view, on);
      return true;
    };
  });
  return { page, context, open: (count = 12, more = {}) => page.evaluate(`window.openPicker(${sampleView(count, more)})`) };
}
