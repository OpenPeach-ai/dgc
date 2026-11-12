// Pips in the 0.52 look, in real Chromium with the real Pips bundle (test/support/pip-chat-scene.mjs). The list: New Pip
// is the one filled button and it is the text colour, Create is an outline, New workflow is quiet text, the search box
// is a borderless field, and a row is pointed at on a 12.5 px corner. A Pip's chat: your message is the shared grey
// bubble in the page's own text colour, Undo and Details are quiet, and the prompt box has the 22 px corner. The Pips
// wordmark and the faces keep their colours. Dark and light, in a tab (700 px) and in the side bar (300 px).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull, isPurple, look, tokenColours } from "./support/look-probe.mjs";

const chromium = await chromiumOrNull();
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

import { openPips } from "./support/codex-look-scene.mjs";

const purpleFills = (p) => p.evaluate(() => { const out = []; const all = (root) => { for (const n of root.querySelectorAll("*")) { if (n.shadowRoot) all(n.shadowRoot); if (!n.checkVisibility() || n.closest("svg, .avatar, .home-pip-face, .pip-face, [role=switch][aria-checked=true]")) continue;   // (a switch that is on is a live mark: media/shared/tokens.css; a Pip's on/off switch, 12 Nov)
  const r = n.getBoundingClientRect(); if (r.width > 12 && r.height > 12) out.push({ n: n.id || String(n.className), c: getComputedStyle(n).backgroundColor }); } }; all(document); return out; });

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`the list of your Pips: one neutral filled button, an outline, quiet text, a borderless search (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, list: true });
    try {
      const token = await tokenColours(x.p, ["--solid", "--on-solid", "--field", "--text", "--text-2"], "#simple-new");
      const create = await look(x.p, "#simple-new");
      assert.deepEqual([create.fill, create.words], [token["--solid"], token["--on-solid"]], "New Pip: the text colour, filled");
      const core = await look(x.p, "#create-core");
      assert.deepEqual([core.fill, core.words, core.lineWidth], ["rgba(0, 0, 0, 0)", token["--text"], "1px"], "Create: an outline");
      assert.equal(isPurple(core.line), false);
      // (11 Nov: DGC's one button. A second action is the hairline outline with the text's colour, no longer quiet text with no edge.)
      const flow = await look(x.p, "#flow-new");
      assert.deepEqual([flow.fill, flow.words, flow.lineWidth], ["rgba(0, 0, 0, 0)", token["--text"], "1px"], "New workflow: an outline");
      const search = await look(x.p, "#pip-search");
      // (13 Nov: the search box has the shared button's corner, 6px: test/search-shape.test.mjs.)
      assert.deepEqual([search.fill, search.corner], [token["--field"], "6px"], "the search box: a field's wash");
      assert.equal(search.line, "rgba(0, 0, 0, 0)", "and no line round it");
      assert.equal((await look(x.p, ".pip-row")).corner, "12.5px");
      assert.deepEqual((await purpleFills(x.p)).filter((m) => isPurple(m.c)).map((m) => m.n), [], "nothing filled purple but a face");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`a Pip's chat: a grey bubble in the page's text colour, quiet Undo and Details, a 22px prompt box (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width });
    try {
      const token = await tokenColours(x.p, ["--bubble", "--text", "--text-2", "--box"], ".pip-message.user .bubble");
      const bubble = await look(x.p, ".pip-message.user .bubble");
      assert.deepEqual([bubble.fill, bubble.words], [token["--bubble"], token["--text"]], "your message: the shared grey, the page's own text colour");
      assert.equal(bubble.image, "none", "no light on it");
      assert.equal((await look(x.p, ".own-change-undo")).words, token["--text-2"], "Undo is quiet");
      assert.equal((await look(x.p, ".own-change-more")).words, token["--text-2"], "Details is quiet");
      const box = await look(x.p, "#chat-form");
      assert.deepEqual([box.corner, box.fill], ["22px", token["--box"]], "the prompt box");
      assert.notEqual(box.shadow, "none");
      assert.deepEqual((await purpleFills(x.p)).filter((m) => isPurple(m.c)).map((m) => m.n), [], "nothing filled purple while there is nothing to send");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
