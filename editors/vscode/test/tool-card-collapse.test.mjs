// A step is one line until the reader opens it.
//
// The group's own folding is settled (tool-group-folding.test.mjs): it is open while the work
// happens and folds once the model has moved on, with trouble as the exception -- a failed, denied
// or stopped card keeps its group open, because an error is the one thing nobody should have to
// expand to find.
//
// What was NOT settled is the card inside it. `.tool.has-output .body { display: block }` put four
// clamped lines of output on screen for every card that had any, open or not. A clean turn hid
// that behind its folded group, so it never showed up in a screenshot of one; a turn with a single
// failure did not fold, and then every successful step beside the failure added four more lines of
// output nobody had asked to see. That is the wall this was reported as ("the tools and command
// runs still remain opened").
//
// Only a real browser can check it: the class is still on the card either way, and jsdom does not
// cascade, so a DOM assertion cannot tell a shown body from a hidden one -- which is exactly how
// three tests went on asserting `has-output` while describing behaviour the panel no longer had.
// These read the computed style.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, html, mainJs, markdownJs;

// Same contract as transcript-spacing.test.mjs: skip visibly without a browser, and fail instead
// when a run has declared that it must prove the layout rather than step around it.
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); }
  catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  mainJs = readFileSync(here + "/../media/main.js", "utf8");
  markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  html = skeleton.replace("</head>", `<style>${css}</style></head>`);
});
after(async () => { await browser?.close(); });

const OUTPUT = "line one\nline two\nline three\nline four\nline five\nline six";
const FAILURE = "not ok 412 - composer keeps the caret\n  AssertionError\n  + expected - actual\n  -3\n  +4";

/** A finished turn: one failed command, then two steps that went fine. */
const TURN = [
  { type: "turn_start", turn_id: "t1", prompt: "run the suite and fix what breaks" },
  { type: "tool_call", call_id: "c1", name: "bash", args: { command: "npm test" }, summary: "npm test" },
  { type: "tool_result", call_id: "c1", name: "bash", output: FAILURE, is_error: true },
  { type: "tool_call", call_id: "c2", name: "read_file", args: { path: "media/main.js" }, summary: "media/main.js" },
  { type: "tool_result", call_id: "c2", name: "read_file", output: OUTPUT },
  { type: "tool_call", call_id: "c3", name: "bash", args: { command: "npm test -- --only composer" },
    summary: "npm test -- --only composer" },
  { type: "tool_result", call_id: "c3", name: "bash", output: OUTPUT },
  { type: "text_delta", text: "Fixed: the pill was inserted before the range collapsed." },
  { type: "stream_end", message_id: "t1:1", phase: "answer" },
  { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 9, final_message_id: "t1:1" },
];

async function render(events) {
  const page = await browser.newPage({ viewport: { width: 460, height: 1100 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content:
    ":root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; }" });
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  await page.evaluate((list) => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event:
      { type: "ready", capabilities: {}, model: "m", mode: "default", think: "off",
        base_url: "http://127.0.0.1:1/v1", commands: [], custom_commands: [],
        goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" } } }));
    for (const event of list) {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
    }
  }, events);
  await page.waitForTimeout(250);
  return page;
}

/** What each card in the (single) group actually shows, measured rather than inferred. */
const cardStates = (page) => page.evaluate(() => {
  const group = document.querySelector(".tool-group");
  group.open = true;                       // look inside it, whatever the group itself decided
  return [...group.querySelectorAll(":scope > .tool")].map((card) => {
    const body = card.querySelector(".body");
    return {
      verb: card.querySelector(".verb").textContent.trim(),
      status: card.dataset.status,
      open: card.classList.contains("open"),
      hasOutput: card.classList.contains("has-output"),
      expanded: card.querySelector(".tool-toggle").getAttribute("aria-expanded"),
      bodyDisplay: getComputedStyle(body).display,
      bodyHeight: Math.round(body.getBoundingClientRect().height),
    };
  });
});

test("a finished step shows one line, not its output", async (t) => {
  if (skipOrFail(t)) return;
  const page = await render(TURN);
  const cards = await cardStates(page);
  const clean = cards.filter((card) => card.status === "completed");
  assert.equal(clean.length, 2, "the fixture must contain two steps that went fine");
  for (const card of clean) {
    assert.equal(card.open, false);
    assert.equal(card.expanded, "false");
    assert.ok(card.hasOutput, "the card still knows it HAS output -- that is the affordance");
    assert.equal(card.bodyDisplay, "none",
      `${card.verb} printed its output with nobody asking; a step is one line until it is opened`);
    assert.equal(card.bodyHeight, 0);
  }
  await page.close();
});

test("the step that failed is open, with its error on screen", async (t) => {
  if (skipOrFail(t)) return;
  const page = await render(TURN);
  const failed = (await cardStates(page)).find((card) => card.status === "failed");
  assert.ok(failed, "the fixture must contain a failure");
  assert.equal(failed.open, true);
  assert.equal(failed.expanded, "true");
  assert.equal(failed.bodyDisplay, "block",
    "an error is the one thing a reader must never have to expand to find");
  assert.ok(failed.bodyHeight > 0);
  await page.close();
});

test("opening a step by hand shows what it returned", async (t) => {
  if (skipOrFail(t)) return;
  const page = await render(TURN);
  const shown = await page.evaluate(() => {
    const group = document.querySelector(".tool-group");
    group.open = true;
    const card = [...group.querySelectorAll(":scope > .tool")]
      .find((item) => item.dataset.status === "completed");
    card.querySelector(".tool-toggle").click();
    const body = card.querySelector(".body");
    return { display: getComputedStyle(body).display, text: body.querySelector("pre").textContent,
             expanded: card.querySelector(".tool-toggle").getAttribute("aria-expanded"),
             clamp: getComputedStyle(body.querySelector("pre")).webkitLineClamp };
  });
  assert.equal(shown.display, "block");
  assert.equal(shown.expanded, "true");
  assert.match(shown.text, /line six/, "and all of it, not four clamped lines");
  assert.notEqual(shown.clamp, "4");
  await page.close();
});

test("a clean turn is still one folded line", async (t) => {
  if (skipOrFail(t)) return;
  // The case that already held, kept here so this file describes the whole rule rather than only
  // the half that changed.
  const page = await render(TURN.filter((event) => event.call_id !== "c1"));
  const folded = await page.evaluate(() => {
    const group = document.querySelector(".tool-group");
    return { open: group.open, label: group.querySelector(".tool-group-label").textContent.trim(),
             height: Math.round(group.getBoundingClientRect().height) };
  });
  assert.equal(folded.open, false, "nothing went wrong, so the model moving on folds the group");
  assert.ok(folded.label.length > 0, "the folded line still says what happened");
  assert.ok(folded.height < 60, `a folded group is one line, not ${folded.height}px`);
  await page.close();
});
