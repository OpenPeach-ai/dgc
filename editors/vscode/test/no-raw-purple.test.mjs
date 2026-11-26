import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readStylesheet, TOKENS_CSS } from "./support/stylesheet.mjs";

// One purple, one place (0.52, UI step 1). Purple did nine jobs on one screen, and Pips had typed in a second purple of
// its own (#6D49E8) next to the panel's. Now every colour token lives in media/shared/tokens.css, every page loads that
// file, and a purple typed anywhere else fails here. A colour that is content, not the brand (a project's chosen colour,
// code highlighting, a chart's series, a Pip character's own tint, the Pips wordmark), is named below with its reason.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = relative(root, TOKENS_CSS);
const read = (rel) => readFileSync(join(root, rel), "utf8");

// Every top-level await comes before the first test(): a test declared before one can let the runner reach after()
// and close the browser early.
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};


function walk(dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(css|js|mjs|ts)$/.test(name)) out.push(rel);
  }
  return out;
}

// Purple: a hue between blue-violet and magenta, saturated enough to read as colour, neither near-black nor near-white.
function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}
const isPurple = (r, g, b) => { const { h, s, l } = hsl(r, g, b); return h >= 245 && h <= 295 && s > 0.35 && l > 0.15 && l < 0.9; };

const COLOUR = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi;
const blankComments = (text, js) => text.replace(js ? /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g : /\/\*[\s\S]*?\*\//g,
  (m, lead = "") => lead + m.slice(lead.length).replace(/[^\n]/g, " "));

/** Every purple literal in a file's text, each with the rule's selector and the declaration it sits in. */
export function purplesIn(text, { js = false } = {}) {
  const src = blankComments(text, js), found = [];
  for (const m of src.matchAll(COLOUR)) {
    let rgb;
    if (m[1]) {
      const hex = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join("") : m[1].slice(0, 6);
      rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    } else rgb = [m[2], m[3], m[4]].map(Number);
    if (!isPurple(...rgb)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    let where;
    if (js) where = src.split("\n")[line - 1].trim();
    else {
      // The innermost open rule: walk back over balanced braces to the "{" that opened it.
      let depth = 0, i = m.index;
      for (; i >= 0; i--) { if (src[i] === "}") depth++; else if (src[i] === "{") { if (!depth) break; depth--; } }
      const start = Math.max(src.lastIndexOf("}", i - 1), src.lastIndexOf("{", i - 1), src.lastIndexOf(";", i - 1)) + 1;
      const selector = src.slice(start, i).trim().replace(/\s+/g, " ");
      const declStart = Math.max(src.lastIndexOf(";", m.index), src.lastIndexOf("{", m.index)) + 1;
      where = `${selector} { ${src.slice(declStart, m.index + m[0].length).trim().replace(/\s+/g, " ")}`;
    }
    found.push({ colour: m[0], line, where });
  }
  return found;
}

// Content colours: each is a palette of its own, not the brand's accent. File, then what its rule or line says.
const CONTENT = [
  ["media/main.css", /\.project-icon\[data-color="purple"\]/, "a project's own colour, the one its owner picked"],
  ["media/main.css", /\.agent-mark\[data-mark="3"\]/, "the agent marks' identity palette, one hue per agent"],
  ["media/main.css", /\.hljs-/, "code highlighting"],
  ["src/pipsTranscript.css", /\.hljs-/, "code highlighting"],
  ["media/main.css", /\.bd \[data-id="files"\]/, "the context breakdown's chart, one hue per kind"],
  ["media/chatdgc.css", /\.cd-chart-c3/, "a chart's third series"],
  ["src/pips.css", /\.layout\.overview \.job.*--pip-tint/, "each Pip character's own tint"],
  ["src/pips.css", /\.usage-bar \{ fill:var\(--vscode-charts-purple/, "the usage chart, in the theme's own chart purple"],
  ["src/settings.css", /--usage-output/, "the usage chart's output series"],
  ["media/pips/wordmark.css", /./, "the Pips wordmark, which is artwork"],
  ["media/main.js", /TROUPE_TILES/, "the agent faces' colours in the troupe mark"],
  ["media/main.js", /^\[12\.6, 12\.6, \[|^\[2, 12\.6, \[/, "the agent faces' colours in the troupe mark"],
  ["src/pipProfile.js", /'lilac', 'Lilac'/, "a Pip's profile colour choice"],
  // The model picker's rail: a connection wears its company's mark, in that company's own colour (media/shared/modelpicker.js).
  ["media/shared/modelpicker.js", /^(qwen|lmstudio|together|gemini): `</, "a provider's own logo, in its company's colours"],
  // The maintainer's Library icon (Iris): the maintainer's own stylesheet, shipped byte for byte (library-iris-browser.test.mjs), its shades and all.
  ["media/icons/library-iris/library.css", /\.library-iris/, "the Library icon's own drawing, as made"],
  ["media/shared/modelpicker.js", /^\["#a78bfa"/, "the Thinking slider's moving picture: its reference's own palette (artwork; the no-WebGL gradient takes the same colours from the tokens, --effort-*)"],
];
const isContent = (file, where) => CONTENT.some(([f, re]) => f === file && re.test(where));

test("the scanner catches a stray purple in every spelling, and skips comments and other hues", () => {
  const caught = purplesIn(`.a { color: #7c5cff; } .b { border: 1px solid rgba(124, 92, 255, .3); }
    .c { background: rgb(124 92 255 / 40%); } .d { color: #a8f; } /* #7C5CFF in a comment */
    .e { color: #3B82F6; } .f { color: #E5484D; } .g { color: #fff; } .h { fill: #1a1a1f; }`);
  assert.deepEqual(caught.map((c) => c.where.split(" {")[0]), [".a", ".b", ".c", ".d"]);
  assert.match(caught[1].where, /^\.b \{ border: 1px solid rgba\(124, 92, 255/);
  assert.equal(purplesIn("const tint = '#6D49E8'; // #7C5CFF\n", { js: true }).length, 1);
});

test("no raw purple anywhere but the tokens file", () => {
  const files = [...walk("media"), ...walk("src")].filter((f) => f !== TOKENS && !/codicon|seti/.test(f));
  const stray = [];
  for (const file of files) {
    for (const p of purplesIn(read(file), { js: !file.endsWith(".css") })) {
      if (!isContent(file, p.where)) stray.push(`${file}:${p.line} ${p.colour} in ${p.where.slice(0, 140)}`);
    }
  }
  assert.deepEqual(stray, [], "use a token from media/shared/tokens.css (--accent, --accent-fill, --accent-text, --link, …)");
});

test("every page loads the tokens file first", () => {
  assert.ok(existsSync(TOKENS_CSS), "media/shared/tokens.css holds every token");
  // Work, ChatDGC and the artifact pages load main.css; its first rule brings the tokens.
  assert.match(read("media/main.css"), /^(?:\/\*[\s\S]*?\*\/\s*)*@import url\("\.\/shared\/tokens\.css"\);/,
    "main.css starts with the tokens");
  for (const page of ["src/artifacts.ts", "src/chatdgc.ts", "src/panel.ts"]) {
    assert.match(read(page), /media", "main\.css"|media\/main\.css|"main\.css"/, `${page} loads main.css`);
  }
  // Pips, Settings and a Pip's computer are bundles: the tokens are their first stylesheet.
  for (const client of ["src/pipsClient.js", "src/settingsClient.js", "src/pipComputerClient.js"]) {
    const first = read(client).match(/^import\s+['"]([^'"]+\.css)['"]/m)?.[1];
    assert.equal(first, "../media/shared/tokens.css", `${client} imports the tokens before any other stylesheet`);
  }
  assert.match(read("media/canvas.css"), /^(?:\/\*[\s\S]*?\*\/\s*)*@import url\("\.\/shared\/tokens\.css"\);/,
    "the canvas starts with the tokens");
});

test("no page keeps its own copy of the brand tokens, and Pips use the panel's purple", () => {
  const BRAND = /(^|[;{\s])--(accent|accent-text|accent-fill|accent-hover|accent-soft|link|ring|lav)\s*:/;
  const copies = [];
  for (const file of [...walk("media"), ...walk("src")].filter((f) => f.endsWith(".css") && f !== TOKENS)) {
    const src = blankComments(read(file));
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (BRAND.test(m[2]) && !/forced-colors/.test(m[1])) copies.push(`${file}: ${m[1].trim().slice(-60)}`);
    }
  }
  assert.deepEqual(copies, [], "the brand tokens are defined once, in media/shared/tokens.css");
  const pips = blankComments(read("src/pips.css"));
  assert.match(pips, /--pip-accent:var\(--accent-fill\)/, "a Pip's button is the panel's fill");
  assert.match(pips, /--pip-accent-hover:var\(--accent-hover\)/);
});

// The theme a page follows, measured in Chromium: the tokens are what the editor's dark, light and high-contrast
// themes make of them, inside Work's page, a Pip's own tab, and a Pip embedded in Work's side bar (a shadow root).
const THEMES = {
  "vscode-dark": "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-textLink-foreground:#4daafc;--vscode-focusBorder:#0078d4",
  "vscode-light": "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-textLink-foreground:#005fb8;--vscode-focusBorder:#005fb8",
  "vscode-high-contrast": "--vscode-editor-background:#000000;--vscode-sideBar-background:#000000;--vscode-foreground:#ffffff;--vscode-textLink-foreground:#21a6ff;--vscode-focusBorder:#f38518",
  "vscode-high-contrast-light": "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#ffffff;--vscode-foreground:#292929;--vscode-textLink-foreground:#0f4a85;--vscode-focusBorder:#006bbd",
};
const PIP_BOX = `<div class="pip-app-root"><button class="primary" id="pip-primary">New Pip</button></div>`;
const PROBE = `(() => {
  // Read where the Pip's button sits when there is one (inside the shadow root, for a Pip in Work's side bar).
  const button = (document.querySelector("#host")?.shadowRoot || document).querySelector("#pip-primary");
  const at = button || document.body, css = getComputedStyle(at), v = (n) => css.getPropertyValue(n).trim();
  const swatch = (value, prop = "color") => { const s = document.createElement("i"); s.style[prop] = value;
    at.parentNode.append(s); const c = getComputedStyle(s)[prop]; s.remove(); return c; };
  return { link: swatch(v("--link")), accentText: swatch(v("--accent-text")), accentFill: swatch(v("--accent-fill")),
           lift: swatch(v("--lift-1"), "boxShadow"), solid: swatch(v("--solid")), primary: button && getComputedStyle(button).backgroundColor };
})()`;
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

async function measure(theme, how) {
  const page = await browser.newPage();
  try {
    const tokens = readStylesheet(TOKENS_CSS), main = readStylesheet(join(root, "media/main.css"));
    const pips = tokens + readStylesheet(join(root, "src/pips.css"));
    const body = `<body class="${theme}" style="${THEMES[theme]}">`;
    if (how === "work") await page.setContent(`<style>${main}</style>${body}</body>`);
    if (how === "pip tab") await page.setContent(`<style>${pips}</style><body class="${theme} pip-app-root" style="${THEMES[theme]}">${PIP_BOX}</body>`);
    if (how === "pip in work") {
      await page.setContent(`<style>${main}</style>${body}<section id="host"></section></body>`);
      // As media/main.js mounts Pips: a shadow root that adopts the Pips bundle, whose :root rules match nothing there.
      await page.evaluate(([css, box]) => {
        const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
        const sheet = new CSSStyleSheet(); sheet.replaceSync(css.replace(/@import[^;]*;/g, ""));
        shadow.adoptedStyleSheets = [sheet]; shadow.innerHTML = box;
      }, [pips, PIP_BOX]);
    }
    return await page.evaluate(PROBE);
  } finally { await page.close(); }
}

test("the tokens follow the editor's dark, light and high-contrast themes", async (t) => {
  if (skipOrFail(t)) return;
  const dark = await measure("vscode-dark", "work"), light = await measure("vscode-light", "work");
  assert.equal(dark.link, rgb("#A78BFA")); assert.equal(dark.accentText, rgb("#A78BFA"));
  assert.equal(light.link, rgb("#6D49E8"));
  assert.equal(light.accentText, rgb("#6D49E8"), "accent text on a light ground takes the deeper step (it read 2.6:1)");
  assert.equal(dark.accentFill, rgb("#7654F6")); assert.equal(light.accentFill, rgb("#7654F6"));
  // A menu's lift (0.52): a half-pixel ring of the text colour and one low shadow, the same on dark and light.
  for (const lift of [dark.lift, light.lift]) { assert.match(lift, /0px 0px 0px 0\.5px/); assert.match(lift, /rgba\(0, 0, 0, 0\.12\) 0px 8px 16px -4px/); }
  const hc = await measure("vscode-high-contrast", "work"), hcLight = await measure("vscode-high-contrast-light", "work");
  assert.equal(hc.link, rgb("#A78BFA"), "high contrast dark keeps the pale purple, 7.6:1 on its black");
  assert.equal(hcLight.link, rgb("#6D49E8"), "on high-contrast light the pale purple read 2.6:1");
  assert.equal(hcLight.accentText, rgb("#6D49E8"));
});

test("a Pip's main button is the panel's one filled pill, the text colour, in its own tab and inside Work's side bar", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["vscode-dark", "vscode-light"]) {
    for (const how of ["pip tab", "pip in work"]) {
      const got = await measure(theme, how);
      assert.equal(got.primary, got.solid, `${how}, ${theme}: a Pip's main button is the shared fill of the text colour (0.52), not a purple of Pips' own`);
      assert.notEqual(got.primary, rgb("#7654F6"), "purple is Send's alone");
      assert.equal(got.link, rgb(theme === "vscode-light" ? "#6D49E8" : "#A78BFA"), `${how}, ${theme}: links follow the theme`);
    }
  }
});
