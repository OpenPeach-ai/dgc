import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// A picture DGC made in Work (generate_image) shows under the reply, as ChatDGC and a Pip's reply show theirs, while
// the turn's steps fold into "Worked for": before, it was three folds deep (Worked for → Used 1 tool · 1 image → the
// step) and the reply only named its path. The step keeps its own tiles. Live and replayed (by ref) alike.
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

const png = (page, w = 96, h = 48) => page.evaluate(([w, h]) => {
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const g = canvas.getContext("2d"); g.fillStyle = "#c2410c"; g.fillRect(0, 0, w, h);
  return canvas.toDataURL("image/png");
}, [w, h]);
const REF = "img_" + "a".repeat(32);
const turn = (data, { live = true } = {}) => [
  { type: "turn_start", turn_id: "t1", prompt: "Make a banner of a fox barista", kind: "prompt" },
  { type: "tool_call", call_id: "g1", name: "generate_image", args: { prompt: "a fox barista" }, summary: "ComfyUI · 1 × 768x320 · free" },
  { type: "tool_images", call_id: "g1", caption: "generated image", images: [live ? data : ""],
    items: [{ ref: REF, name: "a-fox-barista.png", mime: "image/png", width: 96, height: 48, bytes: 4000, source: "view_image", host: "" }] },
  { type: "tool_result", call_id: "g1", name: "generate_image", output: "Made 1 image with ComfyUI · 768×320 · free\nassets/hero/a-fox-barista.png",
    is_error: false, is_diff: false },
  { type: "text_delta", text: "Made the banner: assets/hero/a-fox-barista.png." },
  { type: "stream_end", message_id: "t1:2", phase: "answer" },
  { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:2" },
];
const shape = (page) => page.evaluate(() => {
  const answer = document.querySelector(".answer");
  const pictures = answer?.querySelector(":scope > .made-pictures");
  const img = pictures?.querySelector(".made-image img");
  const r = img?.getBoundingClientRect();
  return { inAnswer: !!pictures, afterReply: pictures?.previousElementSibling?.classList.contains("final") ?? false,
           src: img?.getAttribute("src") || "", visible: !!r && r.width > 40 && r.height > 20, caption: pictures?.querySelector("figcaption")?.textContent || "",
           folded: !!document.querySelector(".msg.dgc.work-folded"), stepPill: document.querySelector('.tool[data-tool-name="generate_image"] .tool-image-count .n')?.textContent || "" };
});

for (const theme of ["dark", "light"]) {
  test(`Work: the picture a turn made is under its reply, with the steps folded (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(460, 800, theme);
    try {
      const data = await png(panel.page);
      await panel.events(turn(data));
      await panel.settle();
      const seen = await shape(panel.page);
      assert.deepEqual(seen, { inAnswer: true, afterReply: true, src: data, visible: true, caption: "a-fox-barista.png", folded: true, stepPill: "1" });
      if (process.env.DGC_SHOTS) await panel.page.screenshot({ path: `${process.env.DGC_SHOTS}/work-picture-under-reply-${theme}.png` });
      await panel.page.click(".made-pictures .image-chip");
      await panel.settle();
      assert.equal(await panel.page.locator("#image-viewer").count(), 1, "the picture opens in the viewer");
    } finally { await panel.page.close(); }
  });
}

for (const [w, h] of [[512, 512], [768, 320], [320, 900], [64, 64]]) {
  test(`Work: a ${w}×${h} picture's frame is the picture's own size, never a grey band beside it`, async (t) => {
    if (skipOrFail(t)) return;
    const panel = await openPanel(900);
    try {
      const data = await png(panel.page, w, h);
      await panel.events(turn(data));
      await panel.settle();
      const fit = await panel.page.evaluate(() => {
        const tile = document.querySelector(".made-pictures .image-tile").getBoundingClientRect();
        const img = document.querySelector(".made-pictures .image-tile img").getBoundingClientRect();
        return { dw: Math.round(tile.width - img.width), dh: Math.round(tile.height - img.height), w: img.width, h: img.height };
      });
      assert.ok(fit.dw <= 2 && fit.dh <= 2, `the frame hugs the picture: ${JSON.stringify(fit)}`);
      assert.ok(fit.w <= 420 && fit.h <= 320, "within 420 × 320");
      assert.ok(Math.abs(fit.w / fit.h - w / h) < 0.03, "its own shape");
    } finally { await panel.page.close(); }
  });
}

test("Work, replayed: the picture comes by ref under the reply too", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(900);
  try {
    const data = await png(panel.page);
    await panel.events(turn(data, { live: false }));
    await panel.settle();
    const asked = await panel.page.evaluate(() => window.__posts.filter((m) => m.type === "getImage"));
    assert.ok(asked.some((m) => m.ref === "img_" + "a".repeat(32)), "asked for by its ref");
    for (const m of asked) await panel.events([{ type: "image", request_id: m.requestId, ref: m.ref, image: data, width: 96, height: 48 }]);
    await panel.settle();
    assert.equal((await shape(panel.page)).src, data);
  } finally { await panel.page.close(); }
});

test("Save to project… under a picture DGC made copies it into the project, live and replayed (both themes)", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    const panel = await openPanel(460, 800, theme);
    try {
      const data = await png(panel.page);
      await panel.events(turn(data));
      await panel.settle();
      const button = panel.page.locator(".made-pictures .made-image-save");
      assert.equal(await button.textContent(), "Save to project…");
      assert.match(await button.getAttribute("title"), /assets\//);
      await button.click();
      const posts = await panel.page.evaluate(() => window.__posts.filter((m) => m.type === "saveImage"));
      assert.deepEqual(posts, [{ type: "saveImage", name: "a-fox-barista.png", data, project: true }]);
      if (process.env.DGC_SHOTS) await panel.page.screenshot({ path: `${process.env.DGC_SHOTS}/work-save-to-project-${theme}.png` });
    } finally { await panel.page.close(); }
  }
  const panel = await openPanel(900);
  try {
    const data = await png(panel.page);
    await panel.events(turn(data, { live: false }));
    await panel.settle();
    await panel.page.locator(".made-pictures .made-image-save").click();
    assert.equal((await panel.page.evaluate(() => window.__posts.filter((m) => m.type === "saveImage"))).length, 0,
                 "nothing to copy until the picture has come");
    const asked = await panel.page.evaluate(() => window.__posts.filter((m) => m.type === "getImage"));
    for (const m of asked) await panel.events([{ type: "image", request_id: m.requestId, ref: m.ref, image: data, width: 96, height: 48 }]);
    await panel.settle();
    await panel.page.locator(".made-pictures .made-image-save").click();
    assert.equal((await panel.page.evaluate(() => window.__posts.filter((m) => m.type === "saveImage")))[0].data, data);
  } finally { await panel.page.close(); }
});

test("a turn that made no picture has no picture row", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel(900);
  try {
    await panel.events([{ type: "turn_start", turn_id: "t2", prompt: "hi", kind: "prompt" }, { type: "text_delta", text: "Hello." },
      { type: "stream_end", message_id: "t2:1", phase: "answer" }, { type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0, final_message_id: "t2:1" }]);
    await panel.settle();
    assert.equal(await panel.page.locator(".made-pictures").count(), 0);
  } finally { await panel.page.close(); }
});
