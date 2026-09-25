import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// Pills in a REAL browser, with real keystrokes.
//
// This file exists because an audit found that every pill assertion in the jsdom suite was
// worthless. jsdom implements no document.execCommand, so every composer edit there falls through
// to the setComposerValue fallback, which rebuilds a canonical flat DOM and leaves the caret after
// the pill. Chromium takes the execCommand path and does the opposite: an inline
// contenteditable=false span has no editable position after it, so the caret collapses to the end
// of the PRECEDING text node. The tests were exercising the branch that does not ship.
//
// Measured consequences before the repair: a pill migrated to the end of the message, two pills
// came out reversed, Backspace could never remove one, and a link pill's URL -- whose wire text is
// the URL itself -- landed in the wrong place in what the model was sent.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }

let browser, page, posted;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");

before(async () => {
  if (!chromium) return;
  try {
    browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
  } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const mainJs = readFileSync(here + "/../media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  page = await browser.newPage({ viewport: { width: 460, height: 800 } });
  await page.setContent(skeleton.replace("</head>", `<style>${css}</style></head>`), { waitUntil: "load" });
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
  }, [mainJs, markdownJs]);
  await page.waitForFunction(() => document.getElementById("input"));
  posted = () => page.evaluate(() => window.__posted.filter(m => m.type === "prompt").map(m => m.text));
});
after(async () => { await browser?.close(); });

const value = () => page.evaluate(() => document.getElementById("input").value);
// Linux Chromium binds undo to Ctrl+Z; macOS binds it to Cmd+Z. The browser's own undo command,
// which a key binding ends up running, is exercised directly too.
const undo = () => page.keyboard.press("Control+Z");
const redo = () => page.keyboard.press("Control+Shift+Z");


const pills = () => page.evaluate(() =>
  [...document.querySelectorAll("#input .composer-pill")].map((p) => p.textContent));

// The backend announces its skills once, at connect. Start each test from an empty composer with
// the full list already registered, the way a real panel comes up -- re-announcing a different list
// mid-message is not something a real backend does.
async function freshComposer(skills) {
  await page.evaluate((s) => {
    document.getElementById("input").replaceChildren();
    window.postMessage({ type: "event", event: { type: "ready", skills: s, custom_commands: [] } }, "*");
  }, skills);
  await page.click("#input");
}

// Pick a skill the way a person does: type the token, then Tab.
async function pickSkill(name) {
  await page.keyboard.type(`$${name.slice(0, 3)}`);
  await page.keyboard.press("Tab");
}

test("what is typed after a pill lands after it, not in front of it", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["fixture"]);
  await page.keyboard.type("Review ");
  await pickSkill("fixture");
  await page.keyboard.type(" the diff");
  assert.equal(await value(), "Review  the diff",
    "the prose is what the model gets, with the pill contributing nothing");
  const order = await page.evaluate(() =>
    [...document.getElementById("input").childNodes]
      .map((n) => (n.nodeType === 3 ? n.data : `[${n.textContent}]`)).join(""));
  assert.match(order, /Review \[fixture\] the diff/,
    "the pill sits where it was picked -- it used to migrate to the end of the message");
});

test("two pills keep the order they were picked in", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["alpha", "bravo"]);
  await pickSkill("alpha");
  await page.keyboard.type(" ");
  await pickSkill("bravo");
  assert.deepEqual(await pills(), ["alpha", "bravo"], "they used to come out reversed");
});

test("Backspace after a pill removes the pill", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["fixture"]);
  await page.keyboard.type("Review ");
  await pickSkill("fixture");
  await page.keyboard.press("Backspace");
  assert.deepEqual(await pills(), [],
    "the handler used to look on the wrong side and eat the prose instead");
  assert.equal(await value(), "Review ");
});

test("a pasted link's URL lands where it was pasted", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer([]);
  await page.keyboard.type("see ");
  await page.evaluate(() => {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { items: [], getData: () => "https://example.test/a/b" } });
    document.getElementById("input").dispatchEvent(e);
  });
  await page.keyboard.type(" ok");
  assert.equal(await value(), "see https://example.test/a/b ok",
    "a link pill's wire text is the URL itself, so a misplaced caret corrupts the message");
});

test("sending clears a composer that holds only a pill", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["fixture"]);
  await pickSkill("fixture");
  assert.equal(await value(), "", "a skill pill's wire text is empty -- that is the trap");
  // A pill-only composer still sends: the skill rides along as an attachment, so submit()'s
  // "nothing to send" guard does not fire.
  await page.keyboard.press("Enter");
  assert.deepEqual(await pills(), [],
    "clearing by text offsets is a 0-to-0 no-op here, so the pill used to survive the send");
  assert.equal(await page.evaluate(() => document.getElementById("input").textContent.trim()), "");
});

test("the caret reads as after a pill, not before it", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["fixture"]);
  await page.keyboard.type("ab ");
  await pickSkill("fixture");
  // Anchor the selection on the host with an offset past the pill, which is what Chromium hands
  // back once the caret sits after an uneditable inline element.
  const at = await page.evaluate(() => {
    const host = document.getElementById("input");
    const pill = host.querySelector(".composer-pill");
    const parent = pill.parentNode;
    const idx = [...parent.childNodes].indexOf(pill);
    const sel = window.getSelection(), range = document.createRange();
    range.setStart(parent, idx + 1); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    return host.selectionStart;
  });
  assert.equal(at, 3, "the offset past the pill means after \"ab \", not back at the start of it");
});

test("a drop the composer cannot use does not inject itself", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer([]);
  const defaultPrevented = await page.evaluate(() => {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: {
      types: ["text/html"], getData: (t) => (t === "text/plain" ? "dropped" : ""),
    } });
    document.getElementById("input").dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(defaultPrevented, true,
    "an editing host is a native drop target -- an untaken drop inserts the dragged markup verbatim");
  assert.equal(await value(), "dropped", "the text still arrives, as text");
});

test("picking one skill twice keeps it attached until the last pill goes", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["fixture"]);
  await page.keyboard.type("run ");
  await pickSkill("fixture");
  await page.keyboard.type(" and again ");
  await pickSkill("fixture");
  await page.keyboard.press("Backspace");   // drop the second pill
  assert.equal((await pills()).length, 1, "one pill still stands for the skill");
  await page.keyboard.press("Enter");
  const skills = await page.evaluate(() => (window.__posted || [])
    .filter((m) => m.type === "prompt").map((m) => m.skills || []).pop());
  assert.deepEqual(skills, ["fixture"],
    "the surviving pill's skill used to be dropped by the first removal, sending no skills at all");
});

test("each pill wears the sigil that picks it, and the one on its own chip", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  // attachInvocation labels the chip "$name" for a skill and "/name" for a template, and the
  // picker opens on $ for skills. A skill had no CSS rule at all, so it fell through to the
  // default and rendered the template's sigil above a chip carrying its own.
  await freshComposer(["fixture"]);
  const sigil = (kind) => page.evaluate((k) => {
    const host = document.getElementById("input");
    host.replaceChildren();
    const pill = document.createElement("span");
    pill.className = `composer-pill pill-${k}`;
    pill.dataset.kind = k; pill.dataset.pill = ""; pill.textContent = "fixture";
    host.appendChild(pill);
    return getComputedStyle(pill, "::before").content.replace(/"/g, "");
  }, kind);
  assert.equal(await sigil("skill"), "$");
  assert.equal(await sigil("template"), "/");
  assert.equal(await sigil("file"), "@");
  assert.equal(await sigil("link"), "\ueb01",
    "a link pill wears the bundled globe codicon -- a fetched favicon would disclose the host of a "
    + "URL the user may still delete");
});

test("a pill-only draft does not render the placeholder over itself", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["fixture"]);
  await pickSkill("fixture");
  const state = await page.evaluate(() => {
    const host = document.getElementById("input");
    return { empty: host.classList.contains("is-empty"), value: host.value,
             placeholderX: getComputedStyle(host, "::before").content };
  });
  assert.equal(state.value, "", "the pill still carries no wire text");
  assert.equal(state.empty, false,
    "is-empty laid the placeholder out as the first inline box, ahead of the pill");
});

test("a line break serializes as one newline, and an empty box as nothing", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer([]);
  await page.keyboard.type("hello");
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  assert.equal(await value(), "hello\n", "Blink makes a block; its filler <br> is not a second line");
  await page.keyboard.type("there");
  assert.equal(await value(), "hello\nthere");
  await freshComposer([]);
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  await page.keyboard.press("Backspace");
  assert.equal(await value(), "", "a visually empty box used to serialize as a newline");
  assert.equal(await page.evaluate(() => document.getElementById("input").classList.contains("is-empty")),
    true, "so the placeholder stayed away and the draft guards called it non-empty");
});

test("every offset survives the round trip through both halves of the serializer", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  // walk() turns a DOM position into an offset; rangeAt() turns an offset back into a DOM
  // position. They are two statements of one rule, and nothing compared them -- walk() opened a
  // block's line only when the text did not already end in a newline, rangeAt() charged for every
  // block it passed while seen < target. Any shape where those disagree moves where a pill
  // splices, and insertComposerPill, unlike editComposer, has no verification and no fallback, so
  // the damage lands in the text that is actually sent. The property below holds for every shape
  // at once, including the mixed <br>-then-block one that keyboard tests cannot produce.
  const shapes = [
    "plain text",
    "a<br>b",
    "a<br><br>b",
    "a<br><br>",
    "a<br><br><br>",
    "a<br>",
    "intro<div><br></div><div>run  now</div>",
    "hello<div><br></div>",
    "<div><br></div>",
    "a<br><div>b</div>",
    "one<div>two</div><div>three</div>",
    'x<span data-pill="@f.ts" data-kind="file" contenteditable="false">f.ts</span>y',
    'lead<div><br></div><div><span data-pill="" data-kind="skill" contenteditable="false">fix</span> tail</div>',
  ];
  const bad = await page.evaluate((html) => {
    const host = document.getElementById("input");
    const failures = [];
    for (const shape of html) {
      host.innerHTML = shape;
      const text = host.value;
      // A pill is atomic: an offset strictly inside its wire text names no DOM position at all, so
      // the round trip is only expected to hold on either side of one.
      const interior = new Set();
      let at = 0;
      const scan = (node) => {
        if (node.nodeType === 3) { at += node.data.length; return; }
        if (node.nodeType !== 1) return;
        if (node.hasAttribute("data-pill")) {
          const len = node.dataset.pill.length;
          for (let k = 1; k < len; k++) interior.add(at + k);
          at += len; return;
        }
        if (node.tagName === "BR") { if (node !== node.parentNode.lastChild) at += 1; return; }
        if (node !== host && getComputedStyle(node).display !== "inline" && at) at += 1;
        [...node.childNodes].forEach(scan);
      };
      scan(host);
      for (let n = 0; n <= text.length; n++) {
        if (interior.has(n)) continue;
        host.setSelectionRange(n, n);
        const back = host.selectionStart;
        if (back !== n) failures.push({ shape, n, back, text });
      }
    }
    host.replaceChildren();
    return failures;
  }, shapes);
  assert.deepEqual(bad, [], "each of these is an offset the two halves place differently");
});

test("a draft survives the round trip through the writer as well as the reader", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  // walk() drops a <br> that is its parent's lastChild, because Chromium leaves one there as a
  // filler so the final line can hold a caret. That makes a SINGLE trailing <br> ambiguous by
  // construction, so the writer has to emit the pair Chromium emits. Writing one meant a draft
  // finished with Shift+Enter lost a newline on every save and restore, cumulatively across chat
  // switches, in silence.
  const bad = await page.evaluate(() => {
    const host = document.getElementById("input");
    const texts = ["", "a", "a\n", "a\n\n", "\n", "\n\n", "a\nb", "a\n\nb", "a\nb\n", "a \n"];
    const failures = [];
    for (const t of texts) { host.value = t; if (host.value !== t) failures.push([t, host.value]); }
    host.replaceChildren();
    return failures;
  });
  assert.deepEqual(bad, [],
    "setComposerValue(t) then composerText() must be t for every t, trailing newlines included");
});

test("clearing the box by hand does not leave its selections attached", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await freshComposer(["fixture"]);
  await page.keyboard.type("draft ");
  await pickSkill("fixture");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  assert.deepEqual(await pills(), []);
  // Read what the next message CARRIES, not the attachment row: without reconciliation nothing
  // re-renders the row after a native delete, so the row looks right while the selection is still
  // attached underneath.
  await page.keyboard.type("something else entirely");
  await page.keyboard.press("Enter");
  const last = await page.evaluate(() => (window.__posted || [])
    .filter((m) => m.type === "prompt").pop());
  assert.equal(last.text, "something else entirely");
  assert.deepEqual(last.skills || [], [],
    "the abandoned draft's skill used to ride along with the next, unrelated prompt");
});

test("a reconnect to the same chat does not flatten the pills being typed", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  // session_ready goes out on every webview repaint AND every backend handshake, both carrying the
  // CURRENT session id -- so a crashed backend coming back, or a dgc serve restart, used to run the
  // whole draft restore against the chat the user was already in. That rebuilds the composer from
  // serialized text, and a pill serializes to "", so pills vanished mid-sentence with no user
  // action and nothing on screen saying why.
  await freshComposer(["fixture"]);
  await page.keyboard.type("Review ");
  await pickSkill("fixture");
  await page.keyboard.type(" before merging");
  await page.evaluate(() => window.postMessage({ type: "session_ready", sessionId: "s1" }, "*"));
  await page.evaluate(() => window.postMessage({ type: "session_ready", sessionId: "s1" }, "*"));
  assert.deepEqual(await pills(), ["fixture"], "the pill is still where it was picked");
  assert.equal(await value(), "Review  before merging");
});

test("a rejected prompt comes back carrying its skills", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  // submit() used to hand pendingPrompts the live attachment objects. Restoring pushed them back
  // still flagged as pill-borne, with no pill standing for them, so reconcilePills withdrew every
  // one of them from the message being given back. jsdom took the fallback branch and cleared the
  // flag by accident, so the suite was green over a message that came back stripped.
  await freshComposer(["fixture"]);
  await page.keyboard.type("Review ");
  await pickSkill("fixture");
  await page.keyboard.press("Enter");
  const req = await page.evaluate(() => (window.__posted || [])
    .filter((m) => m.type === "prompt").pop().requestId);
  await page.evaluate((id) => window.postMessage({ type: "prompt_rejected", requestId: id }, "*"), req);
  await page.waitForFunction(() => document.getElementById("input").value === "Review");
  const chips = await page.evaluate(() => [...document.querySelectorAll("#attachments .chip")]
    .map((c) => c.textContent.replace("\u00d7", "").trim()));
  assert.deepEqual(chips, ["$fixture"], "the selection is visible again, and removable");
  await page.keyboard.press("Enter");
  const skills = await page.evaluate(() => (window.__posted || [])
    .filter((m) => m.type === "prompt").pop().skills);
  assert.deepEqual(skills, ["fixture"], "and the re-sent message still carries it");
});
