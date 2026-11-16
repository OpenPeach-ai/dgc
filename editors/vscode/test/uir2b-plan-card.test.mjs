// User test W29 (15 Nov), in real Chromium on Work's real page: in plan mode the finished plan showed as raw Markdown in
// a code box ("## Goal", backticks and all), its answers were the modes' code names ("Approve → acceptEdits", "auto",
// "default"), and the page DGC serves for it was called "Artifact ready" with a localhost address and a bare "Stop".
// Now the plan is drawn as a reply is, a line and each answer say what approving does, and the page is a preview that
// says so. The answers stay the button family's own boxes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openPlan } from "./support/uir2b-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`W29: the plan is drawn as a reply is, and its answers say how much DGC asks (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPlan(browser, { theme, width });
    try {
      const f = await x.facts();
      assert.deepEqual(f.headings, ["Goal", "Steps", "Risk"], "its headings are headings");
      assert.ok(f.items >= 4 && f.code >= 6 && f.strong >= 3, `lists, code and bold are drawn (${f.items} items, ${f.code} code, ${f.strong} bold)`);
      assert.doesNotMatch(f.raw, /##|\*\*|```/, "no Markdown marks are left in sight");
      assert.equal(f.says, "Approve the plan by choosing how much DGC asks while it carries it out, or keep planning.", "one line says what the answers do");
      assert.deepEqual(f.buttons.map((b) => [b.d, b.text]), [["acceptEdits", "Ask before commands"], ["default", "Ask each time"], ["auto", "Never ask"], ["reject", "Keep planning"]]);
      assert.doesNotMatch(f.buttons.map((b) => b.text).join(" "), /acceptEdits|→|\bauto\b|\bdefault\b/, "never a mode's code name");
      for (const b of f.buttons) {
        assert.ok(b.title.length > 20, `${b.text} says the rest when pointed at`); assert.equal(b.cut, false, `${b.text} is whole`); assert.equal(b.box.height, 28); assert.equal(b.radius, "6px");
        assert.ok(b.box.left >= f.card.left && b.box.right <= f.card.right, `${b.text} is inside the card`);
      }
      for (const [i, a] of f.buttons.entries()) for (const b of f.buttons.slice(i + 1)) assert.ok(a.box.right <= b.box.left || b.box.right <= a.box.left || a.box.bottom <= b.box.top || b.box.bottom <= a.box.top, `${a.text} and ${b.text} don't overlap`);
      // The family's own boxes (one design language): the filled one is the wide box, the others the usual one.
      assert.deepEqual(f.buttons.map((b) => b.box.width), [152, 104, 104, 104]);
      assert.ok(f.sideways <= 0, "nothing scrolls sideways");
      // The page DGC serves for the plan: a preview, its address behind plain words, and a Stop that says what it stops.
      assert.equal(f.preview.head, "Preview ready"); assert.equal(f.preview.name, "Plan");
      assert.equal(f.preview.link, "A page on this computer only"); assert.match(f.preview.linkTitle, /^http:\/\/127\.0\.0\.1:45001\//);
      assert.deepEqual(f.preview.buttons, [{ text: "Open in browser", cut: false }, { text: "Stop preview", cut: false }]);
      assert.doesNotMatch(f.preview.words, /Artifact|127\.0\.0\.1/, "not called an artifact, and no address in sight");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("W29: each answer sends the decision it always did, and the card says what was chosen in words", async (t) => {
  if (skipOrFail(t)) return;
  for (const [d, said] of [["acceptEdits", "Approved · asks before commands"], ["default", "Approved · asks each time"], ["reject", "Kept planning · feedback: Smaller steps"]]) {
    const x = await openPlan(browser, { preview: false });
    try {
      if (d === "reject") await x.page.fill('.card[data-request-id="plan-1"] .feedback', "Smaller steps");
      await x.page.click(`.card[data-request-id="plan-1"] button[data-d="${d}"]`);
      const sent = (await x.posted("plan_response")).at(-1);
      assert.deepEqual([sent.id, sent.decision, sent.feedback], ["plan-1", d, d === "reject" ? "Smaller steps" : ""]);
      assert.equal((await x.facts()).decision, said);
    } finally { await x.page.close(); }
  }
});
