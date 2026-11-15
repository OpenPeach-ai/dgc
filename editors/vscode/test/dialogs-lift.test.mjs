// ui-08: every popover of DGC's own takes the soft menu lift and opens in 150 ms; every centred dialog takes the dialog
// lift over a light scrim with a 2 px blur and opens in 180 ms; nothing bounces; under reduced motion nothing moves.
// The lifts, the scrim and the times are tokens (media/shared/tokens.css); the two layers are media/shared/dialog.css
// (.dgc-popover, .dgc-dialog, .dgc-scrim). Measured in real Chromium, dark and light:
//   - opened as a user opens them: Work's tray popover, goal editor, agent map and Auto-mode question; ChatDGC's
//     shortcuts sheet; a Pip's "What it can do", archive and login sheets (in a tab and in the side bar's shadow root);
//     Settings' sheet and its Add menu; a reply's trace
//   - every other popover, drawn with the classes its code gives it, on its page's real stylesheet (so a later rule of
//     the page that outweighed the shared one would be seen), and its code read for those classes
// VS Code's own dialogs and menus are not DGC's and are not here. A full-window viewer (a picture, a report, a file),
// a page that takes the panel (Skills, Workspace changes) and a drawer at the side (a mod's pane, Sources) are not
// popovers or centred dialogs: they are listed at the end so one that becomes a dialog is noticed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { openRailScene } from "./support/rail-scene.mjs";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { openAgentLines } from "./support/agent-lines-scene.mjs";
import { READY } from "./support/work-buttons-scene.mjs";
import { openChatDgc } from "./support/codex-look-scene.mjs";
import { openChat as openPip } from "./support/pip-chat-scene.mjs";
import { openSettings } from "./support/mods-scene.mjs";
import { readStylesheet } from "./support/stylesheet.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const root = new URL("..", import.meta.url).pathname;
const read = (name) => readFileSync(root + name, "utf8");
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";       // --ease-out: it settles, and never passes where it is going
const LIFT = { dark: { one: /rgba\(0, 0, 0, 0\.12\) 0px 8px 16px -4px/, two: /rgba\(0, 0, 0, 0\.4\) 0px 24px 48px -16px/, scrim: "rgba(0, 0, 0, 0.42)" },
  light: { one: /rgba\(0, 0, 0, 0\.12\) 0px 8px 16px -4px/, two: /rgba\(0, 0, 0, 0\.2\) 0px 24px 48px -16px/, scrim: "rgba(0, 0, 0, 0.21)" } };

/** One element as the page draws it (in the page or any shadow root), or its ::backdrop: its lift, its ground and blur,
    its corner, and how it arrives. `tokens`: what the shared lifts and the scrim compute to where it stands. */
const facts = (page, selector, pseudo = "") => page.evaluate(([sel, ps]) => {
  const find = (scope, s) => { const hit = scope.querySelector(s); if (hit) return hit; for (const n of scope.querySelectorAll("*")) { const inner = n.shadowRoot && find(n.shadowRoot, s); if (inner) return inner; } return null; };
  const n = find(document, sel); if (!n) return null;
  const s = getComputedStyle(n, ps || undefined), box = n.getBoundingClientRect();
  const probe = document.createElement("i"); probe.style.cssText = "position:fixed;left:-99px;width:1px;height:1px"; (n.parentNode || document.body).append(probe);
  const token = (prop, value) => { probe.style.setProperty(prop, value); const out = getComputedStyle(probe).getPropertyValue(prop); probe.style.removeProperty(prop); return out; };
  const tokens = { one: token("box-shadow", "var(--lift-1)"), two: token("box-shadow", "var(--lift-2)"), scrim: token("background-color", "var(--scrim)") };
  probe.remove();
  return { shadow: s.boxShadow, ground: s.backgroundColor, blur: s.backdropFilter || s.webkitBackdropFilter, corner: s.borderTopLeftRadius, shown: box.width > 0 && box.height > 0,
    arrives: s.animationName, time: s.animationDuration, ease: s.animationTimingFunction, classes: n.className, tokens };
}, [selector, pseudo]);

const isPopover = (f, theme, what, { arrives = true } = {}) => {
  assert.ok(f && f.shown, `${what}: on screen`);
  assert.match(f.tokens.one, LIFT[theme].one, `${what}: the page has the menu lift`);
  assert.equal(f.shadow, f.tokens.one, `${what}: the soft menu lift, and no shadow of its own (${f.shadow})`);
  if (arrives) { assert.equal(f.arrives, "dgc-popover-in", `${what}: opens as every popover does`); assert.equal(f.time, "0.15s", `${what}: in 150 ms`); assert.equal(f.ease, EASE, `${what}: easing out, no bounce`); }
};
const isDialog = (f, theme, what) => {
  assert.ok(f && f.shown, `${what}: on screen`);
  assert.match(f.tokens.two, LIFT[theme].two, `${what}: the page has the dialog lift, at half strength on a light ground`);
  assert.equal(f.shadow, f.tokens.two, `${what}: the dialog lift, and no shadow of its own (${f.shadow})`);
  assert.equal(f.corner, "20px", `${what}: the dialog corner`);
  assert.equal(f.arrives, "dgc-dialog-in", `${what}: opens as every dialog does`); assert.equal(f.time, "0.18s", `${what}: in 180 ms`); assert.equal(f.ease, EASE, `${what}: easing out, no bounce`);
};
const isScrim = (f, theme, what) => {
  assert.ok(f, `${what}: there`);
  assert.equal(f.ground, LIFT[theme].scrim, `${what}: the light scrim (42% on dark, 21% on light), not a ground of its own`);
  assert.equal(f.blur, "blur(2px)", `${what}: with a 2 px blur`);
  assert.equal(f.arrives, "dgc-scrim-in", `${what}: fades in with its dialog`); assert.equal(f.time, "0.18s", `${what}: in 180 ms`);
};
// Under reduced motion it is raised the same, and does not move.
const isStill = (f, what) => {
  assert.ok(f && f.shown, `${what}: on screen`);
  const layer = ["dgc-dialog", "dgc-popover", "dgc-scrim"].find((name) => String(f.classes).split(/\s+/).includes(name));
  if (layer === "dgc-scrim") { assert.equal(f.ground, f.tokens.scrim, `${what}: the light scrim`); assert.equal(f.blur, "blur(2px)", `${what}: with a 2 px blur`); }
  else if (layer) assert.equal(f.shadow, layer === "dgc-dialog" ? f.tokens.two : f.tokens.one, `${what}: the shared lift`);
  else assert.equal(f.shadow, f.tokens.one, `${what}: the menu lift (it has no shared class of its own)`);
  assert.equal(f.arrives, "none", `${what}: nothing moves under reduced motion`);
};
const motion = (page, reduced) => page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
const click = (page, sel) => page.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);
const WORK = { dark: "dark-modern", light: "light-modern" };

for (const theme of ["dark", "light"]) for (const reduced of [false, true]) {
  const said = `${theme}${reduced ? ", reduced motion" : ""}`;

  test(`Work, ${said}: the tray's popover is a popover; the goal editor is a dialog over the scrim`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of [700, 300]) {
      const x = await openRailScene(browser, { width, height: 620, theme: WORK[theme], kinds: ["goal", "tasks", "changes"] });
      try {
        await motion(x.page, reduced);
        await click(x.page, '.rail-chip[data-kind="tasks"]');
        if (reduced) isStill(await facts(x.page, "#rail-pop"), `${width}px, the tray's popover`); else isPopover(await facts(x.page, "#rail-pop"), theme, `${width}px, the tray's popover`);
        await click(x.page, "#goal-edit");
        await x.page.waitForSelector("#goal-editor:not([hidden])");
        if (reduced) { isStill(await facts(x.page, "#goal-editor .goal-dialog"), "the goal editor"); isStill(await facts(x.page, "#goal-editor"), "its scrim"); }
        else { isDialog(await facts(x.page, "#goal-editor .goal-dialog"), theme, `${width}px, the goal editor`); isScrim(await facts(x.page, "#goal-editor"), theme, `${width}px, the goal editor's scrim`); }
        assert.deepEqual(x.errors, []);
      } finally { await x.page.close(); }
    }
  });

  test(`Work, ${said}: the agent map and the Auto-mode question are dialogs over the scrim`, async (t) => {
    if (skipOrFail(t)) return;
    const m = await openMapScene(browser, { width: 700, height: 620, theme: WORK[theme], reducedMotion: reduced });
    const map = m.page || m;
    try {
      await map.waitForSelector("#agent-map:not([hidden])");
      if (reduced) { isStill(await facts(map, "#agent-map-box"), "the agent map"); isStill(await facts(map, "#agent-map"), "its scrim"); }
      else { isDialog(await facts(map, "#agent-map-box"), theme, "the agent map"); isScrim(await facts(map, "#agent-map"), theme, "the agent map's scrim"); }
    } finally { await map.close(); }
    const page = await openAgentLines(browser, { width: 700, height: 620, theme: WORK[theme], reducedMotion: reduced, events: [READY] });
    try {
      await motion(page, reduced);
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "autoModePrompt", requestId: "a".repeat(32), needsTrust: false } })));
      await page.waitForSelector(".auto-mode-dialog[open]");
      if (reduced) { isStill(await facts(page, ".auto-mode-dialog"), "the Auto-mode question"); assert.equal((await facts(page, ".auto-mode-dialog", "::backdrop")).arrives, "none"); }
      else { isDialog(await facts(page, ".auto-mode-dialog"), theme, "the Auto-mode question"); isScrim(await facts(page, ".auto-mode-dialog", "::backdrop"), theme, "the Auto-mode question's backdrop"); }
    } finally { await page.close(); }
  });

  test(`ChatDGC, ${said}: the shortcuts sheet is a dialog over the scrim`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChatDgc(browser, { width: 700, height: 620, theme: WORK[theme] });
    try {
      await motion(x.page, reduced);
      await click(x.page, "#cd-keys-open");
      await x.page.waitForSelector("#cd-keys[open]");
      if (reduced) isStill(await facts(x.page, "#cd-keys"), "the shortcuts sheet");
      else { isDialog(await facts(x.page, "#cd-keys"), theme, "the shortcuts sheet"); isScrim(await facts(x.page, "#cd-keys", "::backdrop"), theme, "the shortcuts sheet's backdrop"); }
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  for (const where of ["tab", "side"]) test(`a Pip's chat in the ${where === "tab" ? "editor" : "side bar"}, ${said}: What it can do, Archive and the login sheet are dialogs over the scrim`, async (t) => {
    if (skipOrFail(t)) return;
    const width = where === "tab" ? 700 : 300;
    const check = async (x, what) => {
      await x.p.waitForSelector("#review-root .dialog");
      if (reduced) { isStill(await facts(x.p, "#review-root .dialog"), what); isStill(await facts(x.p, "#review-root .overlay"), `${what}'s scrim`); }
      else { isDialog(await facts(x.p, "#review-root .dialog"), theme, what); isScrim(await facts(x.p, "#review-root .overlay"), theme, `${what}'s scrim`); }
      assert.deepEqual(x.errors, []);
    };
    let x = await openPip(browser, { width, height: 620, theme, where, api: 81, motion: reduced ? "reduce" : "no-preference" });
    try {
      await x.p.evaluate(() => { const r = window.__pipsRoot || document; (r.querySelector("#chat-permissions") || r.querySelector("#chat-level")).click(); });
      await x.p.waitForTimeout(200);
      await x.p.evaluate(() => (window.__pipsRoot || document).querySelector("[data-pip-level-what]")?.click());
      await check(x, "What it can do");
    } finally { await x.close(); }
    x = await openPip(browser, { width, height: 620, theme, where, project: true, api: 81, settings: true, changes: ["schedule", "name"], motion: reduced ? "reduce" : "no-preference" });
    try {
      await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector("#archive-pip"); await click(x.p, "#archive-pip");
      await check(x, "Archive");
    } finally { await x.close(); }
    x = await openPip(browser, { width, height: 620, theme, where, api: 81, settings: true, motion: reduced ? "reduce" : "no-preference" });
    try {
      await click(x.p, '[data-tab="job"]'); await x.p.waitForTimeout(300);
      await x.p.evaluate(() => { const r = window.__pipsRoot || document; [...r.querySelectorAll("button")].find((b) => /Save a login|Add a login/.test(b.textContent)).click(); });
      await x.p.waitForSelector("#review-root .login-dialog");
      await check(x, "the login sheet");
    } finally { await x.close(); }
  });

  test(`Settings, ${said}: its sheet is a dialog over the scrim, and its Add menu a popover`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openSettings(browser, { width: 700, height: 620, theme });
    try {
      await motion(x.page, reduced);
      await x.page.waitForSelector("#add-menu"); await click(x.page, "#add-menu");
      if (reduced) isStill(await facts(x.page, "#add-options"), "the Add menu"); else isPopover(await facts(x.page, "#add-options"), theme, "the Add menu");
      await click(x.page, '[data-add="marketplace"]');
      await x.page.waitForSelector("dialog.plugin-dialog[open]");
      if (reduced) isStill(await facts(x.page, "dialog.plugin-dialog"), "Settings' sheet");
      else { isDialog(await facts(x.page, "dialog.plugin-dialog"), theme, "Settings' sheet"); isScrim(await facts(x.page, "dialog.plugin-dialog", "::backdrop"), theme, "its backdrop"); }
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`a reply's trace, ${said}: a dialog over the scrim, as built otherwise`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openRailScene(browser, { width: 700, height: 620, theme: WORK[theme], kinds: [] });
    try {
      await motion(x.page, reduced);
      await x.page.addStyleTag({ content: read("media/trace.css") }); await x.page.addScriptTag({ content: read("media/trace.js") });
      await x.page.evaluate(() => window.DgcTrace.open({ id: "Trace t1", model: "m", start: 0, end: 4200, rows: [{ name: "Thinking", kind: "think", start: 0, end: 900, detail: "" }, { name: "bash", kind: "tool", start: 900, end: 4200, detail: "npm test" }] }));
      if (reduced) { isStill(await facts(x.page, ".dgc-trace-dialog"), "the trace"); isStill(await facts(x.page, ".dgc-trace-backdrop"), "its scrim"); }
      else { isDialog(await facts(x.page, ".dgc-trace-dialog"), theme, "the trace"); isScrim(await facts(x.page, ".dgc-trace-backdrop"), theme, "the trace's scrim"); }
    } finally { await x.page.close(); }
  });
}

// ---- every other popover, with the classes its code gives it, on its page's own stylesheet
const bundleCss = async (file, loader) => (await build({ entryPoints: [root + "src/" + file], bundle: true, write: false, format: "iife", outdir: "out", platform: "browser", target: "chrome108", loader }))
  .outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const SHEETS = {
  work: () => readStylesheet(root + "media/main.css") + read("media/mentions.css") + read("media/messagequeue.css"),
  chat: () => readStylesheet(root + "media/main.css") + read("media/mentions.css") + read("media/messagequeue.css") + read("media/chatdgc.css"),
  artifact: () => readStylesheet(root + "media/main.css") + read("media/artifact.css"),
  canvas: () => readStylesheet(root + "media/canvas.css"),
  pips: () => bundleCss("pipsClient.js", { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" }),
  settings: () => bundleCss("settingsClient.js", { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" }),
};
// [page, what it is, the markup its code writes (the element measured carries data-x), where its code is, the text there that gives it its classes, arrives?]
const POPOVERS = [
  ["work", "a made file's Download menu", '<div class="artifact-card"><div class="amenu-wrap"><div data-x class="amenu dgc-popover">m</div></div></div>', "media/main.js", 'el("div", "amenu dgc-popover")'],
  ["work", "the prompts of this chat", '<div data-x class="prompt-rail-card dgc-popover" style="left:10px;top:10px">m</div>', "media/promptrail.js", 'el("div", "prompt-rail-card dgc-popover")'],
  ["work", "a mod's commands", '<div style="position:relative;margin-top:300px"><div data-x class="mod-slash dgc-popover">m</div></div>', "media/mods.js", 'el("div", "mod-slash dgc-popover")'],
  ["work", "a queued message's menu", '<div data-x class="dgc-queue-menu dgc-popover">m</div>', "media/messagequeue.js", 'make("div", "dgc-queue-menu dgc-popover")'],
  ["work", "the tray's popover, built for a page without one", '<div class="rail-line has-chips pop-open" style="margin-top:300px"><div data-x class="rail-pop dgc-popover">m</div></div>', "media/shared/tray.js", 'class="rail-pop dgc-popover"'],
  ["chat", "the widgets of this chat", '<div data-x class="cd-wpanel dgc-popover" style="left:10px;top:10px">m</div>', "media/chatdgc.js", 'el("div", "cd-wpanel dgc-popover")'],
  ["chat", "the context window", '<div style="position:relative;margin-top:300px"><div data-x class="cd-pop dgc-popover">m</div></div>', "src/chatdgc.ts", 'class="cd-pop dgc-popover"'],
  ["chat", "a made file's Download menu", '<span style="position:relative"><span data-x class="cd-artifact-menu dgc-popover">m</span></span>', "media/chatdgc.js", 'el("span", "cd-artifact-menu dgc-popover")'],
  ["artifact", "an artifact's Download menu", '<div class="art-menu-wrap"><div data-x class="art-menu dgc-popover">m</div></div>', "src/artifacts.ts", 'class="art-menu dgc-popover"'],
  ["artifact", "an artifact's versions", '<section data-x class="art-versions dgc-popover">m</section>', "src/artifacts.ts", 'class="art-versions dgc-popover"'],
  ["canvas", "the canvas's formula box", '<div data-x class="cv-tex dgc-popover" style="left:10px;top:10px">m</div>', "src/canvasEditor.ts", '"cv-tex dgc-popover"'],
  ["pips", "the Pips' Controls", '<div class="pip-app-root"><details class="runner-controls" open><summary>c</summary><div data-x class="runner-menu dgc-popover">m</div></details></div>', "src/pipsClient.js", 'class="runner-menu dgc-popover"'],
  ["pips", "a Pip's picker", '<div class="pip-app-root"><div style="position:relative"><div data-x class="pip-picker-list dgc-popover">m</div></div></div>', "src/pipPicker.js", 'class="pip-picker-list dgc-popover"'],
  ["pips", "a Pip's page note", '<div class="pip-app-root"><div data-x class="pip-tip-pop dgc-popover">m</div></div>', "src/pipInfoTip.js", "'pip-tip-pop dgc-popover'"],
  ["settings", "a model box's list", '<span style="position:relative"><ul data-x class="model-box-list dgc-popover"><li>m</li></ul></span>', "src/settingsModelBox.js", 'class="model-box-list dgc-popover"'],
  ["settings", "a context size's list", '<span style="position:relative"><ul data-x class="ctx-combo-list dgc-popover"><li>m</li></ul></span>', "src/contextCombo.js", 'class="ctx-combo-list dgc-popover"'],
  // Raised with the same lift, and not the popover's arrival: the @ and / list is drawn again at every key, and a tip
  // follows the pointer with its own quicker fade (100 ms, 2 px).
  ["work", "the @ and / list", '<div data-x class="pop" style="display:block">m</div>', "media/mentions.css", ".pop { box-shadow: var(--lift-1);", false],
  ["work", "a hover tip", '<div data-x class="tip">m</div>', "media/main.css", ".tip { box-shadow: var(--lift-1);", "tip-in"],
];
const DIALOGS = [
  ["artifact", "an artifact's comparison of two versions", '<dialog data-x class="art-compare dgc-dialog">m</dialog>', "media/artifact.js", 'el("dialog", "art-compare dgc-dialog")'],
  ["artifact", "a spreadsheet's chart", '<dialog data-x class="art-compare sh-chart dgc-dialog">m</dialog>', "media/artifactSheet.js", 'el("dialog", "art-compare sh-chart dgc-dialog")'],
  ["work", "an agent's card", '<div class="modal-layer dgc-scrim agent-map-layer am-card-layer"><div data-x class="agent-map dgc-dialog am-window am-card-window">m</div></div>', "src/panel.ts", 'class="agent-map dgc-dialog am-window am-card-window"'],
  ["work", "an agent's transcript", '<div class="modal-layer dgc-scrim agent-map-layer am-transcript-layer"><div data-x class="agent-map dgc-dialog am-window am-transcript-window">m</div></div>', "src/panel.ts", 'class="agent-map dgc-dialog am-window am-transcript-window"'],
  ["work", "the goal's review", '<div class="modal-layer dgc-scrim"><div data-x class="goal-dialog dgc-dialog">m</div></div>', "src/panel.ts", '<div id="goal-review" class="modal-layer dgc-scrim"'],
];
const THEME = { dark: ["vscode-dark", "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-input-background:#313131"],
  light: ["vscode-light", "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-input-background:#ffffff"] };
const sheets = new Map();
const sheet = async (name) => { if (!sheets.has(name)) sheets.set(name, await SHEETS[name]()); return sheets.get(name); };

test("every popover and dialog is given its shared class where its code makes it", () => {
  for (const [, what, , file, text] of [...POPOVERS, ...DIALOGS]) assert.ok(read(file).includes(text), `${what}: ${file} writes ${text}`);
  // The ones opened for real above, too: their classes are in the page's own markup or script.
  for (const [file, text] of [["src/panel.ts", 'id="rail-pop" class="rail-pop dgc-popover"'], ["src/panel.ts", 'id="goal-editor" class="modal-layer dgc-scrim"'], ["src/panel.ts", 'id="agent-map" class="modal-layer dgc-scrim agent-map-layer"'],
    ["media/main.js", '"auto-mode-dialog dgc-dialog"'], ["src/chatdgc.ts", 'class="cd-keys dgc-dialog"'], ["src/settingsClient.js", "'plugin-dialog dgc-dialog'"], ["src/settingsClient.js", 'class="add-menu dgc-popover"'],
    ["media/trace.js", '"dgc-trace-backdrop dgc-scrim"'], ["media/trace.js", '"dgc-trace-dialog dgc-dialog"']]) assert.ok(read(file).includes(text), `${file} writes ${text}`);
  const pips = read("src/pipsClient.js");
  assert.equal((pips.match(/class="overlay(?! dgc-scrim)/g) || []).length, 0, "every sheet of a Pip's is on the shared scrim");
  assert.equal((pips.match(/class="dialog(?![^"]*dgc-dialog)/g) || []).length, 0, "and is the shared dialog");
  // Every page that has one loads the shared layers.
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/dialog\.css"\)/);
  assert.match(read("media/canvas.css"), /@import url\("\.\/shared\/dialog\.css"\)/);
  for (const file of ["src/pipsClient.js", "src/settingsClient.js"]) assert.match(read(file), /import '\.\.\/media\/shared\/dialog\.css'/, file);
});

for (const theme of ["dark", "light"]) for (const reduced of [false, true]) {
  test(`every other popover and dialog, ${theme}${reduced ? ", reduced motion" : ""}: the shared lift and arrival win on its page's own stylesheet`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await browser.newPage({ viewport: { width: 700, height: 620 } });
    try {
      await motion(page, reduced);
      for (const [name, what, html, , , own] of [...POPOVERS, ...DIALOGS]) {
        const arrives = own === undefined;
        const kind = POPOVERS.some((row) => row[1] === what && row[0] === name) ? "popover" : "dialog";
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>:root{${THEME[theme][1]};--vscode-font-family:system-ui,sans-serif}</style><style>${await sheet(name)}</style></head><body class="${THEME[theme][0]}">${html}</body></html>`, { waitUntil: "load" });
        if (kind === "dialog") await page.evaluate(() => { const d = document.querySelector("dialog[data-x]"); if (d) d.showModal(); });
        const f = await facts(page, "[data-x]");
        const where = `${what} (${name})`;
        if (reduced) isStill(f, where);
        else if (kind === "popover") isPopover(f, theme, where, { arrives });
        else { isDialog(f, theme, where); isScrim(await facts(page, html.startsWith("<dialog") ? "[data-x]" : ".dgc-scrim", html.startsWith("<dialog") ? "::backdrop" : ""), theme, `${where}'s scrim`); }
        if (!reduced && kind === "popover" && !arrives) assert.equal(f.arrives, own || "none", `${where}: it does not arrive as a popover`);
      }
    } finally { await page.close(); }
  });
}

test("nothing that opens bounces or slides across: the shared layers only fade, rise 4 px and grow 2%, on the settling curve", () => {
  const css = read("media/shared/dialog.css"), tokens = read("media/shared/tokens.css");
  assert.match(tokens, /--ease-out: cubic-bezier\(\.23,1,\.32,1\)/, "the curve never passes 1: it cannot overshoot");
  assert.match(tokens, /--dur-menu: 150ms; --dur-dialog: 180ms/);
  assert.match(tokens, /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{[^}]*--dur-menu: 0ms; --dur-dialog: 0ms/);
  assert.match(tokens, /--scrim: rgba\(0,0,0,\.42\); --scrim-blur: 2px/);
  const frames = [...css.matchAll(/@keyframes (dgc-[\w-]+) \{([^@]*?\})\s*\}/g)].map((m) => [m[1], m[2].trim()]);
  assert.deepEqual(frames, [["dgc-popover-in", "from { opacity: 0; translate: 0 4px; scale: .98; }"], ["dgc-dialog-in", "from { opacity: 0; scale: .98; }"], ["dgc-scrim-in", "from { opacity: 0; }"]]);
  assert.doesNotMatch(css, /spring|linear\(|cubic-bezier/, "no curve of its own");
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const moving = rules.slice(rules.indexOf("@media (prefers-reduced-motion: no-preference)"), rules.indexOf("@keyframes"));
  assert.equal((rules.match(/animation:/g) || []).length, (moving.match(/animation:/g) || []).length, "every arrival is inside the no-preference block");
  // No stylesheet keeps a heavy shadow or a dark ground of its own for a popover or a dialog.
  for (const file of ["media/main.css", "media/chatdgc.css", "media/artifact.css", "media/canvas.css", "media/mentions.css", "media/messagequeue.css", "media/trace.css", "media/shared/tray.css", "src/pips.css", "src/settings.css"]) {
    const text = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const sel of [".rail-pop", ".amenu", ".prompt-rail-card", ".mod-slash", ".dgc-queue-menu", ".cd-wpanel", ".cd-pop", ".cd-artifact-menu", ".art-menu", ".art-versions", ".cv-tex", ".runner-menu", ".pip-picker-list", ".pip-tip-pop",
      ".add-menu", ".model-box-list", ".ctx-combo-list", ".goal-dialog", ".agent-map", ".auto-mode-dialog", ".cd-keys", ".dialog", ".plugin-dialog", ".dgc-trace-dialog", ".art-compare"]) {
      const own = [...text.matchAll(new RegExp(`(?:^|[},\\s])[^{}]*${sel.replace(/[.-]/g, "\\$&")}(?:::backdrop)?\\s*\\{([^{}]*)\\}`, "gm"))].map((m) => m[1]).filter((body) => /box-shadow:\s*0 \d+px \d+px/.test(body) || /::backdrop/.test(body));
      assert.deepEqual(own, [], `${file}: ${sel} has no shadow of its own`);
    }
  }
});

test("what is not a popover or a centred dialog, and why: a viewer, a page and a drawer keep their own ground", () => {
  const main = read("media/main.css"), chat = read("media/chatdgc.css");
  // A picture or a file shown over the whole window, and a report read on its own: viewers, on a dark ground of their own.
  for (const [css, sel] of [[main, "#att-viewer"], [main, "#image-viewer"], [chat, ".cd-lightbox"], [chat, ".cd-reader"]]) assert.match(css, new RegExp(`${sel.replace(/[.#-]/g, "\\$&")} \\{ position: fixed; inset: 0;`), `${sel} takes the whole window`);
  // Skills, Memory, Workspace changes: a page that takes the panel.
  assert.match(main, /\.panel-overlay \{ position: absolute; inset: 0; z-index: 30; display: flex; flex-direction: column; background: var\(--bg\); \}/);
  // A mod's pane, and ChatDGC's Sources and Project settings: drawers down one side.
  assert.match(main, /\.mod-drawer \{ position: fixed; top: 0; right: 0; bottom: 0;/);
  assert.match(chat, /\.cd-panel \{ position: fixed; z-index: 35; top: 0; right: 0; bottom: 0;/);
});
