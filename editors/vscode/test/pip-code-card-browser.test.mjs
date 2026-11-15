// The code card (0.52, Pips API 98), in real Chromium, on the two real pages: its card in the Pip's chat and its
// notification in the computer view. (Its words, the host's rules and its Needs attention row: pip-code-card.test.mjs.)
//   - the card: "<site> sent you a one-time code", the muted line, a code field, Send (primary) and Not now; Enter sends;
//   - sending ("Sending…", the field read-only), sent ("Sent", and "Signed in"), DGC's own words under the field when it
//     could not be sent (the field empty, to type again), the page that moved on, a card whose time is up or that was
//     answered somewhere else (no field);
//   - THE RULE: the typed code is never kept. Not in the page after it is sent, not in a saved state, not in storage,
//     not in a log, and in no message the page posts but the one fill_pip_code that carries it;
//   - one design language: the field and the buttons are the button family's (6 px, its heights), at 170 to 700 px,
//     dark and light, with a mouse and with a finger; no word broken or cut, nothing running off sideways.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat, PIP as CHAT_PIP } from "./support/pip-chat-scene.mjs";
import { openComputer, PIP } from "./support/pip-computer-scene.mjs";
import { narrowAudit } from "./support/narrow-audit.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const CODE = "K7Q482913";   // letters too: some sites' codes have them
const HOLD = "compact_" + "c".repeat(32), DIGEST = "d".repeat(64);
const SHOWN = "login.northwind-bank.example";
const FIELD = `input[data-code-field="${HOLD}"]`, CARD = `[data-code-card="${HOLD}"]`;

/** Where the code is, anywhere a page could keep it: the page itself (every shadow root, every box's value), each
 *  message it posted (by its type), each state it saved, its storage, its history, its cookies and its name. */
const kept = (p, code) => p.evaluate((word) => {
  const roots = [document]; const walk = (r) => { for (const n of r.querySelectorAll("*")) if (n.shadowRoot) { roots.push(n.shadowRoot); walk(n.shadowRoot); } }; walk(document);
  const has = (v) => { try { return String(typeof v === "string" ? v : JSON.stringify(v) ?? "").includes(word); } catch { return false; } };
  return {
    page: roots.some((r) => has(r === document ? document.documentElement.outerHTML : r.innerHTML)),
    boxes: roots.flatMap((r) => [...r.querySelectorAll("input,textarea,[contenteditable]")]).filter((b) => has(b.value) || has(b.defaultValue) || has(b.textContent) || [...b.attributes].some((a) => has(a.value))).length,
    posted: (window.__all || []).filter(has).map((m) => { const v = JSON.parse(m); return v.type === "pipsRequest" ? v.request.type : v.type; }),
    states: (window.__states || []).filter(has).length,
    storage: [localStorage, sessionStorage].filter((s) => has(Object.entries(s))).length,
    other: [history.state, document.cookie, window.name, window.__state].filter(has).length,
  };
}, code);
const NOWHERE = { page: false, boxes: 0, posted: [], states: 0, storage: 0, other: 0 };
const watchConsole = (p) => { const said = []; p.on("console", (m) => said.push(m.text())); return said; };
const sent = (p, type) => p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t), type);

// What the chat's card measures as.
const chatCard = (p, id) => p.evaluate((card) => {
  const root = window.__pipsRoot || document, c = root.querySelector(`[data-code-card="${card}"]`); if (!c) return null;
  const box = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, radius: s.borderTopLeftRadius }; };
  const field = c.querySelector("input[data-code-field]"), error = c.querySelector(".dgc-card-error"), said = c.querySelector(".code-card-said");
  const host = root.host || document.documentElement;
  return { state: c.dataset.codeState, box: box(c), title: c.querySelector(".dgc-card-words strong")?.textContent || "", line: c.querySelector(".dgc-card-words small")?.textContent || "",
    titleLines: (() => { const t = c.querySelector(".dgc-card-words strong"); return t ? Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)) : 0; })(),
    field: field ? { ...box(field), type: field.type, inputmode: field.getAttribute("inputmode"), autocomplete: field.getAttribute("autocomplete"), maxlength: field.getAttribute("maxlength"), readOnly: field.readOnly, disabled: field.disabled,
      value: field.value, focused: root.activeElement === field, label: field.getAttribute("aria-label"), name: field.getAttribute("name"), ground: getComputedStyle(field).backgroundColor } : null,
    buttons: [...c.querySelectorAll("button")].filter((b) => b.checkVisibility()).map((b) => ({ text: b.textContent, ...box(b), primary: b.classList.contains("primary"), disabled: b.disabled, clipped: b.scrollWidth > b.clientWidth + 1, submit: b.type === "submit" })),
    error: error ? { text: error.textContent, top: error.getBoundingClientRect().top, role: error.getAttribute("role") } : null,
    said: said ? said.textContent.replace(/\s+/g, " ").trim() : "",
    view: [innerWidth, innerHeight], sideways: document.documentElement.scrollWidth > innerWidth + 1 || c.scrollWidth > c.clientWidth + 1, hostWidth: host.getBoundingClientRect().width };
}, id);

const open = (opts = {}) => openChat(browser, { where: "side", width: 440, height: 720, api: 98, ...opts, code: { ...(opts.code || {}) } });

for (const theme of ["dark", "light"]) for (const width of [170, 300, 440, 700]) for (const touch of [false, true]) {
  test(`the card in the Pip's chat: its words, its field, Send and Not now, in the button family's shape (${width} px, ${theme}, ${touch ? "touch" : "mouse"})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme, touch, where: width >= 700 ? "tab" : "side" });
    try {
      const c = await chatCard(x.p, HOLD);
      assert.ok(c, "a code card is in the chat, where a login's card shows");
      assert.equal(c.state, "live");
      assert.equal(c.title, `${SHOWN} sent you a one-time code`);
      assert.match(c.line, /^Type it here and DGC fills it in for .+; the Pip never sees it\.$/);
      if (width >= 440) assert.equal(c.titleLines, 1, "the title is one line");
      assert.deepEqual([c.field.type, c.field.inputmode, c.field.autocomplete, c.field.maxlength, c.field.name], ["text", "numeric", "one-time-code", "12", null]);
      assert.equal(c.field.label, `One-time code from ${SHOWN}`, "the field says what it is to a screen reader");
      assert.deepEqual(c.buttons.map((b) => [b.text, b.primary, b.disabled]), [["Send", true, false], ["Not now", false, false]]);
      assert.equal(c.buttons[0].submit, true, "Enter in the field sends");
      for (const b of c.buttons) { assert.equal(b.radius, "6px", `“${b.text}” has the button corner, never a pill`); assert.equal(b.height, 28, `“${b.text}” is the standard height`); assert.equal(b.clipped, false, `“${b.text}” reads whole`);
        assert.ok(b.left >= c.box.left && b.right <= c.box.right + 0.5, `“${b.text}” is inside the card`); }
      assert.equal(c.field.radius, "6px", "the field has the same corner"); assert.equal(c.field.height, 28, "and the button's height");
      assert.ok(c.field.width >= 96, `the field has room for a code (${c.field.width}px)`);
      assert.ok(c.field.left >= c.box.left && c.field.right <= c.box.right + 0.5, "the field is inside the card");
      assert.ok(c.box.left >= 0 && c.box.right <= c.view[0] + 0.5, `the card is inside the page (${JSON.stringify(c.box)})`);
      assert.equal(c.sideways, false, "nothing runs off sideways");
      if (width >= 440) assert.equal(new Set([Math.round(c.field.top), ...c.buttons.map((b) => Math.round(b.top))]).size, 1, "the field and its two answers share one row");
      else assert.ok(c.buttons.every((b) => b.top >= c.field.bottom), "narrow: the field has its own row, the answers the next");
      const a = await x.p.evaluate(narrowAudit, { scope: "[data-code-card]" });
      assert.deepEqual({ broken: a.broken, cut: a.cut, clipped: a.clipped, sideways: a.sideways }, { broken: [], cut: [], clipped: [], sideways: [] }, "no word on two lines, none cut without “…”, no button's words cut");
      // A press on the field (a finger's tap or the mouse) puts the keyboard in it.
      if (touch) await x.p.tap(FIELD); else await x.p.click(FIELD);
      assert.equal((await chatCard(x.p, HOLD)).field.focused, true);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("typed and sent with Enter: one fill_pip_code for this Pip, this card and its digest; “Sending…” with the field read-only; then “Sent”", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ code: { after: 900 } });
  try {
    await x.p.click(FIELD); await x.p.keyboard.type("482 913");
    assert.equal(await x.p.inputValue(FIELD), "482913", "spaces are ignored as it is typed");
    await x.p.keyboard.press("Enter");
    await x.p.waitForSelector(`${CARD}[data-code-state="sending"]`);
    const going = await chatCard(x.p, HOLD);
    assert.deepEqual(going.buttons.map((b) => [b.text, b.disabled]), [["Sending…", true], ["Not now", true]]);
    assert.deepEqual([going.field.readOnly, going.field.value], [true, ""], "the field is read-only, and already empty");
    assert.equal(going.buttons[0].height, 28); assert.equal(going.buttons[0].clipped, false);
    await x.p.waitForSelector(`${CARD}[data-code-state="sent"]`);
    const done = await chatCard(x.p, HOLD);
    assert.equal(done.said, "Sent"); assert.equal(done.field, null, "no field once it is sent"); assert.deepEqual(done.buttons, []);
    assert.deepEqual(await sent(x.p, "fill_pip_code"), [{ type: "fill_pip_code", pip_id: CHAT_PIP, action_id: HOLD, expected_digest: DIGEST, code: "482913" }]);
    assert.equal((await sent(x.p, "decide_pip_computer_action")).length, 0);
    // Its own place is given back after a moment, and one quiet line stays under the reply that asked.
    await x.p.waitForSelector(CARD, { state: "detached", timeout: 9000 });
    await x.p.waitForSelector(`[data-computer-settled="${HOLD}"]`);
    assert.equal(await x.p.textContent(`[data-computer-settled="${HOLD}"]`), `Sent · One-time code for ${SHOWN}`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("signed in: the card says “Sent” and “Signed in”", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ code: { mode: "signed" } });
  try {
    await x.p.fill(FIELD, "482913"); await x.p.click(`${CARD} button[type=submit]`);
    await x.p.waitForSelector(`${CARD}[data-code-state="sent"]`);
    assert.equal((await chatCard(x.p, HOLD)).said, "Sent · Signed in");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const where of ["side", "tab"]) test(`THE RULE: the typed code is never kept. In the ${where === "side" ? "side bar" : "editor tab"}: not in the page after it is sent, not in a saved state, storage or a log, and in no posted message but fill_pip_code`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where, width: where === "tab" ? 700 : 440, code: { after: 500 } });
  const said = watchConsole(x.p);
  try {
    await x.p.click(FIELD); await x.p.keyboard.type(CODE.slice(0, 4));
    // While it is being typed it is in its field and nowhere else: no draft, no saved state, no message.
    await x.p.waitForTimeout(300);
    let now = await kept(x.p, CODE.slice(0, 4));
    assert.deepEqual({ posted: now.posted, states: now.states, storage: now.storage, other: now.other }, { posted: [], states: 0, storage: 0, other: 0 }, "typing it sends and saves nothing");
    assert.equal(now.page, false, "it is the field's own value, never written into the page's markup");
    await x.p.keyboard.type(CODE.slice(4));
    assert.equal(await x.p.inputValue(FIELD), CODE, "letters can be typed too");
    // The chat is redrawn under it (the page's own refresh, another card's change): what is typed stays, in the same field.
    await x.p.evaluate(() => window.postMessage({ type: "pipsConnection", apiVersion: 98, generation: 1, connected: true, supported: true, enabled: true }, "*"));
    await x.p.waitForTimeout(700);
    assert.equal(await x.p.inputValue(FIELD), CODE, "a redraw of the chat does not lose what is being typed");
    await x.p.keyboard.press("Enter");
    await x.p.waitForSelector(`${CARD}[data-code-state="sending"]`);
    now = await kept(x.p, CODE);
    assert.deepEqual(now, { ...NOWHERE, posted: ["fill_pip_code"] }, "while it is sent: gone from the page, and one message carries it");
    // The field's own undo history does not have it either.
    await x.p.focus(FIELD); await x.p.keyboard.press("Control+z"); await x.p.keyboard.press("Control+z");
    assert.equal(await x.p.inputValue(FIELD), "", "Undo does not bring it back");
    await x.p.waitForSelector(`${CARD}[data-code-state="sent"]`);
    await x.p.waitForTimeout(400);
    now = await kept(x.p, CODE);
    assert.deepEqual(now, { ...NOWHERE, posted: ["fill_pip_code"] }, "after it is sent");
    assert.equal((await sent(x.p, "fill_pip_code")).length, 1, "sent once");
    // And after the page has gone round again (its refresh, the card leaving, its line arriving).
    await x.p.waitForSelector(CARD, { state: "detached", timeout: 9000 });
    assert.deepEqual(await kept(x.p, CODE), { ...NOWHERE, posted: ["fill_pip_code"] }, "after the card has gone");
    assert.deepEqual(said.filter((line) => line.includes(CODE)), [], "no log has it");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("DGC could not send it: its own words under the field, the field empty and ready, and the next try is sent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ code: { mode: "busy" } });
  try {
    await x.p.fill(FIELD, CODE); await x.p.press(FIELD, "Enter");
    await x.p.waitForSelector(`${CARD} .dgc-card-error`);
    const c = await chatCard(x.p, HOLD);
    assert.equal(c.state, "live");
    assert.deepEqual([c.error.text, c.error.role], ["The Pip is using its computer right now. Try again when it stops.", "alert"]);
    assert.ok(c.error.top >= c.field.bottom, "the line is under the field");
    assert.deepEqual([c.field.value, c.field.readOnly, c.field.focused], ["", false, true], "the field is cleared, and the keyboard is back in it");
    assert.deepEqual(c.buttons.map((b) => [b.text, b.disabled]), [["Send", false], ["Not now", false]]);
    assert.deepEqual(await kept(x.p, CODE), { ...NOWHERE, posted: ["fill_pip_code"] }, "the code that failed is kept nowhere either");
    // Typing again takes the line away without losing a letter; the second try goes.
    await x.p.evaluate(() => { window.__code.mode = "ok"; });
    await x.p.keyboard.type("11");
    await x.p.waitForSelector(`${CARD} .dgc-card-error`, { state: "detached" });
    await x.p.keyboard.type("22");
    assert.equal(await x.p.inputValue(FIELD), "1122", "the redraw that takes the line away keeps the caret and what was typed");
    await x.p.keyboard.press("Enter");
    await x.p.waitForSelector(`${CARD}[data-code-state="sent"]`);
    assert.deepEqual((await sent(x.p, "fill_pip_code")).map((r) => r.code), [CODE, "1122"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("what cannot be a code is not sent: the card says how to type it, and the field is cleared", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.click(`${CARD} button[type=submit]`);
    await x.p.waitForSelector(`${CARD} .dgc-card-error`);
    assert.equal((await chatCard(x.p, HOLD)).error.text, "Type the code first.");
    await x.p.fill(FIELD, "12;DROP"); await x.p.press(FIELD, "Enter");
    await x.p.waitForFunction((card) => (window.__pipsRoot || document).querySelector(`[data-code-card="${card}"] .dgc-card-error`)?.textContent.startsWith("Type the code as"), HOLD);
    const c = await chatCard(x.p, HOLD);
    assert.equal(c.error.text, "Type the code as the site shows it: letters and numbers, up to 12.");
    assert.equal(c.field.value, "");
    assert.equal((await sent(x.p, "fill_pip_code")).length, 0, "nothing was sent");
    assert.deepEqual(await kept(x.p, "12;DROP"), NOWHERE);
    // A paste with spaces keeps every digit (the length limit counts the code, not its spaces).
    await x.p.click(FIELD);
    await x.p.evaluate((sel) => { const box = (window.__pipsRoot || document).querySelector(sel), data = new DataTransfer(); data.setData("text", " 4829 1377 1204 ");
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true })); }, FIELD);
    assert.equal(await x.p.inputValue(FIELD), "482913771204");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the page had moved on (lost): the card says so and that the Pip will ask again, with no field", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ code: { mode: "lost" } });
  try {
    await x.p.fill(FIELD, CODE); await x.p.press(FIELD, "Enter");
    await x.p.waitForSelector(`${CARD}[data-code-state="lost"]`);
    const c = await chatCard(x.p, HOLD);
    assert.match(c.said, /^The page moved on before the code came\. .+ will ask again\.$/);
    assert.equal(c.field, null); assert.deepEqual(c.buttons.map((b) => b.text), ["OK"]);
    assert.equal(c.buttons[0].radius, "6px"); assert.equal(c.buttons[0].height, 28);
    assert.deepEqual(await kept(x.p, CODE), { ...NOWHERE, posted: ["fill_pip_code"] });
    await x.p.click(`${CARD} button`);
    await x.p.waitForSelector(CARD, { state: "detached" });
    assert.equal(await x.p.textContent(`[data-computer-settled="${HOLD}"]`), `The page moved on · One-time code for ${SHOWN}`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("its ten minutes are up (expired): the card says so, and the field goes with whatever was typed in it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ code: { expiresIn: 2500 } });
  try {
    await x.p.fill(FIELD, CODE);
    await x.p.waitForSelector(`${CARD}[data-code-state="expired"]`, { timeout: 9000 });
    const c = await chatCard(x.p, HOLD);
    assert.match(c.said, /wasn’t typed in time/); assert.equal(c.field, null, "no field");
    assert.deepEqual(c.buttons.map((b) => b.text), ["OK"]);
    assert.deepEqual(await kept(x.p, CODE), NOWHERE, "what was typed went with the field");
    assert.equal((await sent(x.p, "fill_pip_code")).length, 0);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("answered somewhere else: the card says so and has no field", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.fill(FIELD, CODE);
    await x.p.evaluate(() => Object.assign(window.__code.hold, { status: "rejected", resolved_at: new Date().toISOString(), resolved_by: "local-console" }));
    await x.p.waitForSelector(`${CARD}[data-code-state="elsewhere"]`, { timeout: 15000 });
    const c = await chatCard(x.p, HOLD);
    assert.equal(c.said, "Answered somewhere else."); assert.equal(c.field, null);
    assert.deepEqual(await kept(x.p, CODE), NOWHERE);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Not now: the card is put off (decide, approve false), what was typed is gone, and no code is sent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.fill(FIELD, CODE);
    await x.p.click(`${CARD} button:has-text("Not now")`);
    await x.p.waitForSelector(CARD, { state: "detached" });
    assert.deepEqual(await sent(x.p, "decide_pip_computer_action"), [{ type: "decide_pip_computer_action", action_id: HOLD, expected_digest: DIGEST, approve: false }]);
    assert.equal((await sent(x.p, "fill_pip_code")).length, 0);
    assert.deepEqual(await kept(x.p, CODE), NOWHERE);
    await x.p.waitForSelector(`[data-computer-settled="${HOLD}"]`);
    assert.equal(await x.p.textContent(`[data-computer-settled="${HOLD}"]`), `Not now · One-time code for ${SHOWN}`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("an older DGC (Pips API 97) has no code card: nothing is drawn for one, least of all a form to send", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ api: 97, code: { wait: false } });
  try {
    await x.p.waitForTimeout(900);
    assert.equal(await x.p.locator("[data-code-card], [data-computer-card], input[data-code-field]").count(), 0);
    assert.equal(await x.p.locator(".pip-approval-dock").count(), 0);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Needs attention on the Pips page: “Type the code for <site>”, and its row opens the Pip's chat at the card with the keyboard in the field", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ home: true, code: { attention: true } });
  try {
    const row = x.p.locator(`[data-attention="computer_action:${HOLD}"]`);
    await x.p.waitForFunction((id) => [...(window.__pipsRoot || document).querySelectorAll("[data-attention-key]")].some((li) => li.dataset.attentionKey === id), `computer_action:${HOLD}`).catch(() => {});
    // (The one-card view shows the newest first; go to this card if another is showing.)
    for (let i = 0; i < 12 && !(await row.count()); i++) { const next = x.p.locator("#attention-next:not([disabled])"); if (!(await next.count())) break; await next.click(); }
    await row.waitFor();
    await x.p.waitForFunction((id) => (window.__pipsRoot || document).querySelector(`[data-attention="${id}"] strong`)?.textContent.startsWith("Type the code"), `computer_action:${HOLD}`);
    assert.equal(await row.locator("strong").textContent(), `Type the code for ${SHOWN}`);
    assert.doesNotMatch(await row.textContent(), /Send this on/);
    await row.click();
    await x.p.waitForSelector(CARD);
    await x.p.waitForFunction((sel) => { const root = window.__pipsRoot || document; return root.activeElement === root.querySelector(sel); }, FIELD);
    assert.equal((await chatCard(x.p, HOLD)).state, "live");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- The computer view's notification.
const action = (summary = {}, more = {}) => ({ id: HOLD, pip_id: PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
  summary: { method: "CODE", host: SHOWN, path: "/verify", page: `https://${SHOWN}/verify`, fields: [], more_fields: 0, body_bytes: 0, kind: "code", site: "northwind-bank.example", shown: SHOWN, login: "login_" + "1".repeat(32), filled: ["username", "password"], ...summary },
  digest: DIGEST, frame: null, status: "pending", created_at: new Date(Date.now() - 20000).toISOString(), expires_at: new Date(Date.now() + 9 * 60000).toISOString(), resolved_at: null, resolved_by: null, continuation_run_id: null, ...more });
const NOTE = `.pc-card[data-card="${HOLD}"]`;
const note = (p) => p.evaluate((sel) => {
  const c = document.querySelector(sel); if (!c) return null;
  const box = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, radius: s.borderTopLeftRadius }; };
  const field = c.querySelector("input[data-code-field]");
  return { kind: c.dataset.kind, state: c.dataset.state, box: box(c), title: c.querySelector(".pc-card-open")?.textContent || "", line: c.querySelector(".pc-card-line")?.textContent || "",
    field: field ? { ...box(field), type: field.type, inputmode: field.getAttribute("inputmode"), autocomplete: field.getAttribute("autocomplete"), maxlength: field.getAttribute("maxlength"), readOnly: field.readOnly, value: field.value, focused: document.activeElement === field,
      over: document.elementFromPoint((field.getBoundingClientRect().left + field.getBoundingClientRect().right) / 2, (field.getBoundingClientRect().top + field.getBoundingClientRect().bottom) / 2) === field } : null,
    buttons: [...c.querySelectorAll(".pc-card-actions button")].filter((b) => b.checkVisibility()).map((b) => ({ text: b.textContent, ...box(b), solid: b.classList.contains("solid"), disabled: b.disabled, clipped: b.scrollWidth > b.clientWidth + 1 })),
    error: c.querySelector(".pc-card-error")?.textContent ?? null, done: c.querySelector(".pc-card-done")?.textContent ?? null, said: c.querySelector(".pc-card-note")?.textContent ?? null,
    view: [innerWidth, innerHeight], sideways: document.documentElement.scrollWidth > innerWidth + 1 };
}, NOTE);

for (const theme of ["dark", "light"]) for (const width of [440, 1100]) {
  test(`the computer view's notification offers the card's field, Send and Not now, in the notification's own shape; a code typed there reaches DGC and never the computer (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const chat = await open({ theme });
    const x = await openComputer(browser, { width, height: 700, theme, api: 98, actions: [action()], code: "signed", codeAfter: 700 });
    const said = watchConsole(x.p);
    try {
      await x.p.waitForSelector(`${NOTE} input[data-code-field]`);
      const inChat = await chatCard(chat.p, HOLD), n = await note(x.p);
      assert.equal(n.kind, "code");
      assert.equal(n.title, inChat.title, "the same title as the chat's card");
      assert.match(n.line, /^Type it here and DGC fills it in for .+; the Pip never sees it\.$/);
      assert.deepEqual(n.buttons.map((b) => [b.text, b.solid]), inChat.buttons.map((b) => [b.text, b.primary]), "the same answers, the same order, the same solid one");
      assert.deepEqual([n.field.type, n.field.inputmode, n.field.autocomplete, n.field.maxlength], [inChat.field.type, inChat.field.inputmode, inChat.field.autocomplete, inChat.field.maxlength], "the same field");
      const heights = new Set([n.field.height, ...n.buttons.map((b) => b.height)]);
      assert.deepEqual([...heights], [26], "the field is the notification's answers' own height");
      for (const b of [n.field, ...n.buttons]) { assert.equal(b.radius, "6px", "the button corner, never a pill"); assert.ok(b.left >= n.box.left && b.right <= n.box.right, "inside the card"); }
      for (const b of n.buttons) assert.equal(b.clipped, false, `“${b.text}” reads whole`);
      assert.ok(n.box.left >= 0 && n.box.right <= width + 0.5, "the card is inside the page"); assert.equal(n.sideways, false);
      assert.equal(n.field.over, true, "the field can be pressed (the card's own press-to-open is not over it)");
      // Typed there: DGC's page takes the keys, the computer gets none of them.
      const keysBefore = x.rfb().keys.length, pointersBefore = x.rfb().pointers;
      await x.p.click(`${NOTE} input[data-code-field]`); await x.p.keyboard.type(CODE.slice(0, 5));
      // The drawer is redrawn under it (another card arrives): what is typed stays, and the keyboard stays in the field.
      await x.scene({ actions: [action(), { ...action({ kind: "site", site: "news.example", shown: "news.example", method: "GET", host: "news.example", path: "/" }), id: "compact_" + "e".repeat(32), digest: "e".repeat(64) }] });
      await x.p.waitForSelector(`.pc-card[data-card="${"compact_" + "e".repeat(32)}"]`, { timeout: 9000 });
      let now = await note(x.p);
      assert.deepEqual([now.field.value, now.field.focused], [CODE.slice(0, 5), true], "kept across the redraw, with the caret");
      await x.p.keyboard.type(CODE.slice(5));
      assert.equal((await note(x.p)).field.value, CODE);
      { const typing = await kept(x.p, CODE); assert.deepEqual({ ...typing, boxes: 0 }, { ...NOWHERE }, "typing it sends and saves nothing, and writes nothing into the page"); assert.equal(typing.boxes, 1, "it is in its one field"); }
      await x.p.keyboard.press("Enter");
      await x.p.waitForFunction((sel) => document.querySelector(sel)?.querySelector("button[type=submit]")?.textContent === "Sending…", NOTE);
      now = await note(x.p);
      assert.deepEqual(now.buttons.map((b) => [b.text, b.disabled]), [["Sending…", true], ["Not now", true]]);
      assert.deepEqual([now.field.readOnly, now.field.value], [true, ""]);
      assert.deepEqual(await kept(x.p, CODE), { ...NOWHERE, posted: ["fill_pip_code"] });
      await x.p.waitForSelector(`${NOTE} .pc-card-done`);
      now = await note(x.p);
      assert.equal(now.done, "Sent · Signed in"); assert.equal(now.field, null);
      assert.deepEqual(await sent(x.p, "fill_pip_code"), [{ type: "fill_pip_code", pip_id: PIP.id, action_id: HOLD, expected_digest: DIGEST, code: CODE }], "this Pip, this card, its digest, the code: nothing else");
      assert.deepEqual([x.rfb().keys.length, x.rfb().pointers], [keysBefore, pointersBefore], "nothing typed or pressed on the notification reached the computer");
      await x.p.waitForTimeout(500);
      assert.deepEqual(await kept(x.p, CODE), { ...NOWHERE, posted: ["fill_pip_code"] }, "after it is sent: nowhere in the page, its saved state or its storage");
      assert.deepEqual(said.filter((line) => line.includes(CODE)), [], "no log has it");
      assert.deepEqual([chat.errors, x.errors], [[], []]);
    } finally { await chat.close(); await x.close(); }
  });
}

test("the notification when DGC could not send it, when the page had moved on, and Not now", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 1100, height: 700, api: 98, actions: [action()], code: "error" });
  try {
    await x.p.waitForSelector(`${NOTE} input[data-code-field]`);
    await x.p.fill(`${NOTE} input[data-code-field]`, CODE); await x.p.press(`${NOTE} input[data-code-field]`, "Enter");
    await x.p.waitForSelector(`${NOTE} .pc-card-error`);
    let n = await note(x.p);
    assert.equal(n.error, "The Pip is using its computer right now. Try again when it stops.");
    assert.deepEqual([n.field.value, n.field.readOnly, n.field.focused], ["", false, true]);
    assert.deepEqual(n.buttons.map((b) => [b.text, b.disabled]), [["Send", false], ["Not now", false]]);
    assert.deepEqual(await kept(x.p, CODE), { ...NOWHERE, posted: ["fill_pip_code"] });
    await x.scene({ code: "lost" });
    await x.p.keyboard.type("5566"); await x.p.keyboard.press("Enter");
    await x.p.waitForSelector(`${NOTE} .pc-card-note`);
    n = await note(x.p);
    assert.match(n.said, /^The page moved on before the code came\. .+ will ask again\.$/); assert.equal(n.field, null); assert.deepEqual(n.buttons, []);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const y = await openComputer(browser, { width: 1100, height: 700, api: 98, actions: [action()] });
  try {
    await y.p.waitForSelector(`${NOTE} input[data-code-field]`);
    await y.p.fill(`${NOTE} input[data-code-field]`, CODE);
    await y.p.click(`${NOTE} button:has-text("Not now")`);
    await y.p.waitForSelector(`${NOTE} .pc-card-done`);
    assert.equal((await note(y.p)).done, "Not now");
    assert.deepEqual(await sent(y.p, "decide_pip_computer_action"), [{ type: "decide_pip_computer_action", action_id: HOLD, expected_digest: DIGEST, approve: false }]);
    assert.equal((await sent(y.p, "fill_pip_code")).length, 0);
    assert.deepEqual(await kept(y.p, CODE), NOWHERE);
    assert.deepEqual(y.errors, []);
  } finally { await y.close(); }
});

test("an older DGC (Pips API 97): the computer view draws no notification for a code", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { width: 1100, height: 700, api: 97, actions: [action()] });
  try {
    await x.p.waitForTimeout(900);
    assert.equal(await x.p.locator(`${NOTE}, input[data-code-field]`).count(), 0);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
