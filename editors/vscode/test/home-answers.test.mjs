// Answered on the card (media/main.js, media/shared/hub.js and hub.css, src/pipHomeStrip.js): a card on Home that shows
// everything needed to decide takes its answer there, held for a moment with Undo. Measured in real Chromium on the side
// bar's real page (support/dock-scene.mjs), with a stub DGC that records every request. Both sides of the line:
//   - a new Pip: Create / Reject on the card; one that also gets a computer only opens
//   - a Pip's change to itself: Apply / Not now; a handoff and an email only open
//   - a Pip visiting a new site: Allow / Not now; a payment and an order step only open
//   - a Work session's command, shown whole: Allow once / Deny, never Always allow; a long command, and a session that
//     waits on something else, only open
//   - the answer is held with Undo, and sent when the moment passes; Undo sends nothing
//   - what changed since it was shown is refused, never answered blind
// (The host's side, a session's command reaching Home and the answer reaching that session, is in session-tabs.test.mjs.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { homeContrast, homeState, pipId, P } from "./support/home-scene.mjs";

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

const settle = (page, ms = 60) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);

// ---- what waits ------------------------------------------------------------------------------------------------------
const SETUP = "setup_" + "7".repeat(32), SETUP_BIG = "setup_" + "8".repeat(32), PROPOSAL = "proposal-" + "3".repeat(12), HANDOFF = "handoff_" + "4".repeat(32);
const VISIT = "compact_" + "5".repeat(32), PAY = "compact_" + "6".repeat(32), ORDER = "compact_" + "9".repeat(32), MAIL = "maildraft_" + "1".repeat(32);
const setup = (id, name, goal, more = {}) => ({ id, digest: "a".repeat(64), workspace_id: P, project_root: "/private/pips", pip_id: null, name, goal, pip_type: "rook", work_kind: "personal_task", source_ref: "HEAD",
  schedule: null, run_now: false, next_run_at: null, status: "pending", created_at: "2099-10-02T04:00:00Z", expires_at: "2099-10-02T06:00:00Z", receipt: null, reason: "You asked.", expected_version: null,
  expected_lifecycle_revision: null, permissions: "read_only", source_policy: "personal", runner_notice: "Runs only while Pips are on.", scope_notice: "Reads only what you share.", run_now_policy: null, ...more });
const held = (id, pip, summary) => ({ id, pip_id: pip, workspace_id: P, run_id: "run_" + "b".repeat(32), summary: { method: "GET", host: "", path: "", page: "", fields: [], more_fields: 0, body_bytes: 0, ...summary },
  digest: "d".repeat(64), frame: null, status: "pending", created_at: "2026-11-03T09:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null });
const waits = (kind, card, c, name, type, title, detail, more = {}) => ({ id: `${kind}:${card}`, kind, card, pip_id: c ? pipId(c) : null, pip_name: name, pip_type: type, workspace_id: P, title, detail,
  created_at: "2026-11-03T09:00:00.000Z", expires_at: null, ...more });
/** Six Pips wait, one thing each, and two new Pips: one of each kind on each side of the line. */
function waiting() {
  const state = homeState("quiet");
  const pip = (c, name, type) => ({ id: pipId(c), name, pip_type: type, workspace_id: P, status: "active", pending_review_count: 0, version: 1, current_version: 4 });
  state.list[P] = [pip("a", "Core", "core"), pip("b", "Mail watch", "scout"), pip("c", "Morning brief", "quill"), pip("d", "Garden notes", "lens"), pip("f", "Shop helper", "rook"), pip("0", "Travel desk", "pulse"), pip("1", "Order desk", "lock")];
  const items = [waits("setup", SETUP, null, "Receipts", "rook", "Create the Pip “Receipts”?", "File each receipt from my mail."),
    waits("setup", SETUP_BIG, null, "Shopper", "rook", "Create the Pip “Shopper”?", "Find the best price."),
    waits("computer_action", VISIT, "d", "Garden notes", "lens", "Visit seeds.example?", "https://seeds.example/tomatoes"),
    waits("computer_action", PAY, "f", "Shop helper", "rook", "Pay on shop.example?", "Order 1182 · 42.00"),
    waits("computer_action", ORDER, "1", "Order desk", "lock", "Send this on shop.example?", "2 × large"),
    waits("email", MAIL, "b", "Mail watch", "scout", "A reply to send", "To: someone new")];
  const reviews = [waits("approval", PROPOSAL, "c", "Morning brief", "quill", "Change Morning brief?", "Run at 7:00 instead of 9:00", { review: "schedule_update" }),
    waits("handoff", HANDOFF, "0", "Travel desk", "pulse", "Hand this to Travel desk?", "Book the ferry")];
  state.attention = { as_of: "2026-11-03T12:00:00.000Z", total: 8, items, reviews, truncated: false, counts: { setup: 2, computer_action: 3, email: 1 },
    by_pip: { [pipId("b")]: 1, [pipId("c")]: 1, [pipId("d")]: 1, [pipId("f")]: 1, [pipId("0")]: 1, [pipId("1")]: 1 }, projects: {} };
  state.setups = { [SETUP]: setup(SETUP, "Receipts", "File each receipt from my mail."), [SETUP_BIG]: setup(SETUP_BIG, "Shopper", "Find the best price.", { computer: true }) };
  const computer = (c, action) => ({ pip_id: pipId(c), granted: true, available: true, reason: "", pending: 1, actions: [action] });
  state.computers = { [pipId("d")]: computer("d", held(VISIT, pipId("d"), { kind: "site", site: "seeds.example", shown: "seeds.example", host: "seeds.example", path: "/tomatoes" })),
    [pipId("f")]: computer("f", held(PAY, pipId("f"), { method: "POST", host: "shop.example", path: "/pay", page: "https://shop.example/cart", payment: true, asks_because: "payment", fields: [{ name: "amount", value: "42.00" }], body_bytes: 40 })),
    [pipId("1")]: computer("1", held(ORDER, pipId("1"), { method: "POST", host: "shop.example", path: "/order", page: "https://shop.example/cart", asks_because: "maybe_payment", asks_word: "order", fields: [{ name: "size", value: "large" }], body_bytes: 14 })) };
  return state;
}
const K = { setup: `setup:${SETUP}`, big: `setup:${SETUP_BIG}`, change: `pip:${pipId("c")}`, handoff: `pip:${pipId("0")}`, visit: `pip:${pipId("d")}`, pay: `pip:${pipId("f")}`, order: `pip:${pipId("1")}`, mail: `pip:${pipId("b")}` };
const RUN = { ...DOCK_SESSIONS[2], name: "Plan the 0.52 release notes", waiting: true, running: true, ask: { id: "perm-1", command: "npm test -- --run" } };
const EDIT = { ...DOCK_SESSIONS[1], name: "Rename the watering helpers", waiting: true, running: true };
const LONG = { ...DOCK_SESSIONS[3], name: "Nightly export", waiting: true, running: true, ask: { id: "perm-2", command: `find . -name "*.log" -mtime +30 -print0 | xargs -0 -n 50 tar --append --file=/var/backups/old-logs-$(date +%F).tar && find . -name "*.log" -mtime +30 -delete && echo done ${"x".repeat(60)}` } };
const WORK = { run: `work:${RUN.id}`, edit: `work:${EDIT.id}`, long: `work:${LONG.id}` };

/** Opens Home with it all waiting. The moment an answer is held for (6 s) is the test's to end: `pass()` ends it. */
async function open(options = {}) {
  const x = await openDock(browser, { tab: "home", state: waiting(), sessions: [RUN, EDIT, LONG], width: 700, height: 1400, ...options });
  await x.page.evaluate(() => { const later = window.setTimeout.bind(window); window.__holds = [];
    window.setTimeout = (fn, ms, ...rest) => (ms === 6000 ? (window.__holds.push(fn), 900000 + window.__holds.length) : later(fn, ms, ...rest));
    const clear = window.clearTimeout.bind(window); window.clearTimeout = (id) => { if (id > 900000) window.__holds[id - 900001] = null; else clear(id); }; });
  // (More than eight need you here: the rest are shown too.)
  if (await x.page.locator('#home-hub .dgc-hub-rest[data-group="needs"]').count()) { await x.page.click('#home-hub .dgc-hub-rest[data-group="needs"]'); await settle(x.page); }
  const card = async (key) => (await x.hub()).cards.find((c) => c.key === key);
  const press = async (key, act) => { await x.page.click(`.dgc-hub-card[data-key="${key}"] [data-hub-act="${act}"]`); await settle(x.page); };
  /** The moment to undo passes: what was held is sent, and Home has drawn what DGC then said. */
  const pass = async () => { const from = await x.page.evaluate(() => window.__answered.length);
    const n = await x.page.evaluate(() => { const due = window.__holds.filter(Boolean); window.__holds = []; due.forEach((fn) => fn()); return due.length; });
    await settle(x.page, 120);
    await x.page.waitForFunction(() => window.__asking === 0, null, { timeout: 30000 }); await settle(x.page, 120);
    return { fired: n, from }; };
  const asked = (...types) => x.page.evaluate((t) => window.__requests.filter((r) => t.includes(r.type)), types);
  return { ...x, card, press, pass, asked };
}
const answers = (c) => c.actions;

test("a new Pip is created or rejected on its card; one that also gets a computer only opens", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const c = await x.card(K.setup);
    assert.deepEqual(answers(c), ["Create*", "Reject", "Review"], "Create and Reject on the card, and the way to all of it");
    assert.equal(c.title, "Create the Pip “Receipts”?");
    assert.equal(c.line, "File each receipt from my mail. · Runs when you ask", "what it does and when it runs, whole");
    assert.deepEqual(answers(await x.card(K.big)), ["Review*"], "a new Pip with a computer has more to check than a card shows");
    await x.press(K.setup, "yes");
    const said = await x.card(K.setup);
    assert.deepEqual([said.title, answers(said), said.held], ["Created Receipts.", ["Undo"], true], "it says what was chosen, with Undo");
    assert.deepEqual(await x.asked("accept_pip_setup", "reject_pip_setup"), [], "nothing is sent while it can be undone");
    assert.deepEqual((await x.pass()).fired, 1);
    assert.deepEqual(await x.asked("accept_pip_setup", "reject_pip_setup"), [{ type: "accept_pip_setup", setup_id: SETUP, expected_digest: "a".repeat(64) }], "the Pips page's own command, on what the card showed");
    assert.equal(await x.card(K.setup), undefined, "answered: the card is gone");
    assert.deepEqual(answers(await x.card(K.big)), ["Review*"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Reject on a new Pip's card is held with Undo: Undo sends nothing and the card is as it was; left alone, it is rejected", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.page.focus(`.dgc-hub-card[data-key="${K.setup}"] [data-hub-act="no"]`);
    await x.page.keyboard.press("Enter"); await settle(x.page);
    const said = await x.card(K.setup);
    assert.deepEqual([said.title, answers(said)], ["Rejected. No Pip was created.", ["Undo"]]);
    assert.equal((await x.hub()).focus, `${K.setup}/undo`, "the keyboard is on Undo");
    await x.page.keyboard.press("Enter"); await settle(x.page);
    assert.deepEqual(answers(await x.card(K.setup)), ["Create*", "Reject", "Review"], "undone: it waits again");
    assert.equal((await x.pass()).fired, 0, "nothing was left to send");
    assert.deepEqual(await x.asked("accept_pip_setup", "reject_pip_setup"), []);
    await x.press(K.setup, "no"); await x.pass();
    assert.deepEqual(await x.asked("accept_pip_setup", "reject_pip_setup"), [{ type: "reject_pip_setup", setup_id: SETUP, expected_digest: "a".repeat(64) }]);
    assert.equal(await x.card(K.setup), undefined);
  } finally { await x.close(); }
});

test("a Pip's change to itself is applied or put off on its card; a handoff and an email to send only open", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const c = await x.card(K.change);
    assert.deepEqual([c.title, c.line, answers(c)], ["Change Morning brief?", "Run at 7:00 instead of 9:00", ["Apply*", "Not now", "Review"]]);
    assert.deepEqual(answers(await x.card(K.handoff)), ["Review*"], "a handoff opens");
    assert.deepEqual(answers(await x.card(K.mail)), ["Review*"], "sending to someone is never answered here");
    await x.press(K.change, "yes");
    assert.deepEqual([(await x.card(K.change)).title, answers(await x.card(K.change))], ["Applied. Morning brief is changed.", ["Undo"]]);
    await x.pass();
    assert.deepEqual(await x.asked("accept_pip_update", "reject_pip_update"), [{ type: "accept_pip_update", pip_id: pipId("c"), proposal_id: PROPOSAL, expected_version: 4 }]);
    assert.equal(await x.card(K.change), undefined);
    assert.deepEqual(await x.asked("accept_pip_handoff", "send_pip_message"), []);
  } finally { await x.close(); }
});

test("Not now on a Pip's change sends the Pips page's reject", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.press(K.change, "no");
    assert.equal((await x.card(K.change)).title, "Not now. Morning brief stays as it was.");
    await x.pass();
    assert.deepEqual(await x.asked("accept_pip_update", "reject_pip_update"), [{ type: "reject_pip_update", pip_id: pipId("c"), proposal_id: PROPOSAL, expected_version: 4 }]);
  } finally { await x.close(); }
});

test("a Pip visiting a new site is allowed or not on its card; a payment and an order step only open", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const c = await x.card(K.visit);
    assert.deepEqual([c.title, c.line, answers(c)], ["Visit seeds.example?", "seeds.example/tomatoes", ["Allow*", "Not now", "Review"]]);
    assert.deepEqual(answers(await x.card(K.pay)), ["Review*"], "a payment is never answered here");
    assert.deepEqual(answers(await x.card(K.order)), ["Review*"], "nor a pay, buy or order step");
    await x.press(K.visit, "yes");
    assert.equal((await x.card(K.visit)).title, "Allowed. Garden notes opens seeds.example.");
    await x.pass();
    assert.deepEqual(await x.asked("decide_pip_computer_action", "always_allow_pip_computer_action"), [{ type: "decide_pip_computer_action", action_id: VISIT, expected_digest: "d".repeat(64), approve: true }]);
    assert.equal(await x.card(K.visit), undefined);
    assert.deepEqual(answers(await x.card(K.pay)), ["Review*"]);
  } finally { await x.close(); }
});

test("what changed since the card showed it is refused, and Home says so: nothing is answered blind", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.press(K.visit, "yes");
    // Meanwhile the held step became another one (the same id can not, but its digest says what was shown).
    await x.page.evaluate(([pip]) => { window.__state.computers[pip].actions[0].digest = "e".repeat(64); }, [pipId("d")]);
    await x.pass();
    assert.deepEqual(await x.asked("decide_pip_computer_action"), [], "no decision was sent");
    assert.ok((await x.hub()).notes.includes("This changed since it was shown. Open it to answer."), JSON.stringify((await x.hub()).notes));
    assert.ok(await x.card(K.visit), "it still waits");
  } finally { await x.close(); }
});

test("a Work session's command is shown whole and answered on its card: Allow once or Deny, never Always allow", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const c = await x.card(WORK.run);
    assert.deepEqual([c.title, c.line, answers(c)], ["Wants to run this command", "npm test -- --run", ["Allow once*", "Deny", "Open"]]);
    assert.ok(!answers(c).some((a) => /always/i.test(a)), "Always allow stays in the session");
    assert.equal(await x.page.evaluate((key) => { const n = document.querySelector(`.dgc-hub-card[data-key="${key}"] .dgc-card-note`); return n.scrollWidth <= n.clientWidth && /mono|Consolas|Menlo/i.test(getComputedStyle(n).fontFamily); }, WORK.run), true,
      "the command, whole, in the code face");
    const edit = await x.card(WORK.edit);
    assert.deepEqual([edit.title, edit.line, answers(edit)], ["Wants your okay to go on", "", ["Open*"]], "a session that waits on something else (a file change, a question) opens");
    await x.press(WORK.run, "yes");
    assert.deepEqual([(await x.card(WORK.run)).title, answers(await x.card(WORK.run))], ["Allowed once. It runs the command.", ["Undo"]]);
    assert.deepEqual(await x.posted("homeSessionAnswer"), [], "nothing is sent while it can be undone");
    await x.pass();
    assert.deepEqual(await x.posted("homeSessionAnswer"), [{ type: "homeSessionAnswer", session: RUN.id, id: "perm-1", decision: "once" }], "the host is told which session, which request and the answer");
    assert.equal(await x.card(WORK.run), undefined, "answered: the card is gone");
    // The host's next list says it runs on.
    await x.send({ type: "sessions_list", items: [{ ...RUN, waiting: false, ask: undefined }, EDIT, LONG], error: "" }); await settle(x.page);
    assert.equal(await x.card(WORK.run), undefined);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Deny on a session's command, and Open still opens the session", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.press(WORK.run, "open");
    assert.deepEqual((await x.posted("openSessionInEditor")).map((m) => m.id), [RUN.id]);
    await x.press(WORK.run, "no");
    assert.equal((await x.card(WORK.run)).title, "Denied. The command won’t run.");
    await x.press(WORK.run, "undo");
    assert.deepEqual(answers(await x.card(WORK.run)), ["Allow once*", "Deny", "Open"]);
    await x.press(WORK.run, "no"); await x.pass();
    assert.deepEqual(await x.posted("homeSessionAnswer"), [{ type: "homeSessionAnswer", session: RUN.id, id: "perm-1", decision: "deny" }]);
  } finally { await x.close(); }
});

test("a command too long to show whole is never answered on the card: it opens, at 700 px and at 300 px", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const long = await x.card(WORK.long);
    assert.deepEqual([long.line, answers(long)], ["", ["Open*"]], "a long command opens");
    // A narrow side bar shows less: a line that fitted at 700 px and is cut at 300 px opens there too, and comes back.
    await x.send({ type: "sessions_list", items: [{ ...RUN, ask: { id: "perm-1", command: "git log --oneline --graph -n 40 -- src/app" } }, EDIT, LONG], error: "" }); await settle(x.page);
    assert.deepEqual(answers(await x.card(WORK.run)), ["Allow once*", "Deny", "Open"], "whole at 700 px");
    await x.page.setViewportSize({ width: 300, height: 1400 }); await settle(x.page, 200);
    assert.deepEqual([(await x.card(WORK.run)).line, answers(await x.card(WORK.run))], ["", ["Open*"]], "cut at 300 px: it opens instead");
    assert.deepEqual(answers(await x.card(K.change)), ["Apply*", "Not now", "Review"], "a short line is still answered at 300 px");
    await x.page.setViewportSize({ width: 700, height: 1400 }); await settle(x.page, 200);
    assert.deepEqual(answers(await x.card(WORK.run)), ["Allow once*", "Deny", "Open"], "and is answered again when there is room");
    assert.equal(await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-card-note")].every((n) => n.scrollWidth <= n.clientWidth)), true, "no line on Home is cut");
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: an answered card is the others' size, its words read at 4.5:1, and its answers fit`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ theme, width });
    try {
      await x.press(K.change, "yes");                 // one card says what was chosen, with Undo
      const hub = await x.hub(), plain = hub.cards.find((c) => c.key === K.mail);
      for (const key of [K.setup, K.visit, K.change, WORK.run]) {
        const c = hub.cards.find((card) => card.key === key);
        assert.ok(c, key);
        // (Slim cards: a command keeps its one line at the card's whole width, under its words. Its three answers are
        // icons beside its sentence at every width (12 Nov), so it is the others' height where the sentence takes one
        // line, and a little taller where it takes two.)
        if (key === WORK.run) { assert.equal(c.width, plain.width, `${key}: the same width`); assert.ok(c.height >= plain.height && c.height <= 106, `${key}: the others' height, or a little taller for its command's line (${c.height})`); }
        else assert.deepEqual([c.height, c.width], [plain.height, plain.width], `${key}: the same size as a card that opens`);
      }
      const low = (await homeContrast(x.page)).filter((m) => m.ratio < (m.kind === "words" ? 4.5 : 3));
      assert.deepEqual(low, []);
      const fit = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].map((card) => { const c = card.getBoundingClientRect();
        return { key: card.dataset.key, inside: [...card.querySelectorAll(".dgc-card-btn, .dgc-ia-btn, .dgc-card-note")].every((b) => { const r = b.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right + 0.5 && r.bottom <= c.bottom + 0.5; }),
          cut: [...card.querySelectorAll(".dgc-card-btn")].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) }; }).filter((c) => !c.inside || c.cut.length));
      assert.deepEqual(fit, [], "every answer and line is inside its card, and no answer's word is cut");
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
