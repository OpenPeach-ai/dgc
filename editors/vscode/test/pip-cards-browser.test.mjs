// A Pip's cards in real Chromium (asked 10 and 11 Nov), with the real client and its CSS, in the side bar at 300 and
// 700 px and both themes:
//  - a change waiting for you is the shared card: a sentence, chips on one line ("+N" for the rest), Allow and Not now,
//    and its detail in place. Its card was one run-on line beside two buttons, twenty lines tall at 300 px.
//  - Allow accepts it right on the card, with the request its review page sends, and refuses one written for an older
//    version exactly as that page does; what DGC refuses is said in the card.
//  - a new Pip waiting for you shows once, as a thin card in Needs attention; the section above it is gone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { client, openChat, PIP } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
await client();   // built before the first test is registered (a pending top-level await would end the file early)

/** What a card measures as, read in the page: its parts' boxes, and each ink against the ground it is painted on. */
const measure = (selector) => {
  const root = window.__pipsRoot || document, card = root.querySelector(selector);
  if (!card) return null;
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const chain = (node) => { const list = []; for (let n = node; n; n = n.parentElement || n.getRootNode()?.host) list.unshift(n); return list; };
  const pixel = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  const lum = (c) => { const v = c.map((p) => p / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ink = (node) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1, 1);
    for (const n of chain(node)) { ctx.fillStyle = getComputedStyle(n).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
    const under = pixel(); ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1); const over = pixel();
    const [a, b] = [lum(over), lum(under)].sort((m, n) => n - m);
    return { ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, chroma: Math.max(...over) - Math.min(...over), groundChroma: Math.max(...under) - Math.min(...under) };
  };
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const q = (s) => card.querySelector(s), all = (s) => [...card.querySelectorAll(s)];
  const chips = all(".dgc-card-chips > .dgc-chip").filter((c) => !c.hidden && c.getClientRects().length);
  return { card: box(card), title: q(".dgc-card-title, .dgc-card-words > strong").textContent, sub: q(".dgc-card-sub")?.textContent || "",
    chips: chips.map((c) => ({ text: c.textContent, ...box(c) })), chipsRow: q(".dgc-card-chips") ? box(q(".dgc-card-chips")) : null,
    hiddenChips: all(".dgc-card-chips > .dgc-chip:not(.dgc-chip-more)").filter((c) => c.hidden).length,
    buttons: all(".dgc-card-actions > .dgc-card-btn").map((b) => ({ text: b.textContent, primary: b.classList.contains("primary"), disabled: b.disabled, ...box(b), ...ink(b) })),
    toggle: q("[data-dgc-card-toggle]") ? { text: q("[data-dgc-card-toggle]").textContent, expanded: q("[data-dgc-card-toggle]").getAttribute("aria-expanded"), ...box(q("[data-dgc-card-toggle]")), ...ink(q("[data-dgc-card-toggle]")) } : null,
    detailsOpen: q(".dgc-card-details") ? !q(".dgc-card-details").hidden : false, rows: all(".dgc-card-rows dt").map((n) => n.textContent),
    error: q(".dgc-card-error")?.textContent || "", note: q(".dgc-card-note")?.textContent || "",
    inks: { more: q(".dgc-chip-more:not([hidden])") ? ink(q(".dgc-chip-more:not([hidden])")) : null, title: ink(q(".dgc-card-title, .dgc-card-words > strong")), sub: q(".dgc-card-sub") ? ink(q(".dgc-card-sub")) : null, chip: chips[0] ? ink(chips[0]) : null, icon: ink(q(".dgc-card-icon")),
      error: q(".dgc-card-error") ? ink(q(".dgc-card-error")) : null, note: q(".dgc-card-note") ? ink(q(".dgc-card-note")) : null },
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, dialog: !!root.querySelector(".dialog") };
};
const sent = (p, type) => p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t), type);
const CHANGE = "[data-change-card]";

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`a change waiting for you is a sentence, chips on one line and two answers (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, theme, changes: ["web"] });
    t.after(x.close);
    await x.p.waitForSelector(CHANGE);
    await x.p.waitForFunction(() => { const r = window.__pipsRoot || document; return !r.querySelector(".dgc-card-chips .dgc-chip-more").hidden; });
    const m = await x.p.evaluate(measure, CHANGE);
    assert.deepEqual(x.errors, []);
    assert.equal(m.title, "Mornings wants to read 4 web pages before each run", "what it wants, as a sentence");
    assert.doesNotMatch(m.title + m.sub, /Web pages:|Search ·|Page ·/, "never the run-on of its data");
    // The chips: one line, the first one a read, the last one "+N" for the reads that do not fit.
    assert.ok(m.chips.length >= 2 && m.chips.every((c) => Math.abs(c.top - m.chips[0].top) < 1), `one line of chips: ${JSON.stringify(m.chips.map((c) => c.text))}`);
    assert.match(m.chips[0].text, /^Search: top India news/);
    assert.equal(m.chips.at(-1).text, `+${m.hiddenChips}`, "the rest fold into +N");
    assert.equal(m.chips.length - 1 + m.hiddenChips, 4, "every read is a chip, shown or folded");
    assert.ok(m.chips.at(-1).right <= m.chipsRow.right + 0.5, "nothing is cut off at the card's edge");
    assert.deepEqual(m.buttons.map((b) => [b.text, b.primary]), [["Allow", true], ["Not now", false]], "one filled answer and one quiet one");
    assert.equal(m.toggle.text, "Details");
    assert.equal(m.detailsOpen, false);
    assert.equal(m.sideways, 0, "nothing scrolls sideways");
    assert.ok(m.card.height < (width === 300 ? 220 : 160), `a short card (${m.card.height}px; it was over 330px at 300px)`);
    if (width === 300) {
      // Narrow: the answers share the card's width, and Details sits under them.
      assert.ok(Math.abs(m.buttons[0].width - m.buttons[1].width) < 2 && m.buttons[0].width + m.buttons[1].width > m.card.width * 0.8, "the answers take the full width");
      assert.ok(m.toggle.top >= m.buttons[0].bottom, "Details under the answers");
    } else {
      assert.ok(Math.abs(m.toggle.top + m.toggle.height / 2 - (m.buttons[0].top + m.buttons[0].height / 2)) < 4 && m.toggle.right > m.card.right - 30, "Details at the right of the answers' row");
    }
    // Words at 4.5:1, the mark at 3:1, and nothing purple: every ink is a grey.
    for (const [name, i] of Object.entries({ title: m.inks.title, sub: m.inks.sub, chip: m.inks.chip, "+N": m.inks.more, allow: m.buttons[0], "not now": m.buttons[1], details: m.toggle })) {
      assert.ok(i.ratio >= 4.5, `${name} reads at 4.5:1 (${i.ratio})`);
      assert.ok(i.chroma <= 12 && i.groundChroma <= 12, `${name} is a grey on a grey (${i.chroma}, ${i.groundChroma})`);
    }
    assert.ok(m.inks.icon.ratio >= 3 && m.inks.icon.chroma <= 12, `the mark is 3:1 and grey (${m.inks.icon.ratio})`);
  });
}

test("Details opens in place and Esc closes it; the full review is one more click from there", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 300, theme: "dark", changes: ["web"] });
  t.after(x.close);
  await x.p.waitForSelector(CHANGE);
  await x.p.focus(`${CHANGE} [data-change-allow]`);
  await x.p.keyboard.press("Tab"); await x.p.keyboard.press("Tab");   // Allow, Not now, Details: the keyboard's path
  await x.p.keyboard.press("Enter");
  let m = await x.p.evaluate(measure, CHANGE);
  assert.equal(m.detailsOpen, true, "Details opens with the keyboard");
  assert.equal(m.dialog, false, "in place: no page or dialog opens");
  assert.equal(m.toggle.text, "Hide details");
  assert.deepEqual(m.rows, ["Search", "Search", "Page", "Page", "Why"], "every read in full");
  assert.equal(m.sideways, 0);
  await x.p.keyboard.press("Escape");
  m = await x.p.evaluate(measure, CHANGE);
  assert.equal(m.detailsOpen, false, "Esc closes it");
  assert.equal(await x.p.evaluate(() => (window.__pipsRoot || document).activeElement?.hasAttribute("data-dgc-card-toggle")), true, "and the keyboard is back on Details");
  await x.p.click(`${CHANGE} [data-dgc-card-toggle]`);
  await x.p.click(`${CHANGE} .dgc-card-details [data-proposal]`);
  await x.p.waitForSelector(".dialog");
  assert.match(await x.p.locator(".dialog").textContent(), /Change Mornings\?/, "Open the full review: the page it always had");
  assert.deepEqual(await sent(x.p, "accept_pip_update"), [], "and nothing was accepted by opening it");
});

test("Allow accepts the change on its card: the review page's own request, and no page first", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 300, theme: "dark", changes: ["web"] });
  t.after(x.close);
  await x.p.waitForSelector(CHANGE);
  const id = await x.p.getAttribute(CHANGE, "data-change-card");
  await x.p.click(`${CHANGE} [data-change-allow]`);
  await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("[data-change-card]"));
  assert.deepEqual(await sent(x.p, "accept_pip_update"), [{ type: "accept_pip_update", pip_id: PIP, proposal_id: id, expected_version: 2 }], "what the page sends: the proposal's own expected version");
  assert.equal(await x.p.locator(".dialog").count(), 0, "no review page opened first");
  assert.match(await x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-app-root, body").textContent), /Mornings is updated\./, "and it says so");
  assert.deepEqual(x.errors, []);
});

test("a change written for an older version cannot be allowed, on the card as on its review page, and the card says why", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 300, theme: "dark", changes: ["stale"] });
  t.after(x.close);
  await x.p.waitForSelector(CHANGE);
  const m = await x.p.evaluate(measure, CHANGE);
  assert.equal(m.error, "This was written for an older version of this Pip. Turn it down and ask again.");
  assert.deepEqual(m.buttons.map((b) => [b.text, b.disabled]), [["Allow", true], ["Not now", false]], "Allow is off, as the page's Confirm is; turning it down still works");
  assert.ok(m.inks.error.ratio >= 4.5, `the refusal reads at 4.5:1 (${m.inks.error.ratio})`);
  await x.p.locator(`${CHANGE} [data-change-allow]`).click({ force: true }).catch(() => {});
  assert.deepEqual(await sent(x.p, "accept_pip_update"), [], "nothing is sent");
  // The page blocks the same change the same way: its Accept is off. (A project Pip's page says these words too; a
  // Personal Pip's page only turned the button off, so the card is where a Personal Pip's owner reads why.)
  await x.p.click(`${CHANGE} [data-dgc-card-toggle]`);
  await x.p.click(`${CHANGE} .dgc-card-details [data-proposal]`);
  await x.p.waitForSelector(".dialog");
  assert.equal(await x.p.locator("#review-confirm").isDisabled(), true);
  assert.deepEqual(await sent(x.p, "accept_pip_update"), []);
});

test("a change DGC refuses (the Pip moved on since the card was drawn) says why in the card, and stays", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 300, theme: "light", changes: ["web"], refuse: true });
  t.after(x.close);
  await x.p.waitForSelector(CHANGE);
  await x.p.click(`${CHANGE} [data-change-allow]`);
  await x.p.waitForSelector(`${CHANGE} .dgc-card-error`);
  const m = await x.p.evaluate(measure, CHANGE);
  assert.equal(m.error, "This Pip changed since that was written. Ask it again.", "DGC's own words, in the card");
  assert.equal(m.dialog, false);
  assert.equal((await sent(x.p, "accept_pip_update")).length, 1);
  assert.ok(m.inks.error.ratio >= 4.5, `the refusal reads at 4.5:1 on light (${m.inks.error.ratio})`);
  assert.deepEqual(m.buttons.map((b) => b.disabled), [false, false], "and it can be tried again or turned down");
});

test("two changes for the same version: each card says allowing it sets the other aside, and allowing one says it did", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 700, theme: "dark", changes: ["web", "schedule"] });
  t.after(x.close);
  await x.p.waitForSelector(CHANGE);
  assert.equal(await x.p.locator(CHANGE).count(), 2);
  const m = await x.p.evaluate(measure, CHANGE);
  assert.equal(m.note, "Allowing this sets the other waiting change aside. It is not approved.");
  assert.ok(m.inks.note.ratio >= 4.5);
  await x.p.locator(`${CHANGE} [data-change-allow]`).first().click();
  await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("[data-change-card]"));
  assert.match(await x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-app-root, body").textContent), /Mornings is updated\. The other waiting change was set aside, not approved\./);
});

// ---- The Pips page: a new Pip waiting for you shows once, in Needs attention ---------------------------------------
for (const theme of ["dark", "light"]) for (const [width, count] of [[300, 3], [700, 1]]) {
  test(`${count} new ${count === 1 ? "Pip" : "Pips"} waiting: only in Needs attention, each a thin card (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, theme, where: width > 400 ? "tab" : "side", home: true, setups: count });
    t.after(x.close);
    await x.p.waitForSelector(".attention-toggle");
    const page = () => x.p.evaluate(() => { const r = window.__pipsRoot || document; return { text: r.querySelector(".pip-app-root, body").textContent, inbox: r.querySelectorAll(".setup-inbox, .setup-card").length,
      count: r.querySelector(".attention-count")?.textContent, cards: r.querySelectorAll(".attention [data-setup-card]").length, rows: r.querySelectorAll(".attention .attention-row").length,
      dismiss: r.querySelectorAll(".attention-dismiss").length }; });
    let v = await page();
    assert.equal(v.inbox, 0, "the section above the list is gone");
    assert.doesNotMatch(v.text, /new Pips? waiting for you|New Pips ·/, "and so are its words");
    assert.equal(v.count, String(count + 1), "Needs attention counts each new Pip once, with what else waits");
    // Open when something is in it (his call, 11 Nov); the keyboard folds it and opens it again.
    const open = () => x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".attention-toggle").getAttribute("aria-expanded"));
    assert.equal(await open(), "true", "open when something is in it");
    await x.p.focus(".attention-toggle"); await x.p.keyboard.press("Enter");
    assert.equal(await open(), "false", "Enter folds it");
    await x.p.focus(".attention-toggle"); await x.p.keyboard.press("Enter");
    assert.equal(await open(), "true", "and opens it again");
    await x.p.waitForSelector(".attention [data-setup-card]");
    v = await page();
    assert.equal(v.cards, count, "one card for each new Pip");
    assert.equal(v.rows, 1, "beside the rows of what else waits");
    assert.equal(v.dismiss, 0, "its answers are on its card, not a second row");
    const card = ".attention [data-setup-card]";
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention [data-setup-card] .dgc-chip") !== null);
    const m = await x.p.evaluate(measure, card);
    assert.equal(m.title, "Create the Pip “Bills”?");
    assert.equal(m.sub, "Watch my bills and tell me a week before each is due.");
    assert.ok(m.chips.length >= 2 && m.chips.every((c) => Math.abs(c.top - m.chips[0].top) < 1), "its chips on one line");
    assert.equal(m.chips[0].text, "Scout");
    assert.deepEqual(m.buttons.map((b) => [b.text, b.primary]), [["Review", true], ["Reject", false]]);
    assert.ok(m.card.height < (width === 300 ? 170 : 130), `thinner than the card it replaces (${m.card.height}px)`);
    assert.equal(m.sideways, 0);
    for (const [name, i] of Object.entries({ title: m.inks.title, sub: m.inks.sub, chip: m.inks.chip, review: m.buttons[0], reject: m.buttons[1] })) {
      assert.ok(i.ratio >= 4.5, `${name} reads at 4.5:1 (${i.ratio})`);
      assert.ok(i.chroma <= 12, `${name} is a grey (${i.chroma})`);
    }
    assert.equal(await x.p.evaluate(() => { const f = (window.__pipsRoot || document).querySelector(".attention [data-setup-card] .dgc-card-face"); return !!f && f.getBoundingClientRect().width >= 24 && f.children.length > 0; }), true, "the new Pip's face");
    // Review opens the full details, as before.
    await x.p.click(`${card} [data-setup]`);
    await x.p.waitForSelector(".dialog");
    assert.match(await x.p.locator(".dialog").textContent(), /Bills/);
    assert.deepEqual(x.errors, []);
  });
}
