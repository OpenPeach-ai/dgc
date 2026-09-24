// Every glyph codepoint must be the icon its comment claims.
//
// Seven of ten were not. `image` was `\eb47`, commented "file-media", and the font maps that to
// **rss** — a user saw an RSS icon beside a PNG. `doc` was `arrow-right` commented "book",
// `python` was `new-folder` commented "symbol-namespace", `lock` was `gist-private`.
//
// The table survived that way because it was DEAD CODE: a duplicate rule of equal specificity sat
// later in the file and won every cascade, so not one of these glyphs ever reached a screen. The
// comments were the only description of what they drew, and the comments were wrong. Fixing the
// cascade made a table of wrong icons visible for the first time.
//
// A comment is not a test. This reads the font's own metadata and compares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mainCss } from "./support/webview-dom.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

// codicon.css maps `.codicon-<name>:before { content: "\xxxx" }`. MANY NAMES SHARE A CODEPOINT --
// `zap` and `symbol-event` are both \ea86, `lock` and `mirror-private` are both \ea75 — so this
// collects every alias. Keeping only the last one made the first cut of this test report `zap` as
// wrong when it was right, and a test that cries wolf gets deleted by the next person.
function codiconNames() {
  const css = readFileSync(here + "../media/codicon.css", "utf8");
  const byCode = new Map();
  for (const m of css.matchAll(/\.codicon-([a-z0-9-]+):before\s*\{\s*content:\s*"\\([0-9a-f]{4})"/gi)) {
    const code = m[2].toLowerCase();
    if (!byCode.has(code)) byCode.set(code, new Set());
    byCode.get(code).add(m[1].toLowerCase());
  }
  return byCode;
}

// Rules of the form: ...::before { content: "\xxxx"; }  /* name */ — the comment must be on the
// SAME LINE as the closing brace, or a prose block comment further down gets read as the claim.
function commentedGlyphs(css) {
  const out = [];
  for (const line of css.split("\n")) {
    if (!/\[data-(?:file-kind|link-source)/.test(line)) continue;
    const code = /content:\s*"\\([0-9a-f]{4})"/i.exec(line);
    const claim = /\/\*\s*([^*]+?)\s*\*\/\s*$/.exec(line);
    if (code && claim) out.push({ code: code[1].toLowerCase(), claim: claim[1].trim() });
  }
  return out;
}

// The Seti glyphs come from a font this repo ships, so they are checked against the manifest
// recorded beside it — not against a VS Code install that may not exist on a CI box.
function setiCodepoints() {
  const manifest = JSON.parse(readFileSync(here + "../media/seti-codepoints.json", "utf8"));
  return manifest;
}

test("the codicon map is readable, or this test proves nothing", () => {
  assert.ok(existsSync(here + "../media/codicon.css"), "codicon.css should ship in media/");
  assert.ok(codiconNames().size > 300, "codicon.css should map hundreds of names");
});

test("every Seti glyph is the icon its comment names", () => {
  const { icons, font_sha256 } = setiCodepoints();
  assert.ok(existsSync(here + "../media/seti.woff"), "the Seti font must ship in media/");
  const bytes = readFileSync(here + "../media/seti.woff");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), font_sha256,
    "media/seti.woff does not match the manifest recorded beside it — regenerate both together");
  const wrong = [];
  for (const { code, claim } of commentedGlyphs(mainCss)) {
    const m = /^seti (_[a-z0-9-]+)$/.exec(claim);
    if (!m) continue;                                  // codicon rules are checked below
    const expected = icons[m[1]];
    if (!expected) wrong.push(`${m[1]} is not in the manifest`);
    else if (expected !== code) wrong.push(`${m[1]} is \\${expected} but main.css uses \\${code}`);
  }
  assert.deepEqual(wrong, [], "Seti codepoints must come from the manifest:\n  " + wrong.join("\n  "));
});

test("every commented codicon is the icon the comment names", () => {
  const byCode = codiconNames();
  const wrong = [];
  for (const { code, claim } of commentedGlyphs(mainCss)) {
    if (/^seti /.test(claim)) continue;                // Seti glyphs are checked above
    const aliases = byCode.get(code);
    if (!aliases) { wrong.push(`\\${code} is not in the bundled font (claimed "${claim}")`); continue; }
    // The comment may add prose around the name ("globe: the catch-all", "zap, the panel's own
    // mark", "no brand glyph; globe"). Any alias appearing in it is a match.
    const named = claim.toLowerCase();
    const ok = [...aliases].some((alias) => named.includes(alias)
      || alias.includes(named.split(/[;:,]/)[0].trim()));
    if (!ok) {
      wrong.push(`\\${code} is ${[...aliases].map((a) => `"${a}"`).join(" / ")}`
        + ` but the comment says "${claim}"`);
    }
  }
  assert.deepEqual(wrong, [],
    "a comment is not a test — these codepoints draw something else:\n  " + wrong.join("\n  "));
});

test("no two kinds silently share a glyph", () => {
  // `archive` and `npm` both used \eb29, so a .zip and an npm link were indistinguishable.
  const seen = new Map();
  for (const m of mainCss.matchAll(/\[data-file-kind="([a-z0-9-]+)"\]::before[^{]*\{[^}]*content:\s*"\\([0-9a-f]{4})"/gi)) {
    const [, kind, code] = m;
    if (!seen.has(code)) seen.set(code, []);
    seen.get(code).push(kind);
  }
  const shared = [...seen].filter(([, kinds]) => new Set(kinds).size > 1)
    .map(([code, kinds]) => `\\${code}: ${[...new Set(kinds)].join(", ")}`);
  // Deliberate groups (ts/js/code share one meaning) are fine; this catches ACCIDENTAL collisions
  // across unrelated kinds, so it reports rather than fails when a group is intentional.
  for (const line of shared) {
    const kinds = line.split(": ")[1].split(", ");
    const related = kinds.every((k) => ["ts", "js", "code", "json", "config", "css", "markup"].includes(k));
    assert.ok(related, `unrelated kinds share a glyph, so they are indistinguishable — ${line}`);
  }
});
