// The neutrals every page shares (0.52), in media/shared/tokens.css: hairlines, quiet words, the one filled pill, the
// corner scale and the row height are all taken from the editor's own text and grounds, so no page needs a grey of its
// own. Read two ways: the file's own definitions, and what they compute to in Chromium on the editor's default dark and
// light colours, where every quiet tone must still be readable (4.5:1) on the grounds it is used on.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOKENS_CSS } from "./support/stylesheet.mjs";
import { THEMES } from "./support/options-scene.mjs";

const tokens = readFileSync(TOKENS_CSS, "utf8");
const mainCss = readFileSync(new URL("../media/main.css", import.meta.url), "utf8");
const root = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("\n}\n", tokens.indexOf(":root {")));
const value = (name) => root.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim() ?? null;

test("hairlines are the text colour at 8, 12 and 5 per cent, and the two border tokens are those hairlines", () => {
  assert.equal(value("--hair"), "color-mix(in srgb, var(--text) 8%, transparent)");
  assert.equal(value("--hair-strong"), "color-mix(in srgb, var(--text) 12%, transparent)");
  assert.equal(value("--hair-faint"), "color-mix(in srgb, var(--text) 5%, transparent)");
  assert.equal(value("--border"), "var(--hair)");
  assert.equal(value("--border-strong"), "var(--hair-strong)");
});

test("quiet words are the text colour, thinned: second-level at 65%, faint at 68% (both 72% on a light ground)", () => {
  assert.equal(value("--text-2"), "color-mix(in srgb, var(--text) 65%, transparent)");
  assert.equal(value("--faint"), "color-mix(in srgb, var(--text) 68%, transparent)");
  const light = tokens.match(/body\.vscode-light, body\.vscode-high-contrast-light \{[^}]*--faint[^}]*\}/)?.[0] || "";
  assert.match(light, /--faint:\s*color-mix\(in srgb, var\(--text\) 72%, transparent\)/);
  assert.match(light, /--text-2:\s*color-mix\(in srgb, var\(--text\) 72%, transparent\)/);
});

test("the home's count ink and quiet tone are shared tokens now, not the home's own", () => {
  assert.equal(value("--home-count-ink"), "var(--text)");
  assert.equal(value("--home-quiet"), "var(--text-2)");
  assert.doesNotMatch(mainCss, /--home-(count-ink|quiet)\s*:/, "main.css only reads them");
});

test("one corner scale, one row height, and one filled pill in the text colour", () => {
  assert.deepEqual(["--r-sm", "--r-md", "--r-lg", "--r-xl", "--r-2xl", "--r-box"].map(value), ["7.5px", "10px", "12.5px", "15px", "20px", "6px"]);   // (the prompt box took the buttons' corner on 14 Nov; it was 22px)
  assert.equal(value("--row"), "29px");
  assert.equal(value("--solid"), "var(--text)");
  assert.equal(value("--accent-soft"), "color-mix(in srgb, var(--text) 8%, transparent)", "a count's soft pill is neutral");
});

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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

async function measure(theme) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><style>:root{${THEMES[theme]}}</style><style>${tokens}</style><body class="${theme.startsWith("light") ? "vscode-light" : theme === "hc" ? "vscode-high-contrast" : "vscode-dark"}"><div id="g"><span id="w">words</span></div></body>`);
  const out = await page.evaluate(() => {
    const g = document.getElementById("g"), w = document.getElementById("w");
    const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g).map(Number); return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
    const lum = (c) => { const [r, gg, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * gg + 0.0722 * b; };
    const ratio = (ink, ground) => { g.style.background = `var(${ground})`; w.style.color = `var(${ink})`;
      const under = parse(getComputedStyle(g).backgroundColor), top = parse(getComputedStyle(w).color);
      const c = top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])), [x, y] = [lum(c), lum(under)].sort((p, q) => q - p);
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
    const r = {};
    for (const ink of ["--faint", "--muted-firm", "--home-count-ink"]) for (const ground of ["--bg", "--surface", "--surface2"]) r[`${ink} on ${ground}`] = ratio(ink, ground);
    // (The muted grey is Codex's, for the page's own grounds; a raised ground takes --muted-firm: muted-grey.test.mjs.)
    for (const ground of ["--bg", "--surface"]) r[`--muted on ${ground}`] = ratio("--muted", ground);
    for (const ink of ["--text-2", "--home-quiet"]) for (const ground of ["--bg", "--surface"]) r[`${ink} on ${ground}`] = ratio(ink, ground);
    r["--on-solid on --solid"] = ratio("--on-solid", "--solid");
    r["--on-solid on --solid-hover"] = ratio("--on-solid", "--solid-hover");
    g.style.border = "1px solid var(--hair)";
    const hair = getComputedStyle(g).borderTopColor; g.style.border = "1px solid var(--border)";
    return { ratios: r, hair, border: getComputedStyle(g).borderTopColor };
  });
  await page.close();
  return out;
}

for (const theme of ["dark-modern", "light-modern"]) test(`every quiet tone reads at 4.5:1 on the grounds it is used on (${theme})`, async (t) => {
  if (skipOrFail(t)) return;
  const { ratios } = await measure(theme);
  assert.deepEqual(Object.entries(ratios).filter(([, v]) => v < 4.5), [], JSON.stringify(ratios));
});

test("high contrast keeps a line you can see: the hairline is the theme's own border there", async (t) => {
  if (skipOrFail(t)) return;
  const { hair, border } = await measure("hc");
  assert.deepEqual([hair, border], ["rgb(111, 195, 223)", "rgb(111, 195, 223)"], "the theme's border colour, not white at 8%: the hairline, and the border token made of it");
});
