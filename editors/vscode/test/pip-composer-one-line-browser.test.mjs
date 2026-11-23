// A Pip's prompt box keeps its controls on ONE line at every width, as Work's and ChatDGC's composers do (decided,
// 14 Nov: at narrow widths the "Ask me first" chip and the model selector broke onto two lines). Nothing wraps: as the
// box narrows, labels give way to their icons at the widths Work's composer changes at (media/main.css: 640, 560, 420,
// 360 and 320 px of the side bar), and every control that is only an icon keeps its name in aria-label and title.
// Real Chromium: only a browser lays the row out.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { client, openChat } from "./support/pip-chat-scene.mjs";

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
await client();

/** Every control of the row, as laid out: its box, its words that show, and its names. */
const controls = (root) => root.evaluate((scope) => {
  const row = scope.querySelector(".pip-composer .composer-controls");
  const shown = (node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden"; };
  // The words a control shows: text of its spans that are laid out (an icon is an svg, never text).
  const words = (node) => {
    let text = "";
    const walk = (el) => { for (const child of el.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1 && child.tagName !== "svg" && shown(child) && getComputedStyle(child).display !== "none") walk(child);
    } };
    walk(node);
    // Words drawn by CSS (Work's shorter "Model" label is one) count too.
    for (const el of [node, ...node.querySelectorAll("*")]) { if (el.tagName === "svg" || !shown(el)) continue;
      const before = getComputedStyle(el, "::before").content; if (before && before !== "none" && before !== "normal") text += before.replace(/^"|"$/g, ""); }
    return text.trim();
  };
  const frame = row.getBoundingClientRect(), box = scope.querySelector(".pip-composer").getBoundingClientRect();
  return { row: { left: frame.left, right: frame.right, height: frame.height, scroll: row.scrollWidth, client: row.clientWidth },
    box: { left: box.left, right: box.right, width: box.width },
    page: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
    items: [...row.querySelectorAll("button")].filter(shown).map((b) => { const r = b.getBoundingClientRect();
      return { id: b.id, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, words: words(b), label: b.getAttribute("aria-label") || "", title: b.getAttribute("title") || "",
        icon: !!b.querySelector("svg") && [...b.querySelectorAll("svg")].some((s) => { const q = s.getBoundingClientRect(); return q.width > 0 && q.height > 0; }) }; }) };
});

// What the row holds in this scene: add, the context meter with its %, Routines with its count, the level, the model, send.
const EXPECTED = ["chat-attach", "chat-context-toggle", "chat-routines", "chat-level", "chat-model"];
const OPTS = { where: "side", theme: "dark", api: 96, settings: true, level: "ask", height: 700 };

for (const width of [300, 360, 440, 700]) {
  test(`a Pip's prompt box keeps every control on one line, inside the box, at ${width}px`, async (t) => {
    if (skipOrFail(t)) return;
    const chat = await openChat(browser, { ...OPTS, width });
    try {
      await chat.p.waitForSelector("#chat-level .composer-level-name", { state: "attached" });
      const seen = await controls(chat.root);
      const ids = seen.items.map((item) => item.id);
      for (const id of EXPECTED) assert.ok(ids.includes(id), `${id} is on the row at ${width}px (${ids.join(", ")})`);
      // One line: every control's top and bottom agree (controls are one height, 28px).
      const tops = seen.items.map((item) => Math.round(item.top)), mids = seen.items.map((item) => (item.top + item.bottom) / 2);
      assert.ok(Math.max(...mids) - Math.min(...mids) <= 1, `every control sits on one line at ${width}px: tops ${tops.join(", ")} (${ids.join(", ")})`);
      assert.ok(seen.row.height <= 44, `the row is one line high at ${width}px, not ${seen.row.height}px`);
      // Nothing overflows sideways: each control is inside the row, none is drawn over its neighbour, and nothing scrolls.
      for (const item of seen.items) {
        assert.ok(item.left >= seen.box.left - 0.5 && item.right <= seen.box.right + 0.5, `${item.id} is inside the box at ${width}px (${item.left}..${item.right} in ${seen.box.left}..${seen.box.right})`);
        assert.ok(item.width >= 24, `${item.id} keeps a size that can be pressed at ${width}px (${item.width}px)`);
      }
      const inOrder = [...seen.items].sort((a, b) => a.left - b.left);
      for (let i = 1; i < inOrder.length; i++) assert.ok(inOrder[i].left >= inOrder[i - 1].right - 0.5, `${inOrder[i].id} is not drawn over ${inOrder[i - 1].id} at ${width}px`);
      assert.ok(seen.row.scroll <= seen.row.client + 1, `the row does not scroll sideways at ${width}px (${seen.row.scroll} > ${seen.row.client})`);
      assert.ok(seen.page.scroll <= seen.page.client + 1, `the page does not scroll sideways at ${width}px`);
      // A control that is only its icon keeps its name where a pointer and a screen reader find it.
      for (const item of seen.items) {
        if (item.words) continue;
        assert.ok(item.icon, `${item.id} with no words shows its icon at ${width}px`);
        assert.ok(item.label.trim().length > 3, `${item.id} (icon only at ${width}px) keeps its name in aria-label`);
        assert.ok(item.title.trim().length > 3, `${item.id} (icon only at ${width}px) keeps its name in title`);
      }
      const by = Object.fromEntries(seen.items.map((item) => [item.id, item]));
      assert.match(by["chat-level"].label, /Ask me first/, "the level's name stays in its label");
      assert.match(by["chat-level"].title, /Ask me first/, "and in its title");
      assert.match(by["chat-routines"].label, /Routines/);
      assert.match(by["chat-context-toggle"].label, /Context window/);
      if (width >= 700) {
        // With room, the words are there.
        assert.match(by["chat-level"].words, /Ask me first/);
        assert.match(by["chat-routines"].words, /Routines/);
        assert.ok(by["chat-model"].words.length > 3, "the model is named");
      }
      if (width <= 300) {
        // At the narrowest, the level is its shield, Routines its icon, the context its icon; the model keeps its name,
        // cut to fit (15 Nov: it was its icon here, and the bare word "Model" a little wider).
        assert.equal(by["chat-level"].words, "", "the level is its shield only");
        assert.doesNotMatch(by["chat-routines"].words, /Routines/, "Routines is its icon");
        assert.equal(by["chat-context-toggle"].words, "", "the context meter is its icon only");
        assert.notEqual(by["chat-model"].words, "", "the model is named");
        assert.notEqual(by["chat-model"].words, "Model", "by its own name");
      }
      assert.deepEqual(chat.errors, []);
    } finally { await chat.close(); }
  });
}

test("a Pip's prompt box gives way at the widths Work's composer does, so both change together", async (t) => {
  if (skipOrFail(t)) return;
  // Work's mode is its shield from 420px of the side bar down, and its context % gives way from 640px down
  // (media/main.css). A Pip's level and context meter do the same on each side of both. Its model is always its own
  // name, cut to fit (15 Nov: it was the bare word "Model" from 640px down and an icon from 420px down): from 640px
  // down the thinking level beside the name gives way, and the name stays.
  const words = async (width) => {
    const chat = await openChat(browser, { ...OPTS, width });
    try {
      await chat.p.waitForSelector("#chat-level .composer-level-name", { state: "attached" });
      const seen = await controls(chat.root);
      return Object.fromEntries(seen.items.map((item) => [item.id, item.words]));
    } finally { await chat.close(); }
  };
  const [at421, at420, at641, at640] = [await words(421), await words(420), await words(641), await words(640)];
  for (const [width, at] of [[421, at421], [420, at420], [641, at641], [640, at640]]) {
    assert.notEqual(at["chat-model"], "", `at ${width}px the model is named`);
    assert.notEqual(at["chat-model"], "Model", `at ${width}px by its own name, never the word`);
  }
  assert.equal(at420["chat-level"], "", "at 420px the level is its shield, as Work's mode");
  assert.match(at421["chat-level"], /Ask me first/);
  assert.ok(at641["chat-model"].startsWith(at640["chat-model"]) && at641["chat-model"].length > at640["chat-model"].length, `from 640px down the name stands alone; above it, the thinking level is beside it (${at640["chat-model"]} / ${at641["chat-model"]})`);
  assert.equal(at640["chat-context-toggle"], "", "the context % gives way to its icon at 640px, as Work's");
  assert.match(at641["chat-context-toggle"], /%/);
});
