// Videos in Settings, ChatDGC, a Pip's chat, the Library and the extension host (0.51): Settings → Models → "Images &
// video" says what each generator makes and its price per second, "Asks before each video" (on unless the user turns it
// off here) and + Add generator with a video model; a Pip reply's videos get the shared player; and the host reads only a
// video DGC made (or one the backend reported), and a job's state without its provider handle.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const result = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false,
  loader: { ".css": "empty", ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" }, format: "iife" });
const code = result.outputFiles[0].text;
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const windows = [];
const scratch = mkdtempSync(join(tmpdir(), "dgc-videos-pages-"));
after(() => { windows.forEach((w) => w.close()); rmSync(scratch, { recursive: true, force: true }); });

const fal = { id: "fal", name: "fal FLUX schnell", provider: "fal", provider_name: "fal.ai", base_url: "https://fal.run",
  model: "fal-ai/flux/schnell", size: "1024x1024", enabled: true, asks: true, paid: true, local: false, price_usd: 0.003,
  price: "about $0.003", default: true, has_key: true, key_from: "saved", spent_this_month_usd: 0.012, makes: "images",
  key_spent_this_month_usd: 0.162 };
const wan = { id: "fal-wan-2-2-5b", name: "fal Wan 2.2 5B", provider: "fal", provider_name: "fal.ai", base_url: "https://fal.run",
  model: "fal-ai/wan/v2.2-5b/text-to-video", size: "1024x1024", enabled: true, asks: true, paid: true, local: false,
  price_usd: null, price: "price unknown", default: false, has_key: true, key_from: "saved", spent_this_month_usd: 0.15,
  key_spent_this_month_usd: 0.162, monthly_limit_usd: 5, makes: "videos",
  video: { model: "fal-ai/wan/v2.2-5b/text-to-video", label: "fal Wan 2.2 5B", durations: [1, 2, 3, 4, 5], default_duration_s: 5,
    resolutions: ["720p"], aspects: ["16:9", "9:16", "1:1"], audio: "no", start_image: true,
    price_per_s: "about $0.03/s ($0.15 a 5 s clip at 720p)", price_usd_default: 0.15, minutes: "about 1–2 min", asks: true, pips: [] } };

function settings(statusValue, videos = true) {
  const dom = new JSDOM(viewModule.exports.settingsDocument(), { runScripts: "outside-only", pretendToBeVisual: true });
  const { window: w } = dom;
  windows.push(w);
  const sent = [];
  let current = statusValue;
  const message = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  w.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage: (m) => {
    sent.push(m);
    if (m.type !== "imagesCommand") return;
    queueMicrotask(() => message({ type: "imagesReply", token: m.token, ok: true, status: current }));
  } });
  w.CSS = w.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
  w.eval(code);
  message({ type: "event", event: { type: "config", base_url: "https://model.example/v1", model: "m", mode: "default", images_capable: true,
    videos_capable: videos } });
  message({ type: "show", section: "models" });
  return { w, d: w.document, sent, settle: () => new Promise((r) => setTimeout(r, 10)), $: (s) => w.document.querySelector(s),
           commands: () => JSON.parse(JSON.stringify(sent.filter((m) => m.type === "imagesCommand").map((m) => m.command))) };
}
const status = () => ({ generators: [structuredClone(fal), structuredClone(wan)], default: "fal", auto_fallback: false, save_dir: "",
  project_choice: "", chosen: "", through_plugins: ["Runway", "Higgsfield"] });

test("Settings: Images & video says what each generator makes, its price per second, and asks before each video", async () => {
  const x = settings(status());
  await x.settle();
  assert.equal(x.$("#models-images h3").textContent, "Images & video");
  const card = x.$('[data-images-gen="fal-wan-2-2-5b"]');
  assert.match(card.textContent, /Makes videos · about \$0\.03\/s \(\$0\.15 a 5 s clip at 720p\) · about 1–2 min · 1–5 s · 720p/);
  assert.match(card.textContent, /This month: \$0\.16 of \$5\.00 on its key/, "its limit is read against everything on its key");
  assert.equal(card.querySelector("[data-images-asks]"), null, "no picture switch on a video model");
  const vasks = card.querySelector("[data-images-video-asks]");
  assert.equal(vasks.getAttribute("aria-checked"), "true", "on until the user turns it off here");
  assert.match(card.textContent, /Shows the price first, every time/);
  vasks.click();
  await x.settle();
  assert.deepEqual(x.commands().at(-1), { type: "images_update", action: "edit_generator", generator: "fal-wan-2-2-5b", video_asks: false });
});

test("Settings: + Add generator makes a video model of fal, Gemini or Replicate, or a ComfyUI video workflow", async () => {
  const x = settings(status());
  await x.settle();
  x.$("[data-images-add]").click();
  await x.settle();
  const makes = x.$("#images-add-makes");
  makes.value = "videos";
  // As a browser does for one choice: input, then change (each reads the form).
  makes.dispatchEvent(new x.w.Event("input", { bubbles: true }));
  makes.dispatchEvent(new x.w.Event("change", { bubbles: true }));
  await x.settle();
  const providers = [...x.$("#images-add-provider").options].map((o) => o.value);
  assert.deepEqual(providers, ["fal", "gemini", "replicate", "comfyui"]);
  const models = [...x.$("#images-add-video-model").options].map((o) => o.textContent);
  assert.equal(models[0], "Wan 2.2 5B · $0.15 a clip (cheapest)", "the cheapest good fal model first");
  assert.match(x.$("[data-images-adding]").textContent, /blank: the key its pictures use/);
  x.$("[data-images-add-go]").click();
  await x.settle();
  const added = x.commands().find((c) => c.action === "add_generator");
  assert.deepEqual(added, { type: "images_update", action: "add_generator", provider: "fal", makes: "videos",
                            model: "fal-ai/wan/v2.2-5b/text-to-video" });
});

test("A Pip reply's videos are placeholders the page fills with the shared player", async () => {
  const transcript = await import(src + "pipsTranscript.js");
  const markup = transcript.messageMarkup({ id: "m1", role: "assistant", text: "Started it.", run_id: "r1", created_at: "2026-11-02T10:00:00Z",
    status: "succeeded", videos: [{ id: "vid_0123456789ab", state: "running" }] },
    { name: "Pip", formatDate: () => "", renderMarkdown: (t) => t, prompt: false, canSend: true });
  assert.match(markup, /<div class="msg-videos made-pictures"><div class="msg-video" data-message-video="vid_0123456789ab"><\/div><\/div>/);
});

test("The host reads only a video DGC made or one the backend reported, and a job without its handle", async () => {
  const home = join(scratch, "home");
  mkdirSync(join(home, ".dgc", "videos", "jobs"), { recursive: true });
  mkdirSync(join(home, ".dgc", "videos", "sessions", "s1"), { recursive: true });
  writeFileSync(join(home, ".dgc", "videos", "sessions", "s1", "ball.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
  writeFileSync(join(home, ".dgc", "videos", "jobs", "vid_0123456789ab.json"), JSON.stringify({ id: "vid_0123456789ab", state: "done",
    handle: { request_id: "secret-handle" }, label: "fal Wan 2.2 5B", result: { path: join(home, ".dgc", "videos", "sessions", "s1", "ball.mp4") } }));
  const outside = join(scratch, "project", "intro.mp4");
  mkdirSync(join(scratch, "project"), { recursive: true });
  writeFileSync(outside, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  globalThis.__DGC_TEST_VSCODE = { Uri: { file: (p) => ({ fsPath: p }) }, env: { openExternal: async () => true },
    commands: { executeCommand: async () => undefined }, window: { showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {} },
    workspace: { workspaceFolders: [] } };
  const bundle = join(scratch, "videoHost.cjs");
  await build({ entryPoints: [src + "videoHost.ts"], bundle: true, format: "cjs", platform: "node", outfile: bundle, logLevel: "silent",
    plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "t" }));
      b.onLoad({ filter: /^vscode$/, namespace: "t" }, () => ({ contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js" })); } }] });
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const host = createRequire(import.meta.url)(bundle);
    const posted = [];
    await host.handleVideoMessage({ type: "videoData", requestId: "r1", path: join(home, ".dgc", "videos", "sessions", "s1", "ball.mp4") }, (m) => posted.push(m));
    assert.equal(posted[0].mime, "video/mp4");
    assert.equal(posted[0].data.length, 12, "the bytes, for a blob: URL");
    await host.handleVideoMessage({ type: "videoData", requestId: "r2", path: outside }, (m) => posted.push(m));
    assert.equal(posted[1].error, "DGC shows only the videos it made.", "a project file nobody reported isn't read");
    host.allowFromJobs({ result: { path: outside } });
    await host.handleVideoMessage({ type: "videoData", requestId: "r3", path: outside }, (m) => posted.push(m));
    assert.equal(posted[2].mime, "video/mp4", "one the backend reported (save_to) is");
    await host.handleVideoMessage({ type: "videoData", requestId: "r4", path: "/etc/passwd" }, (m) => posted.push(m));
    assert.match(posted[3].error, /only the videos it made/);
    await host.handleVideoMessage({ type: "videoJob", requestId: "r5", job: "vid_0123456789ab" }, (m) => posted.push(m));
    assert.equal(posted[4].job.state, "done");
    assert.equal(posted[4].job.handle, undefined, "never the provider's handle");
    assert.equal(posted[4].job.can_stop, false);
  } finally {
    process.env.HOME = before;
    delete globalThis.__DGC_TEST_VSCODE;
  }
});

test("Settings: an older CLI (no ready.capabilities.videos) is offered no video model, so it is never sent one", async () => {
  const x = settings({ ...status(), generators: [structuredClone(fal)] }, false);
  await x.settle();
  x.$("[data-images-add]").click();
  await x.settle();
  assert.equal(x.$("#images-add-makes"), null);
});

test("The host passes a video generator's fields on to DGC, checked, and nothing else", async () => {
  const built = await build({ entryPoints: [src + "imagesCommands.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
  const mod = { exports: {} };
  new Function("module", "exports", built.outputFiles[0].text)(mod, mod.exports);
  const { imagesCommand } = mod.exports;
  assert.deepEqual(imagesCommand({ type: "images_update", action: "add_generator", provider: "fal", makes: "videos",
    model: "fal-ai/wan/v2.2-5b/text-to-video" }),
    { type: "images_update", action: "add_generator", provider: "fal", makes: "videos", model: "fal-ai/wan/v2.2-5b/text-to-video" });
  assert.deepEqual(imagesCommand({ type: "images_update", action: "edit_generator", generator: "w", video_asks: false,
    video_pips: ["pip_abc"], makes: "movies" }),
    { type: "images_update", action: "edit_generator", generator: "w", video_asks: false, video_pips: ["pip_abc"] });
  assert.deepEqual(imagesCommand({ type: "images_update", action: "add_generator", provider: "comfyui", workflow: { 6: { class_type: "CLIPTextEncode", inputs: { text: "" } } },
    mapping: { prompt: "6.text", frames: "55.length", fps: "57.fps", evil: "x.y" } }).mapping, { prompt: "6.text", frames: "55.length", fps: "57.fps" });
});


function library(view = "videos") {
  const w = new JSDOM("<body>" + ["views", "about", "search", "list", "more", "status", "origins", "kinds", "made"]
    .map((id) => id === "search" ? '<input id="lib-search">' : `<div id="lib-${id}"></div>`).join("") + "</body>",
    { runScripts: "outside-only" }).window;
  windows.push(w);
  const sent = [];
  w.acquireVsCodeApi = () => ({ getState: () => ({ view }), setState() {}, postMessage: (m) => sent.push(m) });
  w.eval(readFileSync(src + "../media/library.js", "utf8"));
  const message = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  const $ = (selector) => w.document.querySelector(selector);
  return { w, sent, message, $, latest: (type) => sent.filter((m) => m.type === type).at(-1),
    async search(text) { $("#lib-search").value = text; $("#lib-search").dispatchEvent(new w.Event("input"));
      await new Promise((resolve) => setTimeout(resolve, 280)); } };
}
const videoReply = (request, text, extra = {}) => ({ type: "videos", seq: request.seq, offset: request.offset,
  videos: [{ path: `/tmp/${text}.mp4`, prompt: text }], total: 1, next: null, ...extra });

test("Library ignores stale video searches, pagination and surface replies", async () => {
  const x = library();
  x.message({ type: "videosOffered", on: true });
  const old = x.latest("videoList");
  await x.search("new");
  const current = x.latest("videoList");
  x.message(videoReply(current, "NEW RESULT", { next: 1 }));
  x.message(videoReply(old, "OLD RESULT", { total: 99, counts: { work: 99 } }));
  assert.match(x.$("#lib-list").textContent, /NEW RESULT/);
  assert.doesNotMatch(x.$("#lib-list").textContent, /OLD RESULT/);
  assert.equal(x.$("#lib-more").hidden, false, "stale next/counts cannot change the current list");
  x.$("#lib-more").click();
  const page = x.latest("videoList");
  await x.search("latest");
  const latest = x.latest("videoList");
  x.message(videoReply(page, "OLD PAGE"));
  assert.equal(x.$("#lib-status").textContent, "Loading…");
  x.message(videoReply(latest, "LATEST RESULT", { counts: { work: 1 } }));
  assert.doesNotMatch(x.$("#lib-list").textContent, /OLD PAGE/);
  [...x.w.document.querySelectorAll("#lib-made button")].find((b) => b.textContent.startsWith("Work")).click();
  const filtered = x.latest("videoList");
  assert.equal(filtered.surface, "work");
  x.message(videoReply(filtered, "WORK RESULT"));
  x.message(videoReply(latest, "WRONG SURFACE"));
  assert.match(x.$("#lib-list").textContent, /WORK RESULT/);
  assert.doesNotMatch(x.$("#lib-list").textContent, /WRONG SURFACE/);
});

test("Library keeps video and Work image errors through render and clears them on retry", () => {
  for (const kind of ["videos", "workImages"]) {
    const x = library(kind === "videos" ? "videos" : "files");
    x.message({ type: kind === "videos" ? "videosOffered" : "workImagesOffered", on: true });
    const requestType = kind === "videos" ? "videoList" : "workImages";
    const reply = { type: kind, seq: x.latest(requestType).seq, offset: 0, videos: [], images: [], total: 0, next: null,
      error: "The saved files could not be read. Try again." };
    x.message(reply);
    if (kind === "workImages") x.message({ type: "library", files: [], total: 0, next: null });
    assert.equal(x.$("#lib-status").textContent, reply.error);
    assert.equal(x.$("#lib-status").hidden, false);
    x.message({ type: "refresh" });
    assert.doesNotMatch(x.$("#lib-status").textContent, /could not be read/);
    x.message({ ...reply, seq: x.latest(requestType).seq, error: undefined });
    assert.doesNotMatch(x.$("#lib-status").textContent, /could not be read/);
  }
});

test("Library host echoes video request sequence on success and failure", async () => {
  const bundled = await build({ entryPoints: [src + "chatdgc.ts"], bundle: true, write: false, format: "cjs", platform: "node",
    external: ["vscode"] });
  const mod = { exports: {} }, require = createRequire(import.meta.url);
  new Function("module", "exports", "require", bundled.outputFiles[0].text)(mod, mod.exports,
    (name) => name === "vscode" ? {} : require(name));
  const chat = new mod.exports.ChatDGC({});
  const sent = [], panel = { webview: { postMessage: (m) => sent.push(m) } };
  chat.host = { videosOffered: () => true, videosLibrary: async () => ({ videos: [], total: 0 }) };
  await chat.libraryVideos(panel, { seq: 11, query: "new" });
  assert.equal(sent.at(-1).seq, 11);
  chat.host.videosLibrary = async () => { throw new Error("read failed"); };
  await chat.libraryVideos(panel, { seq: 12, query: "new" });
  assert.equal(sent.at(-1).seq, 12);
  assert.equal(sent.at(-1).error, "read failed");
});
