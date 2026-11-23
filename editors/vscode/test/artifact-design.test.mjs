// A design (0.52): a canvas of artboards DGC draws one at a time while you watch. In real Chromium, with the panel's
// real page (test/support/artifact-scene.mjs) over a design as the backend keeps one (artifact-fixture.py): the
// canvas's sums (zoom about the pointer, fit, snapping to edges and to the 80 / 120 gaps); it opens on everything; an
// artboard drawn elsewhere appears without the others being drawn again; every artboard is in a frame with no origin
// and a policy that reaches nothing, and its own script runs only while it plays; pan, zoom, select, move, resize,
// rename, duplicate, delete, notes, pages and tweaks are each one change sent as ops; an artboard opened lets you pick
// a part, restyle it and change its words in place, saved as its page with its own scripts as they were written; a
// comment points at an artboard or a part of one; Ask in chat names it; downloads go through the download path; many
// artboards stay light (a few live frames, pictures for the rest). And the extension's side (src/artifacts.ts against a
// stub `vscode`) sends those as the commands the process takes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { artifactsModule, fixtures, openPanel, panelPage } from "./support/artifact-scene.mjs";

const world = { panels: [], warned: [] };
const uri = (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => `file://${p}` });
globalThis.__DGC_ART_VSCODE = {
  Uri: { file: uri, joinPath: (base, ...parts) => uri([base.fsPath ?? String(base), ...parts].join("/")), parse: (value) => ({ scheme: value.split(":")[0], fsPath: "", path: value, toString: () => value }) },
  ViewColumn: { Active: -1, Beside: -2 }, ProgressLocation: { Notification: 15 },
  window: { createWebviewPanel: (viewType, title) => { const received = [];
    const panel = { viewType, title, visible: true, webview: { options: {}, html: "", cspSource: "vscode-resource:", posted: [], asWebviewUri: (u) => u, postMessage(m) { this.posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (fn) => { received.push(fn); return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }), reveal() {}, dispose() {},
      say(m) { received.forEach((fn) => fn(m)); }, last(type) { return [...this.webview.posted].reverse().find((m) => m.type === type); } };
    world.panels.push(panel); return panel; },
    registerWebviewPanelSerializer: () => ({ dispose() {} }), showWarningMessage: async (m) => { world.warned.push(m); }, showInformationMessage: async () => undefined,
    withProgress: async (_o, work) => work(), showInputBox: async () => world.typed },
  env: { asExternalUri: async (u) => u, openExternal: async () => true },
  workspace: { workspaceFolders: [{ uri: uri("/home/me/code/shop") }], fs: {} },
  commands: { executeCommand: async () => {} },
};

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, data;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : !data ? "no Python that imports this checkout's dgc" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  data = fixtures();
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const SHOTS = process.env.DGC_DESIGN_SHOTS || "";
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } };
const clone = (v) => JSON.parse(JSON.stringify(v));

/** The panel over the fixture's design; `listen` counts what the artboards' own scripts said (they say it when they run). */
async function open(options = {}) {
  const scene = await openPanel(browser, { kind: "design", width: 1280, height: 800, ...options });
  const { page } = scene;
  await page.evaluate(() => { window.__ran = 0; window.addEventListener("message", (e) => { if (e.data && e.data.type === "artboard-script-ran") window.__ran += 1; }); });
  await page.waitForFunction(() => window.DgcDesign?.editor && document.querySelectorAll(".dz-board").length > 0);
  await page.waitForTimeout(250);
  const ed = (fn, arg) => page.evaluate(([code, a]) => (0, eval)(`(${code})`)(window.DgcDesign.editor.debug, a), [fn.toString(), arg]);
  const edits = async () => (await scene.posted("designEdit")).flatMap((m) => m.edits);
  const box = async (id) => page.locator(`.dz-board[data-board="${id}"] .dz-face`).boundingBox();
  const frameOf = async (id) => {
    const handle = await page.locator(`.dz-board[data-board="${id}"] iframe`).elementHandle();
    return handle.contentFrame();
  };
  return { ...scene, ed, edits, box, frameOf };
}
/** The design again as the process would send it after a change (the fixture, changed by `change`). */
async function resend(scene, change) {
  const next = clone({ content: scene.data.content, state: scene.data.state, view: scene.data.view });
  change(next);
  next.view.version += 1;
  await scene.send({ type: "detail", artifact: next.view, content: next.content, state: next.state });
  await scene.page.waitForTimeout(200);
  return next;
}

test("the canvas's sums: zoom keeps the point under the pointer, fit shows everything, frames snap to edges and gaps", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await openPanel(browser, { kind: "design" });
  const out = await page.evaluate(() => {
    const D = window.DgcDesign;
    const view = { x: 40, y: 10, k: 0.5 }, px = 300, py = 200;
    const before = { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
    const zoomed = D.zoomAt(view, px, py, 2);
    const after = { x: (px - zoomed.x) / zoomed.k, y: (py - zoomed.y) / zoomed.k };
    const fit = D.fitView({ x: -100, y: 50, w: 4000, h: 1000 }, 1000, 600);
    const others = [{ x: 0, y: 0, w: 1440, h: 900 }];
    return { before, after, k: zoomed.k, most: D.zoomAt(view, 0, 0, 99).k, least: D.zoomAt(view, 0, 0, 0).k, fit,
             gap: D.snapMove({ x: 1525, y: 4, w: 390, h: 844 }, others, 8),
             edge: D.snapMove({ x: 3, y: 1014, w: 390, h: 844 }, others, 8),
             far: D.snapMove({ x: 1700, y: 300, w: 390, h: 844 }, others, 8),
             grow: D.snapResize({ x: 1520, y: 0, w: 390, h: 893 }, "s", others, 8),
             small: D.snapResize({ x: 1520, y: 0, w: 20, h: 20 }, "se", [], 8),
             tweaks: D.tweakStyle([{ name: "accent", type: "color", value: "#224466" }, { name: "badge", type: "switch", value: false }, { name: "x;y", type: "color", value: "red" }]),
             hex: [D.hexOf("rgb(181, 101, 29)"), D.hexOf("rgba(0, 0, 0, 0)"), D.hexOf("#ABCDEF")] };
  });
  assert.deepEqual(out.after, out.before, "the canvas point under the pointer stays under it");
  assert.equal(out.k, 2);
  assert.equal(out.most, 4);
  assert.ok(out.least > 0 && out.least <= 0.05);
  // Everything fits inside the window, centred.
  assert.ok(out.fit.k * 4000 <= 1000 && out.fit.k * 1000 <= 600);
  assert.ok(Math.abs((-100 * out.fit.k + out.fit.x) - (1000 - (3900 * out.fit.k + out.fit.x))) < 1, "centred across");
  assert.deepEqual([out.gap.x, out.gap.y], [1520, 0], "80 px beside the other frame, its top on that frame's top");
  assert.ok(out.gap.guides.some((g) => g.kind === "gap" && g.gap === 80));
  assert.deepEqual([out.edge.x, out.edge.y], [0, 1020], "under it, 120 px below, left edges in line");
  assert.ok(out.edge.guides.some((g) => g.gap === 120));
  assert.deepEqual([out.far.x, out.far.y, out.far.guides.length], [1700, 300, 0], "nothing near: it stays where it is put");
  assert.equal(out.grow.h, 900, "its bottom edge snaps to the other frame's bottom");
  assert.deepEqual([out.small.w, out.small.h], [100, 100], "never smaller than 100");
  assert.equal(out.tweaks.css, ":root{--accent:#224466;--badge:0}");
  assert.deepEqual(out.tweaks.attrs, { "data-tweak-badge": "off" });
  assert.deepEqual(out.hex, ["#b5651d", "", "#abcdef"]);
  await page.close();
});

test("it opens on everything: each artboard where it sits, the drawn ones live, the rest saying they wait", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  assert.deepEqual(scene.errors, []);
  assert.equal(await page.locator("#art-meta").innerText().then((s) => s.split("·")[0].trim()), "Design");
  assert.deepEqual(await page.locator(".dz-board .dz-name-title").allInnerTexts(), ["Desktop", "Sign in", "Welcome", "Tablet"]);
  assert.deepEqual(await page.locator(".dz-tab").allInnerTexts(), ["Page 1", "Checkout"]);
  const stage = await page.locator(".dz-stage").boundingBox();
  for (const id of ["b1", "b2", "b3", "b4"]) {
    const b = await scene.box(id);
    assert.ok(b.x >= stage.x && b.x + b.width <= stage.x + stage.width + 1 && b.y >= stage.y && b.y + b.height <= stage.y + stage.height + 1, `${id} is in view`);
  }
  // In a row, in order, never over one another.
  const boxes = [await scene.box("b1"), await scene.box("b2"), await scene.box("b3"), await scene.box("b4")];
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].x >= boxes[i - 1].x + boxes[i - 1].width);
  assert.equal(await page.locator(".dz-board[data-state='ready'] iframe.dz-frame").count(), 3);
  assert.equal(await page.locator(".dz-board[data-board='b4'] .dz-wait-words").innerText(), "Not drawn yet");
  // The notes are on the canvas too.
  assert.equal(await page.locator(".dz-note[data-kind='title']").innerText(), "Bean There");
  assert.equal(await page.locator(".dz-note[data-kind='sticky']").getAttribute("data-color"), "pink");
  await shot(page, "open-dark-1280");
  await page.close();
});

test("an artboard is in a frame with no origin and a policy that reaches nothing; its own script runs only in play", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  const frames = await page.evaluate(() => [...document.querySelectorAll("iframe.dz-frame")].map((f) => ({ sandbox: f.getAttribute("sandbox"), doc: f.srcdoc, mode: f.dataset.mode })));
  assert.equal(frames.length, 3);
  for (const f of frames) {
    assert.equal(f.sandbox, "allow-scripts", "scripts only (DGC's helper); never the page's origin, forms, pop-ups or top navigation");
    assert.match(f.doc, /<meta data-dgc-own="" http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:/);
    assert.equal(f.mode, "view");
  }
  // The sign-in screen has a script of its own: on the canvas it is switched off, and it has not run.
  const signIn = frames.find((f) => f.doc.includes("Not signed in yet"));
  assert.match(signIn.doc, /<script type="dgc\/off">/);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__ran), 0, "Play is off until it is asked for");
  // Play it: now its own script runs, in the same kind of frame.
  await scene.ed((d) => d.startPlay("b2"));
  await page.waitForFunction(() => window.__ran === 1);
  const played = await page.evaluate(() => { const f = document.querySelector(".dz-board[data-board='b2'] iframe"); return { sandbox: f.getAttribute("sandbox"), mode: f.dataset.mode }; });
  assert.deepEqual(played, { sandbox: "allow-scripts", mode: "play" });
  // An artboard that isn't interactive runs no script of its own even in play (its links still work).
  await scene.ed((d) => d.stopPlay());
  const welcome = await page.evaluate(() => window.DgcDesign.frameDoc({ id: "b9", interactive: false, tweaks: [] }, "<body><script>parent.postMessage({type:'artboard-script-ran'},'*')</" + "script></body>", "play", "TESTNONCE", "t"));
  assert.match(welcome, /<script type="dgc\/off">/);
  // What a page may not hold is taken out before it is framed, and a handler in an attribute never reaches the frame.
  const cleaned = await page.evaluate(() => window.DgcDesign.frameDoc({ id: "b9", interactive: true, tweaks: [] },
    '<head><meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com/"></head><body><iframe src="https://example.com"></iframe><button onclick="steal()">x</button></body>', "view", "TESTNONCE", "t"));
  assert.doesNotMatch(cleaned, /refresh|<base|<iframe|\sonclick=/);
  assert.match(cleaned, /data-dgc-on-click="steal\(\)"/);
  await page.close();
});

test("an artboard DGC draws shows as it is made, and the others are not drawn again", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  await page.evaluate(() => { for (const f of document.querySelectorAll("iframe.dz-frame")) f.__kept = true; });
  // While a turn is drawing, the first frame not drawn says so.
  const now = new Date().toISOString();
  await resend(scene, (d) => { d.view.updated = now; });
  assert.equal(await page.locator(".dz-board[data-board='b4'] .dz-wait-words").innerText(), "Drawing…");
  await shot(page, "drawing-dark-1280");
  await resend(scene, (d) => {
    d.view.updated = now;
    const b4 = d.content.boards.find((b) => b.id === "b4"); b4.state = "ready"; b4.rev = 1;
    d.state.boards.b4 = "<!doctype html><html><body><h1>Tablet menu</h1></body></html>";
  });
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b4'] iframe"));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("iframe.dz-frame")].filter((f) => f.__kept).length), 3, "the three drawn before are the same frames");
  assert.equal(await page.locator(".dz-board[data-board='b4']").getAttribute("data-state"), "ready");
  await page.waitForFunction(() => /Tablet is drawn/.test(document.getElementById("art-announce").textContent));
  // A new frame added on the next row comes into view by itself (you are watching it fill).
  await resend(scene, (d) => { d.content.boards.push({ id: "b9", page: "p1", title: "Poster", x: 0, y: 1320, w: 1240, h: 1754, fit: "fixed", interactive: false, state: "drawing", rev: 0, tweaks: [] }); });
  const stage = await page.locator(".dz-stage").boundingBox(), poster = await scene.box("b9");
  assert.ok(poster.y + poster.height <= stage.y + stage.height + 1, "the new frame is in view");
  await page.close();
});

test("pan by dragging the canvas, by scrolling and with Space; zoom with Ctrl and scroll about the pointer, and by key", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  const stage = await page.locator(".dz-stage").boundingBox();
  const start = await scene.ed((d) => d.view());
  // Drag on empty canvas.
  await page.mouse.move(stage.x + 20, stage.y + stage.height - 20);
  await page.mouse.down(); await page.mouse.move(stage.x + 120, stage.y + stage.height - 60, { steps: 4 }); await page.mouse.up();
  let now = await scene.ed((d) => d.view());
  assert.deepEqual([Math.round(now.x - start.x), Math.round(now.y - start.y), now.k], [100, -40, start.k]);
  // Two fingers (a wheel without Ctrl) pan.
  await page.mouse.wheel(30, 50);
  let after = await scene.ed((d) => d.view());
  const moved = [after.x - now.x, after.y - now.y];        // (the browser scales a test wheel by the screen's density)
  assert.ok(moved[0] < -10 && moved[1] < -20 && Math.abs(moved[1] / moved[0] - 50 / 30) < 0.01, `panned by the wheel: ${moved}`);
  assert.equal(after.k, now.k);
  // Ctrl and scroll zoom about the pointer: the canvas point under it stays under it.
  const at = { x: stage.x + 400, y: stage.y + 300 };
  await page.mouse.move(at.x, at.y);
  const under = (v) => ({ x: (400 - v.x) / v.k, y: (300 - v.y) / v.k });
  const was = under(after);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -800); await page.keyboard.up("Control");
  now = await scene.ed((d) => d.view());
  assert.ok(now.k > after.k * 1.5, "zoomed in");
  assert.ok(Math.abs(under(now).x - was.x) < 3 && Math.abs(under(now).y - was.y) < 3, "about the pointer (to the pixel the wheel names)");
  // Space and drag pans from anywhere, over an artboard too (it does not move the artboard).
  await page.locator(".dz-stage").focus();
  await page.keyboard.press("f");
  now = await scene.ed((d) => d.view());
  const b1 = await scene.box("b1");
  await page.keyboard.down("Space");
  await page.mouse.move(b1.x + 60, b1.y + 60); await page.mouse.down(); await page.mouse.move(b1.x + 10, b1.y + 30, { steps: 3 }); await page.mouse.up();
  await page.keyboard.up("Space");
  after = await scene.ed((d) => d.view());
  assert.deepEqual([Math.round(after.x - now.x), Math.round(after.y - now.y)], [-50, -30]);
  assert.deepEqual(await scene.edits(), [], "nothing was changed by moving about");
  // Keys: + and - step, 0 is life size, F fits all. The toolbar says the zoom and has the same.
  await page.keyboard.press("0");
  assert.equal((await scene.ed((d) => d.view())).k, 1);
  assert.equal(await page.locator(".dz-zoom").innerText(), "100%");
  await page.keyboard.press("+");
  assert.equal((await scene.ed((d) => d.view())).k, 1.25);
  await page.keyboard.press("-"); await page.keyboard.press("-");
  assert.equal(Math.round((await scene.ed((d) => d.view())).k * 100), 80);
  await page.keyboard.press("f");
  const fit = await scene.ed((d) => d.view());
  assert.ok(Math.abs(fit.k - start.k) < 1e-6 && Math.abs(fit.x - start.x) < 1, "fit all is where it opened");
  await page.locator(".dz-tool[aria-label='Zoom in']").click();
  assert.ok((await scene.ed((d) => d.view())).k > fit.k);
  await page.locator(".dz-zoom").click();
  assert.deepEqual((await page.locator(".dz-menu:not([hidden]) .art-menu-item").allInnerTexts()).slice(0, 2), ["Fit all (F)", "100% (0)"]);
  await page.keyboard.press("Escape");
  await page.close();
});

test("select an artboard and drag it: it snaps 80 px beside its neighbour, shows the guide, and is saved as one move", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  const k = (await scene.ed((d) => d.view())).k;
  const b3 = await scene.box("b3");
  await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2);
  await page.mouse.down();
  // 700 px to the right and 300 down on the canvas, then back to within a few px of the 80 gap after "Tablet".
  await page.mouse.move(b3.x + b3.width / 2 + 700 * k, b3.y + b3.height / 2 + 300 * k, { steps: 5 });
  assert.equal(await page.locator(".dz-board[data-board='b3']").getAttribute("data-selected"), "true");
  const want = 2460 + 834 + 80;                     // right of Tablet (x 2460, 834 wide)
  await page.mouse.move(b3.x + b3.width / 2 + (want - 1990 + 4) * k, b3.y + b3.height / 2 + 3 * k, { steps: 5 });
  assert.equal(await page.locator(".dz-guide[data-kind='gap'] .dz-guide-gap").first().innerText(), "80");
  await shot(page, "snap-guide-dark-1280");
  await page.mouse.up();
  assert.deepEqual(await scene.edits(), [{ op: "move", board: "b3", x: want, y: 0 }]);
  assert.equal(await page.locator(".dz-guide").count(), 0, "the guides go when it is let go");
  // Its actions float by it, and its size shows by its name.
  assert.ok(await page.locator(".dz-acts").isVisible());
  assert.match(await page.locator(".dz-board[data-board='b3'] .dz-name-size").innerText(), /390 × 844/);
  await page.close();
});

test("resize by a handle, rename where its name is, duplicate, delete and nudge: each is one op", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  const k = (await scene.ed((d) => d.view())).k;
  await scene.ed((d) => d.select({ kind: "board", id: "b2" }));
  const b2 = await scene.box("b2");
  await page.mouse.move(b2.x + b2.width, b2.y + b2.height);
  await page.mouse.down(); await page.mouse.move(b2.x + b2.width + 40 * k, b2.y + b2.height + 56 * k, { steps: 4 }); await page.mouse.up();
  let edits = await scene.edits();
  assert.equal(edits.length, 1);
  assert.equal(edits[0].op, "resize");
  assert.ok(Math.abs(edits[0].w - 430) <= 2, `w ${edits[0].w}`);
  assert.equal(edits[0].h, 900, "its bottom edge snapped to the desktop's (900)");
  await scene.clearPosted();
  await page.locator(".dz-board[data-board='b2'] .dz-name-title").dblclick();
  await page.locator(".dz-rename").fill("Sign in, large");
  await page.keyboard.press("Enter");
  assert.deepEqual(await scene.edits(), [{ op: "rename", board: "b2", title: "Sign in, large" }]);
  await scene.clearPosted();
  await page.locator(".dz-acts [data-act='duplicate']").click();
  await page.locator(".dz-stage").focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(650);
  await page.locator(".dz-acts [data-act='delete']").click();
  edits = await scene.edits();
  assert.deepEqual(edits.map((e) => e.op), ["duplicate", "move", "remove"]);
  assert.equal(await page.locator(".dz-board[data-board='b2']").count(), 0, "gone at once");
  await page.waitForFunction(() => /Versions can bring it back/.test(document.getElementById("art-announce").textContent));
  await page.close();
});

test("open an artboard: pick a part, restyle it in the panel, change its words in place; its own script is saved as written", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  const b1 = await scene.box("b1");
  await page.mouse.dblclick(b1.x + b1.width * 0.8, b1.y + b1.height * 0.8);
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b1'] iframe")?.dataset.mode === "edit");
  let frame = await scene.frameOf("b1");
  await frame.locator("h1").click();
  await page.waitForFunction(() => /Part/.test(document.querySelector(".dz-props h2")?.textContent || ""));
  assert.match(await page.locator(".dz-part").innerText(), /^<h1> Coffee worth waking up for/);
  const size = page.locator(".dz-field", { hasText: "Font size" }).locator("input");
  assert.equal(await size.inputValue(), "72");
  await shot(page, "part-picked-dark-1280");
  await size.fill("80"); await size.press("Tab");
  await page.waitForFunction(() => window.__posted.some((m) => m.type === "designEdit"));
  let edits = await scene.edits();
  assert.equal(edits.length, 1);
  assert.deepEqual([edits[0].op, edits[0].board, edits[0].rev, edits[0].note], ["change", "b1", 1, "Restyled"]);
  assert.match(edits[0].html, /<h1 id="headline" style="font-size: 80px;">Coffee worth waking up for<\/h1>/);
  // Only that: nothing of DGC's own is in the page it saves.
  assert.doesNotMatch(edits[0].html, /data-dgc|Content-Security-Policy|dgc-design/);
  assert.match(edits[0].html, /^<!doctype html>\n<html lang="en">/);
  await scene.clearPosted();
  // Words changed in place.
  await frame.locator("p.lead").dblclick();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Roasted this morning.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__posted.some((m) => m.type === "designEdit"));
  edits = await scene.edits();
  assert.deepEqual([edits[0].op, edits[0].rev, edits[0].note], ["change", 2, "Edited text"]);
  assert.match(edits[0].html, /<p class="lead">Roasted this morning\.<\/p>/);
  assert.match(edits[0].html, /font-size: 80px/, "the change before it is still there");
  // Escape closes it; the canvas takes the pointer again.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b1']").dataset.inside === "false");
  // An artboard with a script: a change to it saves the script as it was written, never switched off.
  await scene.clearPosted();
  await scene.ed((d) => d.enterInside("b2"));
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b2'] iframe")?.dataset.mode === "edit");
  frame = await scene.frameOf("b2");
  await frame.locator("h1").dblclick();
  await page.keyboard.press("Control+A"); await page.keyboard.type("Log in"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__posted.some((m) => m.type === "designEdit"));
  edits = await scene.edits();
  assert.match(edits[0].html, /<h1>Log in<\/h1>/);
  assert.match(edits[0].html, /<script>\s*document\.getElementById\("email"\)/);
  assert.equal(await page.evaluate(() => window.__ran), 0, "and it never ran while it was open");
  await page.close();
});

test("an artboard's declared tweaks are changed in the panel, and its size and name too", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  await scene.ed((d) => d.select({ kind: "board", id: "b1" }));
  assert.equal(await page.locator(".dz-props h2").innerText(), "Artboard");
  assert.deepEqual(await page.locator(".dz-props .dz-field-label").allInnerTexts(), ["Name", "Width", "Height", "Accent colour", "Show the badge"]);
  await page.locator(".dz-props .dz-check").click();
  await page.locator(".dz-props .dz-color").evaluate((el) => { el.value = "#224466"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  const width = page.locator(".dz-field", { hasText: "Width" }).locator("input");
  await width.fill("1280"); await width.press("Tab");
  assert.deepEqual(await scene.edits(), [{ op: "tweak", board: "b1", name: "badge", value: false }, { op: "tweak", board: "b1", name: "accent", value: "#224466" },
                                         { op: "resize", board: "b1", w: 1280, h: 900, x: 0, y: 0 }]);
  // The frame is drawn again with the tweaks set on its root.
  await page.waitForFunction(() => /--accent:#224466;--badge:0/.test(document.querySelector(".dz-board[data-board='b1'] iframe")?.srcdoc || ""));
  assert.match(await page.evaluate(() => document.querySelector(".dz-board[data-board='b1'] iframe").srcdoc), /data-tweak-badge="off"/);
  await shot(page, "tweaks-dark-1280");
  await page.close();
});

test("notes and pages: a sticky note moves and changes colour, a title is added, a page is added, renamed and shown", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  const k = (await scene.ed((d) => d.view())).k;
  const note = await page.locator(".dz-note[data-kind='sticky']").boundingBox();
  await page.mouse.move(note.x + 10, note.y + 10);
  await page.mouse.down(); await page.mouse.move(note.x + 10 + 100 * k, note.y + 10 + 50 * k, { steps: 3 }); await page.mouse.up();
  let edits = await scene.edits();
  assert.equal(edits[0].op, "note_change");
  assert.ok(Math.abs(edits[0].x - 1620) <= 2 && Math.abs(edits[0].y - 918) <= 2, JSON.stringify(edits[0]));
  await page.locator(".dz-acts .dz-swatch[data-color='green']").click();
  await page.locator(".dz-tool[data-tool='note']").click();
  assert.deepEqual(await page.locator(".dz-menu:not([hidden]) .art-menu-item").allInnerTexts(), ["Sticky note", "Title"]);
  await page.locator(".dz-menu:not([hidden]) .art-menu-item", { hasText: "Title" }).click();
  await page.locator(".dz-tool[data-tool='add']").click();
  assert.match((await page.locator(".dz-menu:not([hidden]) .art-menu-item").allInnerTexts())[0], /^Phone · 390 × 844$/);
  await page.locator(".dz-menu:not([hidden]) .art-menu-item", { hasText: "Poster" }).click();
  edits = await scene.edits();
  assert.deepEqual(edits.slice(1).map((e) => [e.op, e.kind || e.color || e.size]), [["note_change", "green"], ["note_add", "title"], ["add", "poster"]]);
  assert.equal(edits[3].page, "p1");
  await scene.clearPosted();
  // Pages are tabs: the second shows its own artboards.
  await page.locator(".dz-tab", { hasText: "Checkout" }).click();
  assert.deepEqual(await page.locator(".dz-board .dz-name-title").allInnerTexts(), ["Cart"]);
  assert.equal(await page.locator(".dz-note").count(), 0);
  await page.locator(".dz-tab", { hasText: "Checkout" }).dblclick();
  await page.locator(".dz-rename").fill("Pay"); await page.keyboard.press("Enter");
  await page.locator(".dz-tab-add").click();
  assert.deepEqual(await scene.edits(), [{ op: "page_rename", page: "p2", name: "Pay" }, { op: "page_add", name: "Page 3" }]);
  await page.close();
});

test("a prototype plays: the sign-in button goes to the welcome screen, a link goes back, Escape stops", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  await scene.ed((d) => d.select({ kind: "board", id: "b2" }));
  await page.locator(".dz-acts [data-act='play']").click();
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b2'] iframe")?.dataset.mode === "play");
  assert.match(await page.locator(".dz-play-words").innerText(), /Playing “Sign in”/);
  let frame = await scene.frameOf("b2");
  // Its own controls work while it plays.
  await frame.locator("#email").fill("me@example.com");
  assert.equal(await frame.locator("#said").innerText(), "Typing…");
  await shot(page, "play-dark-1280");
  await frame.locator("#go").click();
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b3']")?.dataset.playing === "true");
  assert.match(await page.locator(".dz-play-words").innerText(), /Playing “Welcome”/);
  frame = await scene.frameOf("b3");
  assert.equal(await frame.locator("h1").innerText(), "Welcome back, Asha");
  await frame.locator("a").click();                    // <a href="#b2">: the sign-in screen, by its id
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b2']")?.dataset.playing === "true");
  await page.locator(".dz-playbar [aria-label='Back to the artboard before']").click();
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b3']")?.dataset.playing === "true");
  await page.locator(".dz-stop").click();
  assert.equal(await page.locator(".dz-playbar").isHidden(), true);
  assert.equal(await page.evaluate(() => document.querySelector(".dz-board[data-board='b2'] iframe")?.dataset.mode), "view");
  assert.deepEqual(await scene.edits(), [], "playing changes nothing");
  await page.close();
});

test("a comment points at an artboard or a part of it; Ask in chat names it; a thread shows its place again", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open({ offer: { comments: true } });
  const { page } = scene;
  await scene.send({ type: "comments", id: scene.data.view.id, version: 5, threads: [] });
  await scene.ed((d) => d.select({ kind: "board", id: "b3" }));
  await page.locator(".dz-acts [data-act='comment']").click();
  assert.equal(await page.locator(".dgc-cm-compose-on").innerText(), "Artboard “Welcome”");
  await page.locator(".dgc-cm-field").fill("Warmer colours here");
  await page.locator(".dgc-cm-compose button", { hasText: /^Comment$/ }).click();
  let added = (await scene.posted("comments")).find((m) => m.op === "add");
  assert.deepEqual(added.anchor, { kind: "artboard", board: "b3", title: "Welcome" });
  assert.equal(added.ask, false);
  await page.locator(".dz-acts [data-act='ask']").click();
  assert.deepEqual((await scene.posted("askChat"))[0], { type: "askChat", kind: "artboard", board: "b3", title: "Welcome" });
  // A part of one: opened, its headline picked.
  await scene.clearPosted();
  await scene.ed((d) => d.enterInside("b1"));
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b1'] iframe")?.dataset.mode === "edit");
  const frame = await scene.frameOf("b1");
  await frame.locator("h1").click();
  await page.waitForFunction(() => /Part/.test(document.querySelector(".dz-props h2")?.textContent || ""));
  await page.locator(".dz-acts [data-act='comment']").click();
  await page.locator(".dgc-cm-field").fill("Make this shorter");
  await page.locator(".dgc-cm-compose button", { hasText: "Ask DGC" }).click();
  added = (await scene.posted("comments")).find((m) => m.op === "add");
  assert.deepEqual(added.anchor, { kind: "artboard", board: "b1", title: "Desktop", path: "h1#headline", tag: "h1", quote: "Coffee worth waking up for" });
  assert.equal(added.ask, true);
  await page.locator(".dz-acts [data-act='ask']").click();
  assert.equal((await scene.posted("askChat"))[0].path, "h1#headline");
  // A thread's place: the canvas goes to its artboard and picks the part.
  await page.keyboard.press("Escape");
  await scene.ed((d) => { d.leaveInside(); d.select(null); });
  await scene.send({ type: "comments", id: scene.data.view.id, version: 5, threads: [{ id: "t_0123456789ab", anchor: { kind: "artboard", board: "b3", title: "Welcome", quote: "Your usual is ready to order." },
    version: 5, status: "open", at: "2026-10-28T08:40:00Z", by: "you", messages: [{ id: "m_1", by: "you", at: "2026-10-28T08:40:00Z", text: "Friendlier", kind: "comment" }],
    suggestions: [], answering: false, found: "here", where: "the artboard “Welcome”" }] });
  await page.locator("#art-comments .dgc-cm-where").first().click();
  await page.waitForFunction(() => document.querySelector(".dz-board[data-board='b3']")?.dataset.selected === "true");
  await shot(page, "comments-dark-1280");
  await page.close();
});

test("downloads: the header offers the canvas (and the selected artboard first); an artboard's own menu asks for it by its id", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await open();
  const { page } = scene;
  await page.locator("#art-export").click();
  assert.deepEqual(await page.locator("#art-export-menu .art-menu-item").allInnerTexts(),
    ["Every artboard as pictures (.zip)", "PDF, an artboard a page", "The canvas as a web page (.html)"]);
  await page.locator("#art-export-menu .art-menu-item").first().click();
  assert.deepEqual(await scene.posted("export"), [{ type: "export", format: "zip" }]);
  await scene.clearPosted();
  await scene.ed((d) => d.select({ kind: "board", id: "b1" }));
  await page.locator(".dz-acts [data-act='download']").click();
  assert.deepEqual(await page.locator(".dz-acts .art-menu-item").allInnerTexts(),
    ["“Desktop” as a picture (.png)", "“Desktop” as PDF", "“Desktop” as a web page (.html)"]);
  await page.locator(".dz-acts .art-menu-item").first().click();
  assert.deepEqual(await scene.posted("export"), [{ type: "export", format: "png", board: "b1" }]);
  // The file comes back through the download module, said by the button that asked.
  await scene.send({ type: "dgcDownload", name: "Coffee landing - Desktop.png", saved: true });
  await page.waitForFunction(() => /Downloaded/.test(document.body.innerText));
  // A frame not drawn has nothing to download or play.
  await scene.ed((d) => d.select({ kind: "board", id: "b4" }));
  assert.equal(await page.locator(".dz-acts [data-act='download']").isDisabled(), true);
  assert.equal(await page.locator(".dz-acts [data-act='play']").isDisabled(), true);
  await page.locator("#art-export").click();
  assert.equal(await page.locator("#art-export-menu .art-menu-item").count(), 3);
  await page.close();
});

test("many artboards stay light: a few live frames near where you look, still pictures for the rest", async (t) => {
  if (skipOrFail(t)) return;
  const many = clone(data.design);
  many.content.boards = []; many.state.boards = {};
  for (let i = 0; i < 48; i++) {
    const id = `b${i + 1}`;
    many.content.boards.push({ id, page: "p1", title: `Screen ${i + 1}`, x: (i % 8) * 470, y: Math.floor(i / 8) * 964, w: 390, h: 844, fit: "fixed", interactive: false, state: "ready", rev: 1, tweaks: [] });
    many.state.boards[id] = `<!doctype html><html><head><style>body{margin:0;background:#${(i * 5 + 16).toString(16).padStart(2, "0")}66cc;color:#fff;font:40px system-ui}</style></head><body><h1>Screen ${i + 1}</h1></body></html>`;
  }
  many.content.notes = [];
  const scene = await open({ fixture: { design: many } });
  const { page } = scene;
  // Everything in view, each too small to read: all pictures, no live frame.
  await page.waitForFunction(() => document.querySelectorAll(".dz-pic").length === 48);
  assert.equal(await page.locator("iframe.dz-frame").count(), 0);
  assert.match(await page.locator(".dz-pic").first().getAttribute("src"), /^data:image\/svg\+xml/);
  await shot(page, "many-dark-1280");
  // Closer: the frames near the middle come alive, never more than ten; the rest keep their pictures.
  await scene.ed((d) => d.setView({ x: -300, y: -200, k: 0.5 }));
  await page.waitForFunction(() => document.querySelectorAll("iframe.dz-frame").length > 0);
  const live = await page.locator("iframe.dz-frame").count();
  assert.ok(live >= 4 && live <= 10, `${live} live`);
  // Panning does not draw a live frame again (it is the same element after a pan).
  await page.evaluate(() => { for (const f of document.querySelectorAll("iframe.dz-frame")) f.__kept = true; });
  await page.mouse.move(640, 500); await page.mouse.wheel(20, 20);
  await page.waitForTimeout(120);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll("iframe.dz-frame")].filter((f) => f.__kept).length) >= live - 2);
  // A picture is the artboard: its own colours drawn (the first screen's blue), not a blank.
  const pixel = await page.evaluate(async () => {
    const src = window.DgcDesign.pictureOf({ w: 390, h: 844, tweaks: [] }, "<!doctype html><html><head><style>body{margin:0;background:rgb(16,102,204)}</style></head><body><h1>x</h1></body></html>");
    const img = new Image(); await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = src; });
    const c = document.createElement("canvas"); c.width = 390; c.height = 844; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    return [...g.getImageData(300, 700, 1, 1).data];
  });
  assert.deepEqual(pixel, [16, 102, 204, 255]);
  await page.close();
});

test("it fits a narrow panel and both themes; floating parts are solid over a theme whose input background is see-through", async (t) => {
  if (skipOrFail(t)) return;
  for (const [theme, width] of [["dark-modern", 300], ["light-modern", 300], ["dark-modern", 440], ["light-modern", 440], ["dark-modern", 700], ["light-modern", 700],
                                ["light-modern", 1280], ["cursor-dark", 1280], ["cursor-dark", 440], ["light-cursor", 700]]) {
    const scene = await open({ theme, width, height: width < 500 ? 640 : 760 });
    const { page } = scene;
    await scene.ed((d) => d.select({ kind: "board", id: "b1" }));
    await page.waitForTimeout(150);
    // Nothing runs off the side: the toolbar, the actions and the panel are inside the window.
    for (const sel of [".dz-bar", ".dz-acts", ".dz-props", ".dz-tools"]) {
      const b = await page.locator(sel).boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= width + 0.5, `${sel} at ${width} (${theme}): ${JSON.stringify(b)}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no sideways scroll at ${width}`);
    for (const sel of [".dz-acts", ".dz-props"]) {
      const alpha = await page.locator(sel).evaluate((el) => { const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor); const p = m[1].split(/[ ,/]+/); return p.length > 3 ? parseFloat(p[3]) : 1; });
      assert.equal(alpha, 1, `${sel} is solid in ${theme}`);
    }
    // One design language: the tools are the panel's own icon buttons, square and 6 px round, never a pill.
    const tool = await page.locator(".dz-tool").first().evaluate((el) => { const c = getComputedStyle(el); return { r: c.borderRadius, w: el.offsetWidth, h: el.offsetHeight }; });
    assert.equal(tool.r, "6px");
    assert.equal(tool.w, tool.h);
    await shot(page, `selected-${theme}-${width}`);
    await page.close();
  }
});

test("a narrow panel: the properties are a one-line sheet under the canvas, the fit is above it, and a name is whole words", async (t) => {
  if (skipOrFail(t)) return;
  for (const [theme, width] of [["dark-modern", 300], ["light-modern", 300], ["dark-modern", 440], ["light-modern", 440], ["dark-modern", 700], ["light-modern", 700]]) {
    const scene = await open({ theme, width, height: 640 });
    const { page } = scene;
    const names = () => page.evaluate(() => [...document.querySelectorAll(".dz-board")].map((b) => {
      const shown = [...b.querySelectorAll(".dz-name-title, .dz-name-short")].find((n) => getComputedStyle(n).display !== "none");
      const r = shown?.getBoundingClientRect();
      return { full: b.querySelector(".dz-name-title").textContent, shown: shown ? shown.textContent : "", right: r ? r.right : 0, left: r ? r.left : 0,
               size: getComputedStyle(b.querySelector(".dz-name-size")).display !== "none" };
    }));
    // Nothing selected: each name is whole, or its first whole words and an ellipsis, or not shown; never a cut word.
    for (const n of await names()) {
      const words = n.full.split(" ");
      const ok = n.shown === n.full || n.shown === "" || (n.shown.endsWith("…") && words.slice(0, n.shown.slice(0, -1).split(" ").length).join(" ") === n.shown.slice(0, -1));
      assert.ok(ok, `${width} ${theme}: “${n.shown}” of “${n.full}”`);
    }
    // No name runs into the next one.
    const row = (await names()).filter((n) => n.shown);
    for (let i = 1; i < row.length; i++) assert.ok(row[i].left >= row[i - 1].right - 0.5, `${width}: names don't run into each other`);
    await scene.ed((d) => d.select({ kind: "board", id: "b2" }));
    await page.waitForTimeout(250);
    const picked = (await names())[1];
    assert.equal(picked.shown, "Sign in", "the selected artboard's name is whole");
    const stage = await page.locator(".dz-stage").boundingBox(), props = await page.locator(".dz-props").boundingBox();
    if (width <= 560) {
      assert.equal(await page.locator(".dz-props").getAttribute("data-sheet"), "closed");
      assert.ok(props.height <= 44, `${width}: one line (${props.height})`);
      assert.ok(props.y >= stage.y + stage.height - 0.5, `${width}: the sheet is under the canvas, not over it`);
      assert.equal(await page.locator(".dz-props-head h2").innerText(), "Sign in");
      assert.equal(await page.locator(".dz-props-body").isHidden(), true);
      // Everything is fitted in the canvas that is left, at a zoom that uses its width.
      for (const id of ["b1", "b2", "b3", "b4"]) {
        const b = await scene.box(id);
        assert.ok(b.x >= stage.x - 0.5 && b.x + b.width <= stage.x + stage.width + 0.5 && b.y >= stage.y - 0.5 && b.y + b.height <= stage.y + stage.height + 0.5, `${width}: ${id} is in the canvas`);
      }
      const k = (await scene.ed((d) => d.view())).k;
      assert.ok(k * 3294 >= width * 0.84, `${width}: the row uses the width (${Math.round(k * 100)}%)`);
      await shot(page, `sheet-closed-${theme}-${width}`);
      // Opened on demand: its fields show, the canvas above is fitted again, still not covered.
      await page.locator(".dz-sheet-toggle").click();
      await page.waitForTimeout(250);
      assert.equal(await page.locator(".dz-sheet-toggle").getAttribute("aria-expanded"), "true");
      assert.deepEqual(await page.locator(".dz-props .dz-field-label").allInnerTexts(), ["Name", "Width", "Height"]);
      const stage2 = await page.locator(".dz-stage").boundingBox(), props2 = await page.locator(".dz-props").boundingBox(), b2 = await scene.box("b2");
      assert.ok(props2.y >= stage2.y + stage2.height - 0.5 && stage2.height >= 200, `${width}: the canvas keeps its room (${stage2.height})`);
      assert.ok(b2.y + b2.height <= stage2.y + stage2.height + 0.5, `${width}: the selected artboard is above the sheet`);
      await shot(page, `sheet-open-${theme}-${width}`);
    } else {
      assert.equal(await page.locator(".dz-props").getAttribute("data-sheet"), "");
      assert.equal(await page.locator(".dz-props h2").innerText(), "Artboard");
      await shot(page, `panel-${theme}-${width}`);
    }
    await page.close();
  }
});

test("the extension's side: the design is a kind of its own, and the canvas's changes are the commands the process takes", async (t) => {
  if (skipOrFail(t)) return;
  const A = artifactsModule();
  assert.ok(A.ARTIFACT_TYPES.includes("design"));
  const raw = { ...data.design.view };
  const view = A.artifactView(raw);
  assert.deepEqual(view.design, { boards: 5, drawing: 2, pages: 2 });
  assert.equal(A.artifactsOffer({ artifacts: { version: 1, designs: 1 } }).designs, true);
  assert.equal(A.formatLabel("design", "zip"), "Every artboard as pictures (.zip)");
  assert.equal(A.formatLabel("page", "zip"), "Zip of its files (.zip)");
  // A comment's place: an artboard by its id, and nothing else by that name.
  assert.deepEqual(A.commentAnchor({ kind: "artboard", board: "b2", title: "Phone", path: "h1", quote: "Hi", tag: "h1", extra: 1 }),
    { kind: "artboard", quote: "Hi", title: "Phone", path: "h1", tag: "h1", board: "b2" });
  assert.equal(A.commentAnchor({ kind: "artboard", board: "../x" }), undefined);
  // The panel's page: the canvas's script and styles, and the nonce a frame's helper carries.
  const html = A.artifactDocument((name) => name, "vscode-resource:", "N0NCE");
  assert.match(html, /<meta name="dgc-frame-nonce" content="N0NCE">/);
  assert.match(html, /media\/artifactDesign\.css/);
  assert.ok(html.indexOf("media/artifactDesign.js") < html.indexOf("media/artifact.js"));
  assert.match(html, /script-src 'nonce-N0NCE'/);
  assert.ok(panelPage().scripts.includes("media/artifactDesign.js"));

  const sent = [], told = [];
  const hub = new A.Artifacts({ extensionUri: uri("/ext"), globalState: { get: () => undefined, update: async () => {} } });
  hub.attach({ send: (cmd) => { sent.push(cmd); return "sent"; },
               offers: () => A.artifactsOffer({ artifacts: { version: 1, designs: 1, comments: 1, exports: { design: ["png", "pdf", "html", "zip"] } } }) });
  hub.listen((m) => told.push(m));
  hub.open(view.id, { type: "design", title: view.title });
  const panel = world.panels.at(-1);
  panel.say({ type: "ready" });
  const get = sent.find((c) => c.type === "artifact_get");
  hub.onEvent({ type: "artifact_detail", request_id: get.request_id, artifact: raw, content: data.design.content, state: data.design.state });
  assert.equal(panel.last("detail").state.boards.b1.includes("Coffee worth waking up for"), true);
  assert.equal(sent.some((c) => c.type === "artifact_open"), false, "a design is drawn from its content: nothing is served for it");
  // A change on the canvas.
  panel.say({ type: "designEdit", edits: [{ op: "move", board: "b2", x: 10, y: 20 }] });
  const edit = sent.find((c) => c.type === "artifact_design_edit");
  assert.deepEqual(edit.edits, [{ op: "move", board: "b2", x: 10, y: 20 }]);
  hub.onEvent({ type: "artifact_changed", request_id: edit.request_id, artifact: { ...raw, version: 6 }, op: "changed", surface: "editor" });
  assert.equal(panel.last("saved").artifact.version, 6);
  assert.equal(sent.filter((c) => c.type === "artifact_get").length, 2, "and the canvas reads it again");
  // A refusal is said as a save's is (a conflict asks to reload).
  panel.say({ type: "designEdit", edits: [{ op: "change", board: "b1", html: "<p>x</p>", rev: 0 }] });
  const stale = sent.filter((c) => c.type === "artifact_design_edit").at(-1);
  hub.onEvent({ type: "command_rejected", request_id: stale.request_id, reason: "conflict", message: "“Desktop” changed since version 0 of it." });
  assert.deepEqual([panel.last("rejected").what, panel.last("rejected").reason], ["save", "conflict"]);
  // What a page may not send as a change is dropped: a measured height comes its own way and is never a version.
  const before = sent.length;
  panel.say({ type: "designEdit", edits: [{ op: "measured", board: "b1", h: 5000 }] });
  panel.say({ type: "designEdit", edits: "x" });
  assert.equal(sent.length, before);
  panel.say({ type: "designMeasured", board: "b1", h: 2400 });
  assert.deepEqual(sent.at(-1).edits, [{ op: "measured", board: "b1", h: 2400 }]);
  // One artboard's picture: asked by its id, and saved under the name the process gave it.
  const saved = [];
  panel.webview.postMessage = function (m) { this.posted.push(m); if (m.type === "dgcDownload") saved.push(m); return Promise.resolve(true); };
  panel.say({ type: "export", format: "png", board: "b1" });
  const exp = sent.find((c) => c.type === "artifact_export");
  assert.deepEqual([exp.format, exp.board], ["png", "b1"]);
  panel.say({ type: "export", format: "png" });
  assert.equal(sent.filter((c) => c.type === "artifact_export").length, 1, "a picture is of one artboard");
  // Ask in chat: every chat surface hears it; the one it was made in takes it.
  panel.say({ type: "askChat", kind: "artboard", board: "b2", title: "Sign in", path: "button#go", tag: "button", quote: "Sign in" });
  const ask = told.find((m) => m.type === "artifactAsk");
  assert.equal(ask.surface, "work");
  assert.equal(ask.text, `[Artboard “Sign in” of the design “Coffee landing” (${view.id}, b2, button#go) · its <button> “Sign in”] `);
  assert.equal(ask.label, "Sign in · Coffee landing");
  panel.say({ type: "askChat", kind: "artboard", board: "nope" });
  assert.equal(told.filter((m) => m.type === "artifactAsk").length, 1);
});
