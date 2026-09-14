// The docked question card is a layout fact, so it is measured in real Chromium: with the goal,
// tasks and monitors rails showing, at 300 and 460 px wide and 480 and 620 px tall, in the dark
// theme. Stop must stay visible and clickable, the transcript keeps max(96px, 20vh), the options
// list scrolls and snaps whole rows, and the badge, descriptions and highlighted circle hold their
// contrast on the composer's real background. The capture matrix lives in render-options.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio } from "./support/webview-dom.mjs";
import { openScene } from "./support/options-scene.mjs";

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

// Resolve a CSS colour (including color-mix and alpha) to opaque hex over the given backdrop.
async function paint(page, color, backdrop) {
  return page.evaluate(([value, under]) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const probe = document.createElement("span"); document.body.appendChild(probe);
    const resolve = (css) => { probe.style.color = ""; probe.style.color = css; return getComputedStyle(probe).color; };
    ctx.fillStyle = resolve(under); ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = resolve(value); ctx.fillRect(0, 0, 1, 1);
    probe.remove();
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  }, [color, backdrop]);
}

for (const width of [300, 460]) {
  for (const height of [480, 620]) {
    test(`docked at ${width}x${height} with rails: no overflow, Stop visible, transcript kept, rows snap`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, errors } = await openScene(browser, { width, height, theme: "dark-modern" });
      try {
        const geometry = await page.evaluate(() => {
          const rect = (node) => node.getBoundingClientRect();
          const send = document.getElementById("send");
          const sendRect = rect(send);
          const hit = document.elementFromPoint(sendRect.left + sendRect.width / 2, sendRect.top + sendRect.height / 2);
          const list = document.querySelector("#cbox > .ask .ask-opts");
          return {
            overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
            cardOverflow: [...document.querySelectorAll("#cbox > .ask *")].some((node) => rect(node).right > innerWidth + 0.5),
            log: rect(document.getElementById("log")).height,
            floor: Math.max(96, innerHeight * 0.2),
            send: { top: sendRect.top, bottom: sendRect.bottom, height: sendRect.height, label: send.getAttribute("aria-label"),
              hit: hit === send || send.contains(hit) },
            footerVisible: getComputedStyle(document.getElementById("cfooter")).display !== "none",
            rail: getComputedStyle(document.getElementById("composer-rail")).display,
            list: { scroll: list.scrollHeight, client: list.clientHeight, snap: getComputedStyle(list).scrollSnapType,
              align: getComputedStyle(list.querySelector(".ask-opt")).scrollSnapAlign },
            hiddenDescriptions: [...document.querySelectorAll(".ask-opt:not(.hot) .ask-desc")].every((node) => getComputedStyle(node).display === "none"),
          };
        });
        assert.equal(geometry.overflowX, false);
        assert.equal(geometry.cardOverflow, false);
        assert.ok(geometry.log >= geometry.floor - 0.5, `transcript ${geometry.log}px >= ${geometry.floor}px`);
        assert.ok(geometry.send.height >= 24 && geometry.send.bottom <= height && geometry.send.top >= 0, JSON.stringify(geometry.send));
        assert.equal(geometry.send.label, "Stop generation");
        assert.equal(geometry.send.hit, true, "Stop is the element under its own centre");
        assert.equal(geometry.footerVisible, true);
        assert.equal(geometry.rail === "none", height < 600, `rail ${geometry.rail} at ${height}px`);
        if (height < 560) assert.equal(geometry.hiddenDescriptions, true, "below 560px only the highlighted row keeps its description");
        assert.match(geometry.list.snap, /y/);
        assert.equal(geometry.list.align, "start");
        if (geometry.list.scroll > geometry.list.client + 1) {
          // Scroll a little past a row start: the list settles on whole rows.
          const settled = await page.evaluate(async () => {
            const list = document.querySelector("#cbox > .ask .ask-opts");
            const rows = [...list.querySelectorAll(".ask-opt")];
            const target = rows[1].offsetTop - list.offsetTop;
            list.scrollTo({ top: target + 6, behavior: "instant" });
            await new Promise((resolve) => setTimeout(resolve, 400));
            const tops = rows.map((row) => row.offsetTop - list.offsetTop);
            const max = list.scrollHeight - list.clientHeight;
            return { top: list.scrollTop, tops, max };
          });
          assert.ok(settled.tops.some((top) => Math.abs(top - settled.top) <= 1) || Math.abs(settled.top - settled.max) <= 1,
            `scrollTop ${settled.top} lands on a row start ${settled.tops} or the end ${settled.max}`);
        }
        const clicked = await page.evaluate(() => { const before = window.__posted.length; document.getElementById("send").click();
          return window.__posted.slice(before).map((m) => m.type); });
        assert.deepEqual(clicked, ["cancel"], "Stop stops, even with the card open");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`contrast on the composer background (${theme}): badge, descriptions, highlighted circle, focus ring`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openScene(browser, { width: 460, height: 900, theme });
    try {
      const colors = await page.evaluate(() => {
        const style = (selector) => getComputedStyle(document.querySelector(selector));
        const cbox = getComputedStyle(document.getElementById("cbox")).backgroundColor;
        const hot = document.querySelector(".ask-opt.hot"), plain = document.querySelector(".ask-opt:not(.hot)");
        return {
          surface: cbox,
          badgeText: style(".ask-opt.hot .ask-badge").color, badgeBg: style(".ask-opt.hot .ask-badge").backgroundColor,
          desc: getComputedStyle(plain.querySelector(".ask-desc")).color,
          hotDesc: getComputedStyle(hot.querySelector(".ask-desc")).color,
          highlight: getComputedStyle(hot).backgroundColor,
          circle: getComputedStyle(hot.querySelector(".ask-n")).borderTopColor,
          pager: style(".ask-pg").color,
        };
      });
      const surface = await paint(page, colors.surface, "#000000");
      const highlight = await paint(page, colors.highlight, surface);
      const badgeBg = await paint(page, colors.badgeBg, highlight);
      const badgeText = await paint(page, colors.badgeText, badgeBg);
      assert.ok(contrastRatio(badgeText, badgeBg) >= 4.5, `badge ${badgeText} on ${badgeBg}`);
      const plainBadgeBg = await paint(page, colors.badgeBg, surface);
      assert.ok(contrastRatio(badgeText, plainBadgeBg) >= 4.5, `badge ${badgeText} on ${plainBadgeBg}`);
      const desc = await paint(page, colors.desc, surface);
      assert.ok(contrastRatio(desc, surface) >= 4.5, `description ${desc} on ${surface}`);
      const hotDesc = await paint(page, colors.hotDesc, highlight);
      assert.ok(contrastRatio(hotDesc, highlight) >= 4.5, `highlighted description ${hotDesc} on ${highlight}`);
      const circle = await paint(page, colors.circle, highlight);
      assert.ok(contrastRatio(circle, highlight) >= 3, `circle ${circle} on ${highlight}`);
      const pager = await paint(page, colors.pager, surface);
      assert.ok(contrastRatio(pager, surface) >= 4.5, `pager ${pager} on ${surface}`);
      // A keyboard move shows a visible focus ring on the row.
      await page.keyboard.press("ArrowDown");
      const ring = await page.evaluate(() => {
        const active = document.activeElement, cs = getComputedStyle(active);
        return { row: active.classList.contains("ask-opt"), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor,
          visible: active.matches(":focus-visible") };
      });
      assert.equal(ring.row, true);
      assert.equal(ring.visible, true);
      assert.notEqual(ring.style, "none");
      assert.ok(ring.width >= 1, JSON.stringify(ring));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("no transition runs under reduced motion", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openScene(browser, { width: 300, height: 620, reducedMotion: true });
  const moving = await openScene(browser, { width: 300, height: 620, reducedMotion: false });
  try {
    const durations = (p) => p.evaluate(() => [...document.querySelectorAll(".ask, .ask *")]
      .map((node) => getComputedStyle(node).transitionDuration.split(",").map(parseFloat)).flat());
    assert.ok((await durations(page)).every((value) => value === 0), "reduced motion: every duration is 0s");
    assert.ok((await durations(moving.page)).some((value) => value > 0), "the no-preference page does animate (the check is live)");
    assert.deepEqual(errors, []);
  } finally { await page.close(); await moving.page.close(); }
});
