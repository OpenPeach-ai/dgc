// The Pip chat design pass (0.52, asked 5 Nov): a Personal and a Project Pip's chat, calm, clear and physical. One
// reading column; bubbles, rows, cards and the box on the shared corners (6 / 8 / 12 / 16) and the 4 px unit; no drop
// shadow on anything that sits in the chat; one purple, for the sent bubble, the one main button and marks; every word
// at 4.5:1 and every control at 3:1 on the editor's own dark and light grounds; motion that answers the press at once
// (120 to 180 ms on the shared curve) and is off under reduced motion; the faces left exactly as they were.
// The real client and its CSS in real Chromium, in the side bar (a shadow root in Work's page) at 300 and 700 px and as
// an editor tab, measured.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { client, facts, openChat } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
await client();   // built before the first test is registered (a pending top-level await would end the file early)

const near = (a, b, slack = 1) => Math.abs(a - b) <= slack;
const PLACES = [["side", 300], ["side", 700], ["tab", 1100]];

for (const theme of ["dark", "light"]) for (const [where, width] of PLACES) {
  test(`a Personal Pip's chat reads as one calm column (${where}, ${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, errors, close } = await openChat(browser, { theme, where, width });
    try {
      await p.waitForSelector(".msg-choices");
      const f = await p.evaluate(facts), say = JSON.stringify;
      assert.deepEqual(errors, []);
      // Nothing is cut or pushed sideways, at any width.
      assert.ok(f.sideways <= 0 && f.pageSideways <= 0, `no sideways scroll: ${f.sideways}, ${f.pageSideways}`);
      const { left, right } = f.column;
      // One column: everything the Pip says starts at one left edge, everything you said ends at one right edge.
      for (const r of f.replies) assert.ok(near(r.left, left), `a reply starts at the column's edge: ${r.left} vs ${left}`);
      assert.ok(near(f.choices.left, left) && near(f.own.left, left), "its choices and its change line start there too");
      for (const b of f.prompts) assert.ok(near(b.right, right), `a prompt ends at the column's edge: ${b.right} vs ${right}`);
      // One measure: the choices are as wide as a reply may be, never a width of their own.
      assert.equal(f.choices["max-width"], f.replies[0]["max-width"], "choices and replies share one measure");
      assert.ok(f.choices.right <= right + 1 && f.replies.every((r) => r.right <= right + 1));
      // Corners on the shared scale: 16 for a bubble with a 6 tail, 8 for a row; and nothing in the chat casts a shadow.
      for (const b of f.prompts) assert.deepEqual([b["border-top-left-radius"], b["border-bottom-right-radius"], b["box-shadow"]], ["16px", "6px", "none"], say(b));
      for (const r of f.replies) assert.deepEqual([r["border-top-left-radius"], r["border-bottom-left-radius"], r["box-shadow"], r["border-top-width"]], ["16px", "6px", "none", "0px"], say(r));
      for (const c of f.choices.rows) assert.equal(c["border-top-left-radius"], "8px");
      assert.equal(f.form["border-top-left-radius"], "16px", "the box keeps the composer's corner");
      // The 4 px unit: a bubble's padding, the gap inside a message, the space between turns.
      for (const b of [...f.prompts, ...f.replies]) assert.deepEqual([b["padding-top"], b["padding-left"]], ["8px", "12px"]);
      for (const m of f.messages) assert.deepEqual([m["row-gap"], m["margin-bottom"], m["margin-top"]], ["4px", "16px", m.user ? "24px" : "0px"], say(m));
      assert.equal(f.choices["row-gap"], "4px");
      // 16 from a prompt to its reply, 24 from a reply to the next prompt: a turn holds together.
      assert.ok(f.steps.length >= 3 && f.steps.every(([from, , gap]) => gap === (from === "user" ? 16 : 24)), say(f.steps));
      // Type: 13 for what you read, 11 for times and figures, and figures in the UI's own font (monospace is for code).
      for (const b of [...f.prompts, ...f.replies]) assert.equal(b["font-size"], "13px");
      for (const x of [...f.times, ...f.stats]) assert.equal(x["font-size"], "11px");
      assert.ok(f.stats.length > 0);
      for (const s of f.stats) assert.equal(s["font-family"], f.uiFont, "a reply's figures are not monospace");
      // Every word clears 4.5:1 on the ground it sits on.
      const words = { prompt: f.prompts.map((b) => b.ink), reply: f.replies.map((b) => b.ink), time: f.times.map((x) => x.ink), stats: f.stats.map((x) => x.ink),
        link: f.replies.map((b) => b.link).filter(Boolean), choice: f.choices.rows.map((c) => c.ink), key: f.choices.rows.map((c) => c.key.ink), change: [f.own.words, ...f.own.acts.map((a) => a.ink)], placeholder: [f.placeholder],
        boxWords: f.controls.filter((c) => c.text).map((c) => c.ink) };
      assert.equal(words.link.length, 1, "the reply's link is measured");
      for (const [name, inks] of Object.entries(words)) for (const i of inks) assert.ok(i.ratio >= 4.5, `${name} is ${i.ratio}:1 (${say(i)})`);
      // Every control's mark clears 3:1.
      for (const c of [...f.controls, ...f.actions, ...f.topbar]) assert.ok(c.ink.ratio >= 3, `${c.id || "a control"} is ${c.ink.ratio}:1`);
      // One purple: a choice is a plain outline row with its letter in a quiet circle, not a second accent.
      for (const c of f.choices.rows) {
        assert.ok(c.key.ink.chroma <= 12 && c.edge.chroma <= 12, `a choice carries no purple: ${say([c.key.ink, c.edge])}`);
        assert.deepEqual([c.key.width, c.key.height, c.key["border-top-left-radius"]], [20, 20, "50%"], "its letter sits in a 20 px circle");
        assert.ok(c.height >= 28, "a row is at least a control high");
      }
      // The top bar's buttons are quiet marks (no ring around each), still a control high.
      for (const b of f.topbar) assert.deepEqual([b["border-top-width"], b.width >= 28, b.height >= 28], ["0px", true, true], say(b));
      // The box at 300 px: no control lies over another, none leaves the box.
      for (const [i, a] of f.controls.entries()) {
        assert.ok(a.left >= f.form.left - 1 && a.right <= f.form.right + 1, `${a.id} stays in the box`);
        for (const b of f.controls.slice(i + 1)) assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, `${a.id} and ${b.id} don't overlap`);
      }
      // The faces are exactly as they were: their boxes, and their own motion still theirs.
      assert.deepEqual([Math.round(f.faces.pill.width), Math.round(f.faces.pill.height)], [28, 27]);
    } finally { await close(); }
  });

  test(`what its computer holds, and the Pip at work, above the box (${where}, ${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await openChat(browser, { theme, where, width, hold: true, running: true });
    try {
      await p.waitForSelector(".pip-working");
      const f = await p.evaluate(facts), say = JSON.stringify;
      assert.ok(f.sideways <= 0 && f.pageSideways <= 0);
      // The Soft card keeps its look; it takes the card corner and the shared buttons: one filled, the rest outlines.
      assert.equal(f.card["border-top-left-radius"], "12px");
      assert.deepEqual(f.card.buttons.map((b) => b.text), ["Send once", "Always allow", "Reject"]);
      for (const b of f.card.buttons) {
        assert.deepEqual([b.height, b["border-top-left-radius"]], [26, "8px"], say(b));
        assert.ok(b.ink.ratio >= 4.5, `${b.text} is ${b.ink.ratio}:1`);
      }
      // Purple is for the one main button: the two beside it are drawn in the text's own ink.
      for (const b of f.card.buttons.slice(1)) assert.ok(b.ink.chroma <= 12, `${b.text} is not purple: ${say(b.ink)}`);
      for (const [name, i] of Object.entries({ title: f.card.title, small: f.card.small, preview: f.card.preview, details: f.card.details })) assert.ok(i.ratio >= 4.5, `the card's ${name} is ${i.ratio}:1`);
      assert.ok(f.card.left >= f.form.left - 1 && f.card.right <= f.form.right + 1 && f.card.bottom <= f.form.top + 1, "it waits just above the box, as wide as the box");
      // The Pip at work: its face as it was, its figures in the UI's font at 11 px, and never a line broken mid-figure.
      assert.deepEqual([Math.round(f.faces.working.width), Math.round(f.faces.working.height)], [34, 33]);
      assert.deepEqual([f.working.meta["font-family"], f.working.meta["font-size"]], [f.uiFont, "11px"]);
      assert.ok(f.working.meta.height <= 16, `its figures stay on one line: ${f.working.meta.height}`);
      assert.ok(f.working.meta.ink.ratio >= 4.5, `its figures are ${f.working.meta.ink.ratio}:1`);
    } finally { await close(); }
  });

  test(`a Project Pip's chat is the same column: its run's post, document and chips (${where}, ${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close } = await openChat(browser, { theme, where, width, project: true });
    try {
      await p.waitForSelector(".run-post .dgc-doc-card");
      const f = await p.evaluate(facts);
      assert.ok(f.sideways <= 0 && f.pageSideways <= 0);
      const { left, right } = f.column;
      for (const r of f.replies) assert.ok(near(r.left, left) && r.right <= right + 1);
      assert.ok(near(f.doc.left, left) && f.doc.right <= right + 1, "the document card sits in the column");
      for (const c of f.chips) assert.ok(c.left >= left - 1 && c.right <= right + 1 && c.ink.ratio >= 4.5, `a chip is in the column and ${c.ink.ratio}:1`);
      for (const r of f.replies) assert.deepEqual([r["border-top-left-radius"], r["box-shadow"], r["padding-top"], r["padding-left"]], ["16px", "none", "8px", "12px"]);
      for (const x of f.times) assert.ok(x.ink.ratio >= 4.5 && x["font-size"] === "11px", `a time is ${x.ink.ratio}:1 at ${x["font-size"]}`);
      for (const i of [f.doc.name, f.doc.meta, f.placeholder, ...f.replies.map((r) => r.ink), ...f.prompts.map((b) => b.ink)]) assert.ok(i.ratio >= 4.5, `${i.ratio}:1`);
      for (const c of [...f.controls, ...f.topbar]) assert.ok(c.ink.ratio >= 3, `${c.id} is ${c.ink.ratio}:1`);
      assert.deepEqual([Math.round(f.faces.pill.width), Math.round(f.faces.pill.height), Math.round(f.faces.post.width), Math.round(f.faces.post.height)], [28, 27, 22, 21]);
    } finally { await close(); }
  });
}

test("a press answers at once and lets go at once: 120 to 180 ms on the shared curve, and nothing moves under reduced motion", async (t) => {
  if (skipOrFail(t)) return;
  const pressed = async (motion) => {
    const { p, close } = await openChat(browser, { where: "side", width: 420, motion });
    try {
      await p.waitForSelector(".msg-choices");
      const row = p.locator(".msg-choice").first(), at = await row.boundingBox();
      const style = () => row.evaluate((n) => { const s = getComputedStyle(n); return { transform: s.transform, duration: s.transitionDuration, curve: s.transitionTimingFunction, property: s.transitionProperty }; });
      const rest = await style();
      await p.mouse.move(at.x + 20, at.y + at.height / 2);
      await p.mouse.down();
      await p.waitForTimeout(260);
      const down = await style();
      // Let go off the row (no click, nothing is sent): it comes back by itself.
      await p.mouse.move(at.x + 20, at.y - 200);
      await p.mouse.up();
      await p.waitForTimeout(260);
      const back = await style();
      const send = await p.locator("#chat-form .chat-send").first().evaluate((n) => { const s = getComputedStyle(n); return { duration: s.transitionDuration, curve: s.transitionTimingFunction }; });
      const faces = await p.evaluate(() => [...new Set([...(window.__pipsRoot || document).querySelectorAll(".avatar .dgc-plush *")].map((n) => getComputedStyle(n).animationName).filter((n) => n && n !== "none"))]);
      return { rest, down, back, send, faces };
    } finally { await close(); }
  };
  const moving = await pressed("no-preference");
  const longest = (d) => Math.max(...d.split(",").map((s) => Number.parseFloat(s) * (s.trim().endsWith("ms") ? 1 : 1000)));
  assert.match(moving.down.transform, /^matrix\(0\.98, 0, 0, 0\.98, 0, 0\)$/, "pressed, the row gives a little");
  assert.ok(["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(moving.back.transform), `let go, it is back: ${moving.back.transform}`);
  for (const s of [moving.rest, moving.send]) {
    assert.ok(longest(s.duration) >= 100 && longest(s.duration) <= 180, `between 100 and 180 ms: ${s.duration}`);
    assert.match(s.curve, /cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
  }
  assert.doesNotMatch(moving.rest.property, /\ball\b/, "only what changes is animated");
  assert.ok(moving.faces.length > 0, "the faces still move by their own rules");
  const still = await pressed("reduce");
  assert.ok(["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(still.down.transform), `nothing moves under reduced motion: ${still.down.transform}`);
  assert.equal(longest(still.rest.duration), 0);
  assert.equal(longest(still.send.duration), 0);
});

test("the design pass never styles a face: no rule of its section names the avatar or the plush", () => {
  const sheet = readFileSync(new URL("../src/pips.css", import.meta.url), "utf8");
  const start = sheet.indexOf("/* ==== Pip chat design pass");
  assert.ok(start > 0, "the section is in src/pips.css");
  const section = sheet.slice(start).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(section, /\.avatar|\.dgc-plush|plush/, "the faces and their motion are left alone");
  // And its colours are tokens: no raw hex but white on the accent, no rgb().
  assert.deepEqual((section.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((c) => c !== "#fff"), []);
  assert.doesNotMatch(section, /rgba?\(/);
});
