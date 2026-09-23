// The per-kind file marks must actually reach the screen.
//
// They did not. `.md-link[data-link-kind="file"]::before` duplicated the `[data-file-kind]`
// block, carried the SAME specificity (one class + one attribute + one pseudo-element), and sat
// later in the file -- so it won every cascade and every file link drew one generic grey glyph.
// A .py, a .sh and a .json were indistinguishable, and the whole kind table was dead code.
//
// Nothing caught it because the classification was right: the DOM said data-file-kind="python",
// the tests asserted data-file-kind="python", and only a rendered pixel disagreed. A real VS Code
// capture is what found it.
//
// jsdom cannot cascade pseudo-element content, so this reads the stylesheet directly: among the
// rules that match a file link and set `content`, the one that wins must be a per-kind rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mainCss } from "./support/webview-dom.mjs";

const markdownSrc = readFileSync(
  fileURLToPath(new URL("../src/markdown.ts", import.meta.url)), "utf8");

// Every top-level ruleset in source order, as {selector, body}. A brace-depth scan rather than a
// regex, because main.css nests rules inside @media and a naive match reads `@media (...) {` as a
// selector and the rules inside it as garbage -- which is why the first cut of this test found
// nothing at all and "passed" its way to a false negative.
function rules(css, top = true) {
  // Comments sit between rules, so without stripping them the "selector" is everything since the
  // last brace -- comment prose included -- and no selector ever compares equal.
  if (top) css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let depth = 0, start = 0, selector = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      if (depth === 0) { selector = css.slice(start, i).trim(); start = i + 1; }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const body = css.slice(start, i);
        // An at-rule's braces hold further rules, so recurse instead of treating it as one.
        if (selector.startsWith("@")) out.push(...rules(body, false));
        // A comma list is several rules sharing a body (ts, js and code share one glyph), so
        // split it -- otherwise only the first selector in the group is ever considered.
        else if (selector) {
          for (const one of splitGroup(selector)) out.push({ selector: one, body });
        }
        start = i + 1;
      }
    }
  }
  return out;
}

// Split a selector group on its TOP-LEVEL commas only. A naive split tears `:is(a, b)` in half,
// which silently turns "no rule matches this kind" into a test failure with a misleading message.
function splitGroup(selector) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { out.push(selector.slice(start, i).trim()); start = i + 1; }
  }
  const last = selector.slice(start).trim();
  if (last) out.push(last);
  return out.filter(Boolean);
}

// (classes+attributes, elements+pseudo-elements) — enough to order these selectors correctly.
// `:is(...)` takes the specificity of its MOST SPECIFIC argument, not the sum of all of them
// (CSS Selectors 4). Counting every branch inflates a shared rule and makes this model disagree
// with the browser about which rule wins — the one thing this file exists to get right.
function specificity(selector) {
  let rest = selector, b = 0;
  for (const m of selector.matchAll(/:is\(([^)]*)\)/g)) {
    b += Math.max(...splitGroup(m[1]).map((branch) =>
      (branch.match(/\.[\w-]+|\[[^\]]+\]/g) || []).length));
    rest = rest.replace(m[0], "");
  }
  b += (rest.match(/\.[\w-]+|\[[^\]]+\]/g) || []).length;
  const c = (rest.match(/::[\w-]+/g) || []).length;
  return b * 10 + c;
}

// Does this selector match an element of `surface` carrying data-file-kind="<kind>"?
// Two surfaces wear the mark: a file link in an answer, and a chip for a file the model produced.
// They are checked SEPARATELY because the table was once scoped to `.md-link` alone, which left
// every produced-file chip with spacing and no glyph at all — and an attribute assertion could
// not see it, because the attribute was always correct.
const SURFACES = {
  link: { classes: ["md-link"], attrs: { "data-link-kind": "file" } },
  chip: { classes: ["chip", "made-file"], attrs: {} },
};

function matchesFileLink(selector, kind, surface = "link") {
  if (!selector.includes("::before")) return false;
  let head = selector.slice(0, selector.indexOf("::before")).trim();
  const { classes, attrs } = SURFACES[surface];
  // `:is(a, b)` matches when any branch does; expand it against this surface's classes.
  const is = /^:is\(([^)]*)\)/.exec(head);
  if (is) {
    const branch = is[1].split(",").map((b) => b.trim())
      .find((b) => b.replace(/^\./, "").split(".").every((c) => classes.includes(c)));
    if (!branch) return false;
    head = head.slice(is[0].length);
  } else {
    const lead = /^((?:\.[\w-]+)+)/.exec(head);
    if (!lead) return false;
    if (!lead[1].slice(1).split(".").every((c) => classes.includes(c))) return false;
    head = head.slice(lead[1].length);
  }
  head = "x" + head;   // keep the attribute scan below unchanged
  const present = { "data-file-kind": kind, ...SURFACES[surface].attrs };
  const found = head.match(/\[[^\]]+\]/g) || [];
  return found.every((attr) => {
    const exact = /^\[([\w-]+)="([^"]*)"\]$/.exec(attr);
    if (exact) return present[exact[1]] === exact[2];
    const bare = /^\[([\w-]+)\]$/.exec(attr);
    return bare ? bare[1] in present : false;
  });
}

const KINDS = ["python", "ts", "js", "json", "config", "doc", "css", "markup",
               "shell", "image", "database", "archive", "lock", "folder", "code",
               // what fileKind() returns for anything it does not recognise -- Makefile,
               // LICENSE -- and which only the bare [data-file-kind] rule covers
               "file"];

test("each file kind's own glyph is the one that wins", () => {
  winnerCheck("link");
});

test("a produced-file chip draws the same mark, not a blank space", () => {
  // The bug this catches shipped for real: the kind table was scoped to `.md-link`, so a chip got
  // `vertical-align` and `margin-right` and NO content — an empty gap where its mark should be.
  // `chip.dataset.fileKind` was "python" throughout, so the attribute test passed.
  winnerCheck("chip");
});

function winnerCheck(surface) {
  const all = rules(mainCss);
  for (const kind of KINDS) {
    const candidates = all
      .map((r, index) => ({ ...r, index }))
      .filter((r) => matchesFileLink(r.selector, kind, surface) && /(^|[;{\s])content\s*:/.test(r.body));
    assert.ok(candidates.length,
      `no ::before content rule matches a ${kind} ${surface} at all — it would render blank`);
    // Highest specificity wins; ties break on source order, last one wins.
    const winner = candidates.reduce((best, r) =>
      specificity(r.selector) > specificity(best.selector) ? r
      : specificity(r.selector) < specificity(best.selector) ? best
      : (r.index > best.index ? r : best));
    // "file" is the catch-all: its glyph legitimately comes from the bare attribute rule, because
    // it is what every unrecognised extension falls back to. Every other kind must win with its own.
    const expected = kind === "file"
      ? /\[data-file-kind\]/
      : new RegExp(`data-file-kind="${kind}"`);
    assert.match(winner.selector, expected,
      `a ${kind} ${surface} would draw the glyph from \`${winner.selector}\` instead of its own — `
      + "a later rule of equal specificity is clobbering the kind table");
  }
}

test("a mark takes the same tone as the link it sits beside", () => {
  // --link, not --accent: the mark is read at body size on the panel background, so it needs the
  // theme-aware tone that clears AA there (see link-contrast.test.mjs). A grey mark beside
  // coloured link text also reads as disabled rather than deliberate.
  for (const selector of [":is(.md-link, .chip.made-file)[data-file-kind]::before",
                          ".md-link[data-link-source]::before"]) {
    const rule = rules(mainCss).find((r) => r.selector === selector);
    assert.ok(rule, `${selector} should exist`);
    assert.match(rule.body, /color:\s*var\(--link\)/, `${selector} should take the link tone`);
  }
});


test("a link carries no rule at rest, and gains one on hover and on focus", () => {
  const all = rules(mainCss);
  const rest = all.find((r) => r.selector === ".md-link");
  assert.ok(rest, "the base .md-link rule should exist");
  assert.match(rest.body, /text-decoration:\s*none/,
    "a permanent underline under every path turns a paragraph into a ladder of lines");
  const lift = all.filter((r) => /^\.md-link:(hover|focus-visible)$/.test(r.selector.trim())
                              || /\.md-link:hover/.test(r.selector));
  assert.ok(lift.some((r) => /text-decoration:\s*underline/.test(r.body)),
    "hover must still confirm what is about to open");
  assert.ok(lift.some((r) => r.selector.includes("focus-visible")),
    "a keyboard user gets the same confirmation as a mouse user, or the rule is decoration");
});

test("no link is identified by colour alone", () => {
  // With the resting underline gone, the mark beside a link is the only non-colour signal that it
  // IS a link. Every link must therefore have one: a favicon, a bundled source glyph, or a file
  // kind glyph. If a future link type renders bare, colour becomes the sole cue and the panel
  // fails WCAG 1.4.1 for anyone who cannot rely on it.
  const all = rules(mainCss);
  const marked = (attr) => all.some((r) => r.selector.includes(`[${attr}`)
                                        && r.selector.includes("::before")
                                        && /(^|[;{\s])content\s*:/.test(r.body));
  // Assert the CATCH-ALLS, not merely that some rule somewhere draws something: an unrecognised
  // host and an unrecognised extension are the cases that would silently render bare.
  const hasContent = (selector) => {
    const r = all.find((rule) => rule.selector === selector);
    return !!r && /(^|[;{\s])content\s*:/.test(r.body);
  };
  assert.ok(hasContent('.md-link[data-link-source="web"]::before'),
    "a host with no bundled mark falls back to web — it must draw something");
  assert.ok(hasContent(":is(.md-link, .chip.made-file)[data-file-kind]::before"),
    "an extension with no rule of its own falls back to this — it must draw something");
  // markdown.ts emits exactly these two link kinds, so those two rules cover every link there is.
  const kinds = [...markdownSrc.matchAll(/data-link-kind="(\$\{[^}]*\}|[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(kinds)].sort(), ["${target.kind}", "external"],
    "a new link kind would need its own mark before it may ship unmarked");
});
