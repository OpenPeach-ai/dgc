// The Pip report cards of a Work chat, polished (asked 13 Nov: "the Pips cards that come in work sessions needs UI
// polish, they do not look good ... better and cleaner"; he saw two Pips' cards with findings in a real project). In
// real Chromium on Work's real page, with the Pips' real faces and the real clock, dark, light and high contrast, at
// 300 and 700 px (media/main.js pipReportCard, media/main.css .pip-report):
//  - calm: severity is a small dot and a quiet word, what a Pip found is said in the card's own ink, never red bold;
//  - a narrow card reads down: the Pip's name whole, what it found, the worst finding in whole words, then Fix and Open;
//    nothing is cut mid-word, nothing overlaps, nothing leaves the card;
//  - opened: the findings are a short list (three, then "Show all 7"), each place a link; one filled answer, one quiet
//    one, and one Dismiss (the ✕ on the first line);
//  - answered: "Asked DGC" is a quiet line, not a greyed-out button; a fix's line has room for where the fix went
//    ("Fixed in your files · not committed", "Already fixed in your files"), with ✕ never alone on a row;
//  - two Pips' cards one after the other: the line that folds them keeps its words at 300 px.
// Pictures: node test/render-pip-cards.mjs <folder>.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "./support/agent-lines-scene.mjs";
import { openSheet, WHERE, ERP, GST } from "./support/pip-cards-polish-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

/** Every report card as it is drawn: its words, its marks, its buttons, and where each sits. */
const look = (page) => page.evaluate(() => {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (colour) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
  const chroma = (colour) => { const [r, g, b] = rgba(colour); return Math.max(r, g, b) - Math.min(r, g, b); };
  const alpha = (colour) => rgba(colour)[3] / 255;
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 0;
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const cut = (n) => n.scrollWidth > n.clientWidth + 0.5 || n.scrollHeight > n.clientHeight + 1.5;
  const said = (n) => (n.textContent || n.getAttribute("aria-label") || "").trim();
  const log = box(document.getElementById("log"));
  const cards = [...document.querySelectorAll("#log .pip-report:not(.is-fix-row)")].filter(seen).map((card) => {
    const c = box(card), q = (s) => [...card.querySelectorAll(s)].filter(seen);
    const words = (s) => q(s).map((n) => ({ text: said(n), cut: cut(n), weight: Number(getComputedStyle(n).fontWeight), chroma: chroma(getComputedStyle(n).color), lines: Math.round(n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).lineHeight)), ...box(n) }));
    const outside = q("button, a, time, .pip-report-chevron, .pip-report-line-name, .pip-report-line-state, .pip-report-line-what, .pip-report-state, .pip-report-title, .pip-report-sev, .pip-report-where, .pip-report-more")
      .filter((n) => { const b = box(n); return b.right > c.right + 0.5 || b.left < c.left - 0.5 || b.bottom > c.bottom + 0.5 || b.right > log.right + 0.5; }).map((n) => `${n.className} “${said(n)}”`);
    // Words that sit on top of each other or under the face.
    const blocks = q(".pip-report-face, .pip-report-line-name, .pip-report-line-state, .pip-report-line-what, .pip-report-head .pip-report-state, .pip-report-title, .pip-report-where, .pip-report-more, .pip-report-detail, button");
    const overlaps = [];
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      if (blocks[i].contains(blocks[j]) || blocks[j].contains(blocks[i])) continue;
      const a = box(blocks[i]), b = box(blocks[j]);
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(`${blocks[i].className} “${said(blocks[i]).slice(0, 24)}” over ${blocks[j].className} “${said(blocks[j]).slice(0, 24)}”`);
    }
    return { name: card._report?.name, outcome: card.dataset.outcome, shown: card.dataset.shown, quiet: card.classList.contains("quiet"), box: c, outside, overlaps,
      face: q(".pip-report-face").map(box)[0] || null,
      nameLine: words(".pip-report-line-name")[0] || null, stateLine: words(".pip-report-line-state")[0] || null, what: words(".pip-report-line-what")[0] || null,
      sentence: words(".pip-report-head .pip-report-state")[0] || null, titles: words(".pip-report-title"),
      places: q(".pip-report-where").map((n) => ({ text: said(n), role: n.getAttribute("role"), underline: getComputedStyle(n).textDecorationLine, chroma: chroma(getComputedStyle(n).color), cut: n.scrollWidth > n.clientWidth + 0.5, ...box(n) })),
      marks: q(".pip-report-sev").map((n) => { const s = getComputedStyle(n), d = getComputedStyle(n, "::before"); return { severity: n.dataset.severity, word: said(n), wordSeen: parseFloat(s.fontSize) > 0, weight: Number(s.fontWeight), chroma: chroma(s.color),
        dot: [parseFloat(d.width), parseFloat(d.height)], round: d.borderTopLeftRadius, dotChroma: chroma(d.backgroundColor), fill: alpha(s.backgroundColor), ...box(n) }; }),
      buttons: q("button").map((n) => { const s = getComputedStyle(n); return { word: said(n), cls: n.className, cut: n.scrollWidth > n.clientWidth + 0.5, filled: alpha(s.backgroundColor) > 0.5, line: parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0.02, radius: s.borderTopLeftRadius, chroma: chroma(s.color), disabled: n.disabled, ...box(n) }; }),
      findings: [...card.querySelectorAll(".pip-report-findings > li")].filter(seen).length };
  });
  const group = document.querySelector("#log .pip-report-group");
  return { cards, sideways: document.documentElement.scrollWidth > innerWidth || document.getElementById("log").scrollWidth > document.getElementById("log").clientWidth + 1,
    group: group ? { title: (() => { const t = group.querySelector(".pip-report-group-title"); return { text: said(t), cut: cut(t) }; })(), time: seen(group.querySelector(".pip-report-group-head time")),
      head: box(group.querySelector(".pip-report-group-head")), rows: [...group.querySelectorAll(":scope > .pip-report")].filter(seen).map(box) } : null,
    fixes: [...document.querySelectorAll("#log .pip-report.is-fix-row")].map((row) => { const text = row.querySelector(".pip-fix-text"), x = row.querySelector(".pip-fix-dismiss");
      return { text: said(text), cut: text.scrollWidth > text.clientWidth + 0.5, inside: box(text).right <= log.right + 0.5 && [...row.querySelectorAll("button")].filter(seen).every((b) => box(b).right <= log.right + 0.5),
        dismissTop: x ? Math.round(box(x).top + box(x).height / 2) : null, answers: [...row.querySelectorAll(".pip-fix-act")].filter(seen).map((b) => ({ word: said(b), mid: Math.round(box(b).top + box(b).height / 2) })) }; }) };
});
const list = (cards, field) => cards.flatMap((c) => c[field].map((x) => `${c.name}: ${x}`));
const GREY = 30;        // an ink with no hue of its own: the greys differ by a few levels a channel at most
const THEMES = ["dark-modern", "light-modern", "hc"];

for (const theme of THEMES) for (const width of [300, 700]) {
  test(`${theme} ${width}px, closed: a card is calm (a dot and quiet words, no red bold) and whole (no word cut, nothing over anything)`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openSheet(browser, "cards", { width, theme });
    try {
      const { cards, sideways } = await look(page);
      assert.deepEqual(cards.map((c) => c.outcome), ["findings", "findings", "failed", "clear", "clear"], "one finding, seven, a failure, a clean run, a fixed one");
      const needy = cards.filter((c) => !c.quiet);
      // Calm: what it found in the card's own ink; severity a 6 px dot with (where there is room) a quiet word.
      for (const c of needy) {
        assert.ok(c.stateLine.weight <= 500 && c.stateLine.chroma <= GREY, `${c.name}: “${c.stateLine.text}” is said in the card's ink, not red or bold (weight ${c.stateLine.weight}, chroma ${c.stateLine.chroma})`);
        const [mark] = c.marks;
        assert.deepEqual([mark.dot, mark.round, mark.fill < 0.02], [[6, 6], "50%", true], `${c.name}: severity is a small dot, never a slab`);
        assert.ok(mark.weight <= 500 && mark.chroma <= GREY, `${c.name}: its word “${mark.word}” is quiet (weight ${mark.weight}, chroma ${mark.chroma})`);
        assert.ok(mark.dotChroma >= 90, `${c.name}: the dot carries the colour (${mark.dotChroma})`);
        assert.equal(c.buttons.filter((b) => b.filled).length, 1, `${c.name}: one filled answer`);
        assert.deepEqual(c.buttons.map((b) => b.word), ["Dismiss", "Fix", "Open"], `${c.name}: ✕ on the first line, Fix and Open under it`);
      }
      // Whole: at 300 px the name has its own row (two lines at most) and nothing is shortened; at 700 a card is two lines.
      if (width === 300) for (const c of cards) {
        assert.deepEqual([c.nameLine.cut, c.nameLine.lines <= 2], [false, true], `${c.name}: the Pip's name reads whole`);
        assert.equal(c.stateLine.cut, false, `${c.name}: “${c.stateLine.text}” reads whole`);
        assert.ok(c.stateLine.top >= c.nameLine.bottom - 1, `${c.name}: what it found is the row under its name`);
        if (c.what) assert.deepEqual([c.what.cut, c.what.lines <= 2, c.what.top >= c.stateLine.bottom - 1], [false, true, true], `${c.name}: its worst finding in whole words, under that`);
        if (!c.quiet) assert.ok(Math.abs(c.face.top - c.nameLine.top) <= 4, `${c.name}: its face is beside its name`);
      } else for (const c of needy) {
        assert.ok(c.box.height <= 62, `${c.name}: two lines (${c.box.height}px)`);
        assert.equal(c.stateLine.cut, false);
        assert.ok(c.places.length === (c.outcome === "findings" ? 1 : 0) && c.places.every((p) => p.width >= 40), `${c.name}: the finding's place is on its line`);
      }
      assert.deepEqual(list(cards, "outside"), [], "nothing leaves its card");
      assert.deepEqual(list(cards, "overlaps"), [], "nothing sits on anything");
      assert.deepEqual(cards.flatMap((c) => c.buttons.filter((b) => b.cut).map((b) => `${c.name}: ${b.word}`)), [], "no button's word is cut");
      assert.equal(sideways, false, "nothing runs off the side");
    } finally { await page.close(); }
  });

  test(`${theme} ${width}px, opened: a short list of findings with each place a link, Show all 7, one filled answer and one Dismiss`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openSheet(browser, "opened", { width, theme });
    try {
      let { cards, sideways } = await look(page);
      assert.ok(cards.every((c) => c.shown === "open"));
      const [one, seven, failed, clear, fixed] = cards;
      assert.deepEqual([one.findings, seven.findings], [1, 3], "three findings in sight at most");
      for (const c of [one, seven]) {
        assert.deepEqual(c.titles.filter((x) => x.cut).map((x) => x.text), [], `${c.name}: each finding reads whole`);
        assert.deepEqual(c.places.map((p) => [p.role, p.underline, p.cut, p.chroma <= GREY]), c.places.map(() => ["link", "underline", false, true]), `${c.name}: each place is a quiet link, whole`);
        for (const [i, title] of c.titles.entries()) {
          const mark = c.marks[i], place = c.places[i];
          assert.deepEqual([mark.dot, mark.wordSeen, mark.weight <= 500, mark.chroma <= GREY], [[6, 6], true, true, true], `${c.name}: “${mark.word}” is a dot and a quiet word`);
          if (width === 300) assert.ok(mark.top >= title.bottom - 1 && place.top >= title.bottom - 1 && place.left > mark.right, `${c.name}: in a narrow card the finding reads first, its mark and place under it`);
          else assert.ok(Math.abs(mark.top - title.top) <= 6 && place.left >= title.right - 1 && mark.right <= title.left + 1, `${c.name}: with room, mark, finding and place are one row`);
        }
      }
      for (const c of [one, seven, failed]) {
        assert.deepEqual(c.buttons.filter((b) => !/link/.test(b.cls)).map((b) => [b.word, b.filled]), [["Dismiss", false], ["Ask DGC to fix", true], ["Open report", false]], `${c.name}: one filled answer, one quiet one, and ✕`);
        const [, fix, open] = c.buttons.filter((b) => !/link/.test(b.cls));
        assert.ok(Math.abs(fix.top - open.top) <= 1, `${c.name}: its two answers share a row at ${width}px`);
      }
      for (const c of [clear, fixed]) assert.equal(c.buttons.filter((b) => b.word === "Dismiss").length, 1, `${c.name}: one Dismiss`);
      assert.match(fixed.sentence.text, /^fixed · nothing found$/);
      const all = seven.buttons.find((b) => /pip-report-all/.test(b.cls));
      assert.deepEqual([all.word, all.radius, all.filled, all.cut], ["Show all 7", "6px", false, false], "the rest are behind a small outline button");
      assert.deepEqual(list(cards, "outside"), []);
      assert.deepEqual(list(cards, "overlaps"), [], "nothing sits on anything, a clean card's face included");
      // All seven, in the card: still whole, still inside.
      await page.click("#log .pip-report .pip-report-all"); await settle(page);
      ({ cards, sideways } = await look(page));
      assert.deepEqual([cards[1].findings, cards[1].buttons.find((b) => /pip-report-all/.test(b.cls)).word, cards[1].shown], [7, "Show fewer", "open"]);
      assert.deepEqual(cards[1].marks.map((m) => m.severity), ["critical", "high", "high", "medium", "medium", "medium", "low"]);
      assert.deepEqual([list(cards, "outside"), list(cards, "overlaps"), cards[1].titles.filter((x) => x.cut).length, sideways], [[], [], 0, false]);
    } finally { await page.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: a card that was asked about says so in a quiet line, not a greyed-out button`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openSheet(browser, "asked", { width, theme });
    try {
      const { cards } = await look(page);
      const asked = cards[0].buttons.find((b) => b.word === "Asked DGC");
      assert.ok(asked?.disabled, "Fix became “Asked DGC”");
      assert.deepEqual([asked.filled, asked.line, asked.chroma <= GREY, asked.cut], [false, false, true, false], "plain quiet words: no fill, no box");
      assert.equal(cards[0].buttons.filter((b) => b.filled).length, 0, "an answered card has no filled button left");
      assert.equal(cards[1].buttons.filter((b) => b.filled).length, 1, "the other Pip's card keeps its Fix");
      assert.deepEqual([list(cards, "outside"), list(cards, "overlaps")], [[], []]);
    } finally { await page.close(); }
  });

  test(`${theme} ${width}px: two Pips' cards one after the other fold into a line that keeps its words; opened, each is whole`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openSheet(browser, "two", { width, theme });
    try {
      let seen = await look(page);
      assert.deepEqual([seen.group.title.text, seen.group.title.cut], ["2 Pip reports · 11 findings", false], "the line reads whole");
      assert.equal(seen.group.time, width > 400, "its time gives way in a narrow side bar");
      await page.click("#log .pip-report-group-head"); await settle(page);
      seen = await look(page);
      assert.deepEqual(seen.cards.map((c) => c.name), [ERP, GST]);
      assert.ok(seen.group.rows[0].top >= seen.group.head.bottom - 1 && seen.group.rows[1].top >= seen.group.rows[0].bottom - 1, "rows one under another");
      assert.deepEqual([list(seen.cards, "outside"), list(seen.cards, "overlaps"), seen.sideways], [[], [], false]);
      if (width === 300) for (const c of seen.cards) assert.deepEqual([c.nameLine.cut, c.stateLine.cut, c.what.cut], [false, false, false], `${c.name}: whole inside the group too`);
    } finally { await page.close(); }
  });

  // Asked 13 Nov, from a real project: "Fixed · 4 files changed" was applied to the files and never committed, and the
  // Pip reported the same findings the next day. The fix's line must have room to say where a fix went. DGC does not send
  // those states yet, so the two lines are written into a finished fix's row and what is held is the room for them.
  test(`${theme} ${width}px: a fix's line has room for where the fix went, and ✕ is never alone on a row`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openSheet(browser, "fixed-where", { width, theme });
    try {
      const { fixes, sideways } = await look(page);
      assert.deepEqual(fixes.map((f) => [f.text, f.cut, f.inside]), WHERE.map((words) => [words, false, true]), "both lines read whole, inside the panel");
      for (const f of fixes) assert.ok(f.answers.some((a) => Math.abs(a.mid - f.dismissTop) <= 3), `“${f.text}”: ✕ sits with the row's answers (${JSON.stringify(f.answers)}, ✕ at ${f.dismissTop})`);
      assert.equal(sideways, false);
    } finally { await page.close(); }
  });
}
