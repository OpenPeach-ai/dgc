import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openChat, conversation } from "./support/chat-scene.mjs";

// Temporary becomes Incognito, with a ghost (his pick, option D, 9 Nov): "Let's rename temporary to incognito, and change
// the box to a ghost style icon." The wide box drew a bare native checkbox (a white square in a dark theme) beside the
// word; now it is a ghost and its word at every width, lit when on, the word dropped when the box is narrow. The chat
// itself is the same: never written down, never listed, never remembered. Its wire field stays `temporary`.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const GHOST = "M5 19.5V10a7 7 0 0 1 14 0v9.5c-1.17 1.17-2.33 1.17-3.5 0s-2.33-1.17-3.5 0-2.33 1.17-3.5 0-2.33-1.17-3.5 0Z";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};

test("the words say Incognito everywhere a person reads them; the wire keeps `temporary`", () => {
  const page = read("src/chatdgc.ts");
  const toggle = page.match(/<label id="cd-temp-toggle"[\s\S]*?<\/label>/)?.[0] || "";
  assert.match(toggle, /title="Incognito: this chat isn't saved, listed or remembered"/);
  assert.match(toggle, /aria-label="Incognito chat"/);
  assert.match(toggle, /<span class="cd-tool-label">Incognito<\/span>/);
  assert.ok(toggle.includes(GHOST), "the ghost he picked (D)");
  assert.doesNotMatch(toggle, /codicon/, "no stand-in icon beside it");
  assert.match(page, /id="cd-temp-badge"[^>]*>[\s\S]{0,700}Incognito<\/span>/, "the header's badge");
  assert.match(page, /Incognito chats keep none\./, "the Library's note");
  assert.doesNotMatch(page.replace(/<!--[\s\S]*?-->/g, ""), />[^<]*\bTemporary\b[^<]*</, "no Temporary left in the page's words");
  assert.match(read("media/chatdgc.js"), /temporary/, "the conversation's field is still `temporary`");
  for (const file of ["media/library.js", "src/settingsClient.js"]) {
    assert.doesNotMatch(read(file), /Temporary chats/, `${file} still says Temporary`);
  }
  assert.match(read("media/library.js"), /Incognito chats keep none/);
  assert.match(read("src/settingsClient.js"), /Incognito chats are never remembered/);
});

async function freshChat(width, theme = "dark-modern") {
  const s = await openChat(browser, { width, height: 600, theme });
  await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
  await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud" });
  return s;
}
const LOOK = () => {
  const label = document.getElementById("cd-temp-toggle"), box = document.getElementById("cd-temporary");
  const ghost = label.querySelector("svg.cd-ghost"), word = label.querySelector(".cd-tool-label"), cs = getComputedStyle;
  const attach = document.getElementById("cd-attach").getBoundingClientRect();
  const r = label.getBoundingClientRect(), g = ghost?.getBoundingClientRect();
  return { boxShown: cs(box).opacity !== "0", checked: box.checked, ghost: !!g && g.width === 16 && g.height === 16, width: Math.round(r.width),
           word: word && cs(word).display !== "none" ? word.textContent : "", height: Math.round(r.height), attach: Math.round(attach.height),
           colour: cs(label).color, ground: cs(label).backgroundColor, accentText: cs(document.body).getPropertyValue("--accent-text").trim() };
};
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: a ghost and its word, no bare checkbox at any width, lit when on`, async (t) => {
    if (skipOrFail(t)) return;
    for (const width of [900, 460]) {
      const s = await freshChat(width, theme);
      try {
        const off = await s.page.evaluate(LOOK);
        assert.equal(off.boxShown, false, `${width}px: no native checkbox drawn (a white square in dark)`);
        assert.equal(off.ghost, true, `${width}px: the ghost, at 16 px`);
        assert.equal(off.word, width === 900 ? "Incognito" : "", `${width}px: the word, dropped when the box is narrow`);
        assert.equal(off.height, off.attach, `${width}px: as tall as its neighbours`);
        if (width === 460) assert.equal(off.width, off.height, "narrow, its ghost alone in a square, like its neighbours");
        assert.equal(off.checked, false);
        await s.page.locator("#cd-temp-toggle").click();
        // Read once its 120 ms colour change has run.
        await s.page.locator("#cd-temp-toggle").evaluate((n) => Promise.all(n.getAnimations().map((a) => a.finished)));
        const on = await s.page.evaluate(LOOK);
        assert.equal(on.checked, true, "a click turns it on");
        assert.equal(on.colour, rgb(on.accentText), "lit in the accent's words colour");
        assert.notEqual(on.ground, "rgba(0, 0, 0, 0)", "on a light wash of the accent");
        await s.page.locator("#cd-temporary").focus();
        await s.page.keyboard.press("Space");
        assert.equal((await s.page.evaluate(LOOK)).checked, false, "Space turns it off again");
        assert.deepEqual(s.errors, []);
      } finally { await s.page.close(); }
    }
  });
}

test("an incognito chat's header says Incognito, with the ghost", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat(browser, { width: 900, height: 600 });
  try {
    await s.send({ type: "opened", conversation: conversation({ temporary: true }), messages: [], earlier: 0, busy: false });
    const badge = await s.page.evaluate(() => { const b = document.getElementById("cd-temp-badge");
      return { shown: !b.hidden && b.checkVisibility(), text: b.textContent.trim(), ghost: !!b.querySelector("svg.cd-ghost") }; });
    assert.deepEqual(badge, { shown: true, text: "Incognito", ghost: true });
  } finally { await s.page.close(); }
});
