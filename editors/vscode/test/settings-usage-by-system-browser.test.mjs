// Settings → Token usage by system, laid out in real Chromium, light and dark, at 300, 460 and 900px: the System
// picker sits under the range and fits, the By system list and the model rows keep each system's name readable with
// the address one hover away, the name links read at 4.5:1, and nothing scrolls the page sideways.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const src = new URL("../src/", import.meta.url).pathname;
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");
const VSCODE_WEBVIEW = '<style id="_defaultStyles">@layer vscode-default{body{margin:0;padding:0 20px;font-family:var(--vscode-font-family);'
  + "font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:10px;height:10px}}</style>"
  + '<style>:root{--vscode-font-family:system-ui,"Ubuntu","Droid Sans",sans-serif;--vscode-font-size:13px}</style>';
// VS Code's Default Light Modern and Dark Modern, the variables this page reads.
const THEMES = {
  light: { body: "vscode-light", vars: { "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#616161",
    "--vscode-editor-background": "#ffffff", "--vscode-editor-foreground": "#3b3b3b", "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-input-background": "#ffffff", "--vscode-input-border": "#cecece", "--vscode-panel-border": "#e5e5e5",
    "--vscode-sideBar-background": "#f8f8f8" } },
  dark: { body: "vscode-dark", vars: { "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editor-background": "#1f1f1f", "--vscode-editor-foreground": "#cccccc", "--vscode-editorWidget-background": "#202020",
    "--vscode-input-background": "#313131", "--vscode-input-border": "#3c3c3c", "--vscode-panel-border": "#2b2b2b",
    "--vscode-sideBar-background": "#181818" } },
};
const row = (model, system, system_id, system_kind, host, input, output, requests = 1, unmetered = 0, provider = "ollama") =>
  ({ model, provider, host, requests, unmetered_requests: unmetered, input_tokens: input, output_tokens: output, cached_input_tokens: 0, system, system_id, system_kind });
const ROWS = [row("deepseek-v4.1-flash:cloud", "Ollama Cloud", "service:ollama-cloud", "service", "127.0.0.1:11434", 182000, 9100, 14),
  row("qwen3.5:9b", "NAS", "nas", "system", "nas.local:11434", 64000, 3100, 9, 2),
  row("qwen2.5:7b", "Basement workstation", "basement", "system", "basement-workstation.local:11434", 30500, 1400, 6),
  row("claude-sonnet-x", "Anthropic", "service:anthropic", "service", "api.anthropic.com", 12000, 900, 2, 0, "anthropic")];

const hostFor = (rows) => `(${function (rows) {
  const event = (ev) => setTimeout(() => window.postMessage({ type: "event", event: ev }, "*"), 1);
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m.type === "ready") event({ type: "config", mode: "auto", think: "off", context_size: 65536 });
    else if (m.type === "getUsage") {
      const mine = m.system ? rows.filter((r) => r.system_id === m.system) : rows;
      const sum = (key) => mine.reduce((s, r) => s + r[key], 0);
      event({ type: "usage_report", request_id: m.requestId, range: m.range, timezone: "IST, UTC+05:30", generated_at: "2026-11-02T15:26:00Z",
        totals: { input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), cached_input_tokens: 0, requests: sum("requests"),
          unmetered_requests: sum("unmetered_requests") },
        by_model: mine, by_day: [{ date: "2026-11-01", input_tokens: 9000, output_tokens: 200, requests: 1 },
          { date: "2026-11-02", input_tokens: sum("input_tokens") - 9000, output_tokens: 300, requests: 2 }] });
    }
  } });
}})(${JSON.stringify(rows)});`;
const pageFor = (theme) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", "<head>" + VSCODE_WEBVIEW + `<style>:root{${Object.entries(THEMES[theme].vars).map(([k, v]) => `${k}:${v}`).join(";")}}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", `<body class="${THEMES[theme].body}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${hostFor(ROWS)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

async function open(width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "Asia/Kolkata",
    colorScheme: theme });
  const p = await context.newPage();
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor(theme), contentType: "text/html" }));
  await p.goto("https://settings.test/view");
  await p.click("[data-nav=usage]");
  await p.waitForSelector("#usage-systems-table tbody tr");
  return { p, close: () => context.close() };
}
const contrast = (p, selector) => p.$eval(selector, (el) => {
  const rgb = (text) => { const m = text.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  let back = null;
  for (let at = el; at && !back; at = at.parentElement) {
    const c = rgb(getComputedStyle(at).backgroundColor);
    if (c.a > 0.5) back = c;
  }
  back = back || { r: 255, g: 255, b: 255 };
  const fore = rgb(getComputedStyle(el).color);
  const [hi, lo] = [lum(fore), lum(back)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
});

for (const theme of ["light", "dark"]) {
  for (const width of [300, 460, 620, 900]) {
    test(`Token usage by system, ${theme}, ${width}px: the picker fits, every system reads, nothing scrolls sideways`, async (t) => {
      if (skipOrFail(t)) return;
      const { p, close } = await open(width, theme);
      try {
        if (process.env.DGC_SHOTS) await p.screenshot({ path: `${process.env.DGC_SHOTS}/usage-by-system-${theme}-${width}.png`, fullPage: true });
        const main = await p.$eval("#main", (m) => ({ client: m.clientWidth, scroll: m.scrollWidth, right: m.getBoundingClientRect().right }));
        assert.ok(main.scroll <= main.client, `the page scrolls sideways (${main.scroll}px in ${main.client}px)`);
        const pick = await p.$eval("#usage-system", (s) => { const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width,
          visible: !s.closest("[hidden]") }; });
        assert.ok(pick.visible, "the System picker shows with more than one system");
        assert.ok(pick.right <= main.right + 0.5 && pick.width >= 110, `the picker fits (${JSON.stringify(pick)})`);
        const range = await p.$eval("#usage-range", (s) => s.getBoundingClientRect().bottom);
        const top = await p.$eval("#usage-system", (s) => s.getBoundingClientRect().top);
        assert.ok(top >= range - 1, "the System picker sits under the range");
        // Each system's name in By system: on one line, and at least its first word shows whole.
        const names = await p.$$eval("#usage-systems-table .usage-system-name", (els) => els.map((el) => ({ text: el.textContent,
          shown: el.clientWidth, full: el.scrollWidth, height: el.getBoundingClientRect().height })));
        assert.equal(names.length, 4);
        for (const n of names) {
          assert.ok(n.height < 30, `${n.text} stays on one line`);
          assert.ok(n.shown >= Math.min(n.full, 72), `${n.text} shows ${n.shown}px of ${n.full}px`);
        }
        // A model row names its system, with the address behind the info mark.
        const where = await p.$eval("#usage-models tr:nth-child(2) .usage-system-where", (el) => ({ text: el.textContent,
          info: el.querySelector(".usage-host-info")?.title, mark: el.querySelector(".usage-host-info")?.getBoundingClientRect().width }));
        assert.match(where.text, /^NAS · ollama/);
        assert.equal(where.info, "nas.local:11434");
        assert.ok(where.mark > 4, "the info mark is drawn, not clipped away");
        // One click shows the address under the row (a webview draws no hover tooltip in every editor).
        await p.click("#usage-models tr:nth-child(2) .usage-host-info");
        const shown = await p.$eval("#usage-models tr:nth-child(2) .usage-host", (el) => ({ hidden: el.hidden, text: el.textContent,
          height: el.getBoundingClientRect().height }));
        assert.deepEqual([shown.hidden, shown.text], [false, "nas.local:11434"]);
        assert.ok(shown.height > 8, "the address is drawn");
        const link = await contrast(p, "#usage-systems-table .usage-system-name");
        assert.ok(link >= 4.5, `a system's name reads at ${link.toFixed(2)}:1`);
        const sub = await contrast(p, "#usage-systems-table .usage-where .usage-head");
        assert.ok(sub >= 4.5, `what a system is reads at ${sub.toFixed(2)}:1`);
        // The tables give way before they scroll sideways: a model's name wraps whole (never cut in its middle),
        // Cached and then Share step aside; only a tab too narrow for the name and three numbers scrolls in its box.
        const tables = await p.$$eval(".usage-section .usage-table-wrap", (wraps) => wraps.filter((w) => w.offsetParent)
          .map((w) => ({ label: w.getAttribute("aria-label"), scroll: w.scrollWidth, client: w.clientWidth })));
        for (const t of tables) {
          if (width >= 460) assert.ok(t.scroll <= t.client + 1, `${t.label} scrolls sideways (${t.scroll}px in ${t.client}px)`);
        }
        const modelNames = await p.$$eval("#usage-models .usage-name", (els) => els.map((el) => ({ text: el.textContent,
          whole: el.scrollWidth <= el.clientWidth + 1, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) })));
        const wheres = await p.$$eval("#usage-models .usage-system-where .usage-head", (els) => els.map((el) => ({ text: el.textContent,
          whole: el.scrollWidth <= el.clientWidth + 1 })));
        if (width >= 460) for (const w of wheres) assert.ok(w.whole, `"${w.text}" is cut`);
        for (const n of modelNames) {
          assert.ok(n.whole, `${n.text} is cut`);
          assert.ok(n.lines <= 2, `${n.text} takes ${n.lines} lines`);
        }
        const columns = await p.$eval("#usage-models", (body) => ({
          cached: getComputedStyle(body.querySelector("tr .col-cached")).display !== "none",
          share: getComputedStyle(body.querySelector("tr .col-share")).display !== "none" }));
        if (width >= 900) assert.deepEqual(columns, { cached: true, share: true }, "a wide tab keeps every column");
        // The filter box's words fit in it.
        const filter = await p.$eval("#usage-find", (input) => {
          const s = getComputedStyle(input), ctx = document.createElement("canvas").getContext("2d");
          ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
          return { text: input.placeholder, need: Math.ceil(ctx.measureText(input.placeholder).width),
            room: input.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) };
        });
        assert.ok(filter.need <= filter.room, `"${filter.text}" needs ${filter.need}px, the box has ${filter.room}px`);
        // One system alone: the list steps aside and the picker stays.
        await p.selectOption("#usage-system", "nas");
        await p.waitForFunction(() => document.querySelector("#usage-systems").hidden);
        assert.equal(await p.$eval(".usage-system-pick", (el) => el.hidden), false);
        const after = await p.$eval("#main", (m) => m.scrollWidth <= m.clientWidth);
        assert.ok(after, "one system alone still fits");
      } finally { await close(); }
    });
  }
}
