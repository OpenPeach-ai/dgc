// The button's fourth role, danger (media/shared/tokens.css, "The button"; asked 11 Nov: "a red danger look kept for
// risky confirms"): the same fixed boxes, corner, step, press and ring as every button, with a red fill made from the
// theme's error colour and white words at 4.5:1 or better, and the system's own colours in high contrast. It is only
// for DGC's own confirms that can't easily be undone, and it replaces the normal fill there: still one filled button a
// view. Measured in real Chromium:
//   - the role itself (.dgc-btn.danger), dark, light and high contrast (the theme, and forced colours)
//   - the Auto-mode dialog's Enable Auto, on Work's real page
//   - Settings' own Remove confirms (a system, an image generator, an MCP server), with Settings' bundled stylesheet
//   - deleting an archived Pip for good, with the Pips bundle's stylesheet; Archive, which can be restored, stays an outline
// (Undo of a fix is asked in VS Code's own modal, which is not DGC's to draw. Settings and Pips are drawn with the very
// markup their pages write, read from their source below.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { openAgentLines, settle } from "./support/agent-lines-scene.mjs";
import { READY } from "./support/work-buttons-scene.mjs";
import { probe, answers } from "./support/buttons-probe.mjs";

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

const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
/** A button as drawn: its fill and words (and their contrast), its box and corner, and whether its fill is the danger token's. */
const danger = (page, selector, shadow = "") => page.evaluate(([sel, host]) => {
  const doc = host ? document.querySelector(host).shadowRoot : document, b = doc.querySelector(sel), s = getComputedStyle(b), r = b.getBoundingClientRect();
  const parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g).map(Number); return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255] : m.slice(0, 3); };
  const lum = (c) => { const [x, y, z] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
  const fill = parse(s.backgroundColor), ink = parse(s.color), [hi, lo] = [lum(fill), lum(ink)].sort((p, q) => q - p);
  const p = document.createElement("i"); (b.parentElement || document.body).append(p); p.style.backgroundColor = "var(--btn-danger)"; const token = getComputedStyle(p).backgroundColor; p.style.backgroundColor = "var(--btn-fill)"; const plain = getComputedStyle(p).backgroundColor; p.remove();
  return { word: b.textContent.trim(), fill: s.backgroundColor, isRole: s.backgroundColor === token, isPlainFill: s.backgroundColor === plain, red: fill[0] > fill[1] + 60 && fill[0] > fill[2] + 60, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
    width: Math.round(r.width), height: Math.round(r.height), radius: s.borderTopLeftRadius, edge: s.borderTopColor, whole: b.scrollWidth <= b.clientWidth + 1, moves: s.transitionProperty.includes("transform") };
}, [selector, shadow]);

test("the role is written once, with the button's other tokens", () => {
  const css = readFileSync(new URL("../media/shared/tokens.css", import.meta.url), "utf8");
  for (const name of ["--btn-danger", "--btn-danger-hover", "--btn-on-danger"]) assert.match(css, new RegExp(`${name}\\s*:`), `${name} is defined`);
  assert.match(css, /--btn-danger:\s*var\(--vscode-inputValidation-errorBorder, #BE1100\)/, "its red is the editor's own error red, never DGC's own --err");
  assert.doesNotMatch(css.match(/--btn-danger[^;]*;/g).join(""), /--err\b/);
  assert.match(css, /\.dgc-btn\.danger/, "and the button itself has the role");
  assert.match(css.slice(css.indexOf("forced-colors: active", css.indexOf("--btn-danger"))), /--btn-danger/, "high contrast gives it the system's colours");
});

for (const [theme, forcedColors] of [["dark-modern", false], ["light-modern", false], ["hc", false], ["dark-modern", true]]) {
  test(`${theme}${forcedColors ? " with forced colours" : ""}: a danger button is the same box and corner, red, its words at 4.5:1, and steps like any button`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openAgentLines(browser, { width: 460, theme, events: [READY], forcedColors });
    try {
      await page.evaluate(() => document.getElementById("log").insertAdjacentHTML("beforeend", '<div id="dz" style="display:flex;gap:8px;padding:12px"><button type="button" class="dgc-btn danger" id="d1">Delete</button><button type="button" class="dgc-btn">Cancel</button><button type="button" class="dgc-btn small danger" id="d2">Remove</button><button type="button" class="dgc-btn wide danger" id="d3">Delete permanently…</button><button type="button" class="dgc-btn danger" id="d4" disabled>Delete</button></div>'));
      await settle(page);
      const [roomy, small, wide] = [await danger(page, "#d1"), await danger(page, "#d2"), await danger(page, "#d3")];
      assert.deepEqual([[roomy.width, roomy.height], [small.width, small.height], [wide.width, wide.height]], [[104, 28], [76, 22], [152, 28]], "the fixed boxes: roomy, small, wide");
      assert.deepEqual([roomy.radius, roomy.isRole, roomy.moves, wide.whole], ["6px", true, true, true], "the shared corner; the role's own fill; ready to step");
      if (!forcedColors) assert.equal(roomy.isPlainFill, false, "not the normal fill");
      const ring = await page.evaluate(async () => { const b = document.getElementById("d1"); b.focus({ focusVisible: true }); await new Promise((r) => requestAnimationFrame(r)); const s = getComputedStyle(b); return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1; });
      assert.equal(ring, true, "the same ring");
      for (const b of [roomy, small, wide]) assert.ok(b.ratio >= 4.5, `${b.word}: its words read at 4.5:1 on its fill (${b.ratio}, ${b.fill})`);
      if (!forcedColors) assert.equal(roomy.red, true, `red (${roomy.fill})`);
      else assert.equal(roomy.red, false, `forced colours: the system's own colour, not a red of ours (${roomy.fill})`);
      const a = await answers(page, page.locator("#d1"));
      assert.deepEqual([a.rest.y, a.pointed.y, a.pointed.ms, a.pressed.y, a.pressed.scale, a.pressed.ms], [0, -1, "0.15s", 1, 0.985, "0.09s"], "the same step and press");
      if (!forcedColors) assert.notEqual(a.pointed.fill, a.rest.fill, "its fill answers the pointer");
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("d4")).opacity), "0.55", "dimmed when off");
    } finally { await page.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: the Auto-mode dialog's Enable Auto is the danger button, the dialog's one filled button`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openAgentLines(browser, { width, height: 760, theme, events: [READY, { host: { type: "autoModePrompt", requestId: "a".repeat(32), needsTrust: false } }] });
    try {
      await page.waitForSelector(".auto-mode-dialog .auto-mode-confirm"); await settle(page);
      const yes = await danger(page, ".auto-mode-dialog .auto-mode-confirm");
      assert.deepEqual([yes.word, yes.isRole, yes.red, yes.width, yes.height, yes.radius, yes.whole], ["Enable Auto", true, true, 152, 28, "6px", true], "red again; with its mark beside its words it is the one wide size, and reads whole");
      assert.equal(await page.evaluate(() => document.querySelector(".auto-mode-confirm .codicon").checkVisibility()), true, "its warning mark is there");
      if (theme !== "hc") assert.equal(yes.fill, "rgb(190, 17, 0)", "the editor's error red, #BE1100");
      assert.ok(yes.ratio >= 4.5, `its words read at 4.5:1 (${yes.ratio})`);
      const found = await page.evaluate(probe, { root: ".auto-mode-dialog", buttons: ".auto-mode-buttons button" });
      const cancel = found.buttons.find((b) => b.word === "Cancel");
      assert.deepEqual([cancel.kind, cancel.width, Math.round(cancel.height)], ["outline", 104, 28], "Cancel is the outline, the same box");
      assert.equal(found.buttons.filter((b) => b.kind === "filled").length, 0, "no second, normal fill beside it");
      assert.ok(found.buttons.every((b) => b.left >= 0 && b.right <= width), "both inside the dialog's width");
      if (process.env.SHOTS && theme !== "hc") await page.screenshot({ path: `${process.env.SHOTS}/auto-mode-${theme.replace("-modern", "")}-${width}.png` });   // SHOTS=<folder> saves what was painted
    } finally { await page.close(); }
  });
}

const settingsCss = (await build({ entryPoints: [new URL("../src/settingsClient.js", import.meta.url).pathname], bundle: true, write: false, format: "iife", outdir: "out", platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } }))
  .outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const pipsCss = (await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false, format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } }))
  .outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const VSCODE = { dark: ["vscode-dark", "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;--vscode-panel-border:#2b2b2b;--vscode-widget-border:#313131;--vscode-editorWidget-background:#202020;--vscode-focusBorder:#0078d4;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-errorForeground:#f85149"],
  light: ["vscode-light", "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;--vscode-panel-border:#e5e5e5;--vscode-widget-border:#e5e5e5;--vscode-editorWidget-background:#f8f8f8;--vscode-focusBorder:#005fb8;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-errorForeground:#f85149"],
  hc: ["vscode-high-contrast", "--vscode-editor-background:#000000;--vscode-sideBar-background:#000000;--vscode-foreground:#ffffff;--vscode-editor-foreground:#ffffff;--vscode-descriptionForeground:#ffffff;--vscode-input-background:#000000;--vscode-input-border:#6fc3df;--vscode-panel-border:#6fc3df;--vscode-widget-border:#6fc3df;--vscode-editorWidget-background:#0c141f;--vscode-focusBorder:#f38518;--vscode-button-secondaryBackground:#000000;--vscode-button-secondaryForeground:#ffffff;--vscode-errorForeground:#f48771"] };
const doc = (theme, css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>:root{${VSCODE[theme][1]};--vscode-font-family:system-ui,sans-serif}</style><style>${css}</style></head><body class="${VSCODE[theme][0]}"><main id="sample" style="display:grid;gap:16px;padding:16px;max-width:560px">${body}</main></body></html>`;

// Settings' own confirms, as its pages write them (src/settingsRouter.js, settingsImages.js, settingsClient.js).
const SETTINGS = `<div class="router-confirm" role="group" aria-label="Remove GPU box"><span>Remove GPU box? Its saved key goes too.</span><button type="button" class="secondary danger" data-router-remove-yes="gpu">Remove</button><button type="button" class="secondary" data-router-remove-no>Keep it</button></div>
  <div class="banner danger-confirm" role="alertdialog" aria-label="Remove server"><p>Remove local-files? Its saved sign-in goes with it.</p><div class="actions"><button type="button" class="secondary danger" id="mcp-remove-yes">Remove it</button><button type="button" class="link" id="mcp-confirm-no">Keep it</button></div></div>
  <div class="actions" id="row"><button type="button" class="secondary danger" id="asks">Remove</button><button type="button" class="save" id="save">Save</button></div>`;
test("Settings' pages still write their Remove confirms this way", () => {
  assert.match(src("settingsRouter.js"), /class="router-confirm"[\s\S]{0,200}class="secondary danger" data-router-remove-yes=/);
  assert.match(src("settingsImages.js"), /class="router-confirm"[\s\S]{0,260}class="secondary danger"/);
  assert.match(src("settingsClient.js"), /class="banner danger-confirm"[\s\S]{0,200}class="secondary danger" id="mcp-remove-yes"/);
});
for (const theme of ["dark", "light", "hc"]) {
  test(`${theme}: in Settings, Remove inside its own confirm is the danger button; the Remove that only asks stays an outline`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await browser.newPage({ viewport: { width: 620, height: 420 } });
    try {
      await p.setContent(doc(theme, settingsCss, SETTINGS), { waitUntil: "load" }); await p.waitForTimeout(120);
      for (const sel of ["[data-router-remove-yes]", "#mcp-remove-yes"]) {
        const b = await danger(p, sel);
        assert.deepEqual([b.isRole, b.red, b.width, b.height, b.radius, b.whole], [true, true, 104, 28, "6px", true], `${sel} (${b.word}): the danger button, the roomy box`);
        assert.ok(b.ratio >= 4.5, `${b.word}: 4.5:1 (${b.ratio})`);
      }
      const asks = await danger(p, "#asks"), keep = await danger(p, "[data-router-remove-no]"), save = await danger(p, "#save");
      assert.deepEqual([asks.fill, asks.isRole], ["rgba(0, 0, 0, 0)", false], "the Remove that opens the question is an outline with red words, not a fill");
      assert.deepEqual([keep.fill, keep.width, save.isPlainFill, save.isRole], ["rgba(0, 0, 0, 0)", 104, true, false], "Keep it is the outline, the same box; Save keeps the normal fill");
      if (process.env.SHOTS && theme !== "hc") await p.screenshot({ path: `${process.env.SHOTS}/settings-remove-${theme}.png` });
    } finally { await p.close(); }
  });
}

// A Pip's dialog, as src/pipsClient.js writes it: deleting an archived Pip for good asks for its name; Archive does not.
const dialog = (permanent) => `<div class="pip-app-root"><div id="review-root"><div class="overlay" style="position:static"><section class="dialog" role="dialog" aria-modal="true"><h2>${permanent ? "Delete Billing review for good?" : "Archive Billing review?"}</h2><p>${permanent ? "Its chat, runs and findings are deleted. This can’t be undone." : "It stops running. You can restore it later."}</p>
  ${permanent ? '<label>Type Billing review to confirm<input id="deletePipName" data-draft="deletePipName" value="" autocomplete="off"></label>' : ""}<div class="actions"><button type="button" id="review-cancel">Cancel</button><button type="button" id="review-confirm" class="danger">${permanent ? "Delete permanently" : "Archive"}</button></div></section></div></div></div>`;
test("a Pip's dialog is still written this way", () => {
  const client = src("pipsClient.js");
  assert.match(client, /r\.permanentPip\?`<label>Type [\s\S]{0,120}<input id="deletePipName"/, "deleting for good asks for the Pip's name");
  assert.match(client, /button\('review-confirm',[\s\S]{0,120}r\.danger\?'danger':'primary'\)/, "a risky confirm is button.danger#review-confirm");
});
for (const theme of ["dark", "light", "hc"]) {
  test(`${theme}: deleting an archived Pip for good is the danger button, at the one wide size; Archive, which can be restored, stays an outline`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await browser.newPage({ viewport: { width: 520, height: 420 } });
    try {
      await p.setContent(doc(theme, pipsCss, dialog(true)), { waitUntil: "load" }); await p.waitForTimeout(120);
      const yes = await danger(p, "#review-confirm"), cancel = await danger(p, "#review-cancel");
      assert.deepEqual([yes.word, yes.isRole, yes.red, yes.width, yes.height, yes.radius, yes.whole], ["Delete permanently", true, true, 152, 28, "6px", true]);
      assert.ok(yes.ratio >= 4.5, `4.5:1 (${yes.ratio})`);
      assert.deepEqual([cancel.fill, cancel.width, cancel.height], ["rgba(0, 0, 0, 0)", 104, 28], "Cancel is the outline");
      if (process.env.SHOTS && theme !== "hc") await p.screenshot({ path: `${process.env.SHOTS}/pip-delete-${theme}.png` });
      await p.setContent(doc(theme, pipsCss, dialog(false)), { waitUntil: "load" }); await p.waitForTimeout(120);
      const archive = await danger(p, "#review-confirm");
      assert.deepEqual([archive.fill, archive.isRole, archive.width], ["rgba(0, 0, 0, 0)", false, 104], "Archive: an outline with red words, as before");
    } finally { await p.close(); }
  });
}
