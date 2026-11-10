// One card for everything that asks you something or reports to you (media/shared/card.js and card.css, asked 10 Nov):
// an icon, what it wants in a sentence, what exactly as chips on one line ("+N" for the rest), one filled answer and
// one quiet one, and the detail one click away, opening in place. Here: the helper's markup and its keys, in jsdom;
// that every page loads it; and that each card a Pip draws with markup of its own has the same parts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)), read = (f) => readFileSync(root + f, "utf8");
const windows = [];
after(() => windows.forEach((w) => w.close()));
const page = () => { const w = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" }).window; windows.push(w); w.eval(read("media/shared/card.js")); return w; };
const CARD = { id: "c1", icon: "web", title: "Mornings wants to read 3 web pages before each run", sub: "So it can pick the morning's top stories.",
  chips: [{ label: "Search: top India news today", icon: "search" }, { label: "bbc.com/news/world", icon: "web" }, "reuters.com/world/india"],
  actions: [{ label: "Allow", primary: true, attrs: { "data-yes": "1" } }, { label: "Not now", attrs: { "data-no": "1" } }],
  details: { rows: [["Search", "top India news headlines today"], ["Page", "https://www.bbc.com/news/world"]], link: { label: "Open the full review", attrs: { "data-open": "1" } } } };

test("a card is a sentence, chips, one filled answer and one quiet one, with its detail folded away", () => {
  const w = page(), d = w.document;
  d.body.innerHTML = w.DgcCard.html(CARD);
  const card = d.querySelector(".dgc-card");
  assert.equal(card.getAttribute("role"), "group");
  assert.equal(card.querySelector(".dgc-card-head .dgc-card-icon svg") !== null, true, "a mark");
  assert.equal(card.querySelector(".dgc-card-title").textContent, CARD.title, "what it wants, as a sentence");
  assert.equal(card.querySelector(".dgc-card-sub").textContent, CARD.sub);
  const chips = [...card.querySelectorAll(".dgc-card-chips > .dgc-chip:not(.dgc-chip-more)")];
  assert.deepEqual(chips.map((c) => c.textContent), ["Search: top India news today", "bbc.com/news/world", "reuters.com/world/india"], "what exactly, one chip each");
  assert.equal(card.querySelector(".dgc-chip-more").hidden, true, "the +N chip is there for the ones that do not fit");
  const buttons = [...card.querySelectorAll(".dgc-card-actions > .dgc-card-btn")];
  assert.deepEqual(buttons.map((b) => [b.textContent, b.classList.contains("primary")]), [["Allow", true], ["Not now", false]], "one filled answer, one quiet");
  assert.equal(buttons[0].dataset.yes, "1");
  const details = card.querySelector(".dgc-card-details"), toggle = card.querySelector("[data-dgc-card-toggle]");
  assert.equal(details.hidden, true, "the detail is one click away");
  assert.equal(toggle.textContent, "Details");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), details.id);
  assert.deepEqual([...details.querySelectorAll("dt")].map((n) => n.textContent), ["Search", "Page"]);
  assert.equal(details.querySelector("button[data-open]").textContent, "Open the full review");
});

test("Details opens in place, stays open across a redraw, and Esc closes it and returns the keyboard", () => {
  const w = page(), d = w.document;
  d.body.innerHTML = w.DgcCard.html(CARD);
  let toggle = d.querySelector("[data-dgc-card-toggle]");
  assert.equal(w.DgcCard.click(d.querySelector(".dgc-card-title")), false, "a click elsewhere is not the card's");
  assert.equal(w.DgcCard.click(toggle), true);
  assert.equal(d.querySelector(".dgc-card-details").hidden, false);
  assert.equal(toggle.textContent, "Hide details");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  d.body.innerHTML = w.DgcCard.html(CARD);   // the page redraws itself
  assert.equal(d.querySelector(".dgc-card-details").hidden, false, "still open");
  toggle = d.querySelector("[data-dgc-card-toggle]");
  const inside = d.querySelector(".dgc-card-details button");
  inside.focus();
  assert.equal(w.DgcCard.key({ key: "Escape", target: inside }), true);
  assert.equal(d.querySelector(".dgc-card-details").hidden, true);
  assert.equal(d.activeElement, toggle, "the keyboard is back on Details");
  assert.equal(w.DgcCard.key({ key: "Escape", target: toggle }), false, "nothing open: Esc is the page's");
});

test("every word a caller passes is escaped, an error is said in the card, and a card with nothing more has no Details", () => {
  const w = page(), d = w.document;
  d.body.innerHTML = w.DgcCard.html({ title: "<img src=x onerror=1>", sub: "<b>x</b>", chips: ["<i>y</i>"], error: "This <expired>.", actions: [{ label: "<u>Go</u>", primary: true }] });
  assert.equal(d.querySelector(".dgc-card img, .dgc-card b, .dgc-card i, .dgc-card u"), null);
  assert.equal(d.querySelector(".dgc-card-error").getAttribute("role"), "alert");
  assert.equal(d.querySelector(".dgc-card-error").textContent, "This <expired>.");
  assert.equal(d.querySelector("[data-dgc-card-toggle]"), null);
  assert.equal(d.querySelector(".dgc-card-details"), null);
});

test("every page loads the shared card: Work and ChatDGC before their own script, the Pips in their bundle", () => {
  const panel = read("src/panel.ts");
  assert.ok(panel.indexOf('src="${cardJs}"') > 0 && panel.indexOf('src="${cardJs}"') < panel.indexOf('src="${js}"'), "Work: card.js before main.js");
  const chat = read("src/chatdgc.ts"), at = (name) => chat.indexOf(`asset("media/${name}")`);
  assert.ok(at("shared/card.js") > 0 && at("shared/card.js") < at("chatdgc.js"), "ChatDGC: card.js before chatdgc.js");
  assert.match(read("src/pipsClient.js"), /import '\.\.\/media\/shared\/card\.css';\nimport '\.\.\/media\/shared\/card\.js';/);
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/card\.css"\);/);
});

test("the card is neutral: no hue of its own, and no accent token", () => {
  const css = read("media/shared/card.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, "every colour is a token");
  assert.doesNotMatch(css, /--accent|--link|--lav|--pip-accent/, "nothing purple");
});

// ---- Each card a Pip draws with markup of its own: the same parts --------------------------------------------------
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = async (file) => (await build({ entryPoints: [src + file], bundle: true, write: false, platform: "node", format: "cjs", loader: { ".css": "empty" } })).outputFiles[0].text;
const load = (code) => { const m = { exports: {} }; new Function("module", "exports", "require", code)(m, m.exports, () => ({})); return m.exports; };
const links = load(await bundle("pipAppLinks.js")), routines = load(await bundle("pipRoutines.js")), borrow = load(await bundle("pipBorrow.js")), attention = load(await bundle("pipAttention.js"));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The parts every card has, whoever drew it: its box, a mark, a sentence with no run-on of its data, and one filled answer. */
function parts(html, name, { answers = true } = {}) {
  const w = page(); w.document.body.innerHTML = html;
  const card = w.document.querySelector(".dgc-card");
  assert.ok(card, `${name}: the shared card`);
  assert.ok(card.querySelector(".dgc-card-head > .dgc-card-icon"), `${name}: a mark`);
  const title = card.querySelector(".dgc-card-head .dgc-card-words > strong");
  assert.ok(title && title.textContent.trim(), `${name}: a sentence`);
  assert.doesNotMatch(title.textContent, / · |, .*, /, `${name}: its sentence is not a run-on of its data`);
  if (answers) {
    assert.equal(card.querySelectorAll(".dgc-card-actions > button.primary").length, 1, `${name}: one filled answer`);
    assert.ok(card.querySelectorAll(".dgc-card-actions > button:not(.primary)").length >= 1, `${name}: and a quiet one`);
  }
  return card;
}

test("a Pip's own cards (connect an app, an email, an event, a routine, your Chrome) are the shared card", () => {
  const w = page(); globalThis.DgcCard = w.DgcCard;
  try {
    const link = { id: "applink_" + "a".repeat(32), toolkit: "gmail", app: "Gmail", reason: "To read your new mail each morning.", status: "requested", label: null, error: null };
    parts(links.appLinkMarkup(link, { esc, pipName: "Mornings" }), "connect an app");
    parts(links.appLinkMarkup({ ...link, status: "failed", error: "Try again." }, { esc }), "an app that did not connect");
    const mail = { id: "maildraft_" + "b".repeat(32), payload: { message: { recipient_email: "sam@mail.example", subject: "Tuesday", body: "See you then." } } };
    parts(links.allowCardMarkup(mail, { esc, link: { label: "me@mail.example" } }), "an email to send");
    const event = { id: "caldraft_" + "c".repeat(32), payload: { event: { summary: "Lunch", start_datetime: "2026-11-12T13:00:00", end_datetime: "2026-11-12T14:00:00", timezone: "Asia/Kolkata", attendees: ["a@x.example", "b@x.example", "c@x.example"] } } };
    parts(links.calendarCardMarkup(event, { esc, link: { label: "My calendar" } }), "an event to add");
    const routine = { id: "routine_" + "d".repeat(32), title: "Bank alerts", prompt: "Tell me what the bank email says.", status: "suggested", created_by: "pip", trigger: { kind: "email", query: "from:alerts@bank.example", every_minutes: 10 } };
    const suggested = parts(routines.routineCardMarkup(routine, { esc, formatDate: String }), "a routine it suggests");
    assert.equal(suggested.querySelector(".dgc-card-title, strong").textContent, "Add the routine “Bank alerts”?");
    assert.deepEqual([...suggested.querySelectorAll(".dgc-chip:not(.dgc-chip-more)")].map((c) => c.textContent), ["When an email matching “from:alerts@bank.example” arrives"], "when it runs is a chip");
    const lend = { id: "borrow_" + "e".repeat(32), status: "requested", sites: ["shop.example", "pay.example"], why: "To pay the bill you asked about.", minutes: 10, reachable: true, sent: [] };
    const asked = parts(borrow.borrowMarkup(lend, { esc, pipName: "Ava" }), "your Chrome, asked for");
    assert.deepEqual([...asked.querySelectorAll(".dgc-chip:not(.dgc-chip-more)")].map((c) => c.textContent), ["shop.example", "pay.example", "10 minutes at most"], "where, and for how long, as chips");
    const lent = parts(borrow.borrowMarkup({ ...lend, status: "in_use", started_at: new Date().toISOString() }, { esc, pipName: "Ava" }), "your Chrome, on loan", { answers: false });
    assert.equal(lent.querySelector("strong").textContent, "Using your Chrome", "the sites are chips, not a run-on in its title");
    assert.deepEqual([...lent.querySelectorAll(".dgc-chip:not(.dgc-chip-more)")].map((c) => c.textContent), ["shop.example", "pay.example"]);
  } finally { delete globalThis.DgcCard; }
});

test("a new Pip waiting for you is a thin card: its face, one sentence, chips, Review and Reject", () => {
  const w = page(); globalThis.DgcCard = w.DgcCard;
  try {
    const setup = { id: "setup_" + "1".repeat(32), name: "Bills", goal: "Watch my bills and tell me a week before each is due." };
    w.document.body.innerHTML = attention.setupCardMarkup({ setup, face: '<span class="avatar"></span>', chips: [{ label: "Scout" }, { label: "Personal" }, { label: "Every day at 09:00" }] });
    const card = w.document.querySelector(".dgc-card.dgc-card-thin[data-setup-card]");
    assert.equal(card.dataset.setupCard, setup.id);
    assert.ok(card.querySelector(".dgc-card-icon.dgc-card-face > .avatar"), "the Pip's face in place of a mark");
    assert.equal(card.querySelector(".dgc-card-title").textContent, "Create the Pip “Bills”?");
    assert.equal(card.querySelector(".dgc-card-sub").textContent, setup.goal);
    assert.deepEqual([...card.querySelectorAll(".dgc-chip:not(.dgc-chip-more)")].map((c) => c.textContent), ["Scout", "Personal", "Every day at 09:00"]);
    assert.deepEqual([...card.querySelectorAll(".dgc-card-actions > button")].map((b) => [b.textContent, b.classList.contains("primary"), b.dataset.setup || b.dataset.rejectSetup]),
      [["Review", true, setup.id], ["Reject", false, setup.id]]);
  } finally { delete globalThis.DgcCard; }
});
