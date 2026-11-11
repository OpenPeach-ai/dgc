// Home's cards are slim (media/shared/hub.css, hub.js): one row, the face or blob, the words (where from and how old,
// small, over the line) and the answers at the right, one over the other. About half the old 138 px, and the same at
// every width. Measured in real Chromium on the side bar's real page (support/dock-scene.mjs):
//   - at 240, 300, 420, 700 and 1,000 px, dark and light: every card one height, 64 to 76 px; nothing cut or outside
//     its card; the answers beside the words, never under them; every answer reached with Tab
//   - chips never add a row: they show where a line is free, and never one that repeats the card's own sentence
//   - a card answered where it is (Apply / Not now, Create / Reject, Allow / Not now, Undo) is the others' height
//   - a command to allow keeps its one line at the card's whole width: that one kind is a little taller where the
//     answers have no room beside its sentence, and the others' height where they do
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { homeState, pipId, P } from "./support/home-scene.mjs";

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

const settle = (page, ms = 80) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
const SLIM = [64, 76], WIDTHS = [240, 300, 420, 700, 1000], THEMES = ["dark-modern", "light-modern"];

// ---- the scenes ------------------------------------------------------------------------------------------------------
const AR = (n) => "ar_" + String(n).padStart(16, "0");
/** Things made, as the host keeps them: a page from a Work session, a document from a chat. */
const made = () => JSON.stringify([["page", "Login redirect map", "work", DOCK_SESSIONS[0].id, 0], ["doc", "Rent or buy, in one page, with every number the bank sent and the two that it did not", "chat", "chat_2", 4]]
  .map(([type, title, surface, where, min], k) => ({ id: AR(k + 1), type, title, version: 1, op: "made", surface, where, at: Date.now() - min * 60000 })));
const SETUP = "setup_" + "7".repeat(32), PROPOSAL = "proposal-" + "3".repeat(12), VISIT = "compact_" + "5".repeat(32), MAIL = "maildraft_" + "1".repeat(32);
/** Everything that is answered on its card, and one that only opens. */
function waiting() {
  const state = homeState("quiet");
  const pip = (c, name, type) => ({ id: pipId(c), name, pip_type: type, workspace_id: P, status: "active", pending_review_count: 0, version: 1, current_version: 4 });
  state.list[P] = [pip("a", "Core", "core"), pip("b", "Mail watch", "scout"), pip("c", "Morning brief", "quill"), pip("d", "Garden notes", "lens")];
  const waits = (kind, card, c, name, type, title, detail, more = {}) => ({ id: `${kind}:${card}`, kind, card, pip_id: c ? pipId(c) : null, pip_name: name, pip_type: type, workspace_id: P, title, detail,
    created_at: "2026-11-03T09:00:00.000Z", expires_at: null, ...more });
  state.attention = { as_of: "2026-11-03T12:00:00.000Z", total: 4, truncated: false, counts: { setup: 1, computer_action: 1, email: 1 }, by_pip: { [pipId("b")]: 1, [pipId("c")]: 1, [pipId("d")]: 1 }, projects: {},
    items: [waits("setup", SETUP, null, "Receipts", "rook", "Create the Pip “Receipts”?", "File each receipt from my mail."),
      waits("computer_action", VISIT, "d", "Garden notes", "lens", "Visit seeds.example?", "https://seeds.example/tomatoes"), waits("email", MAIL, "b", "Mail watch", "scout", "A reply to send", "To: someone new")],
    reviews: [waits("approval", PROPOSAL, "c", "Morning brief", "quill", "Change Morning brief?", "Run at 7:00 instead of 9:00", { review: "schedule_update" })] };
  state.setups = { [SETUP]: { id: SETUP, digest: "a".repeat(64), workspace_id: P, project_root: "/private/pips", pip_id: null, name: "Receipts", goal: "File each receipt from my mail.", pip_type: "rook", work_kind: "personal_task",
    source_ref: "HEAD", schedule: null, run_now: false, next_run_at: null, status: "pending", created_at: "2099-10-02T04:00:00Z", expires_at: "2099-10-02T06:00:00Z", receipt: null, reason: "You asked.", expected_version: null,
    expected_lifecycle_revision: null, permissions: "read_only", source_policy: "personal", runner_notice: "Runs only while Pips are on.", scope_notice: "Reads only what you share.", run_now_policy: null } };
  state.computers = { [pipId("d")]: { pip_id: pipId("d"), granted: true, available: true, reason: "", pending: 1, actions: [{ id: VISIT, pip_id: pipId("d"), workspace_id: P, run_id: "run_" + "b".repeat(32),
    summary: { method: "GET", host: "seeds.example", path: "/tomatoes", page: "", fields: [], more_fields: 0, body_bytes: 0, kind: "site", site: "seeds.example", shown: "seeds.example" }, digest: "d".repeat(64), frame: null, status: "pending",
    created_at: "2026-11-03T09:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null }] } };
  return state;
}
const RUN = { ...DOCK_SESSIONS[2], name: "Plan the 0.52 release notes", waiting: true, running: true, ask: { id: "perm-1", command: "npm test -- --run" } };
const EDIT = { ...DOCK_SESSIONS[1], name: "Rename the watering helpers", waiting: true, running: true };
const K = { setup: `setup:${SETUP}`, change: `pip:${pipId("c")}`, visit: `pip:${pipId("d")}`, mail: `pip:${pipId("b")}`, run: `work:${RUN.id}`, edit: `work:${EDIT.id}` };
const SCENES = {
  // Pips with things waiting and with news, a failed run, sessions, a chat's answer, and two things made (their sheets).
  news: (o) => openDock(browser, { tab: "home", state: homeState("busy"), height: 1500, pages: made(), ...o }),
  // Cards answered where they are: a new Pip, a Pip's change, a site to visit, a command to allow; and two that open.
  answers: (o) => openDock(browser, { tab: "home", state: waiting(), sessions: [RUN, EDIT], height: 1500, ...o }),
};

/** Every card as it is drawn: its box, and what in it is cut, outside it, or over something else. */
const measure = (page) => page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].map((card) => {
  const box = card.getBoundingClientRect(), r = (n) => n.getBoundingClientRect(), seen = (n) => n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && r(n).width > 0;
  const parts = [...card.querySelectorAll(".dgc-card-icon, .dgc-card-title, .dgc-card-sub, .dgc-card-note, .dgc-chip:not([hidden]), .dgc-card-btn")].filter(seen);
  const outside = parts.filter((n) => r(n).left < box.left + 3 || r(n).right > box.right - 3 || r(n).top < box.top + 3 || r(n).bottom > box.bottom - 3).map((n) => `${n.className}: ${n.textContent.slice(0, 30)}`);
  const buttons = [...card.querySelectorAll(".dgc-card-btn")], words = [...card.querySelectorAll(".dgc-card-title, .dgc-card-sub, .dgc-card-note, .dgc-chip:not([hidden])")].filter(seen);
  const cut = buttons.filter((b) => !seen(b) || b.scrollWidth > b.clientWidth + 1 || r(b).height < 14).map((b) => b.textContent);
  const hit = (a, b) => r(a).left < r(b).right - 0.5 && r(b).left < r(a).right - 0.5 && r(a).top < r(b).bottom - 0.5 && r(b).top < r(a).bottom - 0.5;
  const over = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (hit(parts[i], parts[j])) over.push(`${parts[i].textContent.slice(0, 20) || parts[i].className} / ${parts[j].textContent.slice(0, 20)}`);
  const face = r(card.querySelector(".dgc-card-icon")), title = r(card.querySelector(".dgc-card-title")), sub = card.querySelector(".dgc-card-sub");
  return { key: card.dataset.key, mono: card.classList.contains("dgc-hub-mono"), height: Math.round(box.height * 2) / 2, width: Math.round(box.width), outside, cut, over,
    // One row: the face, then the words, then the answers, each beside the last, the answers within the words' and face's rows.
    row: buttons.length ? buttons.every((b) => r(b).left >= Math.max(...words.map((w) => r(w).right)) - 0.5) && title.left >= face.right
      && Math.abs((r(card.querySelector(".dgc-card-actions")).top + r(card.querySelector(".dgc-card-actions")).bottom) / 2 - (face.top + face.bottom) / 2) <= 2 : true,
    subFirst: sub ? r(sub).bottom <= title.top + 0.5 : true, subOneLine: sub ? r(sub).height <= parseFloat(getComputedStyle(sub).lineHeight) * 1.3 : true,
    titleLines: Math.round(title.height / parseFloat(getComputedStyle(card.querySelector(".dgc-card-title")).lineHeight)),
    chips: [...card.querySelectorAll(".dgc-chip:not([hidden])")].filter(seen).map((c) => c.textContent), answers: buttons.map((b) => b.textContent),
    said: buttons.map((b) => b.getAttribute("aria-label") || b.textContent.trim()), sentence: card.querySelector(".dgc-card-title").textContent, label: card.getAttribute("aria-label") };
}));

for (const theme of THEMES) for (const width of WIDTHS) for (const scene of ["news", "answers"]) {
  test(`${theme} ${width}px, ${scene}: every card is slim and one height, in one row, with nothing cut`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await SCENES[scene]({ theme, width });
    try {
      await settle(x.page);
      const cards = await measure(x.page);
      assert.ok(cards.length >= 6, `the scene's cards are on Home (${cards.length})`);
      // (A command to allow keeps its line at the card's whole width: measured in its own test.)
      const usual = cards.filter((c) => !c.mono);
      const heights = [...new Set(usual.map((c) => c.height))];
      assert.equal(heights.length, 1, `every card is one height: ${JSON.stringify(usual.map((c) => [c.key.slice(0, 12), c.height]))}`);
      assert.ok(heights[0] >= SLIM[0] && heights[0] <= SLIM[1], `slim: ${heights[0]} px, about half the old 138`);
      for (const c of cards) {
        assert.deepEqual(c.outside, [], `${c.key}: everything is inside its card`);
        assert.deepEqual(c.cut, [], `${c.key}: no answer is cut or hidden`);
        assert.deepEqual(c.over, [], `${c.key}: nothing is drawn over anything else`);
        assert.ok(c.subFirst && c.subOneLine, `${c.key}: where it is from and its age, on one small line over the sentence`);
        assert.ok(c.titleLines <= 2, `${c.key}: the sentence takes two lines at most`);
        if (!c.mono) assert.ok(c.row, `${c.key}: one row: the face, the words, the answers at the right`);
      }
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const width of WIDTHS) {
  test(`${width}px: every answer on every card is reached with Tab, in the order they are read, and says what it does`, async (t) => {
    if (skipOrFail(t)) return;
    for (const scene of ["news", "answers"]) {
      const x = await SCENES[scene]({ width });
      try {
        await settle(x.page);
        const want = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub [data-hub-act]")].map((b) => `${b.closest(".dgc-hub-card").dataset.key}/${b.dataset.hubAct}`));
        assert.ok(want.length >= 8, `${scene}: the answers are there (${want.length})`);
        await x.page.focus("#home-hub .dgc-hub-show");
        const got = [], rings = [];
        for (let i = 0; i < want.length + 12 && got.length < want.length; i++) {
          await x.page.keyboard.press("Tab");
          const at = await x.page.evaluate(() => { const a = document.activeElement; if (!a?.dataset?.hubAct) return null; const r = a.getBoundingClientRect(), c = a.closest(".dgc-hub-card").getBoundingClientRect(), s = getComputedStyle(a);
            return { id: `${a.closest(".dgc-hub-card").dataset.key}/${a.dataset.hubAct}`, ring: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1, inside: r.top >= c.top && r.bottom <= c.bottom && r.left >= c.left && r.right <= c.right,
              named: (a.getAttribute("aria-label") || a.textContent).trim().length > 1 }; });
          if (at) { got.push(at.id); rings.push(at); }
        }
        assert.deepEqual(got, want, `${scene}: Tab visits every answer, card by card`);
        assert.deepEqual(rings.filter((a) => !a.ring || !a.inside || !a.named), [], `${scene}: each shows its focus ring inside its card, and has a name`);
      } finally { await x.close(); }
    }
  });
}

test("chips never add a row: they show where a line is free, and never one that only repeats the card's sentence", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 420, 700]) {
    const state = homeState("busy");
    // A chip that says what the sentence already says, beside one that says more.
    state.attention.items[0].title = "A reply to send"; state.attention.items[1].title = "A reply to send";
    const x = await openDock(browser, { tab: "home", state, width, height: 1500, pages: made() });
    try {
      await settle(x.page);
      const cards = await measure(x.page);
      const withChips = cards.filter((c) => c.chips.length), without = cards.filter((c) => !c.chips.length);
      assert.ok(withChips.length >= 1, `${width}px: some card shows its chips (${JSON.stringify(cards.map((c) => c.chips))})`);
      for (const c of withChips) {
        assert.equal(c.height, cards[0].height, `${c.key}: chips do not make it taller`);
        assert.equal(c.titleLines, 1, `${c.key}: chips stand on the line a one-line sentence leaves free`);
        for (const chip of c.chips) assert.ok(!c.sentence.toLowerCase().includes(chip.toLowerCase()), `${c.key}: the chip “${chip}” would repeat “${c.sentence}”`);
      }
      // What a hidden chip said is still told to a screen reader, in the card's own name.
      const hub = await x.hub();
      for (const c of without) {
        const all = hub.cards.find((h) => h.key === c.key).chips;       // what the card was given
        for (const chip of all) assert.ok(c.label.includes(chip) || c.sentence.toLowerCase().includes(chip.toLowerCase()), `${c.key}: “${chip}” is in the card's name (${c.label})`);
      }
    } finally { await x.close(); }
  }
});

for (const width of [300, 420, 700]) {
  test(`${width}px: a card answered where it is is the others' height: its line, two answers and the way to all of it, then Undo`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await SCENES.answers({ width });
    try {
      await settle(x.page);
      let cards = await measure(x.page), by = Object.fromEntries(cards.map((c) => [c.key, c]));
      assert.deepEqual(by[K.change].answers, ["Apply", "Not now", "Review"], "a Pip's change is answered on its card, at this width too");
      assert.deepEqual(by[K.visit].answers, ["Allow", "Not now", "Review"]);
      if (width >= 420) assert.deepEqual(by[K.setup].answers, ["Create", "Reject", "Review"], "a new Pip's longer line fits from here");
      assert.deepEqual(by[K.mail].answers, ["Review"], "an email only opens");
      for (const key of [K.change, K.visit, K.setup]) assert.equal(by[key].height, by[K.mail].height, `${key}: the height of a card that opens`);
      const line = await x.page.evaluate((key) => { const n = document.querySelector(`.dgc-hub-card[data-key="${key}"] .dgc-card-note`), c = n.closest(".dgc-hub-card").getBoundingClientRect(), r = n.getBoundingClientRect();
        return { text: n.textContent, whole: n.scrollWidth <= n.clientWidth && n.scrollHeight <= n.clientHeight + 1, inside: r.bottom <= c.bottom - 3 && r.right <= c.right - 3 }; }, K.change);
      assert.deepEqual(line, { text: "Run at 7:00 instead of 9:00", whole: true, inside: true }, "its line is shown whole");
      await x.page.click(`.dgc-hub-card[data-key="${K.change}"] [data-hub-act="yes"]`); await settle(x.page);
      cards = await measure(x.page); by = Object.fromEntries(cards.map((c) => [c.key, c]));
      assert.deepEqual([by[K.change].sentence, by[K.change].answers, by[K.change].height], ["Applied. Morning brief is changed.", ["Undo"], by[K.mail].height], "held with Undo, the same height");
      assert.deepEqual(by[K.change].outside.concat(by[K.change].cut, by[K.change].over), []);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const width of WIDTHS) {
  test(`${width}px: a command to allow keeps its one line at the card's whole width, with Allow once, Deny and Open`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await SCENES.answers({ width });
    try {
      await settle(x.page);
      const cards = await measure(x.page), run = cards.find((c) => c.key === K.run), usual = cards.find((c) => c.key === K.mail);
      assert.deepEqual(run.answers, ["Allow once", "Deny", "Open"], "answered on its card");
      const m = await x.page.evaluate((key) => { const card = document.querySelector(`.dgc-hub-card[data-key="${key}"]`), n = card.querySelector(".dgc-card-note"), c = card.getBoundingClientRect(), r = n.getBoundingClientRect(), s = getComputedStyle(card);
        return { text: n.textContent, whole: n.scrollWidth <= n.clientWidth, lines: Math.round(r.height / parseFloat(getComputedStyle(n).lineHeight)), mono: /mono|Consolas|Menlo/i.test(getComputedStyle(n).fontFamily),
          left: Math.round(r.left - c.left - parseFloat(s.paddingLeft) - parseFloat(s.borderLeftWidth)), right: Math.round(c.right - r.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth)), cardWidth: Math.round(c.width) }; }, K.run);
      assert.deepEqual([m.text, m.whole, m.lines, m.mono], ["npm test -- --run", true, 1, true], "the command, whole, on one line, in the code face");
      assert.deepEqual([m.left, m.right], [0, 0], "from the card's one edge to the other");
      assert.deepEqual(run.outside.concat(run.cut, run.over), [], "nothing is cut, outside it or over anything");
      // Where the three answers have room beside its sentence it is the others' height; where they have not, they
      // stand under the command, and this one card is a little taller: still well under the old 138 px.
      if (m.cardWidth >= 420) assert.equal(run.height, usual.height, `a card ${m.cardWidth} px wide: the others' height`);
      // (Under about 230 px its sentence takes two lines, as any card's may.)
      else assert.ok(run.height > usual.height && run.height <= (m.cardWidth < 230 ? 116 : 100), `a card ${m.cardWidth} px wide: a little taller (${run.height})`);
    } finally { await x.close(); }
  });
}

test("a side bar at its narrowest (170 px): the answers go under the words, every card one height, nothing cut", async (t) => {
  if (skipOrFail(t)) return;
  const x = await SCENES.news({ width: 170 });
  try {
    await settle(x.page);
    const cards = await measure(x.page);
    assert.equal(new Set(cards.map((c) => c.height)).size, 1, `one height: ${[...new Set(cards.map((c) => c.height))]}`);
    assert.ok(cards[0].height <= 100, `still far under the old 138 px (${cards[0].height})`);
    for (const c of cards) assert.deepEqual(c.outside.concat(c.cut, c.over), [], `${c.key}: nothing is cut, outside it or over anything`);
    const words = await x.page.evaluate(() => Math.min(...[...document.querySelectorAll("#home-hub .dgc-card-title")].map((n) => n.getBoundingClientRect().width)));
    assert.ok(words >= 80, `the sentence keeps room to be read (${words} px)`);
  } finally { await x.close(); }
});
