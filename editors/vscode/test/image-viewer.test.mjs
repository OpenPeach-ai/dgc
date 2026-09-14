import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// Model-viewed images, laid out for real: chips in a narrow card scroll inside their row and keep
// their focus ring, the viewer fits every control on screen (a 220px bottom-docked panel included),
// fits a 1280x757 screenshot and shows it at 1280 CSS px on request, holds Tab inside itself, keeps
// its bar readable in dark and light, and an image arriving by ref does not move the transcript.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, html, mainJs, markdownJs;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};

const THEMES = {
  dark: "",
  light: `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF;
    --vscode-panel-border:#E5E5E5; --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE;
    --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F; --vscode-descriptionForeground:#616161;
    --vscode-disabledForeground:#6E6E6E; --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`,
  "high-contrast": `--vscode-sideBar-background:#000000; --vscode-editor-background:#000000; --vscode-input-background:#000000;
    --vscode-panel-border:#6FC3DF; --vscode-widget-border:#6FC3DF; --vscode-input-border:#6FC3DF;
    --vscode-foreground:#FFFFFF; --vscode-editor-foreground:#FFFFFF; --vscode-descriptionForeground:#FFFFFF;
    --vscode-disabledForeground:#A5A5A5; --vscode-list-activeSelectionBackground:#000000; --vscode-focusBorder:#F38518;`,
};

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const codicon = readFileSync(here + "/../media/codicon.css", "utf8")
    .replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(here + "/../media/codicon.ttf").toString("base64")}")`);
  mainJs = readFileSync(here + "/../media/main.js", "utf8");
  markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  html = skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`);
});
after(async () => { await browser?.close(); });

async function openPanel(width, height = 800, theme = "dark") {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }
    body { background: var(--bg); color: var(--text); }` });
  await page.evaluate(([mjs, mdjs, cls]) => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posts.push(m); }, getState: () => undefined, setState() {} });
    document.body.classList.add(cls);
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs, theme === "light" ? "vscode-light" : theme === "high-contrast" ? "vscode-high-contrast" : "vscode-dark"]);
  const panel = {
    page,
    events: (list) => page.evaluate(async (items) => {
      for (const event of items) {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
        await new Promise((done) => setTimeout(done, 2));
      }
    }, list),
    settle: () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80))))),
  };
  await panel.events([{ type: "ready", capabilities: { image_views: true, history_snapshot: true }, model: "qwen3-vl:8b",
    mode: "default", think: "off", commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" }]);
  return panel;
}

// A 1280x757 screenshot-like PNG, drawn in the page so no binary fixture is needed.
const makePng = (page, width = 1280, height = 757, hue = 262) => page.evaluate(([w, h, hueValue]) => {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const g = canvas.getContext("2d");
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hueValue} 70% 45%)`); grad.addColorStop(1, `hsl(${hueValue + 60} 70% 55%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.fillStyle = "#fff"; g.font = `bold ${Math.round(h / 8)}px sans-serif`; g.fillText("Vibe DGC", w * 0.08, h * 0.3);
  g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(w * 0.08, h * 0.45, w * 0.3, h * 0.12);
  return canvas.toDataURL("image/png");
}, [width, height, hue]);

const itemFor = (n, extra = {}) => ({ ref: "img_" + n.toString(16).padStart(32, "0"), name: `page-20260915-1030${String(n).padStart(2, "0")}-a1b2c3.png`,
  mime: "image/png", width: 1280, height: 757, bytes: 318 * 1024, source: "browser", host: "vibedgc.com", ...extra });

async function screenshotStep(panel, count, { callId = "c1", open = true } = {}) {
  const png = await makePng(panel.page);
  await panel.events([
    { type: "turn_start", turn_id: `t-${callId}`, prompt: "Check the deployed landing page", kind: "prompt" },
    { type: "tool_call", call_id: callId, name: "browser", args: { operation: "screenshot" }, summary: "screenshot" },
    { type: "tool_result", call_id: callId, name: "browser", output: "screenshot of the page saved to .dgc/screenshots/page.png",
      is_error: false, is_diff: false },
    { type: "tool_images", call_id: callId, caption: "browser screenshot", images: Array(count).fill(png),
      items: Array.from({ length: count }, (_, i) => itemFor(i + 1)) },
  ]);
  if (open) await panel.page.evaluate((id) => document.querySelector(`.tool[data-call-id="${id}"] .tool-toggle`).click(), callId);
  await panel.settle();
  return png;
}

const noPageOverflow = (panel) => panel.page.evaluate(() => ({
  doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  body: document.body.scrollWidth - document.body.clientWidth,
}));

function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

for (const width of [300, 460, 900]) {
  for (const theme of Object.keys(THEMES)) {
    test(`chips and the viewer fit a ${width}px panel (${theme})`, async (t) => {
      if (skipOrFail(t)) return;
      const panel = await openPanel(width, 800, theme);
      try {
        await screenshotStep(panel, 12);
        const row = await panel.page.evaluate(() => {
          const list = document.querySelector(".tool-images");
          return { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, chips: list.querySelectorAll(".image-chip").length,
            tile: Math.round(document.querySelector(".image-tile").getBoundingClientRect().width) };
        });
        assert.equal(row.chips, 12);
        assert.ok(row.scrollWidth > row.clientWidth, `the chip row scrolls inside itself (${row.scrollWidth} > ${row.clientWidth})`);
        assert.equal(row.tile, width <= 360 ? 64 : 80, "tile size");
        assert.deepEqual(await noPageOverflow(panel), { doc: 0, body: 0 }, "the page never scrolls sideways");

        // Keyboard focus lands on the first chip: its ring must not be clipped by the scrolling row.
        await panel.page.evaluate(() => document.querySelector('.tool[data-call-id="c1"] .tool-toggle').focus());
        await panel.page.keyboard.press("Tab");
        const ring = await panel.page.evaluate(() => {
          const chip = document.activeElement, list = chip.closest(".tool-images");
          const style = getComputedStyle(chip), rows = getComputedStyle(list);
          const grow = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          const c = chip.getBoundingClientRect(), r = list.getBoundingClientRect();
          const inner = { left: r.left + parseFloat(rows.borderLeftWidth), top: r.top + parseFloat(rows.borderTopWidth) };
          return { isChip: chip.classList.contains("image-chip"), grow, style: style.outlineStyle,
            left: c.left - grow - inner.left, top: c.top - grow - inner.top,
            bottom: inner.top + list.clientHeight - (c.bottom + grow) };
        });
        assert.ok(ring.isChip, "Tab reaches the first chip");
        assert.notEqual(ring.style, "none", "the focused chip shows a ring");
        for (const side of ["left", "top", "bottom"]) assert.ok(ring[side] >= -0.5, `the ring stays inside the row (${side} ${ring[side]}px)`);

        await panel.page.evaluate(() => document.activeElement.click());
        await panel.settle();
        const viewer = await panel.page.evaluate(() => {
          const controls = [...document.querySelectorAll("#image-viewer button")].filter((b) => b.offsetParent !== null)
            .map((b) => ({ label: b.getAttribute("aria-label") || b.textContent, ...b.getBoundingClientRect().toJSON() }));
          const img = document.querySelector("#image-viewer .iv-stage img"), stage = img.parentElement;
          const bar = getComputedStyle(document.querySelector("#image-viewer .iv-bar"));
          const rgb = (value) => value.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
          return { controls, inner: [innerWidth, innerHeight], img: img.getBoundingClientRect().toJSON(),
            stage: stage.getBoundingClientRect().toJSON(), natural: [img.naturalWidth, img.naturalHeight],
            title: rgb(getComputedStyle(document.getElementById("iv-title")).color),
            meta: rgb(getComputedStyle(document.getElementById("iv-meta")).color), bar: rgb(bar.backgroundColor),
            focus: document.activeElement.getAttribute("aria-label") };
        });
        assert.equal(viewer.focus, "Close image preview");
        assert.ok(viewer.controls.length >= 5, "Previous, Next, Actual size, Open file, Close");
        for (const control of viewer.controls) {
          assert.ok(control.left >= 0 && control.top >= 0 && control.right <= viewer.inner[0] && control.bottom <= viewer.inner[1],
            `${control.label} is on screen at ${width}px: ${JSON.stringify(control)}`);
        }
        assert.deepEqual(viewer.natural, [1280, 757]);
        assert.ok(viewer.img.width <= viewer.stage.width + 0.5 && viewer.img.height <= viewer.stage.height + 0.5,
          `the screenshot fits the stage (${viewer.img.width}x${viewer.img.height} in ${viewer.stage.width}x${viewer.stage.height})`);
        if (theme !== "high-contrast") {
          assert.ok(contrast(viewer.title, viewer.bar) >= 4.5, `title contrast ${contrast(viewer.title, viewer.bar).toFixed(2)}`);
          assert.ok(contrast(viewer.meta, viewer.bar) >= 4.5, `meta contrast ${contrast(viewer.meta, viewer.bar).toFixed(2)}`);
        }
        assert.deepEqual(await noPageOverflow(panel), { doc: 0, body: 0 });
      } finally { await panel.page.close(); }
    });
  }
}

test("a 220px-tall panel keeps every viewer control on screen", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(300, 220);
  try {
    await screenshotStep(panel, 2);
    await panel.page.evaluate(() => document.querySelector(".image-chip").click());
    await panel.settle();
    const box = await panel.page.evaluate(() => ({
      controls: [...document.querySelectorAll("#image-viewer button")].filter((b) => b.offsetParent !== null)
        .map((b) => ({ label: b.getAttribute("aria-label"), ...b.getBoundingClientRect().toJSON() })),
      stage: document.querySelector("#image-viewer .iv-stage").getBoundingClientRect().toJSON(),
      img: document.querySelector("#image-viewer .iv-stage img").getBoundingClientRect().toJSON(),
    }));
    for (const control of box.controls) {
      assert.ok(control.top >= 0 && control.bottom <= 220 && control.left >= 0 && control.right <= 300, `${control.label}: ${JSON.stringify(control)}`);
    }
    assert.ok(box.stage.height > 40, `the image still has room (${box.stage.height}px)`);
    assert.ok(box.img.height <= box.stage.height + 0.5 && box.img.bottom <= 220.5, "and fits in it");
    assert.deepEqual(await noPageOverflow(panel), { doc: 0, body: 0 });
  } finally { await panel.page.close(); }
});

test("Actual size shows 1280 CSS px and the stage scrolls; Tab never leaves the viewer", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(460, 700);
  try {
    for (let i = 0; i < 10; i += 1) {
      await panel.events([{ type: "turn_start", turn_id: `p${i}`, prompt: `Earlier question ${i}`, kind: "prompt" },
        { type: "text_delta", text: "An earlier answer that takes some room. ".repeat(12) },
        { type: "stream_end", message_id: `p${i}:1`, phase: "answer" },
        { type: "turn_end", turn_id: `p${i}`, reason: "completed", token_estimate: 0, final_message_id: `p${i}:1` }]);
    }
    await screenshotStep(panel, 3);
    await panel.page.evaluate(() => {
      const log = document.getElementById("log");
      document.querySelector(".image-chip").scrollIntoView({ block: "center" });
      log.dispatchEvent(new WheelEvent("wheel"));
      log.scrollTop = Math.max(0, log.scrollTop - 200);
    });
    await panel.settle();
    await panel.page.evaluate(() => document.querySelector(".image-chip").click());
    await panel.settle();
    assert.equal(await panel.page.evaluate(() => !document.getElementById("to-latest").hidden), true, "#to-latest is showing behind the viewer");

    const insideAfterTabs = [];
    for (let i = 0; i < 12; i += 1) {
      await panel.page.keyboard.press(i % 5 === 4 ? "Shift+Tab" : "Tab");
      insideAfterTabs.push(await panel.page.evaluate(() => !!document.activeElement?.closest("#image-viewer")));
    }
    assert.deepEqual(insideAfterTabs, Array(12).fill(true), "12 Tab presses stay inside the viewer");

    await panel.page.keyboard.press("z");
    await panel.settle();
    const actual = await panel.page.evaluate(() => {
      const img = document.querySelector("#image-viewer .iv-stage img"), stage = img.parentElement;
      return { width: img.getBoundingClientRect().width, scrolls: stage.scrollWidth > stage.clientWidth,
        pressed: document.querySelector("#image-viewer .iv-zoom").getAttribute("aria-pressed") };
    });
    assert.equal(actual.width, 1280, "actual size is 1280 CSS px");
    assert.ok(actual.scrolls, "the stage scrolls to reach the rest");
    assert.equal(actual.pressed, "true");
    const panned = await panel.page.evaluate(async () => {
      const stage = document.querySelector("#image-viewer .iv-stage");
      stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
      await new Promise((done) => requestAnimationFrame(done));
      return stage.scrollLeft;
    });
    assert.equal(panned, 48, "Shift+Arrow pans at actual size");
    await panel.page.keyboard.press("Escape");
    assert.equal(await panel.page.evaluate(() => !!document.getElementById("image-viewer")), false);
  } finally { await panel.page.close(); }
});

test("an image arriving by ref does not move the transcript", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(460, 600);
  try {
    const png = await makePng(panel.page, 640, 400, 190);
    const history = [];
    for (let i = 0; i < 8; i += 1) {
      history.push({ type: "turn_start", turn_id: `h${i}`, prompt: `Question ${i}`, kind: "prompt" },
        { type: "text_delta", text: "Saved answer text. ".repeat(20) }, { type: "stream_end", message_id: `h${i}:1`, phase: "answer" },
        { type: "turn_end", turn_id: `h${i}`, reason: "completed", token_estimate: 0, final_message_id: `h${i}:1` });
    }
    history.splice(16, 0, { type: "tool_call", call_id: "hc", name: "view_image", args: { path: "logo.png" }, summary: "logo.png" },
      { type: "tool_result", call_id: "hc", name: "view_image", output: "viewed logo.png", is_error: false, is_diff: false },
      { type: "tool_images", call_id: "hc", images: ["", ""], caption: "", items: [itemFor(7, { source: "view_image", host: "" }), itemFor(8, { source: "view_image", host: "" })] });
    await panel.events([{ type: "session", kind: "resumed", session_id: "s1" }, { type: "history", items: history, todos: [] }]);
    await panel.settle();
    await panel.page.evaluate(() => {
      const card = document.querySelector('.tool[data-call-id="hc"]');
      card.querySelector(".tool-toggle").click();
      card.scrollIntoView({ block: "center" });
      document.getElementById("log").dispatchEvent(new WheelEvent("wheel"));
    });
    await panel.settle();
    const before = await panel.page.evaluate(() => ({ top: document.getElementById("log").scrollTop,
      asks: window.__posts.filter((m) => m.type === "getImage").map((m) => [m.requestId, m.ref]),
      states: [...document.querySelectorAll('.tool[data-call-id="hc"] .image-chip')].map((c) => c.dataset.state) }));
    assert.equal(before.asks.length, 2);
    assert.deepEqual(before.states, ["loading", "loading"]);
    assert.ok(before.top > 0);
    await panel.events(before.asks.map(([requestId, ref]) => ({ type: "image", request_id: requestId, ref, image: png,
      mime: "image/png", width: 640, height: 400 })));
    await panel.settle();
    const afterState = await panel.page.evaluate(() => ({ top: document.getElementById("log").scrollTop,
      states: [...document.querySelectorAll('.tool[data-call-id="hc"] .image-chip')].map((c) => c.dataset.state),
      loaded: [...document.querySelectorAll('.tool[data-call-id="hc"] .image-chip img')].every((img) => img.complete && img.naturalWidth === 640) }));
    assert.deepEqual(afterState.states, ["ready", "ready"]);
    assert.ok(afterState.loaded);
    assert.equal(afterState.top, before.top, "scrollTop did not move when the chips filled in");
  } finally { await panel.page.close(); }
});
