// A link is body text, so it has to be comfortable to read on both grounds.
//
// It was not. `--accent` (#7C5CFF) is a saturated mid-tone that scores 4.08:1 on the panel's dark
// ground and 4.09:1 on its light one -- below the 4.5:1 this codebase already enforces for card
// text -- so it failed AA on BOTH themes at once. The founder described it as hurting the eyes,
// which is what reading sub-threshold text for an hour feels like.
//
// No single purple fixes it: a tone light enough for the dark ground (#A78BFA, 6.5:1) collapses to
// 2.6:1 on the light one. So the link tone follows the theme, and this file holds both ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, mainCss } from "./support/webview-dom.mjs";

const AA = 4.5;

// The grounds a link is actually read on. DGC's own fallbacks plus the stock VS Code themes,
// because the panel takes its background from the editor and most users never change it.
const DARK = { "DGC fallback": "#181819", "Dark Modern": "#181818", "Dark+": "#252526" };
const LIGHT = { "Light Modern": "#F8F8F8", "Light+": "#F3F3F3", "white": "#FFFFFF" };

function token(name, scope = ":root") {
  const block = new RegExp(`${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  for (const m of mainCss.matchAll(block)) {
    const hit = new RegExp(`--${name}\\s*:\\s*(#[0-9a-f]{6})`, "i").exec(m[1]);
    if (hit) return hit[1];
  }
  return null;
}

test("the link tone clears AA on every dark ground", () => {
  const dark = token("link");
  assert.ok(dark, "--link should be defined on :root as a literal hex");
  for (const [name, bg] of Object.entries(DARK)) {
    const ratio = contrastRatio(dark, bg);
    assert.ok(ratio >= AA, `${dark} on ${name} ${bg} is ${ratio.toFixed(2)}:1, under ${AA}`);
  }
});

test("the link tone clears AA on every light ground", () => {
  const light = token("link", "body.vscode-light");
  assert.ok(light, "body.vscode-light should redefine --link, or light users read the dark tone");
  for (const [name, bg] of Object.entries(LIGHT)) {
    const ratio = contrastRatio(light, bg);
    assert.ok(ratio >= AA, `${light} on ${name} ${bg} is ${ratio.toFixed(2)}:1, under ${AA}`);
  }
});

test("the two tones are genuinely different", () => {
  // If a refactor collapses them back to one value, one theme silently drops below AA again.
  assert.notEqual(token("link"), token("link", "body.vscode-light"),
    "one purple cannot serve both grounds — that is the bug this token exists to fix");
});

test("links do not fall back to the accent that failed", () => {
  // --accent is right for buttons and fills, where it sits on its own solid ground. It is wrong
  // for text on the panel background, which is the whole point of a separate token.
  const accent = token("accent");
  assert.ok(accent, "--accent should still exist for buttons and fills");
  const worst = Math.min(...Object.values({ ...DARK, ...LIGHT })
    .map((bg) => contrastRatio(accent, bg)));
  assert.ok(worst < AA,
    "if --accent now clears AA everywhere, re-check whether --link is still needed");
  const rule = /\.md-link \{([^}]*)\}/.exec(mainCss);
  assert.ok(rule, "the base .md-link rule should exist");
  assert.match(rule[1], /color:\s*var\(--link\)/,
    "link text must use --link, not the accent it was moved off");
});

test("forced-colors hands links back to the system", () => {
  const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n  \}/.exec(mainCss);
  assert.ok(forced, "the forced-colors block should exist");
  assert.match(forced[1], /--link\s*:\s*LinkText/,
    "in high contrast the user's own LinkText wins over any hex we picked");
});
