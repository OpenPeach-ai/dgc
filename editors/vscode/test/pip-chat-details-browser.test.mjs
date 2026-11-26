// Chat details and attachments in a Pip's chat (pips-08; Pips API 84), in real Chromium with the real client and its
// CSS (test/support/pip-chat-scene.mjs, opts.details):
// - a thumbs-up on the Pip's latest reply answers its open yes-or-no question with its yes choice, and only then;
// - a picture you sent stands above your bubble, at the bubble's right edge, and a click opens the original;
// - a file DGC made in a reply (a picture) comes back as a row: the sheet of its kind, its name, "PNG · 1.2 MB" and
//   Download, which asks the host to save the original;
// - pictures and files go with a message sent while the Pip works, and to a Project Pip, from API 84 (before it the
//   first is refused in words and a Project Pip has no "+").
// DGC_CHATDETAILS_PICTURES=<folder> also writes the pictures (dark and light, 700 and 300 px).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { openChat } from "./support/pip-chat-scene.mjs";
import { madeFilesMarkup, messageMarkup, yesChoice } from "../src/pipsTranscript.js";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
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

const open = (opts = {}) => openChat(browser, { width: 700, height: 820, api: 84, convs: !opts.project, details: true, ...opts });
const inPage = (p, fn, arg) => p.evaluate(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);
const message = (id) => `.pip-message[data-message="${id}"]`;
const sends = (p) => p.evaluate(() => window.__sent.filter((r) => r.type === "send_pip_message").map((r) => ({ text: r.text, images: (r.images || []).length, files: (r.files || []).length })));
const posted = (p, type) => p.evaluate((t) => (window.__posted || []).filter((m) => m.type === t), type);
// An element's box, its painted ink over its painted ground (contrast, and how far the ink is from grey), and whether it is in sight.
const look = (p, selector) => inPage(p, (root, s) => {
  const node = root.querySelector(s); if (!node) return null;
  const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d", { willReadFrequently: true });
  const chain = []; for (let n = node; n; n = n.parentElement || n.getRootNode()?.host) chain.unshift(n);
  g.fillStyle = "#fff"; g.fillRect(0, 0, 1, 1); for (const n of chain) { g.fillStyle = getComputedStyle(n).backgroundColor; g.fillRect(0, 0, 1, 1); }
  const under = [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  g.fillStyle = getComputedStyle(node).color; g.fillRect(0, 0, 1, 1); const over = [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  const lum = (v) => { const [r, gg, b] = v.map((x) => x / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * gg + 0.0722 * b; };
  const [hi, lo] = [lum(over), lum(under)].sort((a, b) => b - a), r = node.getBoundingClientRect();
  let opacity = 1; for (const n of chain) opacity *= Number(getComputedStyle(n).opacity);
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, opacity, ratio: (hi + 0.05) / (lo + 0.05), chroma: Math.max(...over) - Math.min(...over) };
}, selector);
const column = (p) => inPage(p, (root) => { const log = root.querySelector(".conversation-log"), r = log.getBoundingClientRect(), s = getComputedStyle(log);
  return { left: r.left + parseFloat(s.paddingLeft), right: r.left + log.clientLeft + log.clientWidth - parseFloat(s.paddingRight), sideways: log.scrollWidth - log.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
const attach = async (p, files) => { await p.setInputFiles("#chat-attach-input", files); await p.waitForFunction((n) => (window.__pipsRoot || document).querySelectorAll(".chat-images .dgc-att").length === n, files.length); };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const logo = { name: "logo.png", mimeType: "image/png", buffer: PNG }, notes = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Launch is on the 14th.\n") };

const base = { id: "m1", pip_id: "p", workspace_id: "w", run_id: "r", model: "", created_at: "2026-11-10T08:00:00Z", status: "succeeded" };
const draw = (m, more = {}) => messageMarkup({ ...base, ...m }, { name: "Mornings", formatDate: String, renderMarkdown: (t) => t, canSend: true, ...more });

test("the rule: a thumbs-up answers only yes-or-no choices, with the first yes choice in the Pip's own words", () => {
  assert.equal(yesChoice(["Yes, send it", "Not yet"]), "Yes, send it");
  assert.equal(yesChoice(["No", "Yes"]), "Yes");
  assert.equal(yesChoice(["Wait", "Go ahead", "Yes, and copy me"]), "Go ahead", "the first of them");
  assert.equal(yesChoice(["OK", "Cancel"]), "OK");
  for (const none of [["Tea", "Coffee"], ["Email it", "Share a link"], ["Yes", "Yes, and copy me"], ["Yesterday's draft", "No"], ["Okra", "Nothing"], ["No", "Not now"], [], null, ["Yes"], [1, "No"]])
    assert.equal(yesChoice(none), "", JSON.stringify(none));
});

test("the markup: the thumb is on a reply with open yes-or-no choices only, sends that choice, and is off when nothing can be sent", () => {
  const asked = draw({ role: "assistant", text: "Shall I send it?" }, { choices: ["Yes, send it", "Not yet"] });
  assert.match(asked, /<button type="button" class="ract ract-yes" data-pip-choice="Yes, send it" data-pip-yes aria-label="Answer “Yes, send it”" title="Answer “Yes, send it”">/);
  assert.doesNotMatch(draw({ role: "assistant", text: "Shall I send it?" }), /ract-yes/, "no open choices: no thumb");
  assert.doesNotMatch(draw({ role: "assistant", text: "Which?" }, { choices: ["Tea", "Coffee"] }), /ract-yes/, "not a yes-or-no question");
  assert.doesNotMatch(draw({ role: "user", text: "Yes" }, { choices: ["Yes", "No"] }), /ract-yes/, "never on your own message");
  assert.match(draw({ role: "assistant", text: "Shall I?" }, { choices: ["Yes", "No"], canSend: false }), /class="ract ract-yes"[^>]* disabled>/);
  assert.match(draw({ role: "assistant", text: "Shall I?" }, { choices: ['Yes <b>"now"</b>', "No"] }), /data-pip-choice="Yes &lt;b&gt;&quot;now&quot;&lt;\/b&gt;"/, "the Pip's words are text");
});

test("the markup: a file DGC made is a row with its kind, its size and Download; your picture comes before your bubble", () => {
  const made = { ...base, id: "a1", role: "assistant", text: "Done.", images: [{ index: 0, mime: "image/png", bytes: 1258291 }, { index: 1, mime: "image/jpeg", bytes: 900 }, { index: 2, mime: "text/html", bytes: 5 }] };
  const rows = madeFilesMarkup(made);
  assert.equal(rows.match(/class="dgc-doc-card msg-made-file"/g).length, 2, "a kind DGC doesn't keep as a picture gets no row");
  assert.match(rows, /<span class="dgc-doc-name">Picture 1\.png<\/span><span class="dgc-doc-meta">PNG · 1\.2 MB<\/span>/);
  assert.match(rows, /<span class="dgc-doc-name">Picture 2\.jpg<\/span><span class="dgc-doc-meta">JPG · 900 B<\/span>/);
  assert.match(rows, /<button type="button" class="dgc-doc-dl" data-message-download="a1:0" aria-label="Download Picture 1\.png" title="Download">/);
  assert.match(rows, /class="dgc-sheet" data-kind="img"/, "the sheet of its kind");
  assert.match(draw(made, { canDownload: true }), /msg-made-files/);
  assert.doesNotMatch(draw(made), /msg-made-files/, "where nothing can be downloaded there is no row");
  assert.doesNotMatch(draw({ ...made, role: "user" }, { canDownload: true }), /msg-made-files/, "a picture you sent is not a file DGC made");
  const mine = draw({ role: "user", text: "Use this", images: [{ index: 0, mime: "image/png", bytes: 9 }], files: [{ index: 0, name: "a<b>.txt", bytes: 2048 }] });
  assert.ok(mine.indexOf('class="msg-images"') < mine.indexOf('class="bubble"') && mine.indexOf('class="msg-images"') > 0, "above the bubble");
  assert.match(mine, /<span class="chat-file-name">a&lt;b&gt;\.txt<\/span><span class="chat-file-size">2 KB<\/span>/);
});

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`${theme}, ${width} px: the thumb is in sight on the open question, your picture is above your bubble, and a made file is a row that fits`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await open({ theme, width, where: width === 300 ? "side" : "tab" });
    try {
      // The pointer rests where the scene last clicked (the Pip's row in the list). With the prompt box one line high
      // (14 Nov) the made-file row sits 30px lower at 300px, right under it, and would be measured in its hover wash.
      // This test reads the page at rest. (In its hover wash, on light, the row's quiet line is 4.4:1: reported.)
      await s.p.mouse.move(1, 1);
      const col = await column(s.p);
      assert.ok(col.sideways <= 0 && col.page <= 0, "nothing scrolls sideways");
      // The thumb: only on the reply whose question is open, in sight without pointing at it, grey, a real target.
      assert.equal(await inPage(s.p, (root) => root.querySelectorAll(".ract-yes").length), 1);
      const thumb = await look(s.p, `${message("a2")} .ract-yes`);
      assert.ok(thumb.opacity >= 0.99, "in sight without pointing at the message");
      assert.ok(thumb.width >= 20 && thumb.height >= 20, `a target of ${thumb.width}×${thumb.height}`);
      assert.ok(thumb.ratio >= 4.5 && thumb.chroma <= 24, `its ink reads and is grey (${thumb.ratio.toFixed(1)}, ${thumb.chroma})`);
      assert.ok(thumb.left >= col.left - 1 && thumb.right <= col.right + 1);
      // Your picture: above the bubble, the files between, all at the bubble's right edge, inside the column.
      const picture = await look(s.p, `${message("u1")} .msg-image`), file = await look(s.p, `${message("u1")} .msg-file`), bubble = await look(s.p, `${message("u1")} .bubble`);
      assert.ok(picture.bottom <= file.top && file.bottom <= bubble.top, "picture, then file, then your words");
      assert.ok(Math.abs(picture.right - bubble.right) <= 1 && Math.abs(file.right - bubble.right) <= 1, `at the bubble's right edge (${picture.right}, ${file.right}, ${bubble.right})`);
      assert.ok(picture.left >= col.left - 1 && bubble.right <= col.right + 1);
      await s.p.waitForFunction((sel) => !!(window.__pipsRoot || document).querySelector(sel)?.getAttribute("src"), `${message("u1")} .msg-image`);
      // The file the Pip made: one row under its reply, at the reply's left edge, with everything inside it.
      const row = await look(s.p, `${message("a1")} .msg-made-file`), reply = await look(s.p, `${message("a1")} .answer`);
      assert.ok(row.left >= col.left - 1 && row.right <= col.right + 1, `inside the column (${row.left}–${row.right} of ${col.left}–${col.right})`);
      assert.ok(Math.abs(row.left - reply.left) <= 1, "in the reply's column");
      for (const part of [".dgc-sheet", ".dgc-doc-name", ".dgc-doc-meta", ".dgc-doc-dl"]) {
        const box = await look(s.p, `${message("a1")} .msg-made-file ${part}`);
        assert.ok(box.width > 0 && box.left >= row.left - 1 && box.right <= row.right + 8 && box.top >= row.top - 1 && box.bottom <= row.bottom + 1, `${part} sits in the row`);
      }
      assert.equal(await inPage(s.p, (root) => root.querySelector(".msg-made-file .dgc-doc-name").textContent + " | " + root.querySelector(".msg-made-file .dgc-doc-meta").textContent), "Picture 1.png | PNG · 1.2 MB");
      const name = await look(s.p, ".msg-made-file .dgc-doc-name"), meta = await look(s.p, ".msg-made-file .dgc-doc-meta"), dl = await look(s.p, ".msg-made-file .dgc-doc-dl");
      assert.ok(name.ratio >= 4.5 && meta.ratio >= 4.5 && dl.ratio >= 4.5, `the row reads (${name.ratio.toFixed(1)}, ${meta.ratio.toFixed(1)}, ${dl.ratio.toFixed(1)})`);
      assert.ok(name.chroma <= 24 && meta.chroma <= 24 && dl.chroma <= 24, "in the editor's greys");
      assert.ok(dl.width >= 24 && dl.height >= 24);
      assert.deepEqual(s.errors, []);
      if (process.env.DGC_CHATDETAILS_PICTURES) {
        mkdirSync(process.env.DGC_CHATDETAILS_PICTURES, { recursive: true });
        await s.p.evaluate(() => { const log = (window.__pipsRoot || document).querySelector(".conversation-log"); log.scrollTop = 0; });
        await s.p.screenshot({ path: `${process.env.DGC_CHATDETAILS_PICTURES}/chat-details-${theme}-${width}-top.png` });
        await s.p.evaluate(() => { const log = (window.__pipsRoot || document).querySelector(".conversation-log"); log.scrollTop = log.scrollHeight; });
        await s.p.screenshot({ path: `${process.env.DGC_CHATDETAILS_PICTURES}/chat-details-${theme}-${width}.png` });
      }
    } finally { await s.close(); }
  });
}

test("a thumbs-up answers the open question with its yes choice, once; choices that aren't yes or no have no thumb", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.p.click(`${message("a2")} .ract-yes`);
    await s.p.waitForFunction(() => window.__sent.some((r) => r.type === "send_pip_message"));
    assert.deepEqual(await sends(s.p), [{ text: "Yes, send it", images: 0, files: 0 }]);
    await s.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector(".ract-yes"));
    assert.equal(await inPage(s.p, (root) => root.querySelectorAll(".msg-choices").length), 0, "answered: the card and its thumb are gone");
    assert.equal((await sends(s.p)).length, 1);
  } finally { await s.close(); }
  const other = await open({ details: "ab" });
  try {
    assert.equal(await inPage(other.p, (root) => root.querySelectorAll(".msg-choice").length), 2);
    assert.equal(await inPage(other.p, (root) => root.querySelectorAll(".ract-yes").length), 0);
  } finally { await other.close(); }
});

test("with words already in the box the thumb adds its answer to them, as a tap on the choice does", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.p.click("#chatText"); await s.p.keyboard.type("And copy me");
    await s.p.click(`${message("a2")} .ract-yes`);
    await s.p.waitForFunction(() => /Yes, send it/.test((window.__pipsRoot || document).querySelector("#chatText").value ?? (window.__pipsRoot || document).querySelector("#chatText").textContent));
    assert.deepEqual(await sends(s.p), [], "nothing was sent for you");
  } finally { await s.close(); }
});

test("a click on your picture opens the original in the chat's pop-up, and Download on a made file asks the host for it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.p.evaluate(() => { (window.__pipsRoot || document).querySelector(".conversation-log").scrollTop = 0; });
    await s.p.click(`${message("u1")} .msg-image`);
    // (18 Nov: large in a pop-up inside the chat, its original asked of the host to show; Open in editor is in the pop-up.)
    assert.equal(await s.p.locator(".dgc-picpop").count(), 1);
    assert.deepEqual((await posted(s.p, "pipsOpenPhoto")).map(({ message_id, index, save, view }) => ({ message_id, index, save, view })), [{ message_id: "u1", index: 0, save: undefined, view: true }]);
    await s.p.keyboard.press("Escape");
    await s.p.click(`${message("a1")} .msg-made-file .dgc-doc-dl`);
    assert.deepEqual((await posted(s.p, "pipsOpenPhoto")).slice(1).map(({ message_id, index, save }) => ({ message_id, index, save })), [{ message_id: "a1", index: 0, save: true }]);
    await s.p.keyboard.press("Shift");   // the keyboard is in use: focus shows
    await s.p.focus(`${message("a1")} .msg-made-file .dgc-doc-dl`);
    assert.match(await inPage(s.p, (root) => getComputedStyle(root.querySelector(".msg-made-file .dgc-doc-dl")).outlineStyle), /solid|auto/, "the keyboard sees where it is");
  } finally { await s.close(); }
});

test("while the Pip works a message takes a picture and a file with it (API 84); before 84 it says to send them after", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open({ details: "working" });
  try {
    const waits = await look(s.p, `${message("m3")} .msg-image`), words = await look(s.p, `${message("m3")} .bubble`);
    assert.ok(waits.bottom <= words.top && Math.abs(waits.right - words.right) <= 1, "one sent meanwhile shows its picture above its words too");
    await attach(s.p, [logo, notes]);
    await s.p.click("#chatText"); await s.p.keyboard.type("Use these"); await s.p.keyboard.press("Enter");
    await s.p.waitForFunction(() => window.__sent.some((r) => r.type === "send_pip_message"));
    assert.deepEqual(await sends(s.p), [{ text: "Use these", images: 1, files: 1 }]);
    await s.p.waitForFunction(() => (window.__pipsRoot || document).querySelectorAll(".chat-images .dgc-att").length === 0);
    assert.equal(await inPage(s.p, (root) => root.querySelector(".notice.error, .error")?.textContent || ""), "");
    const mine = await s.p.evaluate(() => window.__brought);
    assert.deepEqual(mine.map(({ images, files }) => [images, files]), [[1, 1]]);
  } finally { await s.close(); }
  const old = await open({ details: "working", api: 83 });
  try {
    await attach(old.p, [logo]);
    await old.p.click("#chatText"); await old.p.keyboard.type("Use this"); await old.p.keyboard.press("Enter");
    await old.p.waitForFunction(() => /after this reply/.test((window.__pipsRoot || document).querySelector("[role=alert], .error")?.textContent || ""));
    assert.deepEqual(await sends(old.p), [], "an older DGC is never sent what it refuses");
  } finally { await old.close(); }
});

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`${theme}, ${width} px: a Project Pip shows the picture and the file you sent as reference, and takes more`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await open({ project: true, theme, width, where: width === 300 ? "side" : "tab" });
    try {
      const col = await column(s.p);
      assert.ok(col.sideways <= 0 && col.page <= 0);
      const picture = await look(s.p, `${message("u1")} .msg-image`), file = await look(s.p, `${message("u1")} .msg-file`), bubble = await look(s.p, `${message("u1")} .bubble`);
      assert.ok(picture.bottom <= file.top && file.bottom <= bubble.top && Math.abs(picture.right - bubble.right) <= 1);
      assert.ok(picture.left >= col.left - 1 && file.left >= col.left - 1);
      assert.equal(await inPage(s.p, (root) => !!root.querySelector("#chat-attach")), true, "its box has the + for pictures and files");
      if (process.env.DGC_CHATDETAILS_PICTURES) await s.p.screenshot({ path: `${process.env.DGC_CHATDETAILS_PICTURES}/project-pip-${theme}-${width}.png` });
      if (theme === "dark" && width === 700) {
        await s.p.click("#chat-attach");
        assert.deepEqual(await inPage(s.p, (root) => [...root.querySelectorAll(".composer-add-menu .dgc-menu-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim())), ["Pictures and filesFrom this computer", "A file in this project@"], "plain words for what a Project Pip can be given");
        await s.p.keyboard.press("Escape");
        await attach(s.p, [logo, notes]);
        await s.p.click("#chatText"); await s.p.keyboard.type("Compare these"); await s.p.keyboard.press("Enter");
        await s.p.waitForFunction(() => window.__sent.some((r) => r.type === "send_pip_message"));
        assert.deepEqual(await sends(s.p), [{ text: "Compare these", images: 1, files: 1 }]);
      }
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });
}

test("a Project Pip on a DGC before API 84 has no + for pictures and files", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open({ project: true, api: 83 });
  try { assert.equal(await inPage(s.p, (root) => !!root.querySelector("#chat-attach")), false); } finally { await s.close(); }
});

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`${theme}, ${width} px: a message sent while the Pip works keeps its picture above its words`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await open({ details: "working", theme, width, where: width === 300 ? "side" : "tab" });
    try {
      const col = await column(s.p);
      assert.ok(col.sideways <= 0 && col.page <= 0);
      const picture = await look(s.p, `${message("m3")} .msg-image`), bubble = await look(s.p, `${message("m3")} .bubble`);
      assert.ok(picture.bottom <= bubble.top && Math.abs(picture.right - bubble.right) <= 1 && picture.left >= col.left - 1);
      assert.equal(await inPage(s.p, (root) => root.querySelectorAll(".ract-yes").length), 0, "the question is no longer the latest: no thumb");
      if (process.env.DGC_CHATDETAILS_PICTURES) await s.p.screenshot({ path: `${process.env.DGC_CHATDETAILS_PICTURES}/while-it-works-${theme}-${width}.png` });
    } finally { await s.close(); }
  });
}

// A screenshot from a test machine (25 Nov): the icons under a reply didn't line up. Read aloud's speaker sat 1.5 px off Copy and Trace
// (its Play / Stop wrapper set it on a text baseline), and, measured live after, the closed ⓘ (Response details) 1 px
// above them (its details box took a text line). Every part of a reply's row on one centre line; one of Play / Stop.
for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`${theme}, ${width} px: a reply's row, Copy to Trace with its ⓘ, sits on one centre line`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await open({ theme, width, where: width === 300 ? "side" : "tab" });
    try {
      await s.p.waitForFunction(() => !!(window.__pipsRoot || document).querySelector(".pip-message .response-actions .ract-trace"));
      const rows = await inPage(s.p, (root) => [...root.querySelectorAll(".pip-message .response-actions")].filter((row) => row.querySelector(".ract-trace") && row.querySelector(".message-details:not([open])")).map((row) =>
        [...row.children].filter((c) => c.getBoundingClientRect().height > 2 && !c.classList.contains("reply-stats")).map((c) => {
          const shown = [...c.querySelectorAll("svg")].filter((v) => v.getBoundingClientRect().height > 0);
          let r; if (shown[0]) r = shown[0].getBoundingClientRect(); else { const range = document.createRange(); range.selectNodeContents(c); r = range.getBoundingClientRect(); }
          return { what: c.dataset.chatAction || c.className.toString().split(" ")[0], icons: shown.length, mid: (r.top + r.bottom) / 2 };
        })));
      assert.ok(rows.length >= 1, "a reply with Trace and its ⓘ");
      for (const row of rows) {
        assert.ok(["copy", "read", "trace", "message-details"].every((w) => row.some((b) => b.what === w)), `Copy, Read aloud, ⓘ and Trace (${JSON.stringify(row)})`);
        assert.equal(row.find((b) => b.what === "read").icons, 1, "Read aloud shows one of Play / Stop");
        // (A narrow row wraps, by design: what shares a line shares its centre.)
        const lines = [];
        for (const b of [...row].sort((a, z) => a.mid - z.mid)) { const line = lines.at(-1); if (line && b.mid - line[0].mid <= 6) line.push(b); else lines.push([b]); }
        for (const line of lines) { const mids = line.map((b) => b.mid); assert.ok(Math.max(...mids) - Math.min(...mids) <= 1, `one centre line (${JSON.stringify(row)})`); }
      }
    } finally { await s.close(); }
  });
}
