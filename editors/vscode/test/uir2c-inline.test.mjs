// 2d: inline touches in what you type and what you read (media/shared/inline.js), the same on Work, ChatDGC and a Pip's
// chat: a colour's swatch, keyboard shortcuts as keys, commits and issues as links, times in your time, and codes that
// copy on a click. In real Chromium on the real pages.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openPip, openWork } from "./support/uir2a-scene.mjs";
import * as chat from "./support/chat-scene.mjs";
import { INLINE_REPLY, INLINE_GIT, inlineRead, boxDecorations, inlineClick } from "./support/uir2c-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const ASK = "Use #ff0000 with Ctrl+K, not #123";
const AT = "2026-11-10T09:30:00Z";
/** Each surface with one message of yours and one reply. `reply`/`ask`: their words. */
const SURFACES = {
  Work: async (o) => { const x = await openWork(browser, { width: o.width, turns: 0 }); await x.turn(o.ask || ASK, o.reply || INLINE_REPLY); await x.page.waitForTimeout(200);
    return { ...x, close: () => x.page.close(), bubble: "#log .msg.user .bubble", reply: "#log .msg.dgc .text", box: "#input", value: () => x.page.evaluate(() => document.getElementById("input").value), copies: async () => (await x.posted("copy")).map((m) => m.text) }; },
  ChatDGC: async (o) => { const x = await chat.openChat(browser, { width: o.width });
    await x.send({ type: "opened", conversation: chat.conversation({ title: "The palette" }), earlier: 0, busy: false, messages: [{ id: chat.M(1), role: "user", text: o.ask || ASK, created_at: AT }, { id: chat.M(2), role: "assistant", text: o.reply || INLINE_REPLY, created_at: AT, finish: "stop", model: "qwen3.8:27b" }] });
    await x.send({ type: "models", ids: ["qwen3.8:27b"], current: "qwen3.8:27b" }); await x.page.waitForTimeout(250);
    return { ...x, close: () => x.page.close(), bubble: ".cd-bubble", reply: ".text.cd-body", box: "#cd-input", value: () => x.page.evaluate(() => document.getElementById("cd-input").value), copies: async () => (await x.posted("copy")).map((m) => m.text) }; },
  "a Pip's chat": async (o) => { const { ask, reply, pip, ...size } = o;                                         // (only the size goes to the scene: it has options of its own by these names)
    const x = await openPip(browser, { ...size, said: [{ role: "user", text: ask || ASK }, { role: "assistant", text: reply || INLINE_REPLY }], ...(pip || {}) });
    return { ...x, bubble: ".pip-message.user .bubble", reply: ".message-body", box: "#chatText", value: () => x.page.locator("#chatText").evaluate((n) => (typeof n.value === "string" ? n.value : n.innerText)),
      copies: () => x.page.evaluate(() => (window.__posted || []).filter((m) => m && m.type === "copy").map((m) => m.text)) }; },
};
const rgb = (r, g, b) => `rgb(${r}, ${g}, ${b})`;

for (const [name, open] of Object.entries(SURFACES)) for (const width of [300, 700]) {
  test(`${name}: a reply shows each colour's swatch, shortcuts as keys and a zoned time in your time; nothing for what only looks like one (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width });
    try {
      const got = await inlineRead(x.page, x.reply);
      assert.deepEqual(got.swatches.map((s) => s.code), ["#7c5cff", "#1f1f1f", "rgb(255, 120, 0)", "hsl(210 50% 40%)"], "a swatch after each colour, in plain words and in inline code; none in the fenced block, the issue, the URL or the longer word");
      assert.deepEqual(got.swatches.map((s) => s.ground).slice(0, 3), [rgb(124, 92, 255), rgb(31, 31, 31), rgb(255, 120, 0)], "each is that exact colour");
      for (const s of got.swatches) { assert.ok(s.w >= 8 && s.w <= 13 && s.w === s.h, `a small square (${s.w}x${s.h})`); assert.equal(s.inPre, false); assert.match(s.name, /colour/i, "it has a spoken name");
        assert.match(s.title, /#[0-9a-f]{6}.*rgb\(.*hsl\(/i, "pointed at, it says the colour in hex, rgb and hsl"); }
      assert.deepEqual(got.keys.map((k) => k.as), ["Ctrl+Shift+P", "⌘K", "F5", "Alt+Enter"], "the shortcuts are keys; 'Enter the value' is words");
      assert.deepEqual(got.keys[0].caps, ["Ctrl", "Shift", "P"]); assert.deepEqual(got.keys[2].caps, ["F5"]);
      assert.equal(got.keys[0].radius, "4px", "key caps wear the code chip's corner");
      assert.deepEqual(got.times.map((n) => n.text), ["09:00 UTC", "3pm PST"], "the times with a zone; 12:30 has none");
      for (const n of got.times) { assert.match(n.line, /underline/); assert.match(n.title, /your time/i); assert.match(n.title, /ago|in \d+|now|yesterday|tomorrow/); }
      assert.deepEqual(got.apis, ["GET /api/orders", "/v1/users/{id}"], "the API paths copy on a click; `npm test` is ordinary code");
      assert.deepEqual([got.commits.length, got.issues.length], [0, 0]);
      const sideways = await x.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(sideways <= 0, "nothing is pushed off the page");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const [name, open] of Object.entries(SURFACES)) {
  test(`${name}: your sent bubble shows the swatch and the keys, and never one for an issue number`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width: 440, reply: "Done." });
    try {
      const got = await inlineRead(x.page, x.bubble);
      assert.deepEqual(got.swatches.map((s) => [s.code, s.ground]), [["#ff0000", rgb(255, 0, 0)]]);
      assert.deepEqual(got.keys.map((k) => k.as), ["Ctrl+K"]);
      assert.deepEqual(got.times, [], "times are a reply's");
    } finally { await x.close(); }
  });

  test(`${name}: the box is never decorated: a colour, keys or an issue typed there stay plain words`, async (t) => {
    // His call (16 Nov): a square hanging under a code in the box read as a glitch. What is typed is shown as typed; the
    // touches are for what a chat shows.
    if (skipOrFail(t)) return;
    const x = await open({ width: 440, reply: "Done." });
    try {
      const p = x.page, box = p.locator(x.box);
      await box.click(); await p.keyboard.type("bg #00ff00 then rgb(0, 128, 255) with Ctrl+K and #123"); await p.waitForTimeout(400);
      assert.deepEqual(await boxDecorations(p, x.box), [], "nothing drawn in or over the box");
      assert.equal(await x.value(), "bg #00ff00 then rgb(0, 128, 255) with Ctrl+K and #123", "the box's words are exactly what was typed");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${name}: a swatch and an API path copy on a click with a Copied tick; selecting ordinary code copies nothing`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width: 440 });
    try {
      await inlineClick(x.page, `.dgc-il-sw[data-colour="#7c5cff"]`); await x.page.waitForTimeout(80);
      assert.deepEqual(await x.copies(), ["#7c5cff"], "the code as written");
      assert.equal((await inlineRead(x.page)).copied, 1, "it says Copied");
      await inlineClick(x.page, `.dgc-il-copy[data-copy="/v1/users/{id}"]`); await x.page.waitForTimeout(80);
      assert.deepEqual(await x.copies(), ["#7c5cff", "/v1/users/{id}"]);
      // Text selected inside a code that copies: the click that ends a selection is not a copy.
      const before = (await x.copies()).length;
      await x.page.evaluate(() => { const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll("*")) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };
        const pick = (text) => all(document, "code").find((c) => c.textContent === text);
        for (const text of ["GET /api/orders", "npm test"]) { const code = pick(text), root = code.getRootNode(), sel = (root.getSelection ? root.getSelection() : null) || document.getSelection(), r = document.createRange();
          r.selectNodeContents(code); sel.removeAllRanges(); sel.addRange(r); code.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); sel.removeAllRanges(); }
        pick("npm test").dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); });
      await x.page.waitForTimeout(80);
      assert.equal((await x.copies()).length, before, "nothing more was copied");
      await x.page.waitForTimeout(1900);
      assert.equal((await inlineRead(x.page)).copied, 0, "the tick goes");
    } finally { await x.close(); }
  });
}

test("Work: a reply that grows is decorated once at every step, and Copy copies the reply's own words", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWork(browser, { width: 440, turns: 0 });
  try {
    const id = await x.say("Which colours?");
    await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "t1", prompt: "" });
    const text = "Accent #7c5cff, press Ctrl+Shift+P. Warn rgb(255, 120, 0) at 09:00 UTC.";
    const counts = [];
    for (let i = 0; i < text.length; i += 9) { await x.event({ type: "text_delta", text: text.slice(i, i + 9) }); const got = await inlineRead(x.page, "#log .msg.dgc .text"); counts.push(got.swatches.length);
      assert.ok(got.swatches.every((s, k, all) => all.findIndex((o) => o.code === s.code) === k), "never two swatches for one colour"); }
    await x.event({ type: "stream_end", message_id: "t1:1", phase: "final" }); await x.event({ type: "turn_end", turn_id: "t1", status: "completed", usage: {} }); await x.page.waitForTimeout(200);
    const got = await inlineRead(x.page, "#log .msg.dgc .text");
    assert.deepEqual([got.swatches.map((s) => s.code), got.keys.map((k) => k.as), got.times.map((n) => n.text)], [["#7c5cff", "rgb(255, 120, 0)"], ["Ctrl+Shift+P"], ["09:00 UTC"]]);
    assert.ok(counts.includes(1) && counts.at(-1) === 2 && counts.every((c, i) => i === 0 || c >= counts[i - 1]), `the swatches arrive with their codes and stay (${counts.join(",")})`);
    assert.equal(await x.page.evaluate(() => document.querySelector("#log .msg.dgc .text").innerText.replace(/\s+/g, " ").trim()), text, "the words read as they were written");
    await x.page.evaluate(() => [...document.querySelectorAll('#log .msg.dgc button')].find((b) => /^copy/i.test(b.getAttribute("aria-label") || b.title || ""))?.click());
    await x.page.waitForTimeout(80);
    assert.equal((await x.posted("copy")).at(-1)?.text.trim(), text, "Copy copies the original words");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("Work: a commit is a link once the host says it exists, and opens through the host; issues link to the project's GitHub", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWork(browser, { width: 440, turns: 0 });
  try {
    await x.turn("What changed?", INLINE_GIT); await x.page.waitForTimeout(200);
    let got = await inlineRead(x.page, "#log .msg.dgc .text");
    assert.deepEqual([got.commits, got.issues], [[], []], "nothing is a link until the host has answered");
    const asked = await x.posted("gitRefs");
    assert.ok(asked.length >= 1, "the page asks the host");
    assert.deepEqual([...new Set(asked.flatMap((m) => m.hashes))].sort(), ["9f8e7d6c", "a1b2c3d"], "about the two that look like commits (never the colour)");
    assert.ok(asked.every((m) => Object.keys(m).sort().join() === "hashes,type"), "and names no path and no command");
    await x.send({ type: "gitRefs", remote: true, github: "acme/shop", known: { a1b2c3d: true, "9f8e7d6c": false } }); await x.page.waitForTimeout(150);
    got = await inlineRead(x.page, "#log .msg.dgc .text");
    assert.deepEqual(got.commits.map((c) => c.hash), ["a1b2c3d"], "the real commit is a link; the hash that is not a commit stays words");
    assert.deepEqual(got.issues.map((i) => [i.text, i.href]), [["#123", "https://github.com/acme/shop/issues/123"], ["acme/shop#45", "https://github.com/acme/shop/issues/45"]]);
    assert.deepEqual(got.swatches.map((s) => s.code), ["#0a0b0c"]);
    await inlineClick(x.page, ".dgc-il-commit"); await x.page.waitForTimeout(80);
    assert.deepEqual((await x.posted("gitCommitOpen")).map((m) => m.hash), ["a1b2c3d"]);
    // Alt+click copies the hash.
    await inlineClick(x.page, ".dgc-il-commit", 0, { altKey: true }); await x.page.waitForTimeout(80);
    assert.equal((await x.posted("copy")).at(-1)?.text, "a1b2c3d"); assert.equal((await x.posted("gitCommitOpen")).length, 1);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
  const plain = await openWork(browser, { width: 440, turns: 0 });
  try {
    await plain.turn("What changed?", INLINE_GIT); await plain.page.waitForTimeout(150);
    await plain.send({ type: "gitRefs", remote: false, github: "", known: {} }); await plain.page.waitForTimeout(150);
    const got = await inlineRead(plain.page, "#log .msg.dgc .text");
    assert.deepEqual([got.commits, got.issues], [[], []], "a project with no remote: plain words");
  } finally { await plain.page.close(); }
});

test("a Pip with a folder asks its host about commits; a Personal Pip and ChatDGC ask nothing and show plain words", async (t) => {
  if (skipOrFail(t)) return;
  const refs = (page) => page.evaluate(() => (window.__posted || []).filter((m) => m && /gitrefs/i.test(m.type || "")));
  const pip = await SURFACES["a Pip's chat"]({ width: 700, reply: INLINE_GIT, pip: { project: true } });
  try {
    const asked = await refs(pip.page);
    assert.ok(asked.length >= 1 && asked.every((m) => m.type === "pipsGitRefs" && /^pip_/.test(m.pip_id)), "it asks, naming the Pip and never a folder");
    assert.deepEqual([...new Set(asked.flatMap((m) => m.hashes))].sort(), ["9f8e7d6c", "a1b2c3d"]);
    await pip.page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), { type: "pipsGitRefs", pip_id: asked[0].pip_id, remote: true, github: "acme/shop", known: { a1b2c3d: true, "9f8e7d6c": false } });
    await pip.page.waitForTimeout(200);
    const got = await inlineRead(pip.page, pip.reply);
    assert.deepEqual([got.commits.map((c) => c.hash), got.issues.map((i) => i.text)], [["a1b2c3d"], ["#123", "acme/shop#45"]]);
    await inlineClick(pip.page, ".dgc-il-commit"); await pip.page.waitForTimeout(80);
    assert.deepEqual(await pip.page.evaluate(() => window.__posted.filter((m) => m && m.type === "pipsGitCommitOpen").map((m) => [m.hash, /^pip_/.test(m.pip_id)])), [["a1b2c3d", true]]);
  } finally { await pip.close(); }
  for (const name of ["a Pip's chat", "ChatDGC"]) {
    const x = await SURFACES[name]({ width: 700, reply: INLINE_GIT });
    try { const got = await inlineRead(x.page, x.reply); assert.deepEqual([got.commits, got.issues, (await refs(x.page)).length], [[], [], 0], name); assert.deepEqual(got.swatches.map((s) => s.code), ["#0a0b0c"]); }
    finally { await x.close(); }
  }
});
