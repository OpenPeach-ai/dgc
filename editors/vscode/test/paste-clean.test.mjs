// media/pasteclean.js on its own: the shared module every prompt box uses. The invisible-character rules
// are held to the same file as dgc/textsafety.py (tests/test_invisible_characters.py runs the two against
// each other on random text as well). The list restoring is tested with what real applications put on
// the clipboard: Chromium's plain text has no markers, Firefox's and Safari's do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
await import("../media/pasteclean.js");
const P = globalThis.DgcPasteClean;
const corpus = JSON.parse(readFileSync(new URL("../../../tests/fixtures/invisible_characters.json", import.meta.url), "utf8"));

test("the module gives the corpus's answer for every case", () => {
  assert.ok(corpus.length > 40);
  for (const row of corpus) {
    const { counts, clean } = P.classify(row.text);
    assert.deepEqual(counts, row.counts, row.name);
    assert.equal(clean, row.clean, row.name);
    assert.equal(P.notice(P.total(counts)), row.notice, row.name);
  }
});

test("cleaning clean text changes nothing", () => {
  for (const row of corpus) assert.deepEqual(P.classify(row.clean), { counts: {}, clean: row.clean }, row.name);
});

test("the notice and its detail", () => {
  assert.equal(P.notice(0), "");
  assert.equal(P.notice(1), "Removed 1 invisible character from the pasted text");
  assert.equal(P.notice(5), "Removed 5 invisible characters from the pasted text");
  assert.equal(P.detail({ "zero-width": 3, bidi: 1, hidden: 2, control: 1 }),
    "3 zero-width characters, 1 text direction control, 2 hidden tag characters, 1 control character. Undo brings them back.");
  assert.equal(P.detail({}), "");
});

test("trimDraft takes the blank lines around a message and keeps its first line's indentation", () => {
  assert.equal(P.trimDraft("\n  \n\tfirst\n\n\nlast  \n\n"), "\tfirst\n\n\nlast");
  assert.equal(P.trimDraft("    def f():\n        return 1\n"), "    def f():\n        return 1");
  assert.equal(P.trimDraft("  \n \n"), "");
});

const clip = (flavours) => ({ getData: (type) => flavours[type] ?? "" });
const restored = (plain, html) => P.clipboardText(clip({ "text/plain": plain, "text/html": html }));

test("Chromium's numbered list: the numbers come back, nothing else moves", () => {
  assert.equal(restored("Intro  text\nOne\nTwo\nOutro\n", "<p>Intro  text</p><ol><li>One</li><li>Two</li></ol><p>Outro</p>"),
    "Intro  text\n1. One\n2. Two\nOutro\n", "the plain text's own spacing is what stays");
});

test("start, value, reversed and the kinds of numbering", () => {
  assert.equal(restored("a\nb\nc", '<ol start="7"><li>a</li><li>b</li><li value="12">c</li></ol>'), "7. a\n8. b\n12. c");
  assert.equal(restored("a\nb", '<ol reversed><li>a</li><li>b</li></ol>'), "2. a\n1. b");
  assert.equal(restored("a\nb", '<ol reversed start="10"><li>a</li><li>b</li></ol>'), "10. a\n9. b");
  assert.equal(restored("a\nb", '<ol type="a"><li>a</li><li>b</li></ol>'), "a. a\nb. b");
  assert.equal(restored("a\nb", '<ol type="A"><li>a</li><li>b</li></ol>'), "A. a\nB. b");
  assert.equal(restored("a\nb\nc\nd", '<ol type="i"><li>a</li><li>b</li><li>c</li><li>d</li></ol>'), "i. a\nii. b\niii. c\niv. d");
  assert.equal(restored("a\nb", '<ol type="I" start="9"><li>a</li><li>b</li></ol>'), "IX. a\nX. b");
  assert.equal(restored("a\nb", '<ol style="list-style-type: lower-alpha"><li>a</li><li>b</li></ol>'), "a. a\nb. b");
  assert.equal(restored("a\nb", '<ol><li style="list-style-type: upper-roman">a</li><li>b</li></ol>'), "I. a\n2. b");
});

test("nesting: bullets, numbers inside bullets, and a list right inside a list as Google Docs writes it", () => {
  assert.equal(restored("Top\nNested\nDeep\nNested two\nNext",
    "<ul><li>Top<ul><li>Nested<ul><li>Deep</li></ul></li><li>Nested two</li></ul></li><li>Next</li></ul>"),
    "- Top\n  - Nested\n    - Deep\n  - Nested two\n- Next");
  assert.equal(restored("Open\nPick\nFont\nRestart", '<ol><li>Open<ol type="a"><li>Pick</li><li>Font</li></ol></li><li>Restart</li></ol>'),
    "1. Open\n   a. Pick\n   b. Font\n2. Restart");
  assert.equal(restored("A\nB\nC", '<ol><li aria-level="1">A</li><ol><li aria-level="2">B</li></ol><li aria-level="1">C</li></ol>'),
    "1. A\n   1. B\n2. C");
});

test("an item with more than one line: its markers and its blank lines", () => {
  assert.equal(restored("One\n\nStill one\n\nTwo\n\n", "<ol><li><p>One</p><p>Still one</p></li><li><p>Two</p></li></ol>"),
    "1. One\n\n   Still one\n\n2. Two\n\n");
  assert.equal(restored("Run:\nmake  all\nDone", "<ol><li>Run:<pre>make  all</pre></li><li>Done</li></ol>"), "1. Run:\n   make  all\n2. Done");
  assert.equal(restored("a\nb\nc", "<ul><li>a<br>b</li><li>c</li></ul>"), "- a\n  b\n- c");
});

test("what a list holds inline does not matter, nor how the page cases or spaces it", () => {
  assert.equal(restored("Use the  tool now\nNEXT", '<ol><li>Use <a href="x">the</a>\n  <code>tool</code> <b>now</b></li><li style="text-transform:uppercase">next</li></ol>'),
    "1. Use the  tool now\n2. NEXT");
});

test("a table in a list, a list beside a table", () => {
  assert.equal(restored("a\tb\nc\nd", "<table><tr><td>a</td><td>b</td></tr></table><ul><li>c</li><li>d</li></ul>"), "a\tb\n- c\n- d");
});

test("a browser that keeps its markers is left alone", () => {
  // Firefox and Safari.
  const html = "<ol><li>One</li><li>Two<ul><li>Sub</li></ul></li></ol>";
  for (const plain of [" 1. One\n 2. Two\n     * Sub", "1.\tOne\n2.\tTwo\n\t\u2022\tSub", "1. One\n2. Two\n- Sub"]) {
    assert.equal(restored(plain, html), plain);
  }
});

test("when the two flavours do not describe the same text, the plain text stands", () => {
  assert.equal(restored("something\nelse", "<ol><li>One</li><li>Two</li></ol>"), "something\nelse");
  assert.equal(restored("One\nsomething else", "<ol><li>One</li><li>Two</li></ol>"), "One\nsomething else", "all or nothing");
  assert.equal(restored("Home About Contact", '<ul><li style="display:inline">Home</li><li style="display:inline">About</li></ul>'),
    "Home About Contact");
});

test("one list that does not line up costs only that list", () => {
  // A real Wikipedia page: its references list has a back-link in the HTML that the plain text leaves out.
  assert.equal(restored("Steps\nOne\nTwo\nRefs\nA book\nA paper\nEnd\nX\nY",
    "<p>Steps</p><ol><li>One</li><li>Two</li></ol><p>Refs</p><ol><li><a>^</a> A book</li><li><a>^</a> A paper</li></ol><p>End</p><ul><li>X</li><li>Y</li></ul>"),
    "Steps\n1. One\n2. Two\nRefs\nA book\nA paper\nEnd\n- X\n- Y");
});

test("words selected inside one item get no marker, because nobody selected a list", () => {
  // Chromium wraps them in the item's list.
  assert.equal(restored("three", '<ol id="o"><li>three</li></ol>'), "three");
  assert.equal(restored("a phrase", "<ul><li>a phrase</li></ul>"), "a phrase");
  // But a one-item list in the middle of a selection is a list.
  assert.equal(restored("Lead\nOnly one", "<p>Lead</p><ul><li>Only one</li></ul>"), "Lead\n- Only one");
});

test("a list drawn as a row of words is not a list", () => {
  assert.equal(restored("Menu\nHome \u00B7 About\nOne\nTwo",
    '<p>Menu</p><ul><li style="margin:0;display:inline">Home \u00B7 </li><li style="display:inline">About</li></ul><ol><li>One</li><li>Two</li></ol>'),
    "Menu\nHome \u00B7 About\n1. One\n2. Two");
});

test("nothing is invented where the page shows no marker", () => {
  assert.equal(restored("Home\nAbout", '<ul style="list-style: none"><li>Home</li><li>About</li></ul>'), "Home\nAbout");
  assert.equal(restored("Home\nAbout\nMore", '<ul><li style="list-style-type:none">Home</li><li>About</li><li>More</li></ul>'), "Home\n- About\n- More");
  assert.equal(restored("Just a paragraph", "<p>Just a paragraph</p>"), "Just a paragraph");
});

test("a heading with the same words as an item does not take its marker", () => {
  assert.equal(restored("Install\nInstall\nRun", "<h2>Install</h2><ol><li>Install</li><li>Run</li></ol>"), "Install\n1. Install\n2. Run");
});

test("VS Code's own editor copy: its HTML is spans, and the plain text is the code", () => {
  const code = "def f(x):\n\tif x:\n\t\treturn  x   +  1\n    # four spaces";
  const html = '<div style="color:#d4d4d4"><div><span style="color:#569cd6">def</span> f(x):</div><div>&nbsp;&nbsp;&nbsp;&nbsp;if x:</div></div>';
  assert.equal(restored(code, html), code);
});

test("Word's list: its numbers are text in both flavours", () => {
  const html = '<p class=MsoListParagraph style="mso-list:l0 level1 lfo1"><![if !supportLists]><span>1.<span>&nbsp;&nbsp;</span></span><![endif]>First</p>';
  assert.equal(restored("1.\tFirst", html), "1.\tFirst");
});

test("line endings", () => {
  assert.equal(P.clipboardText(clip({ "text/plain": "a\r\nb\rc\u2028d\u2029e" })), "a\nb\nc\nd\ne");
});

test("only HTML on the clipboard: its words and shape, as text", () => {
  assert.equal(P.clipboardText(clip({ "text/html": "<h1>Title</h1><p>One  two</p><ol><li>a</li><li>b</li></ol><pre>  x\n\n    y\n</pre><table><tr><td>c</td><td>d</td></tr></table>" })),
    "Title\n\nOne two\n\n1. a\n2. b\n\n  x\n\n    y\n\nc\td");
  assert.equal(P.clipboardText(clip({ "text/html": "a<br><br>b<br>c" })), "a\n\nb\nc");
  assert.equal(P.clipboardText(clip({ "text/html": "<script>x()</script><style>p{}</style><img alt='no' src='x'>ok" })), "ok");
  assert.equal(P.clipboardText(clip({})), "");
  assert.equal(P.clipboardText(null), "");
});

test("a very long page stays quick", () => {
  const items = Array.from({ length: 5000 }, (_, i) => `item ${i}`);
  const start = Date.now();
  const out = restored(items.join("\n"), `<ol>${items.map((t) => `<li>${t}</li>`).join("")}</ol>`);
  assert.equal(out.split("\n")[4999], "5000. item 4999");
  assert.ok(Date.now() - start < 3000);
});

test("fromClipboard is the whole paste: as copied, as it lands, and what went", () => {
  const paste = P.fromClipboard(clip({ "text/plain": "One\u200B\nTwo", "text/html": "<ol><li>One\u200B</li><li>Two</li></ol>" }));
  assert.equal(paste.raw, "1. One\u200B\n2. Two");
  assert.equal(paste.clean, "1. One\n2. Two");
  assert.deepEqual(paste.counts, { "zero-width": 1 });
  assert.equal(paste.removed, 1);
});
