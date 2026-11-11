// No dialog of DGC's own cuts its main action (reported 11 Nov: the Auto-mode dialog read "Enable A…" in the 104 px box).
// A dialog's main action that carries a mark, or whose words do not fit the button's box, takes the shared wide size
// (152 px; media/shared/tokens.css, "The button"): by its own rule where the words are fixed (Enable Auto, Delete
// permanently, Save and connect), and by src/buttonFit.js where they vary (a Pip's dialogs, Settings' dialogs).
// Measured in real Chromium, dark, light and high contrast:
//   - Work: the Auto-mode dialog and the goal dialog, on Work's real page
//   - a Pip's dialogs: Archive with changes waiting ("Reject them and archive"), in the real client (dark and light, the
//     themes its scene has), and every long confirm the client writes, drawn with the Pips bundle's stylesheet and the
//     fitting it runs (dark, light and high contrast)
//   - Settings' dialogs, with Settings' bundled stylesheet and the fitting it runs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { openAgentLines, settle } from "./support/agent-lines-scene.mjs";
import { READY } from "./support/work-buttons-scene.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

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

/** Each button matching `selector`: its words, whether they are cut or wrapped, its box, and whether it is filled. */
const actions = (page, selector, shadow = "") => page.evaluate(([sel, host]) => { const doc = host ? document.querySelector(host).shadowRoot : document;
  return [...doc.querySelectorAll(sel)].filter((b) => b.getBoundingClientRect().width > 0).map((b) => { const s = getComputedStyle(b), r = b.getBoundingClientRect(), fill = s.backgroundColor;
    return { word: b.textContent.trim().replace(/\s+/g, " "), cut: b.scrollWidth > b.clientWidth + 1, oneLine: s.whiteSpace === "nowrap" && Math.round(r.height) <= 28, width: Math.round(r.width), height: Math.round(r.height),
      filled: !/rgba\(0, 0, 0, 0\)|transparent/.test(fill), inside: r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5 }; }); }, [selector, shadow]);
const whole = (list, where) => { for (const b of list) { assert.equal(b.cut, false, `${where}: “${b.word}” is whole, not cut (${b.width} px)`); assert.ok(b.oneLine && b.inside, `${where}: “${b.word}” is one line, inside the dialog`);
  assert.ok([104, 152].includes(b.width) && b.height === 28, `${where}: “${b.word}” is the button's own box, or the one wide size (${b.width}x${b.height})`); } };

for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 700]) {
  test(`Work, ${theme} ${width}px: the Auto-mode dialog's and the goal dialog's main actions read whole`, async (t) => {
    if (skipOrFail(t)) return;
    for (const needsTrust of [false, true]) {
      const page = await openAgentLines(browser, { width, height: 760, theme, events: [READY, { host: { type: "autoModePrompt", requestId: "a".repeat(32), needsTrust } }] });
      try {
        await page.waitForSelector(".auto-mode-dialog .auto-mode-confirm"); await settle(page);
        const list = await actions(page, ".auto-mode-dialog .auto-mode-buttons button");
        assert.deepEqual(list.map((b) => [b.word, b.width]), [["Cancel", 104], [list[1].word, 152]], "Cancel in the box, the main action wide");
        // (In a workspace not yet trusted it says "Trust and enable", its spoken name "Trust and enable Auto": the longer words did not fit beside its mark.)
        assert.equal(list[1].word, needsTrust ? "Trust and enable" : "Enable Auto");
        if (needsTrust) assert.equal(await page.evaluate(() => document.querySelector(".auto-mode-confirm").getAttribute("aria-label")), "Trust and enable Auto");
        whole(list, "the Auto-mode dialog");
      } finally { await page.close(); }
    }
    const page = await openAgentLines(browser, { width, height: 760, theme, events: [READY] });
    try {
      // The goal dialog is in the page's own markup (src/panel.ts); it is shown as the page shows it.
      const shown = await page.evaluate(() => { const save = document.getElementById("goal-editor-save"), box = save?.closest("dialog, [role=dialog], .goal-dialog, #goal-editor"); if (!box) return false;
        if (typeof box.showModal === "function" && !box.open) box.showModal(); else { box.hidden = false; box.style.display = "block"; } return true; });
      assert.equal(shown, true, "the goal dialog is on Work's page");
      await settle(page);
      whole(await actions(page, ".goal-dialog-actions button"), "the goal dialog");
    } finally { await page.close(); }
  });
}

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`a Pip's dialog, ${theme} ${width}px: Archive with changes waiting says "Reject them and archive" whole, at the wide size`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, height: 900, theme, project: true, api: 81, settings: true, changes: ["schedule", "name"], motion: "no-preference" });
    try {
      await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
      await x.p.waitForSelector("#archive-pip"); await x.p.evaluate(() => (window.__pipsRoot || document).querySelector("#archive-pip").click());
      await x.p.waitForSelector("#review-root .dialog #review-confirm"); await x.p.waitForTimeout(300);
      const list = await actions(x.p, "#review-root .dialog .actions button", "#pips-host");
      assert.deepEqual(list.map((b) => [b.word, b.width]), [["Cancel", 104], ["Reject them and archive", 152]]);
      whole(list, "Archive");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

const bundle = async (file, loader) => (await build({ entryPoints: [new URL(`../src/${file}`, import.meta.url).pathname], bundle: true, write: false, format: "iife", outdir: "out", platform: "browser", target: "chrome108", loader })).outputFiles;
const pipsCss = (await bundle("pipsClient.js", { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" })).filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const settingsCss = (await bundle("settingsClient.js", { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" })).filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const fit = (await build({ entryPoints: [new URL("../src/buttonFit.js", import.meta.url).pathname], bundle: true, write: false, format: "iife", globalName: "ButtonFit", platform: "browser" })).outputFiles[0].text;
const VSCODE = { dark: ["vscode-dark", "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-editorWidget-background:#202020;--vscode-focusBorder:#0078d4;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;--vscode-errorForeground:#f85149;--vscode-inputValidation-errorBorder:#be1100"],
  light: ["vscode-light", "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-editorWidget-background:#f8f8f8;--vscode-focusBorder:#005fb8;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-errorForeground:#f85149;--vscode-inputValidation-errorBorder:#be1100"],
  hc: ["vscode-high-contrast", "--vscode-editor-background:#000000;--vscode-sideBar-background:#000000;--vscode-foreground:#ffffff;--vscode-editor-foreground:#ffffff;--vscode-descriptionForeground:#ffffff;--vscode-input-background:#000000;--vscode-editorWidget-background:#0c141f;--vscode-focusBorder:#f38518;--vscode-button-secondaryBackground:#000000;--vscode-button-secondaryForeground:#ffffff;--vscode-errorForeground:#f48771;--vscode-inputValidation-errorBorder:#be1100"] };
const doc = (theme, css, body, watch) => `<!doctype html><html><head><meta charset="utf-8"><style>:root{${VSCODE[theme][1]};--vscode-font-family:system-ui,sans-serif}</style><style>${css}</style></head><body class="${VSCODE[theme][0]}">${body}<script>${fit}</script><script>ButtonFit.watchButtons(document.body, ${JSON.stringify(watch)}, window);</script></body></html>`;

// Every confirm a Pip's dialog can say, read from the client's own source (the words after `confirm:`), drawn as the
// client draws a dialog (button.primary or button.danger #review-confirm in .dialog .actions) and fitted as it fits them.
const client = readFileSync(new URL("../src/pipsClient.js", import.meta.url), "utf8");
const CONFIRMS = [...new Set([...client.matchAll(/confirm:[^,}\n]{0,160}/g)].flatMap((m) => [...m[0].matchAll(/'([A-Z][^'$]{2,40})'/g)].map((w) => w[1])).concat(["Reject them and archive", "Reject it and archive", "Create and run once"]))];
test("the client's confirms are found in its source, the long ones among them", () => {
  assert.ok(CONFIRMS.length >= 25, `${CONFIRMS.length} confirms`);
  for (const word of ["Delete permanently", "Prepare setup card", "Approve and queue", "Review what it can do…", "Stop all Pips"]) assert.ok(CONFIRMS.includes(word), word);
  assert.match(client, /watchButtons\(shell,'#review-root \.dialog \.actions button',window\)/, "and the client fits its dialogs' buttons");
});
for (const theme of ["dark", "light", "hc"]) {
  test(`a Pip's dialogs, ${theme}: every confirm the client writes reads whole: in the box, or at the one wide size`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await browser.newPage({ viewport: { width: 420, height: 600 } });
    try {
      const body = `<div class="pip-app-root"><div id="review-root">${CONFIRMS.map((word, i) => `<div class="overlay" style="position:static;padding:4px"><section class="dialog" role="dialog"><div class="actions"><button type="button">Cancel</button><button type="button" class="${i % 2 ? "danger" : "primary"}" data-confirm>${word.replace(/&/g, "&amp;")}</button></div></section></div>`).join("")}</div></div>`;
      await p.setContent(doc(theme, pipsCss, body, "#review-root .dialog .actions button"), { waitUntil: "load" }); await p.waitForTimeout(250);
      const list = await actions(p, "[data-confirm]");
      assert.equal(list.length, CONFIRMS.length);
      whole(list, "a Pip's dialog");
      assert.ok(list.some((b) => b.width === 152) && list.some((b) => b.width === 104), "short words keep the box; long ones take the wide size");
    } finally { await p.close(); }
  });

  test(`Settings' dialogs, ${theme}: a dialog's main action reads whole`, async (t) => {
    if (skipOrFail(t)) return;
    const p = await browser.newPage({ viewport: { width: 520, height: 600 } });
    try {
      const words = ["Save", "Save provider", "Install and sign in", "Finish signing in", "Save and connect", "Connect account", "Create plugin", "Forget saved sign-in…"];
      const body = words.map((word) => `<dialog class="plugin-dialog" open style="position:static;margin:6px"><div class="dialog-footer"><button class="save" data-main>${word}</button><button class="secondary">Cancel</button></div></dialog>`).join("")
        + `<dialog class="plugin-dialog connection-dialog" open style="position:static;margin:6px"><div class="dialog-footer"><button class="save" data-main>Save and connect</button></div></dialog>`;
      await p.setContent(doc(theme, settingsCss, body, ".save, .install, .secondary, .fbtn"), { waitUntil: "load" }); await p.waitForTimeout(250);
      const list = await actions(p, "[data-main]");
      assert.equal(list.length, words.length + 1);
      whole(list, "Settings");
      assert.ok(list.every((b) => b.filled), "each is its dialog's filled button");
    } finally { await p.close(); }
  });
}
