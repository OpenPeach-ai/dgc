// Always allow on every Pip card (decided 15 Nov; live round 1, findings 39 and 40), and the site card at the
// narrowest side bar (finding 45), on a Pip's real chat in real Chromium:
//   - a payment's card, an order's, the card that carries what it read from your apps to a site or into its Terminal,
//     and the "could delete everything" card have the Always allow button where the other cards have it (after the
//     main answer, before Reject / Not now) and in the same shape; a new site's card has none (Allow adds the site);
//   - a payment's (and an order's) says, in one quiet line, "Inside its daily limit";
//   - at 170 px a site's long name is never broken inside the word: it stays on one line and ends in "…" when it is
//     longer than the line (whole on hover), and no button's words are cut: the buttons go one under the other.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openCard, cardNow } from "./support/pip-cards-scene.mjs";

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

const WORDS = { payment: ["Review…", "Always allow", "Reject"], order: ["Send once", "Always allow", "Reject"], carry: ["Allow once", "Always allow", "Not now"], terminal: ["Allow once", "Always allow", "Not now"], floor: ["Allow once", "Always allow", "Not now"] };
for (const theme of ["dark", "light"]) for (const [kind, words] of Object.entries(WORDS)) {
  test(`${kind}: its card has Always allow in the same place and shape as a form's card (300 px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const plain = await openCard(browser, "form", { width: 300, theme });
    let ref; try { ref = (await cardNow(plain.p)).buttons.find((b) => b.always); } finally { await plain.close(); }
    assert.ok(ref, "a form's card has Always allow (as before)");
    const x = await openCard(browser, kind, { width: 300, theme });
    try {
      const c = await cardNow(x.p);
      assert.deepEqual(c.buttons.map((b) => b.text), words);
      const always = c.buttons[1];
      assert.equal(always.always, true);
      for (const key of ["h", "radius", "cls", "border", "ground", "font"]) assert.equal(always[key], ref[key], `the same ${key} as on a form's card`);
      assert.ok(always.radius >= 4 && always.radius <= 10, "a button of the family, never a pill");
      assert.ok(Math.abs(always.top - c.buttons[0].top) < 1 && always.left >= c.buttons[0].right, "beside the main answer, after it");
      assert.ok(c.buttons[2].left >= always.right || c.buttons[2].top >= always.bottom, "before the answer that says no");
      for (const b of c.buttons) { assert.equal(b.cut, false, `“${b.text}” is whole`); assert.equal(b.lines, 1); }
      assert.match(always.title, /Always allow lets Mornings/);
      if (kind === "payment" || kind === "order") {
        assert.ok(c.limit, "one quiet line");
        assert.equal(c.limit.text, "Inside its daily limit"); assert.equal(c.limit.lines, 1);
        assert.ok(c.limit.bottom <= c.actions.top + 0.5 && c.actions.top - c.limit.bottom <= 16, "just over its buttons");
        assert.ok(c.limit.size <= 12, `quiet (${c.limit.size}px)`);
      } else assert.equal(c.limit, null, "only a payment says so");
      assert.equal(c.sideways, false); assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Always allow on a careful card asks DGC for the grant, with the card's own id and digest", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCard(browser, "carry", { width: 300 });
  try {
    await x.p.click("[data-computer-always]"); await x.p.waitForTimeout(250);
    const sent = await x.p.evaluate(() => (window.__sent || []).filter((r) => r.type === "always_allow_pip_computer_action"));
    assert.equal(sent.length, 1, "asked once");
    assert.match(sent[0].action_id, /^compact_/); assert.match(sent[0].expected_digest, /^[a-f0-9]{64}$/);
  } finally { await x.close(); }
});

test("a new site's card has no Always allow: Allow adds the site for good", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCard(browser, "site", { width: 300 });
  try { const c = await cardNow(x.p); assert.deepEqual(c.buttons.map((b) => b.text), ["Allow this site", "Not now"]); assert.equal(c.limit, null); } finally { await x.close(); }
});

// ---- finding 45: the site card at the narrowest side bar ----------------------------------------------------------------
for (const theme of ["dark", "light"]) for (const width of [170, 220, 300]) for (const kind of ["site", "longSite"]) {
  test(`${kind} card at ${width} px (${theme}): the site's name is never broken inside the word, and no button's words are cut`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openCard(browser, kind, { width, theme });
    try {
      const c = await cardNow(x.p);
      assert.ok(c.domains.length >= 2, "the site's name in the title and in the line under it");
      for (const d of c.domains) {
        assert.equal(d.lines, 1, `“${d.text}” is on one line`);
        assert.equal(d.dots, "ellipsis", "and ends in “…” when it is longer than the line");
        assert.ok(d.right <= c.card.right + 0.5, "inside the card");
        assert.ok(d.title.includes(d.text.replace(/\?$/, "")), "whole on hover");
      }
      if (kind === "site" && width >= 220) assert.ok(c.domains.every((d) => !d.cut), "a name that fits is whole");
      if (kind === "longSite" && width === 170) assert.ok(c.domains.every((d) => d.cut), "a name longer than the line ends in “…”");
      assert.deepEqual(c.buttons.map((b) => b.text), ["Allow this site", "Not now"]);
      for (const b of c.buttons) { assert.equal(b.cut, false, `“${b.text}” is whole (${Math.round(b.w)}px)`); assert.equal(b.lines, 1); assert.ok(b.right <= c.card.right + 0.5 && b.left >= c.card.left - 0.5); assert.ok(b.radius >= 4 && b.radius <= 10); }
      if (width === 170) {
        assert.ok(c.buttons[1].top >= c.buttons[0].bottom, "at the narrowest the buttons go one under the other");
        assert.ok(Math.abs(c.buttons[0].w - c.buttons[1].w) < 1 && c.buttons[0].w >= c.actions.w - 1, "each the full width");
      }
      assert.equal(c.sideways, false); assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
for (const kind of ["payment", "carry", "floor", "form"]) {
  test(`${kind} card at 170 px: three buttons, none cut, one under the other`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openCard(browser, kind, { width: 170 });
    try {
      const c = await cardNow(x.p);
      assert.equal(c.buttons.length, 3);
      for (const b of c.buttons) { assert.equal(b.cut, false, `“${b.text}” is whole (${Math.round(b.w)}px)`); assert.equal(b.lines, 1); assert.ok(b.right <= c.card.right + 0.5); }
      assert.ok(c.buttons[1].top >= c.buttons[0].bottom && c.buttons[2].top >= c.buttons[1].bottom);
      assert.equal(c.sideways, false);
    } finally { await x.close(); }
  });
}
