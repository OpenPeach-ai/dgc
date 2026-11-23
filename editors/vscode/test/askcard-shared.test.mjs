// The question card is one module (0.52, the rule, 15 Nov: one capability, one module): media/shared/askcard.js and
// askcard.css are the card Work docks in its composer and a Pip's chat draws under a reply (Pips API 106). Work's page
// loads the script before media/main.js and its stylesheet imports the look; the Pips bundle imports both. Neither page
// keeps a copy of its own: the rows, the keys and the answered panel are written once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Work and a Pip's chat load the one card, and neither keeps its own", () => {
  const panel = read("src/panel.ts"), main = read("media/main.js"), mainCss = read("media/main.css"), pips = read("src/pipsClient.js");
  assert.match(panel, /"media", "shared", "askcard\.js"/);
  assert.ok(panel.indexOf("${askCardJs}") > panel.indexOf("${iconsJs}") && panel.indexOf("${askCardJs}") < panel.indexOf('src="${js}"'),
    "after the icons it draws with, before main.js");
  assert.match(mainCss, /@import url\("\.\/shared\/askcard\.css"\);/);
  assert.match(pips, /import '\.\.\/media\/shared\/askcard\.js';/);
  assert.match(pips, /import '\.\.\/media\/shared\/askcard\.css';/);
  assert.ok(pips.indexOf("askcard.css") > pips.indexOf("import './pips.css'"), "after the view's own buttons, so the card wins their ties");
  for (const own of ["function askUnmark", "function renderAskCard", "function askKey(", "function askChoose", "function askedOption"])
    assert.ok(!main.includes(own), `main.js keeps no ${own} of its own`);
  assert.ok(!/\.ask-opt\s*\{/.test(mainCss) && !/\.asked-panel\s*\{/.test(mainCss), "main.css keeps no copy of the card's look");
  assert.ok(!/\.ask-opt\s*\{/.test(read("src/pipsTranscript.css")) && !/\.ask-opt\s*\{/.test(read("src/pips.css")), "nor do the Pips' styles");
});

test("the module draws its own glyphs (a shadow root can't use the icon font) and settles a card from what DGC says", () => {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/icons.js") + "\n" + read("media/shared/askcard.js"));
  const Ask = dom.window.DgcAskCard;
  for (const name of ["close", "chevron-left", "chevron-right"]) assert.match(Ask.glyph(name), new RegExp(`data-icon="${name}"`), name);
  assert.match(Ask.glyph("pencil"), /data-icon="pencil"/);
  const questions = [{ id: "q1", header: "Storage", question: "Which?", multi_select: false,
    options: [{ label: "SQLite (Recommended)", description: "" }, { label: "JSON", description: "Plain." }] }];
  assert.equal(Ask.valid(questions), true);
  assert.equal(Ask.valid([{ ...questions[0], options: questions[0].options.slice(0, 1) }]), false);
  assert.match(Ask.answeredHtml({ outcome: "answered", questions, answers: { q1: { selected: [0], other: "" } } }),
    /<li class="asked-opt picked">.*SQLite<\/span><span class="ask-badge">Recommended<\/span>/);
  assert.equal(Ask.answeredHtml({ outcome: "dismissed", questions }), '<p class="asked-outcome">Dismissed without an answer</p>');
  assert.equal(Ask.answeredHtml({ outcome: "closed", questions }), '<p class="asked-outcome">Not answered: the chat moved on</p>');
  // A card: built, mounted by the page, then drawn; its post goes to the page.
  const posted = [];
  const state = Ask.create(questions, { onPost: (p) => posted.push(p) });
  dom.window.document.body.append(state.el);
  Ask.render(state);
  assert.equal(state.el.querySelectorAll(".ask-opt").length, 2);
  assert.equal(state.el.querySelector(".ask-opt").getAttribute("aria-checked"), "true", "the recommendation is preselected");
  Ask.dismiss(state);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ dismissed: true }]);
  Ask.rejected(state, "Try again.");
  assert.equal(state.el.querySelector(".ask-error").textContent, "Try again.");
  Ask.retire(state);
  assert.ok([...state.el.querySelectorAll("button")].every((b) => b.disabled));
});
