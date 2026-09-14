import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CONTRAST_SOURCE, SCENARIOS, openThinkingPage } from "./render-thinking.mjs";

// Thinking provenance is a layout fact as much as a label: the provenance suffix must fit a 300px
// sidebar (the provider name clipped, never dropped for screen readers), the muted text must stay
// readable in every theme, and an inline summary's hint must sit on the line its last paragraph ends
// on. Only a real browser lays that out, so these run in Chromium. DGC_REQUIRE_CHROMIUM=1 turns a
// missing browser into a failure instead of a skip.
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const THEMES = ["dark-modern", "light-modern", "hc"];

for (const width of [300, 460]) {
  for (const theme of THEMES) {
    test(`thinking rows fit and stay readable at ${width}px in ${theme}`, async (t) => {
      if (skipOrFail(t)) return;
      const page = await openThinkingPage(browser, { width, theme, height: 1400, events: SCENARIOS.all });
      try {
        const facts = await page.evaluate((contrastSource) => {
          const contrast = eval(contrastSource);
          const log = document.getElementById("log");
          const lines = (node) => {
            const style = getComputedStyle(node);
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
            return Math.round(node.getBoundingClientRect().height / lineHeight);
          };
          const headers = [...document.querySelectorAll(".disclosure")];
          const note = document.querySelector(".thought-note");
          const hint = note.querySelector(".thought-hint");
          const paragraphs = [...note.querySelectorAll("p")];
          const lastRect = [...paragraphs.at(-1).getClientRects()].at(-1);
          const hintRect = hint.getBoundingClientRect();
          const by = headers[1].querySelector(".thought-by").getBoundingClientRect();
          const staticRow = document.querySelector(".thought-static");
          return {
            overflow: Math.max(log.scrollWidth - log.clientWidth,
              document.documentElement.scrollWidth - window.innerWidth),
            headerLines: headers.map(lines),
            staticLines: lines(staticRow),
            byWidth: by.width, byHeight: by.height,
            contrast: {
              header: headers.map(contrast), note: contrast(paragraphs[0]), hint: contrast(hint),
              staticRow: contrast(staticRow),
            },
            hintOnLastLine: Math.abs(hintRect.bottom - lastRect.bottom) <= 3 && hintRect.left >= lastRect.left,
            firstParagraphBlock: getComputedStyle(paragraphs[0]).display === "block"
              && paragraphs[0].getBoundingClientRect().bottom <= paragraphs.at(-1).getBoundingClientRect().top + 1,
            lastParagraphInline: getComputedStyle(paragraphs.at(-1)).display === "inline",
          };
        }, CONTRAST_SOURCE);
        assert.ok(facts.overflow <= 0, `no horizontal overflow (${facts.overflow}px)`);
        for (const count of facts.headerLines) {
          assert.ok(width >= 460 ? count === 1 : count <= 2, `header spans ${count} lines at ${width}px`);
        }
        assert.ok(facts.staticLines <= (width >= 460 ? 1 : 2));
        if (width <= 360) assert.ok(facts.byWidth <= 1 && facts.byHeight <= 1, "the provider name is clipped at 300px");
        else assert.ok(facts.byWidth > 20, "the provider name is visible at 460px");
        for (const [name, value] of Object.entries(facts.contrast)) {
          for (const ratio of [value].flat()) assert.ok(ratio >= 4.5, `${name} contrast ${ratio.toFixed(2)} in ${theme}`);
        }
        assert.ok(facts.hintOnLastLine, "the hint shares a line box with the last paragraph");
        assert.ok(facts.firstParagraphBlock, "a two-paragraph note keeps its first paragraph as a block");
        assert.ok(facts.lastParagraphInline);

        const snapshot = await page.locator(".disclosure").nth(1).ariaSnapshot();
        assert.match(snapshot, /summarized by Anthropic/, "clipped text is still in the accessibility tree");
      } finally {
        await page.close();
      }
    });
  }
}

test("forced colours keep the hint, the note and the static row visible", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openThinkingPage(browser, { width: 300, theme: "hc", height: 1400, events: SCENARIOS.all });
  try {
    await page.emulateMedia({ forcedColors: "active" });
    const facts = await page.evaluate(() => {
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none"
          && style.color !== style.backgroundColor && style.color !== "rgba(0, 0, 0, 0)";
      };
      return {
        forced: matchMedia("(forced-colors: active)").matches,
        hint: visible(document.querySelector(".thought-hint")),
        note: visible(document.querySelector(".thought-note")),
        row: visible(document.querySelector(".thought-static")),
      };
    });
    assert.equal(facts.forced, true);
    assert.deepEqual({ hint: facts.hint, note: facts.note, row: facts.row }, { hint: true, note: true, row: true });
  } finally {
    await page.close();
  }
});

test("the settings select hint and hide-reasoning render as designed", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openThinkingPage(browser, { width: 460, theme: "dark-modern", events: SCENARIOS.all,
    config: { show_reasoning: false } });
  try {
    const hidden = await page.evaluate(() => [".disclosure", ".reasoning", ".thought-note", ".thought-static"]
      .map((selector) => [...document.querySelectorAll(selector)].every((node) => getComputedStyle(node).display === "none")));
    assert.deepEqual(hidden, [true, true, true, true]);
  } finally {
    await page.close();
  }
});
