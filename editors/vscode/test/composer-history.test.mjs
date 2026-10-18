import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// The prompt box's own undo history, in a real browser, with the real keys on both platforms:
// Cmd+Z / Cmd+Shift+Z / Cmd+Y on a Mac and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y elsewhere -- the bindings
// of Codex's composer. Each case here was wrong while the box leaned on Chromium's undo stack:
// every insertText the panel made joined the typing run before it, a typing run never ended on a
// pause, the selection a pill stands for was not in the stack at all, and a pill removed with
// Backspace could not come back. jsdom has no editing commands and no undo, so only Chromium can
// show any of it.
//
// The Mac page is the same Chromium with navigator.platform reporting a Mac, read by main.js when it
// starts: Chromium on Linux binds nothing to Cmd+Z of its own, so a Cmd+Z that works here is the
// composer's binding and nothing else.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }

let browser;
const pages = {};
const PLATFORMS = [
  { name: "Mac", mod: "Meta", platform: "MacIntel" },
  { name: "Linux and Windows", mod: "Control", platform: "Linux x86_64" },
];
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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const mainJs = readFileSync(here + "/../media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  for (const p of PLATFORMS) {
    // Served from a localhost origin, which is a secure context, so a test can read back what a copy
    // really put on the clipboard -- a copy event's own clipboardData reads empty for the browser's
    // default copy, which is written after the event.
    const context = await browser.newContext({ viewport: { width: 460, height: 800 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost" });
    const page = await context.newPage();
    const html = skeleton.replace("</head>", `<style>${css}</style></head>`);
    await page.route("http://localhost/panel", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://localhost/panel", { waitUntil: "load" });
    await page.evaluate(([mjs, mdjs, platform]) => {
      Object.defineProperty(navigator, "platform", { get: () => platform, configurable: true });
      window.__posted = [];
      window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
      window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
      window.postMessage({ type: "event", event: { type: "ready", skills: ["fixture"], custom_commands: [] } }, "*");
      window.postMessage({ type: "files", files: [{ label: "src/app.ts", path: "/w/src/app.ts",
        uri: "file:///w/src/app.ts", relative_path: "src/app.ts", workspace: "/w" }] }, "*");
    }, [mainJs, markdownJs, p.platform]);
    await page.waitForFunction(() => document.getElementById("input"));
    pages[p.name] = page;
  }
});
after(async () => { await browser?.close(); });

let chat = 0;
// A chat of its own for every case: an empty box with a fresh history, as a new chat has.
async function fresh(page) {
  await page.evaluate((id) => {
    const pop = document.getElementById("pop");
    if (pop) pop.style.display = "none";
    window.postMessage({ type: "event", event: { type: "session", kind: "new", session_id: id } }, "*");
  }, `history${++chat}`);
  await page.waitForFunction(() => document.getElementById("input").value === "");
  await page.click("#input");
}
const value = (page) => page.evaluate(() => document.getElementById("input").value);
const pills = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#input [data-pill]")].map((pill) => `${pill.dataset.kind}:${pill.textContent}`));
const lastPrompt = (page) => page.evaluate(() => window.__posted.filter((m) => m.type === "prompt").pop());
const paste = (page, text) => page.evaluate((t) => {
  const box = document.getElementById("input");
  box.focus();
  const data = new DataTransfer();
  data.setData("text/plain", t);
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, text);
// The editor's own way to a skill: type its token, and Tab picks it.
async function pickSkill(page) {
  await page.keyboard.type("$fix");
  await page.waitForFunction(() => document.getElementById("pop").style.display === "block");
  await page.keyboard.press("Tab");
}

for (const { name, mod } of PLATFORMS) {
  const undo = (page) => page.keyboard.press(`${mod}+Z`);
  const redo = (page) => page.keyboard.press(`${mod}+Shift+Z`);
  const redoY = (page) => page.keyboard.press(`${mod}+Y`);
  const key = mod === "Meta" ? "Cmd" : "Ctrl";

  test(`${name}: a paste is its own undo step, not part of the words typed before it`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("hello ");
    await paste(page, "world");
    assert.equal(await value(page), "hello world");
    await undo(page);
    assert.equal(await value(page), "hello ", `${key}+Z takes back the paste and only the paste`);
    await undo(page);
    assert.equal(await value(page), "", "and then the typing");
    await redo(page);
    assert.equal(await value(page), "hello ", `${key}+Shift+Z redoes in the same order`);
    await redoY(page);
    assert.equal(await value(page), "hello world", `${key}+Y redoes too`);
  });

  test(`${name}: dictated words are their own step`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("note:");
    await page.evaluate(() => window.postMessage({ type: "mic", from: "chat", state: "idle", text: "buy milk" }, "*"));
    await page.waitForFunction(() => document.getElementById("input").value === "note: buy milk");
    await undo(page);
    assert.equal(await value(page), "note:", "what was said goes, what was typed stays");
  });

  test(`${name}: a pause ends a typing run, as it does in Codex`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("first thought");
    await page.waitForTimeout(800);
    await page.keyboard.type(" and a second");
    await undo(page);
    assert.equal(await value(page), "first thought", "one press takes back what came after the pause");
    await undo(page);
    assert.equal(await value(page), "");
  });

  test(`${name}: a picked skill undone and redone still sends its skill`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("Review ");
    await page.waitForTimeout(600);
    await pickSkill(page);
    assert.deepEqual(await pills(page), ["skill:fixture"]);
    await undo(page);
    assert.equal(await value(page), "Review $fix", "undoing the pick gives back what was typed");
    assert.deepEqual(await pills(page), []);
    await redo(page);
    assert.deepEqual(await pills(page), ["skill:fixture"], "redo puts the pill back");
    await page.keyboard.press("Enter");
    assert.deepEqual((await lastPrompt(page)).skills, ["fixture"],
      "and the skill it stands for: the browser's redo brought back a pill that attached nothing");
  });

  test(`${name}: a picked file undone and redone still sends the file`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("open @app");
    await page.waitForFunction(() => document.getElementById("pop").style.display === "block");
    await page.keyboard.press("Enter");
    assert.deepEqual(await pills(page), ["file:src/app.ts"]);
    await undo(page);
    assert.equal(await value(page), "open @app");
    await redo(page);
    await page.keyboard.press("Enter");
    assert.deepEqual(((await lastPrompt(page)).context || []).map((c) => c.relative_path), ["src/app.ts"]);
  });

  test(`${name}: a pill removed with Backspace comes back with ${key}+Z`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("Run ");
    await page.waitForTimeout(600);
    await pickSkill(page);
    await page.keyboard.press("Backspace");
    assert.deepEqual(await pills(page), []);
    await undo(page);
    assert.deepEqual(await pills(page), ["skill:fixture"],
      "the browser's undo skipped the removal and undid the pick: the token came back, never the pill");
    assert.equal(await value(page), "Run ");
    await page.keyboard.press("Enter");
    assert.deepEqual((await lastPrompt(page)).skills, ["fixture"]);
  });

  test(`${name}: a message given back to the box is one step`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("Ship the fix");
    await page.keyboard.press("Enter");
    const { requestId } = await lastPrompt(page);
    await page.evaluate((id) => window.postMessage({ type: "prompt_rejected", requestId: id }, "*"), requestId);
    await page.waitForFunction(() => document.getElementById("input").value === "Ship the fix");
    await page.keyboard.type(" today");
    await undo(page);
    assert.equal(await value(page), "Ship the fix", "the typing after it goes first");
    await undo(page);
    assert.equal(await value(page), "", "then the message that was put back");
    await redo(page);
    assert.equal(await value(page), "Ship the fix");
  });

  test(`${name}: a paste folded into a chip is undone and redone with ${key}`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("see: ");
    await paste(page, "z".repeat(6000));
    const chips = () => page.evaluate(() => document.querySelectorAll("#attachments .pasted-chip").length);
    assert.equal(await chips(), 1);
    await page.keyboard.type("x");
    await undo(page);
    assert.equal(await value(page), "see: ", "the typing after the paste goes first");
    assert.equal(await chips(), 1);
    await undo(page);
    assert.equal(await chips(), 0, "then the chip");
    await redo(page);
    assert.equal(await chips(), 1, "and redo brings it back");
  });

  test(`${name}: the undo keys are the box's, so VS Code does not undo a second time`, async (t) => {
    // VS Code's webview host cancels Cmd/Ctrl+Z and Y on the window and sends them to the
    // workbench, whose Undo then runs execCommand("undo") on this page: the browser's stack, over
    // nodes the box's history has since replaced. The box must keep them to itself.
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.evaluate(() => {
      window.__windowKeys = [];
      window.__record = (e) => { if (/^[zy]$/i.test(e.key)) window.__windowKeys.push(e.key); };
      window.addEventListener("keydown", window.__record);
    });
    await page.keyboard.type("abc");
    await undo(page); await redo(page); await redoY(page);
    assert.deepEqual(await page.evaluate(() => window.__windowKeys), []);
    await page.evaluate(() => window.removeEventListener("keydown", window.__record));
  });

  test(`${name}: the Edit menu's Undo and Redo use the box's history`, async (t) => {
    // What the workbench sends the focused webview for Undo and Redo that do not come from its own
    // keydown -- the macOS menu bar, whose items leave focus where it is.
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("menu undo");
    await page.waitForTimeout(700);
    await page.keyboard.type(" works");
    assert.equal(await page.evaluate(() => document.execCommand("undo")), true);
    assert.equal(await value(page), "menu undo");
    assert.equal(await page.evaluate(() => document.execCommand("redo")), true);
    assert.equal(await value(page), "menu undo works");
  });

  test(`${name}: a paste as VS Code delivers it keeps the pills already in the box`, async (t) => {
    // VS Code's Paste runs execCommand("paste") on this page, so the paste handler runs INSIDE an
    // editing command, and Chromium refuses a nested one: insertText returns false. Reproduced here
    // by dispatching the paste from inside execCommand("copy"), which trips the same refusal.
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("Use ");
    await pickSkill(page);
    await page.keyboard.type(" now");
    await page.waitForTimeout(600);
    const nested = await page.evaluate(() => {
      const box = document.getElementById("input");
      let refused = null;
      document.addEventListener("copy", (e) => {
        e.preventDefault();
        refused = !document.execCommand("insertText", false, "");
        const data = new DataTransfer();
        data.setData("text/plain", ", please");
        box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }, { once: true, capture: true });
      document.execCommand("copy");
      return refused;
    });
    assert.equal(nested, true, "the paste really ran where Chromium refuses a nested editing command");
    assert.equal(await value(page), "Use  now, please");
    assert.deepEqual(await pills(page), ["skill:fixture"],
      "the pill survives: the fallback used to rewrite the box as plain text, every pill in it gone");
    await undo(page);
    assert.equal(await value(page), "Use  now", "and one press takes back the paste");
    assert.deepEqual(await pills(page), ["skill:fixture"]);
  });

  test(`${name}: a cut as VS Code delivers it takes the text out, and ${key}+Z puts it back`, async (t) => {
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("alpha beta gamma");
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document.getElementById("input").setSelectionRange(6, 11);
      document.execCommand("cut");
    });
    assert.equal(await value(page), "alpha gamma");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "beta ");
    await undo(page);
    assert.equal(await value(page), "alpha beta gamma");
  });

  test(`${name}: a copy holding pills reads as their tokens and pastes back as pills`, async (t) => {
    // Copied the way VS Code copies: its Copy command runs execCommand("copy") in the webview.
    if (skipOrFail(t)) return;
    const page = pages[name];
    await fresh(page);
    await page.keyboard.type("Use ");
    await pickSkill(page);
    await page.keyboard.type(" on @app");
    await page.waitForFunction(() => document.getElementById("pop").style.display === "block");
    await page.keyboard.press("Enter");
    await page.keyboard.type(" now");
    const copied = await page.evaluate(async () => {
      const box = document.getElementById("input");
      const range = document.createRange();
      range.selectNodeContents(box);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      document.execCommand("copy");
      const items = await navigator.clipboard.read();
      return { plain: await navigator.clipboard.readText(), types: items.flatMap((item) => item.types) };
    });
    assert.equal(copied.plain, "Use $fixture on @src/app.ts now",
      "another app gets the words and the tokens; Chromium's own copy left the pills out: \"Use  on  now\"");
    assert.deepEqual(copied.types, ["text/plain"], "and plain text only, never the box's markup");
    await page.keyboard.press("End");
    await page.keyboard.type(" | ");
    await page.waitForTimeout(600);
    await paste(page, copied.plain);
    assert.deepEqual(await pills(page), ["skill:fixture", "file:src/app.ts", "skill:fixture", "file:src/app.ts"],
      "pasted back into the box, it is pills again");
    await undo(page);
    assert.deepEqual(await pills(page), ["skill:fixture", "file:src/app.ts"], "and one press takes the whole paste back");
    await redo(page);
    await page.keyboard.press("Enter");
    const sent = await lastPrompt(page);
    assert.deepEqual(sent.skills, ["fixture"]);
    assert.deepEqual((sent.context || []).map((c) => c.relative_path), ["src/app.ts", "src/app.ts"]);
  });
}

// The clipboard keys themselves. Chromium on Linux binds them to Ctrl; a Mac's Cmd+C/X/V are its own
// platform bindings and are covered above by the command VS Code turns them into.
test("Ctrl: cut a pill out and paste it somewhere else in the box", async (t) => {
  if (skipOrFail(t)) return;
  const page = pages["Linux and Windows"];
  await fresh(page);
  await page.keyboard.type("A ");
  await pickSkill(page);
  await page.keyboard.type(" B");
  await page.evaluate(() => {
    const pill = document.querySelector("#input [data-pill]");
    const range = document.createRange();
    range.setStartBefore(pill); range.setEndAfter(pill);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await page.keyboard.press("Control+X");
  assert.deepEqual(await pills(page), [], "cut takes the pill out");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+V");
  assert.deepEqual(await pills(page), ["skill:fixture"], "paste puts it back as a pill, not as the word \"fixture\"");
  const order = await page.evaluate(() => [...document.getElementById("input").childNodes]
    .map((n) => (n.nodeType === 3 ? n.data : `[${n.textContent}]`)).join(""));
  assert.match(order, /^A  B\[fixture\]$/);
  await page.keyboard.press("Control+Z");
  assert.deepEqual(await pills(page), [], "undo takes the paste back");
  await page.keyboard.press("Control+Z");
  assert.deepEqual(await pills(page), ["skill:fixture"], "and then the cut");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.deepEqual((await lastPrompt(page)).skills, ["fixture"]);
});

test("Ctrl: Ctrl+B and Ctrl+I do not format the plain-text box", async (t) => {
  if (skipOrFail(t)) return;
  const page = pages["Linux and Windows"];
  await fresh(page);
  await page.keyboard.type("plain ");
  await page.keyboard.press("Control+B");
  await page.keyboard.press("Control+I");
  await page.keyboard.type("still plain");
  assert.equal(await page.evaluate(() => document.querySelector("#input b, #input i, #input strong, #input em")), null);
});
