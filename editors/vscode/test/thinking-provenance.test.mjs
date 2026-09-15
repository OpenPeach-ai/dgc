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

for (const width of [300, 460]) {
  test(`a sub-agent's rows say so and every label lines up at ${width}px`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openThinkingPage(browser, { width, theme: "light-modern", height: 1000, events: SCENARIOS.subagent });
    try {
      const facts = await page.evaluate(() => {
        const labels = [...document.querySelectorAll(".disclosure .thought-agent, .disclosure .thought-label:first-of-type")];
        const rows = [...document.querySelectorAll(".disclosure, .thought-static")];
        const start = (row) => (row.querySelector(".thought-agent") || row.querySelector(".thought-label")).getBoundingClientRect().left;
        const prefix = document.querySelector(".disclosure[data-agent] .thought-agent");
        return {
          starts: rows.map(start),
          prefixVisible: !!prefix && prefix.getBoundingClientRect().width > 30,
          prefixes: rows.map((row) => !!row.querySelector(".thought-agent")),
          headerLines: [...document.querySelectorAll(".disclosure")].map((node) =>
            Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight))),
          labels: labels.length,
        };
      });
      assert.deepEqual(facts.prefixes, [false, true, true, false]);
      assert.ok(facts.prefixVisible, "the Sub-agent prefix is visible");
      for (const x of facts.starts) assert.ok(Math.abs(x - facts.starts[0]) <= 1, `label starts ${facts.starts.join(", ")}`);
      for (const count of facts.headerLines) assert.ok(width >= 460 ? count === 1 : count <= 2, `header spans ${count} lines`);
      const snapshot = await page.locator(".disclosure[data-agent]").ariaSnapshot();
      assert.match(snapshot, /Sub-agent ?, Thought for 2s ?, raw/, "Chromium joins the parts with a space before each comma");
    } finally {
      await page.close();
    }
  });
}

for (const width of [300, 460, 900]) {
  test(`the Show model thinking select shows its whole value at ${width}px`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openThinkingPage(browser, { width, theme: "dark-modern", height: 800, events: [] });
    try {
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
        data: { type: "settings_open", providers: [], models: [], section: "general" } })));
      await page.waitForTimeout(150);
      const facts = await page.evaluate(() => {
        const select = document.getElementById("s-show_reasoning");
        const style = getComputedStyle(select);
        const context = document.createElement("canvas").getContext("2d");
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 18;
        return { room, widths: [...select.options].map((option) => [option.textContent, context.measureText(option.textContent).width]) };
      });
      for (const [text, measured] of facts.widths) {
        assert.ok(measured <= facts.room, `"${text}" is ${measured.toFixed(1)}px in ${facts.room.toFixed(1)}px`);
      }
    } finally {
      await page.close();
    }
  });
}

test("a block whose text is not here says so inside its body", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openThinkingPage(browser, { width: 300, theme: "light-modern", height: 1000, events: SCENARIOS.missing });
  try {
    await page.evaluate(() => document.querySelectorAll(".disclosure").forEach((button) => button.click()));
    const facts = await page.evaluate((contrastSource) => {
      const contrast = eval(contrastSource);
      return [...document.querySelectorAll(".thought-cut")].map((node) => ({
        text: node.textContent, visible: node.getBoundingClientRect().height > 8, ratio: contrast(node) }));
    }, CONTRAST_SOURCE);
    assert.deepEqual(facts.map((fact) => fact.text), ["The text of this reasoning is not in this view.",
      "The text of this reasoning was not kept.", "… the rest of this reasoning was not kept."]);
    for (const fact of facts) {
      assert.ok(fact.visible);
      assert.ok(fact.ratio >= 4.5, `contrast ${fact.ratio.toFixed(2)}`);
    }
    assert.equal(await page.locator(".thought-note").count(), 0);
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

// Light Modern's descriptionForeground is its foreground (#3B3B3B): an inline summary drawn in
// --muted would read exactly like the answer beside it. The note and its hint take a derived tone
// that is visibly lighter than the text and still clears 4.5:1; Dark Modern keeps its own muted
// colour; a theme switch while the panel is open measures again.
for (const theme of ["light-modern", "dark-modern"]) {
  test(`the inline summary and its hint stay muted in ${theme}`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openThinkingPage(browser, { width: 460, theme, height: 1400, events: SCENARIOS.all });
    try {
      const facts = await page.evaluate((contrastSource) => {
        const contrast = eval(contrastSource);
        const note = document.querySelector(".thought-note"), hint = note.querySelector(".thought-hint");
        const answer = document.querySelector("#log .text:not(.thought-note)") || document.body;
        return { note: getComputedStyle(note.querySelector("p")).color, hint: getComputedStyle(hint).color,
                 text: getComputedStyle(answer).color, noteContrast: contrast(note.querySelector("p")),
                 hintContrast: contrast(hint), muted: getComputedStyle(document.body).getPropertyValue("--vscode-descriptionForeground").trim() };
      }, CONTRAST_SOURCE);
      assert.notEqual(facts.note, facts.text, `the note is not drawn in the text colour (${facts.note})`);
      assert.notEqual(facts.hint, facts.text, "nor is its hint");
      assert.ok(facts.noteContrast >= 4.5 && facts.hintContrast >= 4.5,
        `still readable: ${facts.noteContrast.toFixed(2)} / ${facts.hintContrast.toFixed(2)}`);
      if (theme === "dark-modern") assert.equal(facts.note, "rgb(157, 157, 157)", "a theme with its own muted colour keeps it");
    } finally {
      await page.close();
    }
  });
}

test("switching from Dark Modern to Light Modern with the panel open re-derives the muted tone", async (t) => {
  if (skipOrFail(t)) return;
  const page = await openThinkingPage(browser, { width: 460, theme: "dark-modern", height: 1400, events: SCENARIOS.all });
  try {
    const light = { "--vscode-sideBar-background": "#F8F8F8", "--vscode-editor-background": "#FFFFFF",
      "--vscode-foreground": "#3B3B3B", "--vscode-editor-foreground": "#3B3B3B", "--vscode-descriptionForeground": "#3B3B3B" };
    // What VS Code does on a theme change: new variables on <html> and a new body theme class.
    await page.evaluate((vars) => {
      for (const [name, value] of Object.entries(vars)) document.documentElement.style.setProperty(name, value);
      document.body.classList.replace("vscode-dark", "vscode-light");
    }, light);
    await page.waitForTimeout(100);
    const facts = await page.evaluate((contrastSource) => {
      const contrast = eval(contrastSource);
      const p = document.querySelector(".thought-note p");
      return { note: getComputedStyle(p).color, text: getComputedStyle(document.body).color, contrast: contrast(p) };
    }, CONTRAST_SOURCE);
    assert.equal(facts.text, "rgb(59, 59, 59)");
    assert.notEqual(facts.note, facts.text);
    assert.ok(facts.contrast >= 4.5, facts.contrast.toFixed(2));
  } finally {
    await page.close();
  }
});
