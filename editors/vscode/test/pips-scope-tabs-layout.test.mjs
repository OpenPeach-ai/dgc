// Personal | Project in real Chromium: the side bar's real page (panel.ts, main.css, main.js) with the real Pips view
// in its shadow root, at 300 and 460 px, dark and light. The tabs are the Sessions home's Chat | Work over again (the
// reported 2026-10-21: "tabs would look better"), so the two pages read as one: the same box, type and colours, read
// from computed style; they fit; their words clear 4.5:1; and switching tabs never moves them.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const bundled = await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" } });
const pipsJs = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const pipsCss = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");

// The page main.js draws, a backend that answers the Pips view, and the Pips opened as the Pips button opens them.
async function openPage({ width, theme, folder = true }) {
  const { html, mainJs, markdownJs } = panelHtml();
  const context = await browser.newContext({ viewport: { width, height: 640 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // An https origin: the Pips view's request ids come from crypto.randomUUID, which a secure context has.
  await page.route("https://dgc.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("https://dgc.test/panel");
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs, pjs, pcss]) => {
    const root = document.documentElement;
    root.dataset.chatPlace = "home"; root.dataset.chatdgcSeen = "1"; root.dataset.pipsDocumentId = "doc";
    document.getElementById("pips-host").dataset.styleUri = "data:text/css;base64," + btoa(unescape(encodeURIComponent(pcss)));
    const P = "ws_" + "1".repeat(32), Q = "ws_" + "2".repeat(32), R = "ws_" + "3".repeat(32);
    const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
      role: id, description: "Reads", available: id !== "core", unavailable_reason: id === "core" ? "Core is the main chat." : null, default_name: id, default_goal: "Help",
      engine: id === "core" ? null : id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
    const pip = (id, ws, name, type) => ({ id, name, pip_type: type, workspace_id: ws, status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only",
      trigger: "manual", goal: "Help", source_ref: "HEAD", schedule: null, proposals: [], pending_review_count: 0, model_choice: { mode: "default" },
      created_at: "2026-10-21T09:00:00Z", updated_at: "2026-10-21T09:00:00Z" });
    const pips = { [P]: [pip("pip_" + "a".repeat(32), P, "Core", "core"), pip("pip_" + "b".repeat(32), P, "India Market Brief", "quill")],
      [Q]: [pip("pip_" + "c".repeat(32), Q, "ERP daily audit", "rook")], [R]: [pip("pip_" + "d".repeat(32), R, "Billing app watcher", "scout")] };
    const runner = { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
    const answers = {
      list_workspaces: () => ({ workspaces: [{ id: P, name: "Personal", kind: "personal" }, { id: Q, name: "erp-tools", kind: "git" }, { id: R, name: "billing-app", kind: "git" }], current_workspace_id: Q }),
      list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
      list_pips: (r) => ({ pips: pips[r.workspace_id] || [], total: (pips[r.workspace_id] || []).length, next_offset: null }),
      get_pip_runner: () => ({ runner }), get_workspace_context: (r) => ({ context: { workspace_id: r.workspace_id, revision: 0, entries: [] } }),
      list_pip_attention: () => ({ as_of: new Date().toISOString(), total: 0, counts: {}, by_pip: {}, items: [], truncated: false }),
      get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000, count: 2 }),
    };
    window.__state = undefined;
    window.acquireVsCodeApi = () => ({ getState: () => window.__state, setState(s) { window.__state = s; }, postMessage(m) {
      const make = m?.type === "pipsRequest" && answers[m.request.type];
      if (make) setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } })), 1);
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    (0, eval)(pjs);
    eval(mjs);
  }, [mainJs, markdownJs, pipsJs, pipsCss]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  await send({ type: "sessions_list", items: [], error: "" });
  await page.waitForSelector("#home-tabs:not([hidden])");
  const home = await styles(page, "home");
  await send({ type: "pipsOpen" });
  await send({ type: "pipsConnection", apiVersion: 58, generation: 1, connected: true, supported: true, enabled: true, folder });
  await page.waitForFunction(() => document.getElementById("pips-host").shadowRoot?.querySelector("#pips-tabpanel .pip-row"), undefined, { timeout: 10000 });
  return { page, home, errors, close: () => context.close() };
}

const PROPS = ["display", "gap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderTopStyle", "borderTopColor",
  "borderTopLeftRadius", "backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "minHeight", "height", "width", "justifyContent", "alignItems", "cursor"];
// The tab bar, its chosen tab and the other one, wherever they are: the Sessions home's, or the Pips view's.
function styles(page, which) {
  return page.evaluate(([which, props]) => {
    const root = which === "home" ? document : document.getElementById("pips-host").shadowRoot;
    const bar = root.querySelector(which === "home" ? "#home-tabs" : ".pips-tabs");
    const chosen = bar.querySelector('[role="tab"][aria-selected="true"]'), other = bar.querySelector('[role="tab"][aria-selected="false"]');
    const pick = (n) => { const c = getComputedStyle(n); return Object.fromEntries(props.map((p) => [p, c[p]])); };
    const box = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    // The painted ground behind a node, across the shadow boundary.
    const ground = (n) => { for (let e = n; e; e = e.parentElement || e.getRootNode()?.host) { const bg = getComputedStyle(e).backgroundColor.replace(/\s/g, "");
      if (bg !== "rgba(0,0,0,0)" && bg !== "transparent") return bg; } return "rgb(255,255,255)"; };
    const rgb = (v) => v.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => { const v = c.map((p) => p / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    // Words on one line, inside their tab.
    const lines = (n) => { const range = document.createRange(); range.selectNodeContents(n); return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size; };
    const tab = (n) => ({ style: pick(n), box: box(n), text: n.textContent.trim(), lines: lines(n), clipped: n.scrollWidth > n.clientWidth + 0.5,
      contrast: ratio(getComputedStyle(n).color, ground(n)) });
    return { bar: { style: pick(bar), box: box(bar) }, chosen: tab(chosen), other: tab(other), sideways: document.documentElement.scrollWidth > innerWidth + 1 };
  }, [which, PROPS]);
}
const click = (page, id) => page.evaluate((id) => document.getElementById("pips-host").shadowRoot.getElementById(id).click(), id);
const pipsText = (page) => page.evaluate(() => document.getElementById("pips-host").shadowRoot.querySelector(".pip-app-root").textContent.replace(/\s+/g, " "));

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 460]) {
    test(`${theme} at ${width}px: Personal | Project are the Sessions home's tabs, they fit and read, and switching never moves them`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, home, errors, close } = await openPage({ width, theme });
      try {
        const personal = await styles(page, "pips");
        assert.deepEqual([personal.chosen.text, personal.other.text], ["Personal", "Project"]);
        assert.deepEqual([home.chosen.text, home.other.text], ["Chat", "Work"], "measured against the home's own tabs");
        // The same box, type and colours as the home's tabs, property by property.
        for (const part of ["bar", "chosen", "other"]) {
          const differs = PROPS.filter((p) => personal[part].style[p] !== home[part].style[p]);
          assert.deepEqual(differs.map((p) => `${p}: ${personal[part].style[p]} vs ${home[part].style[p]}`), [], `${part} matches the home's`);
        }
        // Where they sit across the side bar: the home's gutters.
        assert.equal(Math.round(personal.bar.box.x), Math.round(home.bar.box.x), "the same left edge");
        assert.equal(Math.round(personal.bar.box.width), Math.round(home.bar.box.width), "and the same width");
        for (const tab of [personal.chosen, personal.other]) {
          assert.equal(tab.lines, 1, `"${tab.text}" stays on one line`);
          assert.equal(tab.clipped, false, `"${tab.text}" is not cut off`);
          assert.ok(tab.box.x >= 0 && tab.box.right <= width + 0.5, `"${tab.text}" is inside the side bar`);
          assert.ok(tab.contrast >= 4.5, `"${tab.text}" reads at ${tab.contrast.toFixed(2)}:1, at least 4.5:1`);
        }
        assert.ok(Math.abs(personal.chosen.box.width - personal.other.box.width) <= 1, "the two share the bar evenly");
        assert.equal(personal.sideways, false, "the page does not scroll sideways");
        // Project: this project's Pips, under tabs in the very same place.
        await click(page, "pips-tab-project");
        await page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector('#pips-tabpanel [data-job="pip_' + "c".repeat(32) + '"]'));
        const project = await styles(page, "pips");
        assert.deepEqual([project.chosen.text, project.other.text], ["Project", "Personal"]);
        assert.deepEqual(project.bar.box, personal.bar.box, "the tabs do not move when the other is chosen");
        for (const part of ["chosen", "other"]) {
          const differs = PROPS.filter((p) => project[part].style[p] !== home[part].style[p]);
          assert.deepEqual(differs, [], `on Project, the ${part} tab still matches the home's`);
          assert.ok(project[part].contrast >= 4.5, `${project[part].text}: ${project[part].contrast.toFixed(2)}:1`);
        }
        const text = await pipsText(page);
        assert.match(text, /ERP daily audit/);
        assert.doesNotMatch(text, /billing-app|Billing app watcher|India Market Brief/, "only this project's Pips");
        // The keyboard focus ring is the home's.
        await page.evaluate(() => document.getElementById("pips-host").shadowRoot.getElementById("pips-tab-project").blur());
        await page.keyboard.press("Tab");   // focus-visible needs a key, as a person tabbing in has
        const ring = await page.evaluate(() => { const r = document.getElementById("pips-host").shadowRoot; r.getElementById("pips-tab-project").focus(); const c = getComputedStyle(r.getElementById("pips-tab-project"));
          return [c.outlineStyle, c.outlineWidth, c.outlineOffset]; });
        assert.deepEqual(ring, ["solid", "1px", "1px"], "a 1px focus ring 1px out, as the home's");
        assert.deepEqual(errors, []);
      } finally { await close(); }
    });
  }
}

test("with no folder open, the Project tab's one line fits at 300px", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors, close } = await openPage({ width: 300, theme: "dark-modern", folder: false });
  try {
    await click(page, "pips-tab-project");
    await page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector("#pips-tabpanel.pips-tab-empty"));
    const m = await page.evaluate(() => { const r = document.getElementById("pips-host").shadowRoot, p = r.querySelector("#pips-tabpanel p"), b = p.getBoundingClientRect();
      return { text: p.textContent, left: b.left, right: b.right, sideways: document.documentElement.scrollWidth > innerWidth + 1 }; });
    assert.equal(m.text, "Open a project folder to see its Pips.");
    assert.ok(m.left >= 8 && m.right <= 300 - 8, `inside the side bar's gutters (${m.left}-${m.right})`);
    assert.equal(m.sideways, false);
    const s = await styles(page, "pips");
    assert.equal(s.chosen.text, "Project");
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
