import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Secondary text in Settings, read in a real browser under VS Code's light theme tokens. The panel
// painted hints, notes, inactive tabs and the Close button with --faint, which resolves to VS Code's
// disabledForeground: rgba(97,97,97,.5) in the light themes, 2.13:1 on the sidebar. Text a reader
// needs (a time zone, a privacy note, which tabs exist) has to clear 4.5:1.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");

// The colours VS Code injects for its two stock light themes (Light Modern, Light+). Light+'s own
// descriptionForeground (#717171) reads 4.4:1 on its #f3f3f3 sidebar, which is as clear as the panel
// can be there without overriding the theme, so that theme is held to the theme's own figure.
const MINIMUM = { "Default Light Modern": 4.5, "Default Light+": 4.4 };
const LIGHT_THEMES = {
  "Default Light Modern": { "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#3b3b3b",
    "--vscode-disabledForeground": "rgba(97, 97, 97, 0.5)", "--vscode-sideBar-background": "#f8f8f8",
    "--vscode-editor-background": "#ffffff", "--vscode-input-background": "#ffffff" },
  "Default Light+": { "--vscode-foreground": "#616161", "--vscode-descriptionForeground": "#717171",
    "--vscode-disabledForeground": "rgba(97, 97, 97, 0.5)", "--vscode-sideBar-background": "#f3f3f3",
    "--vscode-editor-background": "#ffffff", "--vscode-input-background": "#ffffff" },
};

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

for (const [theme, tokens] of Object.entries(LIGHT_THEMES)) {
  test(`Settings secondary text clears ${MINIMUM[theme]}:1 in ${theme}`, async (t) => {
    if (skipReason()) return t.skip(skipReason());
    const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
    const css = readFileSync(here + "/../media/main.css", "utf8");
    const mainJs = readFileSync(here + "/../media/main.js", "utf8");
    const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
      .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
    const vars = Object.entries(tokens).map(([k, v]) => `${k}:${v};`).join("");
    const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
    try {
      await page.setContent(skeleton.replace("</head>", `<style>${css}</style><style>:root{${vars}}</style></head>`), { waitUntil: "load" });
      await page.evaluate((mjs) => {
        document.body.classList.add("vscode-light");
        window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
        window.DgcMarkdown = { render: (s) => String(s), linkTarget: () => null };
        eval(mjs);
        window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
        window.postMessage({ type: "settings_open", providers: [], models: [], section: "usage" }, "*");
      }, mainJs);
      await page.waitForTimeout(200);
      const readings = await page.evaluate(() => {
        const rgba = (value) => { const m = value.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1]; };
        const lum = ([r, g, b]) => { const c = [r, g, b].map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        const ground = (node) => {
          for (let el = node; el; el = el.parentElement) {
            const bg = rgba(getComputedStyle(el).backgroundColor);
            if (bg[3] > 0.99) return bg;
          }
          return [255, 255, 255, 1];
        };
        const ratio = (node) => {
          const fg = rgba(getComputedStyle(node).color), bg = ground(node);
          const mixed = [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
          const a = lum(mixed), b = lum(bg);
          return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
        };
        const pick = {
          "time zone line": "#usage-timezone", "privacy note": ".usage-privacy",
          "section hint": '.set-section[data-section="usage"] .set-hint', "inactive tab": ".set-tab:not(.active)",
          "Close button": "#set-cancel", "close icon": "#set-close", "group heading": '.set-section[data-section="usage"] .set-group',
        };
        return Object.fromEntries(Object.entries(pick).map(([name, selector]) => {
          const node = document.querySelector(selector);
          return [name, node ? ratio(node) : null];
        }));
      });
      if (process.env.DGC_SHOT_DIR) await page.screenshot({ path: `${process.env.DGC_SHOT_DIR}/settings-${theme.replace(/\W+/g, "-")}.png` });
      for (const [name, value] of Object.entries(readings)) {
        assert.ok(value !== null, `${name} is on the page`);
        assert.ok(value >= MINIMUM[theme], `${name} reads ${value}:1 in ${theme} (${JSON.stringify(readings)})`);
      }
    } finally { await page.close(); }
  });
}
