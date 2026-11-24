// The pixel pass (0.52), each measured in real Chromium on the real page, as it is drawn:
//   - the added-lines green on a light theme: "+2" in the files-changed card read 2.0:1 (the dark theme's green on
//     white). As words it clears 4.5:1; as a mark (an added line's rail, a dot) 3:1. The dark theme keeps its green.
//   - the account chooser in the narrowest side bar (170 px): "Use another account" was cut ("Use another a…") where
//     each answer already had a row of its own; its words wrap onto a second line there, never cut.
//   - a Pip computer's tab on a light theme: its face in the slim bar is a soft-coloured plush on a white bar, its edge
//     about 2 to 3:1 against it. There it wears a hairline of the text's colour, so its shape stands off the bar.
//   - the Pips list: a redraw (a Pip's state, a pin) dropped the keyboard's focus from a menu's button that has no id
//     (Teams, Project pages, a Pip's More): the focus stays on the button, and in its open menu.
//   - Keep Pips running fails while Controls is open: the menu lay over the page's error line, so its × could not be
//     reached. The menu closes when the switch reports a failure, and the focus goes to Controls.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openOnePips, GST, MORNINGS } from "./support/one-pips-scene.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";
import { openComputer, PIP as COMPUTER_PIP } from "./support/pip-computer-scene.mjs";
import { openWork } from "./support/uir2a-scene.mjs";
import { inks } from "./support/muted-probe.mjs";

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

// ---- the added-lines green ------------------------------------------------------------------------------------------------
const DIFF = "--- a/src/upload.py\n+++ b/src/upload.py\n@@ -1,3 +1,4 @@\n import os\n-LIMIT = 10\n+LIMIT = int(os.environ.get('LIMIT', 10))\n+PLAN = 'pro'\n def read():\n";
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
const rgb = (s) => String(s).match(/[\d.]+/g).slice(0, 3).map(Number);
async function editedTurn(theme, width) {
  const x = await openWork(browser, { width, theme, prompts: ["hello"] });
  const id = await x.say("Move the limit into settings.");
  await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "t9", prompt: "" });
  await x.event({ type: "tool_call", call_id: "c1", name: "edit_file", args: { path: "src/upload.py" } });
  await x.event({ type: "tool_result", call_id: "c1", name: "edit_file", output: DIFF, is_diff: true, diff: DIFF });
  await x.event({ type: "text_delta", text: "Done." }); await x.event({ type: "stream_end", message_id: "t9:1", phase: "final" });
  await x.event({ type: "turn_end", turn_id: "t9", status: "completed", reason: "completed", usage: {} });
  await x.page.waitForSelector(".turn-summary .change-add");
  // (The card starts folded to its header since 24 Nov: its files' rows are read once it is opened.)
  await x.page.click(".turn-summary .ts-fold"); await x.page.waitForSelector(".turn-summary .ts-list:not([hidden])");
  return x;
}
for (const theme of ["light-modern", "dark-modern"]) for (const width of [300, 700]) {
  test(`the lines added and removed read at 4.5:1 as words, and an added line's rail at 3:1 as a mark (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await editedTurn(theme, width);
    try {
      const rows = (await inks(x.page)).filter((r) => /change-add|change-del/.test(r.what));
      assert.ok(rows.filter((r) => /change-add/.test(r.what)).length >= 2 && rows.some((r) => /change-del/.test(r.what)), `the card shows its counts: ${JSON.stringify(rows.map((r) => r.text))}`);
      assert.deepEqual(rows.filter((r) => r.ratio < 4.5).map((r) => `${r.what} “${r.text}” is rgb(${r.color}) on rgb(${r.ground}), ${r.ratio}:1`), [], "every count reads at 4.5:1");
      // The rail of an added line in a diff, and the green a dot or a tick wears: the colour over the page's ground.
      const marks = await x.page.evaluate(() => { const probe = document.createElement("i"); document.body.append(probe);
        const read = (v) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
        const out = { good: read("--good"), bg: read("--bg"), surface: read("--surface"), rail: getComputedStyle(document.querySelector(".diff .add")).boxShadow }; probe.remove(); return out; });
      assert.match(marks.rail, /inset/, "an added line has its rail");
      assert.deepEqual(rgb(marks.rail), rgb(marks.good), "the rail is the green token");
      assert.ok(ratio(rgb(marks.good), rgb(marks.bg)) >= 3, `the green as a mark on the page's ground: ${marks.good} on ${marks.bg}, ${ratio(rgb(marks.good), rgb(marks.bg))}:1`);
      assert.ok(ratio(rgb(marks.good), rgb(marks.surface)) >= 3, `and on a raised ground: ${marks.good} on ${marks.surface}, ${ratio(rgb(marks.good), rgb(marks.surface))}:1`);
      // Still a green, in both themes (never a grey or the accent).
      const [r, g, b] = rgb(marks.good); assert.ok(g > r + 40 && g > b + 20, `a green: ${marks.good}`);
      if (theme === "dark-modern") assert.deepEqual(rgb(marks.good), [91, 203, 139], "the dark theme keeps its green");
    } finally { await x.page.close(); }
  });
}

// ---- the account chooser at the narrowest side bar ----------------------------------------------------------------------
const click = (p, sel) => p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);
for (const theme of ["dark", "light"]) for (const width of [170, 220]) {
  test(`the account chooser at ${width} px: every answer's words are whole, each on a row of its own (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, height: 1000, theme, where: "side", api: 88, settings: true, apps: true, convs: true });
    try {
      await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-apps [data-pip-app]");
      await click(x.p, '[data-pip-app-add="gmail"]');
      await x.p.waitForSelector('.app-link[data-state="requested"] [data-app-link-start]'); await click(x.p, '.app-link[data-state="requested"] [data-app-link-start]');
      await x.p.waitForSelector("[data-app-link-account]");
      const a = await x.p.evaluate(() => { const root = window.__pipsRoot || document, card = root.querySelector(".app-link[data-app-link]"), c = card.getBoundingClientRect();
        return [...card.querySelectorAll(".dgc-card-actions > button")].map((b) => { const r = b.getBoundingClientRect(), s = getComputedStyle(b), range = document.createRange(); range.selectNodeContents(b); const w = range.getBoundingClientRect();
          const room = r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
          return { text: b.textContent.trim(), whole: b.scrollWidth <= b.clientWidth + 0.5 && w.width <= room + 0.5 && w.top >= r.top - 0.5 && w.bottom <= r.bottom + 0.5, top: Math.round(r.top), height: Math.round(r.height), inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5, radius: s.borderTopLeftRadius, dots: s.textOverflow }; }); });
      assert.deepEqual(a.map((b) => b.text), ["Use another account", "Not now"]);
      assert.deepEqual(a.filter((b) => !b.whole).map((b) => b.text), [], `no answer's words are cut: ${JSON.stringify(a)}`);
      assert.ok(a.every((b) => b.inside), "each inside its card");
      assert.equal(new Set(a.map((b) => b.top)).size, 2, "each answer on a row of its own");
      assert.ok(a.every((b) => b.radius === "6px"), "the shared corner");
      assert.ok(a.every((b) => b.height >= 28), "never shorter than the shared button");
      assert.equal(a[1].height, 28, "an answer whose words fit keeps the shared height");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- a Pip computer's tab: its face in the slim bar -----------------------------------------------------------------------
const TYPES = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
/** The face as it is painted: of the lines that cross its box (each row and each column, from both ends), the share on
    which, within 2 px of where the face begins, a pixel stands off the bar's ground by 3:1. */
const edgeOf = (page, png) => page.evaluate(async (b64) => {
  const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height, scale = W / 30;
  const lum = (r, gg, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b); };
  const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; }, g0 = at(0, 0), ground = lum(...g0);
  const off = (p) => { const l = lum(...p); return (Math.max(l, ground) + 0.05) / (Math.min(l, ground) + 0.05); };
  const isGround = (p) => Math.abs(p[0] - g0[0]) + Math.abs(p[1] - g0[1]) + Math.abs(p[2] - g0[2]) < 10;
  const reach = Math.round(2 * scale); let lines = 0, clear = 0;
  const walk = (get, n) => { let first = -1; for (let k = 0; k < n; k++) if (!isGround(get(k))) { first = k; break; } if (first < 0) return; lines++;
    for (let k = first; k < Math.min(n, first + reach + 1); k++) if (off(get(k)) >= 3) { clear++; return; } };
  for (let y = 0; y < H; y++) { walk((k) => at(k, y), W); walk((k) => at(W - 1 - k, y), W); }
  for (let x = 0; x < W; x++) { walk((k) => at(x, k), H); walk((k) => at(x, H - 1 - k), H); }
  return { lines, share: lines ? Math.round((clear / lines) * 100) : 0, ground: g0 };
}, png.toString("base64"));
async function barFace(theme, type) {
  const x = await openComputer(browser, { width: 1100, height: 700, theme });
  // (The scene serves no art: the faces' sprite and mask come from media/, as the editor serves them, and are asked for again.)
  await x.p.route(/pc\.test\/ext\/media\/pips\//, (r) => r.fulfill({ body: readFileSync(new URL(`../media/pips/${new URL(r.request().url()).pathname.split("/").pop()}`, import.meta.url)) }));
  await x.p.evaluate((pip) => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipComputerInit", pip, desktop: true } })), { ...COMPUTER_PIP, pip_type: type });
  await x.p.waitForFunction((t) => document.querySelector(".pc-face .dgc-plush")?.dataset.character === t, type);
  await x.p.evaluate(async () => { const all = [...document.querySelectorAll(".pc-face image")];
    await Promise.all(all.map((im) => new Promise((done) => { im.addEventListener("load", done, { once: true }); im.addEventListener("error", done, { once: true }); im.setAttribute("href", `${im.getAttribute("href").split("?")[0]}?face=1`); })));
    for (const a of document.getAnimations()) a.pause(); });
  const box = await x.p.evaluate(() => { const b = document.querySelector(".pc-face").getBoundingClientRect(); return { x: b.left - 4, y: b.top - 4, width: b.width + 8, height: b.height + 8 }; });
  const read = await edgeOf(x.p, await x.p.screenshot({ clip: box }));
  return { ...x, read, box };
}
test("a Pip computer's tab on a light theme: every character's face is drawn as it is, with no ring round it", async (t) => {
  // (A ring of the text colour lifted their edges past 3:1, but it made the plush faces look stickered: the face is an
  // illustration beside the Pip's name, not text, so it stays as it is drawn.)
  if (skipOrFail(t)) return;
  for (const type of TYPES) {
    const x = await barFace("light", type);
    try {
      assert.ok(x.read.lines >= 60, `${type}: the face is painted (${x.read.lines} lines cross it)`);
      assert.equal(await x.p.evaluate(() => getComputedStyle(document.querySelector(".pc-face")).filter), "none", `${type}: no ring`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
test("a Pip computer's tab on a dark theme: the faces are as they were (no line round them)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await barFace("dark", "core");
  try {
    assert.equal(await x.p.evaluate(() => getComputedStyle(document.querySelector(".pc-face")).filter), "none");
    assert.ok(x.read.lines >= 60 && x.read.share >= 80, `painted, and the lighter thing on its bar: ${JSON.stringify(x.read)}`);
  } finally { await x.close(); }
});

// ---- the Pips list: the keyboard's focus through a redraw ----------------------------------------------------------------
async function pipsList(opts = {}) {
  const { width = 300, theme = "dark-modern", answers } = opts;
  const x = await openOnePips(browser, { theme, width, height: 760, where: width >= 600 ? "tab" : "side", scene: { fix: "ask", unread: { [GST]: { id: "msg_" + "7".repeat(32), latest: "Tonight's check found 3 things." } }, ...(answers ? { answers } : {}) } });
  await x.inPips((root) => { window.__redraws = 0;
    new MutationObserver((list) => { if (list.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.("[data-job]") || n.querySelector?.("[data-job]"))))) window.__redraws++; }).observe(root, { childList: true, subtree: true }); });
  let pinned = false;
  /** The list draws itself again, with new nodes (a Pip pinned to the dock or taken off it), and has done so. */
  const redraw = async () => { const n = await x.page.evaluate(() => window.__redraws); pinned = !pinned;
    await x.send({ type: "dock", pinned: pinned ? [`pip:${MORNINGS}`] : [] });
    await x.page.waitForFunction((was) => window.__redraws > was, n); };
  const focus = () => x.inPips((root) => { const a = root.activeElement; return a ? { tag: a.tagName, id: a.id, label: a.getAttribute("aria-label") || a.textContent.trim().slice(0, 40), menu: a.closest("details")?.dataset.details || "", inPage: a.isConnected } : null; });
  return { ...x, redraw, focus };
}
for (const width of [300, 700]) {
  test(`the Pips list: a redraw leaves the keyboard on a menu's button that has no id, and in its open menu (Teams, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await pipsList({ width });
    try {
      await x.inPips((root) => root.querySelector("details.team-menu > summary").focus());
      assert.deepEqual([(await x.focus()).tag, (await x.focus()).label], ["SUMMARY", "Teams"]);
      await x.redraw();
      assert.deepEqual(await x.focus(), { tag: "SUMMARY", id: "", label: "Teams", menu: "team-menu", inPage: true }, "the focus is still on Teams after the list drew itself again");
      // Open, by the keyboard, and into its rows: a redraw leaves the menu open and the focus on the same row.
      await x.page.keyboard.press("Enter");
      await x.page.waitForFunction(() => (document.getElementById("pips-host")?.shadowRoot || document).querySelector("details.team-menu[open]"));
      await x.redraw();
      assert.deepEqual([(await x.focus())?.label, await x.inPips((root) => !!root.querySelector("details.team-menu[open]"))], ["Teams", true], "open, the focus on its button, through a redraw");
      await x.page.keyboard.press("ArrowDown");
      const row = await x.focus();
      assert.deepEqual([row.tag, row.menu], ["BUTTON", "team-menu"], "Down goes into the menu");
      await x.redraw();
      assert.deepEqual(await x.focus(), row, "and the focus stays on that row through a redraw");
      await x.page.keyboard.press("Escape");
      assert.deepEqual([(await x.focus())?.label, await x.inPips((root) => !!root.querySelector("details.team-menu[open]"))], ["Teams", false], "Escape closes it and the focus is back on Teams");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- Keep Pips running fails while Controls is open ----------------------------------------------------------------------
const KEEP = { platform: "linux", supported: true, reason: "", on: false, starts_at_login: false, restarts_after_failure: false, while_logged_out: false };
const NOTIFY = { available: true, last: null, on: false, platform: "linux" };
const WHY = { message: "Could not register the service: the user service manager is not running." };
// (The menu's other switch, Desktop notifications, says its failure on the same line: the same rule.)
for (const [width, theme, box, name] of [[300, "dark-modern", "keep-running", "Keep Pips running"], [700, "light-modern", "keep-running", "Keep Pips running"], [170, "dark-modern", "keep-running", "Keep Pips running"], [300, "light-modern", "desktop-notifications", "Desktop notifications"]]) {
  test(`${name} fails with Controls open: the menu closes, the error line's × can be reached, the focus is on Controls (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await pipsList({ width, theme, answers: { get_pips_keep_running: { keep_running: KEEP }, set_pips_keep_running: { error: WHY }, get_pips_desktop_notifications: { desktop_notifications: NOTIFY }, set_pips_desktop_notifications: { error: WHY } } });
    try {
      await x.waitIn(`#${box}`);
      await x.inPips((root) => root.querySelector("#runner-controls-toggle").click());
      await x.waitIn(`details.runner-controls[open] #${box}`);
      await x.inPips((root, id) => { const sw = root.querySelector(`#${id}`); sw.focus(); sw.click(); }, box);
      await x.waitIn('[data-dismiss-note="error"]');
      // (Until the switch has finished: the page is no longer busy with it.)
      await x.page.waitForFunction(() => { const root = document.getElementById("pips-host")?.shadowRoot || document; return !root.querySelector("#keep-running[aria-busy='true']"); });
      const m = await x.inPips((root, id) => { const dismiss = root.querySelector('[data-dismiss-note="error"]'), r = dismiss.getBoundingClientRect();
        const top = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), a = root.activeElement;
        return { says: dismiss.closest(".notice, [role='alert'], p, div")?.textContent.trim().slice(0, 60), open: !!root.querySelector("details.runner-controls[open]"), reach: top === dismiss || dismiss.contains(top), over: top ? `${top.tagName}.${String(top.className).slice(0, 40)}` : "",
          focus: a ? a.id || a.tagName : "", box: root.querySelector(`#${id}`).checked }; }, box);
      assert.match(m.says, /Could not register the service/, "the page says why");
      assert.equal(m.open, false, "the Controls menu has closed");
      assert.equal(m.reach, true, `the error line's × is what a pointer on it reaches (it reaches ${m.over})`);
      assert.equal(m.focus, "runner-controls-toggle", "the focus is on Controls, not lost with the menu");
      assert.equal(m.box, false, "and the switch is as it was: off");
      // The × takes the line away; Controls opens again as before.
      await x.inPips((root) => root.querySelector('[data-dismiss-note="error"]').click());
      assert.equal(await x.inPips((root) => !!root.querySelector('[data-dismiss-note="error"]')), false);
      await x.inPips((root) => root.querySelector("#runner-controls-toggle").click());
      await x.waitIn(`details.runner-controls[open] #${box}`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
