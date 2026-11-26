// One × for every line that stays (media/shared/dismiss.js, window.DgcDismiss). A warning, an error or a "done" note
// that a page keeps on screen until something else replaces it can be closed, the same way on every surface. Here:
// the shared piece itself, in jsdom (the button, one line made by hand, every line of a page found again after each
// change, what stays closed and what shows again, where the focus goes), and that every page loads it. The surfaces,
// painted, are in dismiss-lines-browser.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ICONS = read("media/shared/icons.js"), DISMISS = read("media/shared/dismiss.js"), CSS = read("media/shared/dismiss.css");
const tick = () => new Promise((r) => setTimeout(r, 0));
function page(body, { icons = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
  if (icons) dom.window.eval(ICONS);
  dom.window.eval(DISMISS);
  return { w: dom.window, d: dom.window.document, D: dom.window.DgcDismiss, $: (s) => dom.window.document.querySelector(s) };
}
const closed = (el) => el.hasAttribute("data-dgc-dismissed");

test("the button: the Close glyph in a real button, titled Dismiss and named Dismiss this message", () => {
  const { D, d } = page("");
  const b = D.button(d);
  assert.equal(b.tagName, "BUTTON"); assert.equal(b.type, "button");
  assert.equal(b.title, "Dismiss"); assert.equal(b.getAttribute("aria-label"), "Dismiss this message");
  assert.ok(b.classList.contains("dgc-dismiss"));
  const glyph = b.querySelector("svg");
  assert.equal(glyph.dataset.icon, "close", "one action, one icon: the Close glyph"); assert.equal(glyph.getAttribute("aria-hidden"), "true");
  assert.equal(b.textContent, "", "it adds no words to its line");
  // A page's own hook rides on it; a page with no icons loaded draws the same outline.
  assert.match(D.html({ attrs: 'data-dismiss-note="error"', cls: "page-note-close" }), /class="dgc-dismiss page-note-close" data-dismiss-note="error" title="Dismiss"/);
  const bare = page("", { icons: false });
  assert.equal(bare.D.button(bare.d).querySelector("path").getAttribute("d"), glyph.querySelector("path").getAttribute("d"));
});

test("the look: a 26px box with the 6px corner, never a pill; a closed line is out of sight", () => {
  assert.match(CSS, /\.dgc-dismiss\{[^}]*width:26px;height:26px[^}]*border-radius:var\(--btn-r,6px\)/);
  assert.doesNotMatch(CSS, /border-radius:\s*(999|50%|var\(--r-full)/);
  assert.match(CSS, /\[data-dgc-dismissed\]\{display:none!important\}/);
  assert.match(CSS, /forced-colors:active/);
});

test("one line made by hand: its × hides that line, tells the page, and the focus goes where the page says", () => {
  const { D, $, d } = page('<div id="log"><div class="sys err" id="a">The model x isn’t available.</div><div class="sys err" id="b">Another.</div></div><div id="input" tabindex="0"></div>');
  let told = null;
  const b = D.add($("#a"), { focus: () => $("#input"), onDismiss: (line) => { told = line; } });
  D.add($("#b"));
  assert.equal($("#a").lastElementChild, b); assert.ok($("#a").classList.contains("dgc-dismissible"));
  assert.equal($("#a").textContent, "The model x isn’t available.", "the line's words are as they were");
  b.click();
  assert.ok(closed($("#a")), "that line is closed"); assert.equal(closed($("#b")), false, "the other one stays");
  assert.equal(told, $("#a")); assert.equal(d.activeElement, $("#input"), "the focus is on the message box");
});

test("a page's lines, found again after each change: closed words stay closed, a new or different message shows", async () => {
  const { D, $, d } = page('<h2>Pips</h2><div id="host"></div><button id="next">Start Pips</button>');
  const host = $("#host"), draw = (words) => { host.innerHTML = words ? `<p class="notice error" role="alert">${words}</p>` : ""; };
  const w = D.watch({ root: d.body, lines: [".notice.error"] });
  draw("The service manager reload failed."); await tick();
  let line = $(".notice.error"), x = line.querySelector(".dgc-dismiss");
  assert.ok(x, "the line has its ×"); assert.equal(x.getAttribute("aria-label"), "Dismiss this message");
  x.click();
  assert.ok(closed(line), "it goes"); assert.equal(d.activeElement, $("#next"), "the focus is on the control after it");
  // The page draws itself again with the same words (a poll): still closed.
  draw("The service manager reload failed."); await tick();
  assert.ok(closed($(".notice.error")), "the same words drawn again stay closed");
  // Something else is said: it shows.
  draw("Pips couldn’t be started."); await tick();
  line = $(".notice.error"); assert.equal(closed(line), false, "a different message shows"); assert.ok(line.querySelector(".dgc-dismiss"));
  line.querySelector(".dgc-dismiss").click();
  // It went away, and the same thing fails again: that is a new message.
  draw(""); await tick(); draw("Pips couldn’t be started."); await tick();
  assert.equal(closed($(".notice.error")), false, "the same words after the line went away show again");
  w.dispose();
  draw("Later."); await tick();
  assert.equal($(".notice.error .dgc-dismiss"), null, "a page that stopped watching draws no ×");
});

test("a line the page keeps and fills (hidden until it says something): the × follows its words", async () => {
  const { D, $, d } = page('<h2 id="head">Library</h2><p id="status" role="status" hidden></p>');
  const status = $("#status"), say = (words, kind) => { status.textContent = words; status.hidden = !words; if (kind) status.dataset.kind = kind; else delete status.dataset.kind; };
  let told = 0;
  D.watch({ root: d.body, lines: [{ sel: '#status[data-kind="error"]', onDismiss: () => { told++; } }] });
  say("Loading…"); await tick();
  assert.equal(status.querySelector(".dgc-dismiss"), null, "a line that only counts work has no ×");
  say("DGC didn’t answer.", "error"); await tick();
  const x = status.querySelector(".dgc-dismiss"); assert.ok(x);
  assert.equal(status.textContent, "DGC didn’t answer.");
  x.click();
  assert.ok(closed(status)); assert.equal(told, 1);
  assert.equal(d.activeElement, $("#head"), "no control to go to: the heading takes the focus"); assert.equal($("#head").getAttribute("tabindex"), "-1");
  say("DGC didn’t answer.", "error"); await tick();
  assert.ok(closed(status), "written again with the same words: still closed");
  say(""); await tick();
  assert.equal(closed(status), false); assert.equal(status.querySelector(".dgc-dismiss"), null, "an empty line keeps no ×");
  say("DGC didn’t answer.", "error"); await tick();
  assert.equal(closed(status), false, "said again after it went: it shows"); assert.ok(status.querySelector(".dgc-dismiss"));
  say("Nothing here yet."); await tick();
  assert.equal(status.querySelector(".dgc-dismiss"), null, "and a line that is no longer an error loses its ×");
});

test("what a page leaves out has no ×: a line with its own way out, a dialog's own words", async () => {
  const { D, $, d } = page('<p class="note" id="plain">Couldn’t list your Pips.</p><p class="note" id="retry">Couldn’t check. <button class="retry">Retry</button></p><div role="dialog"><p class="note" id="asked">Delete it?</p></div>');
  D.watch({ root: d.body, lines: [{ sel: ".note", when: (line) => !line.querySelector(".retry") && !line.closest('[role="dialog"]') }] });
  await tick();
  assert.ok($("#plain .dgc-dismiss")); assert.equal($("#retry .dgc-dismiss"), null); assert.equal($("#asked .dgc-dismiss"), null);
  // A click on the × never reaches the page's own listener for what the line is in (a card that is one button).
  let reached = 0; d.body.addEventListener("click", () => { reached++; });
  $("#plain .dgc-dismiss").click();
  assert.equal(reached, 0); assert.ok(closed($("#plain")));
});

test("every page loads the one shared piece", () => {
  const panel = read("src/panel.ts"), chat = read("src/chatdgc.ts");
  assert.match(panel, /"media", "shared", "dismiss\.js"\)/); assert.match(panel, /src="\$\{dismissJs\}"/);
  assert.equal(chat.split('asset("media/shared/dismiss.js")').length - 1, 2, "ChatDGC's page and the Library's own tab");
  assert.match(read("src/artifacts.ts"), /s\("media\/shared\/dismiss\.js"\)/);
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/dismiss\.css"\);/);
  for (const bundle of ["src/pipsClient.js", "src/settingsClient.js", "src/pipComputerClient.js", "src/dgcBrowserTab.js"]) {
    const source = read(bundle);
    assert.match(source, /import '\.\.\/media\/shared\/dismiss\.css';/, `${bundle}: the look`);
    assert.match(source, /import '\.\.\/media\/shared\/dismiss\.js';/, `${bundle}: the piece`);
  }
  // No page keeps a × of its own for a line: the Pips page's and its computer's are the shared button.
  assert.doesNotMatch(read("src/pipsClient.js"), /class="pop-close page-note-close"/);
  assert.doesNotMatch(read("src/pipComputerClient.js"), /crossButton\('data-dismiss=/);
});
