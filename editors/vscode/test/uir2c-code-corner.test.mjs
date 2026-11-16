// Inline code's corner (his call, 16 Nov: 4 px): one token, --r-code, on every inline code chip on every surface. A
// fenced block keeps its own corner. In real Chromium on Work, ChatDGC and a Pip's chat, and over every stylesheet.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openChatDgc, openPip, openWork } from "./support/uir2a-scene.mjs";
import * as chat from "./support/chat-scene.mjs";

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

export const REPLY = "The limit is read in `src/upload.py` and again in `billing/plans/limits.py`; run `npm test` after.\n\n```python\nLIMIT = 20\n```\n\nSee [`docs/limits.md`](docs/limits.md) too.";
const DEEP = "const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll('*')) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };";
const read = (page) => page.evaluate((deep) => { const all = new Function(`${deep} return all;`)();
  const r = (n) => { const s = getComputedStyle(n); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].join(" "); };
  const codes = all(document, "code").filter((n) => n.getClientRects().length);
  // The chip's ground over everything behind it, against that ground alone, composited on a 1-pixel canvas.
  const chain = (n) => { const out = []; for (let e = n; e; e = e.parentElement || e.getRootNode().host) out.unshift(getComputedStyle(e).backgroundColor); return out; };
  const paint = (colours) => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 1, 1);
    for (const col of colours) { g.fillStyle = col; g.fillRect(0, 0, 1, 1); } return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const apart = (n) => { const all = chain(n), chip = paint(all), under = paint(all.slice(0, -1)); return Math.max(...chip.map((v, i) => Math.abs(v - under[i]))); };
  return { inline: codes.filter((n) => !n.closest("pre")).map((n) => ({ text: n.textContent, r: r(n), h: Math.round(n.getBoundingClientRect().height), apart: apart(n) })), blocks: all(document, "pre").filter((n) => n.getClientRects().length).map(r) }; }, DEEP);
const FOUR = "4px 4px 4px 4px";
const check = (got, where) => {
  assert.ok(got.inline.length >= 3, `${where}: the paths and the command are drawn as code (${got.inline.length})`);
  for (const c of got.inline) assert.equal(c.r, FOUR, `${where}: ${c.text}`);
  // A chip you can see in every theme (seen 16 Nov: on ChatDGC's light page the input background was the page's white).
  for (const c of got.inline) assert.ok(c.apart >= 10, `${where}: ${c.text}'s ground shows (${c.apart} levels from the page)`);
  assert.ok(got.blocks.length >= 1, `${where}: the fenced block is drawn`);
  for (const b of got.blocks) assert.notEqual(b, FOUR, `${where}: a fenced block keeps its own corner`);
};

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`inline code has 4 px corners in a reply on Work, ChatDGC and a Pip's chat (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const work = await openWork(browser, { theme, width, turns: 0 });
    try { await work.turn("Where is the upload limit read?", REPLY); await work.page.waitForTimeout(150); check(await read(work.page), "Work"); assert.deepEqual(work.errors, []); } finally { await work.page.close(); }
    const c = await chat.openChat(browser, { theme, width });
    try {
      await c.send({ type: "opened", conversation: chat.conversation({ title: "The upload limit" }), earlier: 0, busy: false, messages: [{ id: chat.M(1), role: "user", text: "Where is the upload limit read?", created_at: "2026-11-10T09:30:00Z" },
        { id: chat.M(2), role: "assistant", text: REPLY, created_at: "2026-11-10T09:30:00Z", finish: "stop", model: "qwen3.8:27b" }] });
      await c.page.waitForTimeout(250); check(await read(c.page), "ChatDGC"); assert.deepEqual(c.errors, []);
    } finally { await c.page.close(); }
    const pip = await openPip(browser, { theme, width, said: [{ role: "user", text: "Where is the upload limit read?" }, { role: "assistant", text: REPLY }] });
    try { check(await read(pip.page), "a Pip's chat"); assert.deepEqual(pip.errors, []); } finally { await pip.close(); }
  });
}

test("every stylesheet's inline code chip takes its corner from --r-code, and the token is 4px", () => {
  const root = new URL("..", import.meta.url), files = [...["media", "media/shared", "src"].flatMap((d) => readdirSync(new URL(d + "/", root)).filter((f) => f.endsWith(".css")).map((f) => `${d}/${f}`))];
  assert.match(readFileSync(new URL("media/shared/tokens.css", root), "utf8"), /--r-code:\s*4px/);
  const off = [];
  for (const f of files) { const css = readFileSync(new URL(f, root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) { const sels = m[1].split(",").map((s) => s.trim()).filter((s) => /(^|[\s>])code$/.test(s) && !/\bpre\b/.test(s));
      if (!sels.length) continue; const r = /border-radius:\s*([^;]+)/.exec(m[2]);
      if (r && !/^var\(--r-code/.test(r[1].trim()) && !/^0|inherit/.test(r[1].trim())) off.push(`${f}: ${sels.join(", ")} { border-radius: ${r[1].trim()} }`); } }
  assert.deepEqual(off, []);
});
