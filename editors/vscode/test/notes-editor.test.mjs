// Notes, step 3 (media/shared/notes.js): the editor. Formatting shown as you type (bold looks bold while you write),
// headings, bulleted and numbered lists, checklists, links, a format bar, the shortcuts, undo and redo; underneath, a
// note is Markdown text, so a note written before opens unchanged. In real Chromium, answered by the real host.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid } from "./support/home-grid-scene.mjs";
import { sample, FERRY } from "./support/notes-sample.mjs";
import { cleanup, notesModule, context, ask } from "./support/notes-host.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });

const CARD = '.hc-grid .hc-card[data-card="note"]', OPEN = ".hc-open .hc-card", DOC = `${OPEN} .nt-doc`;
const opened = async (width, more = {}) => { const x = await openGrid(browser, { width: 300, layout: ["note", "clock"], seed: sample(), ...more }); await x.page.click(`${CARD} .nt-openapp`); await x.rest(200); if (width !== 300) await x.resize(width, more.height || 900); return x; };
const lines = (p, doc = DOC) => p.evaluate((sel) => [...document.querySelectorAll(`${sel} > .nt-l`)].map((l) => [l.dataset.k, l.textContent, ...(l.dataset.in ? [`in${l.dataset.in}`] : []), ...(l.dataset.k === "ck" ? [l.dataset.done === "1"] : []), ...(l.dataset.k === "ol" ? [l.dataset.n] : [])]), doc);
const fresh = async (x) => { await x.page.click(`${OPEN} .hc-note-new`); await x.rest(200); };
/** The words of the note with this title, as its file has them, once the typing has rested. */
const saved = async (x, title) => { await x.rest(900); const n = (await x.notes.list()).find((m) => m.title === title); return n ? x.notes.text(n.id) : undefined; };
const caretEnd = (p, k) => p.evaluate(({ sel, k }) => { const l = document.querySelectorAll(`${sel} > .nt-l`)[k], r = document.createRange(); r.selectNodeContents(l); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector(sel).focus(); }, { sel: DOC, k });

test("a note written as Markdown is shown formatted, and opening it changes nothing: bold, italic, two headings, lists that number themselves, ticks, a link", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    const before = (await x.notes.list()).find((n) => n.id === "ferry1").edited;
    await p.click(`${OPEN} .hc-note-row[data-note="ferry1"]`); await x.rest(300);
    assert.deepEqual(await lines(p), [["p", "Ferry to Porto"], ["p", "Leaves from the north quay, not the old terminal. Be there 40 minutes early with the car."], ["h2", "Before we go"], ["ck", "Book the 09:40", true], ["ck", "Check the car deck height", true], ["ck", "Ask about bikes", false], ["ck", "Print the tickets", false],
      ["h2", "On the day"], ["ol", "Fuel the evening before", "1"], ["ol", "Leave by 07:30", "2"], ["ol", "Coffee at the quay", "3"], ["p", ""], ["ul", "Timetable: ferries.example/porto"], ["ul", "Cabin 214, deck 5"]]);
    const look = await p.evaluate((sel) => { const d = document.querySelector(sel), css = (n) => getComputedStyle(n), l = d.querySelectorAll(":scope > .nt-l");
      return { bold: d.querySelector("b").textContent, boldWeight: Number(css(d.querySelector("b")).fontWeight), italic: d.querySelector("i").textContent, italicStyle: css(d.querySelector("i")).fontStyle, link: [d.querySelector("a").textContent, d.querySelector("a").getAttribute("href")],
        title: parseFloat(css(l[0]).fontSize), h2: parseFloat(css(l[2]).fontSize), body: parseFloat(css(l[1]).fontSize), struck: css(l[3]).textDecorationLine, plainTick: css(l[5]).textDecorationLine, marks: d.textContent.includes("**") || d.textContent.includes("- [") || d.textContent.includes("## ") }; }, DOC);
    assert.deepEqual([look.bold, look.italic, look.link], ["north quay", "Be there 40 minutes early", ["ferries.example/porto", "https://ferries.example/porto"]]);
    assert.ok(look.boldWeight >= 600); assert.equal(look.italicStyle, "italic"); assert.equal(look.marks, false, "no Markdown marks are shown");
    assert.ok(look.title > look.h2 && look.h2 > look.body, `the title, then a heading, then the words (${look.title} ${look.h2} ${look.body})`);
    assert.match(look.struck, /line-through/, "a ticked line is struck through"); assert.equal(look.plainTick, "none");
    await x.rest(900);
    assert.equal(await x.notes.text("ferry1"), FERRY, "its words are as they were"); assert.equal((await x.notes.list()).find((n) => n.id === "ferry1").edited, before, "opening a note is not an edit");
    assert.equal((await x.posted("homeNotesDo")).some((m) => m.op === "save"), false);
  } finally { await x.close(); }
});

test("every kind of line survives a round trip as the same Markdown, and words that look like marks stay words", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    const cases = [FERRY, "Ferry to Porto\n- [ ] book the 09:40\n- [x] check the car deck\nAsk about bikes", "Sums\n5 * 3 * 2 is 30\nsnake_case_name and a_b\n\\* not a bullet\n2\\. not a number\n\\# not a heading", "Nested\n- one\n  - two\n    - three\n  1. first\n  2. second\n- back",
      "Marks\n**bold _both_ bold** and *soft* and [a link](https://example.org/a_b) and https://example.org/x_y end", "  leading spaces stay\n\n\nthree lines down", "### Small heading\n## Bigger\n# Biggest", ""];
    const out = await p.evaluate((all) => { const ed = window.DgcNotes.createEditor({ doc: document, onInput() {}, longest: () => 100000 }); document.body.append(ed.el); const got = all.map((text) => { ed.set(text); return ed.text(); }); ed.el.remove(); return got; }, cases);
    assert.deepEqual(out, cases);
  } finally { await x.close(); }
});

test("typed as you go: a list starts with “- ”, numbers keep themselves in order, “[] ” is a tick box, “## ” a heading, **bold** and *italic* turn as they close; an empty item ends its list", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await fresh(x);
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true, "a new note opens ready to type");
    await p.keyboard.type("Shopping"); await p.keyboard.press("Enter");
    await p.keyboard.type("- milk"); await p.keyboard.press("Enter"); await p.keyboard.type("eggs"); await p.keyboard.press("Enter"); await p.keyboard.press("Enter");
    await p.keyboard.type("1. flour"); await p.keyboard.press("Enter"); await p.keyboard.type("sugar"); await p.keyboard.press("Enter"); await p.keyboard.press("Enter");
    await p.keyboard.type("[] call the baker"); await p.keyboard.press("Enter"); await p.keyboard.press("Enter");
    await p.keyboard.type("## Later"); await p.keyboard.press("Enter");
    await p.keyboard.type("A **bold** word and *soft* one");
    assert.deepEqual(await lines(p), [["p", "Shopping"], ["ul", "milk"], ["ul", "eggs"], ["ol", "flour", "1"], ["ol", "sugar", "2"], ["ck", "call the baker", false], ["h2", "Later"], ["p", "A bold word and soft one"]]);
    assert.deepEqual(await p.evaluate((sel) => [document.querySelector(`${sel} b`)?.textContent, document.querySelector(`${sel} i`)?.textContent], DOC), ["bold", "soft"], "bold looks bold while you write");
    assert.equal(await saved(x, "Shopping"), "Shopping\n- milk\n- eggs\n1. flour\n2. sugar\n- [ ] call the baker\n## Later\nA **bold** word and *soft* one");
    // A line put between two numbered ones: the numbers follow.
    await caretEnd(p, 3); await p.keyboard.press("Enter"); await p.keyboard.type("butter"); await x.rest(100);
    assert.deepEqual((await lines(p)).filter((l) => l[0] === "ol"), [["ol", "flour", "1"], ["ol", "butter", "2"], ["ol", "sugar", "3"]]);
    // Backspace at the start of a list line makes it plain words again; again joins it to the line above.
    await p.keyboard.press("Home"); await p.keyboard.press("Backspace"); await x.rest(60);
    assert.deepEqual((await lines(p))[4], ["p", "butter"]);
    await p.keyboard.press("Backspace"); await x.rest(60);
    assert.deepEqual((await lines(p)).slice(3, 5), [["ol", "flourbutter", "1"], ["ol", "sugar", "2"]]);
    assert.match(await saved(x, "Shopping"), /\n1\. flourbutter\n2\. sugar\n/);
  } finally { await x.close(); }
});

test("the format bar and the shortcuts: Bold, Italic, Heading, the three lists, indent with Tab; each button says whether it is on", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await fresh(x);
    const bar = () => p.evaluate((sel) => [...document.querySelectorAll(`${sel} .nt-format button[data-cmd]`)].map((b) => [b.dataset.cmd, b.getAttribute("aria-pressed") || "", !!b.getAttribute("aria-label")]), OPEN);
    assert.deepEqual((await bar()).map((b) => b[0]), ["bold", "italic", "heading", "ul", "ol", "ck", "link", "undo"]); assert.ok((await bar()).every((b) => b[2]), "every button has a name");
    await p.keyboard.type("Plan"); await p.keyboard.press("Enter"); await p.keyboard.type("north quay early");
    // Bold by shortcut on chosen words; Italic by its button.
    for (let k = 0; k < 5; k++) await p.keyboard.press("Shift+ArrowLeft");
    await p.keyboard.press("Control+b"); await x.rest(80);
    assert.equal(await p.evaluate((sel) => document.querySelector(`${sel} b`)?.textContent, DOC), "early");
    assert.equal((await bar()).find((b) => b[0] === "bold")[1], "true", "the bar says Bold is on where the caret is");
    await p.click(`${OPEN} .nt-format button[data-cmd="italic"]`); await x.rest(80);
    assert.equal(await p.evaluate((sel) => document.querySelector(`${sel} i`)?.textContent, DOC), "early");
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true, "the keyboard stays in the note");
    await p.keyboard.press("Control+b"); await x.rest(60);
    assert.equal(await p.evaluate((sel) => document.querySelector(`${sel} b`), DOC), null, "Bold again takes it off");
    // Bold while you write: turned on with nothing chosen, the next words are bold.
    // (On a line of its own: words typed at the end of italic words are italic too, as in any editor.)
    await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.type("and "); await p.keyboard.press("Control+b"); await p.keyboard.type("loud"); await p.keyboard.press("Control+b"); await p.keyboard.type(" then quiet");
    assert.equal(await p.evaluate((sel) => document.querySelector(`${sel} b`)?.textContent, DOC), "loud");
    // Headings: the button goes through heading, small heading, plain; Ctrl+Alt+1 and 2 choose one.
    await p.keyboard.press("Enter"); await p.keyboard.type("Before we go");
    await p.click(`${OPEN} .nt-format button[data-cmd="heading"]`); assert.equal((await lines(p))[3][0], "h2");
    await p.click(`${OPEN} .nt-format button[data-cmd="heading"]`); assert.equal((await lines(p))[3][0], "h3");
    await p.click(`${OPEN} .nt-format button[data-cmd="heading"]`); assert.equal((await lines(p))[3][0], "p");
    await p.keyboard.press("Control+Alt+Digit2"); assert.equal((await lines(p))[3][0], "h3"); await p.keyboard.press("Control+Alt+Digit1"); assert.equal((await lines(p))[3][0], "h2");
    // Lists: by button and by shortcut; Tab and Shift+Tab indent; the kinds change in place.
    await p.keyboard.press("Enter"); await p.keyboard.type("tickets"); await p.click(`${OPEN} .nt-format button[data-cmd="ul"]`);
    await p.keyboard.press("Enter"); await p.keyboard.type("on paper"); await p.keyboard.press("Tab"); await x.rest(60);
    assert.deepEqual((await lines(p)).slice(4), [["ul", "tickets"], ["ul", "on paper", "in1"]]);
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true, "Tab indents a list line: the keyboard stays");
    await p.keyboard.press("Shift+Tab"); assert.deepEqual((await lines(p))[5], ["ul", "on paper"]);
    await p.keyboard.press("Control+Shift+Digit7"); assert.deepEqual((await lines(p))[5], ["ol", "on paper", "1"]);
    await p.keyboard.press("Control+Shift+Digit9"); assert.deepEqual((await lines(p))[5], ["ck", "on paper", false]);
    await p.keyboard.press("Control+Shift+Digit8"); assert.deepEqual((await lines(p))[5], ["ul", "on paper"]);
    assert.equal((await bar()).find((b) => b[0] === "ul")[1], "true");
    assert.equal(await saved(x, "Plan"), "Plan\nnorth quay *early*\nand **loud** then quiet\n## Before we go\n- tickets\n- on paper");
  } finally { await x.close(); }
});

test("a checklist: ticked with a click on its box or Ctrl+Enter, struck through when done, and written into the note", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(760), p = x.page;
  try {
    await p.click(`${OPEN} .hc-note-row[data-note="ferry1"]`); await x.rest(300);
    const box = async (k) => { const r = await p.evaluate(({ sel, k }) => { const l = document.querySelectorAll(`${sel} > .nt-l`)[k].getBoundingClientRect(); return { x: l.left + 7, y: l.top + l.height / 2 }; }, { sel: DOC, k }); await p.mouse.click(r.x, r.y); await x.rest(80); };
    await box(5);
    assert.deepEqual((await lines(p))[5], ["ck", "Ask about bikes", true]);
    assert.match(await saved(x, "Ferry to Porto"), /- \[x\] Ask about bikes\n- \[ \] Print the tickets/, "a tick is written into the note");
    await box(3); assert.deepEqual((await lines(p))[3], ["ck", "Book the 09:40", false]);
    await caretEnd(p, 6); await p.keyboard.press("Control+Enter"); await x.rest(80);
    assert.deepEqual((await lines(p))[6], ["ck", "Print the tickets", true]);
    assert.match(await saved(x, "Ferry to Porto"), /- \[ \] Book the 09:40\n- \[x\] Check the car deck height\n- \[x\] Ask about bikes\n- \[x\] Print the tickets/);
    assert.match(await p.locator(".hc-live").innerText(), /Done|Not done/, "a screen reader hears the tick");
  } finally { await x.close(); }
});

test("links: a typed address becomes one; Ctrl+K puts one on the chosen words; Ctrl+click opens it in the browser, a plain click does not", async (t) => {
  if (skipOrFail(t)) return;
  const opens = [], x = await opened(300, { notesOptions: { env: { openExternal: (url) => { opens.push(url); } } } }), p = x.page;
  try {
    await fresh(x);
    await p.keyboard.type("Links"); await p.keyboard.press("Enter"); await p.keyboard.type("see https://tides.example/bay today");
    const links = () => p.evaluate((sel) => [...document.querySelectorAll(`${sel} a`)].map((a) => [a.textContent, a.getAttribute("href")]), DOC);
    assert.deepEqual(await links(), [["https://tides.example/bay", "https://tides.example/bay"]]);
    // Ctrl+K on chosen words.
    await p.keyboard.press("Enter"); await p.keyboard.type("the timetable");
    for (let k = 0; k < 9; k++) await p.keyboard.press("Shift+ArrowLeft");
    await p.keyboard.press("Control+k"); await x.rest(120);
    assert.equal(await p.evaluate(() => document.activeElement?.matches("input.nt-url")), true, "the address field has the keyboard");
    await p.keyboard.type("ferries.example/porto"); await p.keyboard.press("Enter"); await x.rest(150);
    assert.deepEqual((await links())[1], ["timetable", "https://ferries.example/porto"], "an address typed without https:// gets it");
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true);
    assert.equal(await saved(x, "Links"), "Links\nsee https://tides.example/bay today\nthe [timetable](https://ferries.example/porto)");
    // A plain click only puts the caret there; Ctrl+click opens it, and only the web or mail.
    await p.locator(`${DOC} a`).first().click(); await x.rest(150); assert.deepEqual(opens, []);
    await p.locator(`${DOC} a`).first().click({ modifiers: ["Control"] }); await x.rest(200);
    assert.deepEqual(opens, ["https://tides.example/bay"]);
    const { Notes } = await notesModule(), seen = [], notes = new Notes(context(), { env: { openExternal: (url) => seen.push(url) } });
    for (const url of ["https://a.example/x", "mailto:me@example.org", "file:///etc/passwd", "javascript:alert(1)", "vscode://x", "command:workbench.action.reloadWindow", 7]) await ask(notes, { type: "homeNotesDo", op: "link", url });
    assert.deepEqual(seen, ["https://a.example/x", "mailto:me@example.org"], "nothing else is ever opened");
  } finally { await x.close(); }
});

test("undo and redo while typing: Ctrl+Z, Ctrl+Shift+Z and the bar's Undo bring back words and formatting", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await fresh(x);
    await p.keyboard.type("Undo me"); await p.keyboard.press("Enter"); await p.keyboard.type("- one"); await p.keyboard.press("Enter"); await p.keyboard.type("two"); await x.rest(1200);
    await p.keyboard.press("Control+Shift+Digit9"); await x.rest(60);
    assert.deepEqual((await lines(p))[2], ["ck", "two", false]);
    await p.keyboard.press("Control+z"); await x.rest(60);
    assert.deepEqual((await lines(p))[2], ["ul", "two"], "Undo: the line is a bullet again");
    await p.keyboard.press("Control+Shift+z"); await x.rest(60);
    assert.deepEqual((await lines(p))[2], ["ck", "two", false], "Redo");
    await p.click(`${OPEN} .nt-format button[data-cmd="undo"]`); await x.rest(60);
    assert.deepEqual((await lines(p))[2], ["ul", "two"]);
    await p.keyboard.press("Control+z"); await x.rest(60);
    assert.ok((await lines(p)).length < 3 || (await lines(p))[2][1] !== "two", "and again: the typing before it");
    for (let k = 0; k < 12; k++) await p.keyboard.press("Control+z");
    assert.deepEqual(await lines(p), [["p", ""]], "all the way back to the empty note, and no further");
    for (let k = 0; k < 20; k++) await p.keyboard.press("Control+Shift+z");
    assert.deepEqual((await lines(p)).at(-1), ["ck", "two", false], "and Redo, all the way forward to the last thing done");
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true);
    assert.equal(await saved(x, "Undo me"), "Undo me\n- one\n- [ ] two");
  } finally { await x.close(); }
});

test("pasted words come in as plain lines (a list as a list), never as a page's own styles; a note stops at 100,000 characters and says so", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await fresh(x);
    await p.keyboard.type("Pasted"); await p.keyboard.press("Enter");
    const paste = (text, html) => p.evaluate(({ sel, text, html }) => { const d = new DataTransfer(); d.setData("text/plain", text); if (html) d.setData("text/html", html); document.querySelector(sel).dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); }, { sel: DOC, text, html });
    await paste("- boots\n- the red flask\nand **two** maps", '<ul style="color:red"><li><span style="font-size:40px">boots</span></li></ul>'); await x.rest(100);
    assert.deepEqual(await lines(p), [["p", "Pasted"], ["ul", "boots"], ["ul", "the red flask"], ["p", "and two maps"]]);
    assert.equal(await p.evaluate((sel) => document.querySelector(sel).querySelectorAll("[style], span, font, ul, li").length, DOC), 0, "no styles of the page it came from");
    await p.keyboard.type("!"); assert.deepEqual((await lines(p)).at(-1), ["p", "and two maps!"], "the caret is after what was pasted");
    assert.equal(await saved(x, "Pasted"), "Pasted\n- boots\n- the red flask\nand **two** maps!");
    // The most a note holds.
    await p.keyboard.press("Enter"); await paste("x".repeat(100001)); await x.rest(150);
    assert.match(await p.locator(`${OPEN} .nt-limit`).innerText(), /100,000 characters/);
    assert.equal((await lines(p)).at(-1)[1], "", "what does not fit is not put in");
    await paste("y".repeat(500)); await x.rest(900);
    assert.equal((await saved(x, "Pasted")).length, "Pasted\n- boots\n- the red flask\nand **two** maps!\n".length + 500);
  } finally { await x.close(); }
});
