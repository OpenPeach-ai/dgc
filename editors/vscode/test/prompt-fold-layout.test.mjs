// A long prompt's fold is a layout fact, so it is measured in real Chromium: the five-line clamp, the
// fade, the "Show more" pill (hover, keyboard, touch, High Contrast, forced colours), the sticky "Show
// less" and where it stops, the pins, and the fold being decided again when the width changes. A
// string test cannot see a cascade -- the clamp could lose to a later rule and every attribute test
// would still pass -- so every face here is read back from computed style and geometry.
// prompt-fold.test.mjs holds the behaviour in jsdom; render-panel.mjs --long-prompt draws the faces.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
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

// Twelve lines short enough never to wrap, even at 300px.
const LONG = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: check the bounds`).join("\n");
// The same, with a URL on line 2 (inside the five visible lines) and one on line 11 (folded away).
const LINKED = LONG.split("\n").map((row, i) => (i === 1 ? "See https://vibedgc.com/docs"
  : i === 10 ? "Then https://example.com/later" : row)).join("\n");
const TALL = Array.from({ length: 48 }, (_, i) => `Line ${i + 1} of a long pasted spec`).join("\n");
const WIDE = "The migration touches several tables, so the order of the steps matters a great deal. ".repeat(5).slice(0, 420);
// A typed link wears its site's favicon from the icon service; it is answered here, offline.
const FAVICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const turn = (id, prompt, answer = "Done: the bounds hold.") => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt" },
  { type: "text_delta", text: answer },
  { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:1` },
];

// The real panel: the shipped skeleton and stylesheet, a VS Code theme's variables and body class,
// then main.js, a session and a backend that has said hello.
async function openPage({ width = 460, height = 800, theme = "dark-modern", forcedColors = false, context = null } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = context ? await context.newPage()
    : await browser.newPage({ viewport: { width, height }, forcedColors: forcedColors ? "active" : "none" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("https://www.google.com/s2/favicons**", (route) => route.fulfill({ contentType: "image/png", body: FAVICON }));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const events = async (list) => { for (const event of list) await send({ type: "event", event }); };
  await send({ type: "session_ready", sessionId: "s1" });
  await events([{ type: "ready", capabilities: { history_snapshot: true }, model: "qwen3.8:27b", mode: "default", think: "off",
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" }]);
  const settle = (ms = 160) => page.evaluate((wait) => new Promise((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
  return { page, send, events, settle, errors };
}
// The pill fades in and out over 120ms: read its opacity once any transition on it has finished, not
// after a fixed sleep (a loaded machine runs the fade late).
const opacity = (page, index = -1) => page.evaluate(async (i) => {
  const toggle = [...document.querySelectorAll(".prompt-fold")].at(i);
  await Promise.all(toggle.getAnimations().map((animation) => animation.finished.catch(() => {})));
  return getComputedStyle(toggle).opacity;
}, index);
const focusedName = (page) => page.evaluate(() => {
  const node = document.activeElement;
  if (node?.classList.contains("prompt-fold")) return "toggle";
  if (node?.classList.contains("prompt-link")) return `link ${node.textContent}`;
  return node?.id || node?.className || node?.tagName || "";
});

for (const theme of ["dark-modern", "light-modern", "hc"]) {
  for (const width of [300, 460]) {
    test(`a long prompt shows five lines, and its pill answers hover and Tab (${theme}, ${width}px)`, async (t) => {
      if (skipOrFail(t)) return;
      const s = await openPage({ width, theme });
      try {
        await s.events(turn("t1", LINKED));
        await s.settle();
        await s.page.mouse.move(1, 1);
        const rest = await s.page.evaluate(() => {
          const bubble = document.querySelector(".msg.user > .bubble"), text = bubble.querySelector(":scope > .prompt-text");
          const style = getComputedStyle(text);
          return { fold: bubble.dataset.fold, line: parseFloat(style.lineHeight), clientHeight: text.clientHeight,
            scrollHeight: text.scrollHeight, maxHeight: style.maxHeight, mask: style.webkitMaskImage, maskStd: style.maskImage };
        });
        assert.equal(rest.fold, "folded");
        assert.ok(Math.abs(rest.clientHeight - 5 * rest.line) <= 1, `five lines show: ${rest.clientHeight}px of ${rest.line}px lines`);
        assert.ok(rest.scrollHeight > rest.clientHeight + rest.line, "and the rest is there, folded away");
        assert.notEqual(rest.maxHeight, "none", "the clamp wins the cascade");
        if (theme === "hc") {
          assert.equal(rest.mask, "none", "High Contrast cuts the text cleanly, no fade");
          assert.equal(rest.maskStd, "none");
          assert.equal(await opacity(s.page), "1", "and always shows the pill");
        } else {
          assert.match(rest.mask, /linear-gradient/, "the last lines fade out");
          assert.match(rest.maskStd, /linear-gradient/);
          assert.equal(await opacity(s.page), "0", "at rest the pill is not shown");
        }
        await s.page.hover(".msg.user > .bubble");
        assert.equal(await opacity(s.page), "1", "hovering the bubble shows it");
        await s.page.mouse.move(1, 1);
        assert.equal(await opacity(s.page), theme === "hc" ? "1" : "0", "and moving away hides it again");

        // Real Tab presses from the header: the link on line 2, then the pill; line 11's link is
        // folded away and skipped until the prompt opens.
        await s.page.evaluate(() => document.getElementById("thread-title").focus());
        const order = [];
        for (let i = 0; i < 60 && order.at(-1) !== "toggle"; i += 1) {
          await s.page.keyboard.press("Tab");
          order.push(await focusedName(s.page));
        }
        assert.equal(order.at(-1), "toggle", `Tab reaches the pill (${order.join(" > ")})`);
        assert.equal(order.at(-2), "link https://vibedgc.com/docs", `the visible link comes just before it (${order.join(" > ")})`);
        assert.equal(order.some((name) => name.includes("example.com")), false, "the folded link is skipped");
        assert.equal(await s.page.evaluate(() => document.querySelector(".prompt-fold").matches(":focus-visible")), true);
        assert.equal(await opacity(s.page), "1", "keyboard focus shows the pill without a pointer anywhere near it");

        const geometry = await s.page.evaluate(() => {
          const log = document.getElementById("log"), bubble = document.querySelector(".msg.user > .bubble");
          const toggle = bubble.querySelector(".prompt-fold");
          const b = bubble.getBoundingClientRect(), r = toggle.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".prompt-fold");
          const selection = getSelection();
          selection.selectAllChildren(bubble);
          const copied = selection.toString();
          selection.removeAllRanges();
          return { inside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
            hit: hit === toggle, height: r.height, overflow: log.scrollWidth - log.clientWidth, copied };
        });
        assert.ok(geometry.inside, "the pill sits inside its bubble");
        assert.ok(geometry.hit, "and nothing covers it");
        assert.ok(geometry.height >= 24, `a 24px target at least (${geometry.height}px)`);
        assert.ok(geometry.overflow <= 0, `the transcript does not scroll sideways (${geometry.overflow}px)`);
        assert.doesNotMatch(geometry.copied, /Show (more|less)/, "a selection never holds the pill's words");
        assert.match(geometry.copied, /Step 12/, "and does hold the folded-away tail");
        assert.deepEqual(s.errors, []);
      } finally { await s.page.close(); }
    });
  }
}

test("holding a key down on the pill toggles it once", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage();
  const fold = () => s.page.evaluate(() => document.querySelector(".msg.user > .bubble").dataset.fold);
  try {
    await s.events(turn("t1", LONG));
    await s.settle();
    await s.page.evaluate(() => document.getElementById("thread-title").focus());
    for (let i = 0; i < 30 && (await focusedName(s.page)) !== "toggle"; i += 1) await s.page.keyboard.press("Tab");
    assert.equal(await focusedName(s.page), "toggle");
    // Playwright sends every keydown after the first with `repeat: true`, as a held key does.
    for (let i = 0; i < 4; i += 1) await s.page.keyboard.down("Enter");
    await s.page.keyboard.up("Enter");
    assert.equal(await fold(), "open", "a held Enter opened it once, and did not flip it back and forth");
    for (let i = 0; i < 4; i += 1) await s.page.keyboard.down(" ");
    await s.page.keyboard.up(" ");
    assert.equal(await fold(), "folded", "a held Space folds it once");
    assert.equal(await focusedName(s.page), "toggle", "focus stays on the pill throughout");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("forced colours cut the text cleanly and always show the pill", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ forcedColors: true });
  try {
    await s.events(turn("t1", LONG));
    await s.settle();
    await s.page.mouse.move(1, 1);
    const face = await s.page.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".msg.user .prompt-text"));
      return { fold: document.querySelector(".msg.user > .bubble").dataset.fold, mask: style.webkitMaskImage, maskStd: style.maskImage };
    });
    assert.equal(face.fold, "folded");
    assert.equal(face.mask, "none");
    assert.equal(face.maskStd, "none");
    assert.equal(await opacity(s.page), "1");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a touch screen, which cannot hover, always shows the pill", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ viewport: { width: 460, height: 800 }, hasTouch: true, isMobile: true });
  try {
    const s = await openPage({ context });
    await s.events(turn("t1", LONG));
    await s.settle();
    const hoverNone = await s.page.evaluate(() => matchMedia("(hover: none)").matches);
    if (!hoverNone) { t.skip("this Chromium does not report (hover: none) for an emulated touch screen"); return; }
    assert.equal(await s.page.evaluate(() => document.querySelector(".msg.user > .bubble").dataset.fold), "folded");
    assert.equal(await opacity(s.page), "1");
    assert.deepEqual(s.errors, []);
  } finally { await context.close(); }
});

test("open, Show less stays in reach down a long prompt, clear of the Latest pill, and folding brings the top back", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 460, height: 600 });
  try {
    for (let i = 0; i < 4; i += 1) await s.events(turn(`p${i}`, `Earlier question ${i}`, "Some answer prose. ".repeat(30)));
    await s.events(turn("t1", TALL, `Answer.\n\n${"More prose. ".repeat(40)}`));
    await s.settle();
    const bubbles = ".msg.user > .bubble";

    // A drag that starts on line 2 and runs off below the bubble selects into the folded tail; the
    // clipped box must not scroll with it, or the five-line window would show a later slice.
    const start = await s.page.evaluate((sel) => {
      const text = [...document.querySelectorAll(sel)].at(-1).querySelector(".prompt-text");
      text.scrollIntoView({ block: "center" });
      const r = text.getBoundingClientRect();
      return { x: r.left + 24, y: r.top + 30, bottom: r.bottom };
    }, bubbles);
    await s.page.mouse.move(start.x, start.y);
    await s.page.mouse.down();
    await s.page.mouse.move(start.x + 10, start.bottom + 200, { steps: 12 });
    await s.page.waitForTimeout(400);
    await s.page.mouse.up();
    assert.equal(await s.page.evaluate((sel) => [...document.querySelectorAll(sel)].at(-1).querySelector(".prompt-text").scrollTop, bubbles), 0,
      "a drag-selection leaves the folded window on the prompt's first lines");
    await s.page.evaluate(() => getSelection().removeAllRanges());
    await s.page.mouse.move(1, 1);

    // The keyboard way in: Tab from the control before it, Enter to open.
    await s.page.evaluate(() => [...document.querySelectorAll(".ract-edit")].at(-2).focus());
    await s.page.keyboard.press("Tab");
    assert.equal(await focusedName(s.page), "toggle");
    await s.page.keyboard.press("Enter");
    const opened = await s.page.evaluate((sel) => {
      const bubble = [...document.querySelectorAll(sel)].at(-1), toggle = bubble.querySelector(".prompt-fold");
      return { fold: bubble.dataset.fold, expanded: toggle.getAttribute("aria-expanded"), focused: document.activeElement === toggle };
    }, bubbles);
    assert.deepEqual(opened, { fold: "open", expanded: "true", focused: true });
    await s.settle(60);
    const pin = await s.page.evaluate((sel) => {
      const block = [...document.querySelectorAll(sel)].at(-1).parentElement;
      return { pin: block.style.containIntrinsicSize, height: block.offsetHeight };
    }, bubbles);
    assert.equal(pin.pin, `auto ${pin.height}px`, "the open prompt's block is pinned at its open height");

    // Read down into it: its top in view, its end below the transcript.
    const stuck = await s.page.evaluate(async (sel) => {
      const log = document.getElementById("log"), bubble = [...document.querySelectorAll(sel)].at(-1);
      log.dispatchEvent(new WheelEvent("wheel"));
      log.scrollTop += bubble.getBoundingClientRect().top - log.getBoundingClientRect().top - 40;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const view = log.getBoundingClientRect(), b = bubble.getBoundingClientRect();
      const toggle = bubble.querySelector(".prompt-fold").getBoundingClientRect();
      const latest = document.getElementById("to-latest");
      const l = latest.getBoundingClientRect();
      return { spans: b.top > view.top && b.bottom > view.bottom, fromBottom: view.bottom - toggle.bottom,
        insideBubble: toggle.left >= b.left && toggle.right <= b.right, beforeEnd: toggle.bottom < b.bottom - 50,
        latestShown: !latest.hidden && l.height > 0,
        overlap: !latest.hidden && toggle.left < l.right && toggle.right > l.left && toggle.top < l.bottom && toggle.bottom > l.top,
        settled: bubble.parentElement.classList.contains("settled") };
    }, bubbles);
    assert.ok(stuck.spans, "the open prompt runs past the bottom of the transcript");
    assert.ok(stuck.beforeEnd && stuck.insideBubble, "Show less is stuck in view, not at the end of the text");
    assert.ok(stuck.fromBottom >= 36, `and stands ${stuck.fromBottom}px above the transcript's bottom edge`);
    assert.ok(stuck.latestShown, "the reader is away from the end, so the Latest pill shows");
    assert.equal(stuck.overlap, false, "and the two never overlap");
    assert.ok(stuck.settled, "it sticks inside a settled (content-visibility: auto) block");

    // Read further, so the prompt's top has gone above the transcript, then Show less.
    await s.page.evaluate((sel) => {
      const log = document.getElementById("log"), bubble = [...document.querySelectorAll(sel)].at(-1);
      log.dispatchEvent(new WheelEvent("wheel"));
      log.scrollTop += bubble.getBoundingClientRect().top - log.getBoundingClientRect().top + 200;
    }, bubbles);
    await s.settle(30);
    assert.ok(await s.page.evaluate((sel) => [...document.querySelectorAll(sel)].at(-1).getBoundingClientRect().top
      < document.getElementById("log").getBoundingClientRect().top, bubbles), "the prompt's top is above the view");
    await s.page.keyboard.press("Enter");
    const folded = await s.page.evaluate((sel) => {
      const log = document.getElementById("log"), bubble = [...document.querySelectorAll(sel)].at(-1);
      const toggle = bubble.querySelector(".prompt-fold");
      return { fold: bubble.dataset.fold, top: bubble.getBoundingClientRect().top - log.getBoundingClientRect().top,
        focused: document.activeElement === toggle };
    }, bubbles);
    folded.opacity = await opacity(s.page);
    assert.equal(folded.fold, "folded");
    assert.ok(folded.top >= -1, `its top is back in view (${folded.top}px from the transcript's top)`);
    assert.ok(Math.abs(folded.top - 16) <= 1, `16px clear of the edge (${folded.top}px)`);
    assert.ok(folded.focused, "focus stays on the pill");
    assert.equal(folded.opacity, "1", "which stays visible because it has keyboard focus");

    // Open with the pointer, with the end in view: Show less sits 8px under the last line, at the right.
    await s.page.click(`${bubbles} >> nth=-1 >> .prompt-fold`);
    const resting = await s.page.evaluate(async (sel) => {
      const log = document.getElementById("log"), bubble = [...document.querySelectorAll(sel)].at(-1);
      log.dispatchEvent(new WheelEvent("wheel"));
      log.scrollTop += bubble.getBoundingClientRect().bottom - log.getBoundingClientRect().bottom + 120;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const text = bubble.querySelector(".prompt-text").getBoundingClientRect(), b = bubble.getBoundingClientRect();
      const toggle = bubble.querySelector(".prompt-fold").getBoundingClientRect();
      return { fold: bubble.dataset.fold, below: toggle.top - text.bottom, right: b.right - toggle.right,
        label: getComputedStyle(bubble.querySelector(".prompt-fold"), "::before").content };
    }, bubbles);
    assert.equal(resting.fold, "open");
    assert.ok(Math.abs(resting.below - 8) <= 1, `under the last line (${resting.below}px)`);
    assert.ok(Math.abs(resting.right - 12) <= 1, `at the bubble's right padding (${resting.right}px)`);
    assert.equal(resting.label, '"Show less"');
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a fold is decided again at a new width, without moving the reader", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 900, height: 900 });
  const foldOf = () => s.page.evaluate(() => [...document.querySelectorAll(".msg.user > .bubble")].map((b) => b.dataset.fold || "none"));
  try {
    for (let i = 0; i < 10; i += 1) await s.events(turn(`p${i}`, `${i}. ${WIDE}`, `Answer ${i}. ${"The bounds hold across every page. ".repeat(8)}`));
    await s.settle(300);
    assert.ok((await foldOf()).every((state) => state === "none"), "at 900px a 420-character line fits in four lines");
    // Read from the middle: not following the end.
    await s.page.evaluate(() => { const log = document.getElementById("log"); log.dispatchEvent(new WheelEvent("wheel")); log.scrollTop = log.scrollHeight * 0.45; });
    await s.settle();
    await s.page.setViewportSize({ width: 300, height: 900 });
    await s.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    // Never a turn's prompt: pinned, it stays where it is drawn whatever moves under it (0.47 pinned
    // prompt), and the check below would pass however far the page jumped.
    const before = await s.page.evaluate(() => {
      const log = document.getElementById("log"), top = log.getBoundingClientRect().top;
      const blocks = [...log.querySelectorAll(".msg")].filter((n) => !n.parentElement.closest(".msg") && !n.classList.contains("turn-head"));
      const index = blocks.findIndex((n) => n.getBoundingClientRect().bottom > top);
      return { index, top: blocks[index].getBoundingClientRect().top };
    });
    const until = (want) => s.page.waitForFunction((state) => [...document.querySelectorAll(".msg.user > .bubble")]
      .every((b) => (b.dataset.fold || "none") === state), want, { timeout: 5000 }).catch(() => {});
    await until("folded");
    await s.settle(60);
    assert.ok((await foldOf()).every((state) => state === "folded"), `at 300px every one folds (${await foldOf()})`);
    const after = await s.page.evaluate((index) => [...document.getElementById("log").querySelectorAll(".msg")]
      .filter((n) => !n.parentElement.closest(".msg") && !n.classList.contains("turn-head"))[index].getBoundingClientRect().top, before.index);
    assert.ok(Math.abs(after - before.top) <= 2, `the block being read moved ${Math.round(after - before.top)}px as the folds came`);
    await s.page.setViewportSize({ width: 900, height: 900 });
    await until("none");
    await s.settle(60);
    assert.ok((await foldOf()).every((state) => state === "none"), `back at 900px none does (${await foldOf()})`);
    assert.equal(await s.page.evaluate(() => document.querySelectorAll(".prompt-fold").length), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a prompt drawn live and the same prompt replayed fold to the same height", async (t) => {
  if (skipOrFail(t)) return;
  const live = await openPage({ width: 460 }), replay = await openPage({ width: 460 });
  try {
    await live.page.evaluate((text) => {
      const input = document.getElementById("input");
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("send").click();
    }, LONG);
    const id = await live.page.evaluate(() => window.__posted.filter((m) => m.type === "prompt").at(-1).requestId);
    await live.events([{ type: "prompt_accepted", request_id: id, state: "started" }, { ...turn("t1", LONG)[0], request_id: id }, ...turn("t1", LONG).slice(1)]);
    await replay.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", items: turn("t1", LONG), todos: [] }]);
    const shape = (s) => s.page.evaluate(() => [...document.querySelectorAll(".msg.user > .bubble")]
      .map((b) => ({ fold: b.dataset.fold, height: b.getBoundingClientRect().height })));
    await live.settle(); await replay.settle();
    const [a, b] = [await shape(live), await shape(replay)];
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].fold, "folded");
    assert.equal(b[0].fold, a[0].fold);
    assert.ok(Math.abs(a[0].height - b[0].height) <= 1, `live ${a[0].height}px, replayed ${b[0].height}px`);
    assert.deepEqual([...live.errors, ...replay.errors], []);
  } finally { await live.page.close(); await replay.page.close(); }
});
