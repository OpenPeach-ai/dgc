// Videos in Work (0.51): every generate_video step shows its Allow card with the length, resolution and price, and no
// Always; the turn's video is drawn under its reply in the same row a picture is (media/videoPlayer.js), first as its
// job's progress with Stop, then as a player once video_job says it's made; a replayed chat asks for its job's state.
// media/main.js in Chromium with a scripted event stream (setContent only; no port is opened).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, html, mainJs, markdownJs, playerJs;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  mainJs = readFileSync(here + "/../media/mentions.js", "utf8") + "\n" + readFileSync(here + "/../media/main.js", "utf8");
  playerJs = readFileSync(here + "/../media/videoPlayer.js", "utf8");
  markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  html = skeleton.replace("</head>", `<style>${css}</style></head>`);
});
after(async () => { await browser?.close(); });

async function openPanel() {
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(([pjs, mjs, mdjs]) => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posts.push(m); }, getState: () => undefined, setState() {} });
    document.body.classList.add("vscode-dark");
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(pjs);
    eval(mjs);
  }, [playerJs, mainJs, markdownJs]);
  const panel = {
    page, errors,
    events: (list) => page.evaluate(async (items) => {
      for (const event of items) {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
        await new Promise((done) => setTimeout(done, 2));
      }
    }, list),
    host: (message) => page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), message),
    posts: () => page.evaluate(() => window.__posts),
    settle: () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 60)))),
  };
  await panel.events([{ type: "ready", capabilities: { history_snapshot: true }, model: "m", mode: "default", think: "off",
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" }]);
  return panel;
}

const JOB = "vid_" + "a1b2c3d4e5f6";
const CARD = { prompt: "a felt ball rolls across a desk", generator: "fal Wan 2.2", label: "fal Wan 2.2 5B", provider: "fal.ai",
  model: "fal-ai/wan/v2.2-5b/text-to-video", length: "5 s", duration_s: 5, resolution: "720p", aspect: "16:9", audio: false,
  price: "about $0.15", facts: "5 s · 720p · about $0.15", minutes: "about 1–2 min", video: true,
  this_month: "$0.20 of your $5.00 limit" };
const turn = () => [
  { type: "turn_start", turn_id: "t1", prompt: "Animate the felt ball", kind: "prompt" },
  { type: "tool_call", call_id: "v1", name: "generate_video", args: { prompt: CARD.prompt }, summary: "fal Wan 2.2" },
  { type: "tool_result", call_id: "v1", name: "generate_video", is_error: false, is_diff: false,
    output: `Started a 5 s video with fal Wan 2.2 5B (720p, about $0.15), about 1–2 min (job ${JOB}). It's made in the background.` },
  { type: "text_delta", text: "It's on its way." },
  { type: "stream_end", message_id: "t1:2", phase: "answer" },
  { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:2" },
];

test("Work: a video's Allow card has its length, resolution, price and spend, and no Always", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel();
  try {
    await panel.events([{ type: "turn_start", turn_id: "t1", prompt: "Make a clip", kind: "prompt" },
      { type: "permission_request", id: "p1", call_id: "v1", name: "generate_video", args: CARD, summary: "",
        suggested_rule: "GenerateVideo", choices: ["once", "deny"] }]);
    await panel.settle();
    const card = await panel.page.evaluate(() => {
      const c = document.querySelector(".card[data-request-id]");
      return { title: c.querySelector(".q").textContent.trim(), facts: c.querySelector(".perm-facts")?.textContent,
               prompt: c.querySelector(".perm-prompt")?.textContent, buttons: [...c.querySelectorAll(".btns button")].map((b) => b.textContent) };
    });
    assert.equal(card.title, "Make this video with fal Wan 2.2 5B?");
    assert.equal(card.facts, "5 s · 720p · about $0.15 · this month $0.20 of your $5.00 limit · about 1–2 min");
    assert.equal(card.prompt, CARD.prompt);
    assert.deepEqual(card.buttons, ["Make it · about $0.15", "Edit", "Don't"]);
    await panel.events([{ type: "permission_request", id: "p2", call_id: "v2", name: "generate_video", choices: ["once", "deny"],
      args: { ...CARD, over_limit: true, note: "This would pass this month's $0.30 limit on this key, so it can't be made." } }]);
    await panel.settle();
    const blocked = await panel.page.evaluate(() => {
      const c = [...document.querySelectorAll(".card[data-request-id]")].find((n) => n.dataset.requestId === "p2");
      return { make: c.querySelector('[data-d="once"]').disabled, note: c.querySelector(".perm-note")?.textContent };
    });
    assert.equal(blocked.make, true, "a clip past the limit can't be made from its card");
    assert.match(blocked.note, /can't be made/);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.page.close(); }
});

test("Work: the video is under its reply, its progress with Stop, then its player", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel();
  try {
    await panel.events(turn());
    await panel.settle();
    const queued = await panel.page.evaluate(() => {
      const row = document.querySelector(".answer > .made-pictures");
      const fig = row?.querySelector("figure.made-image.made-video");
      return { row: !!row, label: row?.getAttribute("aria-label"), state: fig?.dataset.state, stop: !!fig?.querySelector(".video-stop"),
               words: fig?.querySelector(".video-words")?.textContent || "" };
    });
    assert.equal(queued.row, true, "in the same row pictures are drawn in");
    assert.equal(queued.label, "The video this turn made");
    assert.equal(queued.state, "queued");
    assert.equal(queued.stop, true);
    assert.ok((await panel.posts()).some((m) => m.type === "videoJobs" && m.job === JOB), "its job's state is asked for");
    const started = Math.floor(Date.now() / 1000) - 24;
    await panel.events([{ type: "video_job", job: { id: JOB, state: "running", status: "fal is making it", label: "fal Wan 2.2 5B",
      started, duration_s: 5, resolution: "720p", price: "about $0.15", can_stop: true } }]);
    await panel.settle();
    const words = await panel.page.locator("figure.made-video .video-words").textContent();
    assert.match(words, /^fal Wan 2\.2 5B: fal is making it · 0:2[4-6]$/);
    await panel.page.click("figure.made-video .video-stop");
    assert.ok((await panel.posts()).some((m) => m.type === "videoStop" && m.job === JOB), "Stop goes to the host");
    await panel.events([{ type: "video_job", job: { id: JOB, state: "done", status: "made", label: "fal Wan 2.2 5B", started,
      finished: started + 70, resolution: "720p", cost_usd: 0.15, can_stop: false,
      result: { path: "/home/me/.dgc/videos/sessions/s1/a-felt-ball.mp4", file: "a-felt-ball.mp4", bytes: 2_200_000, seconds: 5,
                width: 1280, height: 720, poster: "/home/me/.dgc/videos/sessions/s1/a-felt-ball.jpg" } } }]);
    await panel.settle();
    const asked = (await panel.posts()).find((m) => m.type === "videoData");
    assert.equal(asked?.path, "/home/me/.dgc/videos/sessions/s1/a-felt-ball.mp4", "the bytes are asked of the host");
    await panel.host({ type: "videoData", requestId: asked.requestId, mime: "video/mp4", data: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      poster: "data:image/jpeg;base64,/9j/" });
    await panel.settle();
    const done = await panel.page.evaluate(() => {
      const fig = document.querySelector("figure.made-video");
      const video = fig.querySelector("video");
      return { state: fig.dataset.state, controls: video?.controls, src: video?.src.slice(0, 5), poster: video?.poster.slice(0, 15),
               facts: fig.querySelector(".video-facts")?.textContent, name: fig.querySelector(".video-name")?.textContent,
               actions: [...fig.querySelectorAll(".video-actions button")].map((b) => b.textContent),
               badge: document.querySelector('.tool[data-tool-name="generate_video"] .badge')?.textContent };
    });
    assert.deepEqual(done, { state: "done", controls: true, src: "blob:", poster: "data:image/jpeg", facts: "0:05 · 1280×720 · 2.1 MB",
                             name: "a-felt-ball.mp4", actions: ["Open", "Show in folder", "Save to project…"], badge: "made" });
    await panel.page.click("figure.made-video .video-actions button:nth-child(2)");
    assert.ok((await panel.posts()).some((m) => m.type === "videoReveal" && m.path.endsWith("a-felt-ball.mp4")));
    assert.deepEqual(panel.errors, []);
  } finally { await panel.page.close(); }
});

test("Work: a failed or stopped video says what happened, in the same place", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel();
  try {
    await panel.events(turn());
    await panel.events([{ type: "video_job", job: { id: JOB, state: "cancelled", label: "fal Wan 2.2 5B", duration_s: 5,
      charged: "It hadn't started, so nothing was charged." } }]);
    await panel.settle();
    assert.equal(await panel.page.locator("figure.made-video .video-said").textContent(),
      "Stopped the video with fal Wan 2.2 5B. It hadn't started, so nothing was charged.");
  } finally { await panel.page.close(); }
});

test("Work: a turn a video woke says so, not that a monitor did", async (t) => {
  if (skipOrFail(t)) return;
  const panel = await openPanel();
  try {
    await panel.events([{ type: "turn_start", turn_id: "t2", prompt: "video: fal Wan 2.2 5B · ended", kind: "monitor" }]);
    await panel.settle();
    assert.equal(await panel.page.locator(".monitor-note").last().innerText(), "Woke as a video ended · fal Wan 2.2 5B");
  } finally { await panel.page.close(); }
});

test("removed players release blobs and ignore late data, including shadow roots", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<body></body>", { runScripts: "outside-only" });
  const w = dom.window, sent = [], created = [], revoked = [];
  w.CSS = { escape: String };
  w.URL.createObjectURL = () => { const url = `blob:${created.length}`; created.push(url); return url; };
  w.URL.revokeObjectURL = (url) => revoked.push(url);
  w.eval(readFileSync(here + "/../media/videoPlayer.js", "utf8"));
  w.DgcVideo.host((m) => sent.push(m));
  const settle = () => new Promise((resolve) => w.setTimeout(resolve, 0));
  try {
    for (const shadow of [false, true]) {
      const host = w.document.body.appendChild(w.document.createElement("div"));
      const root = shadow ? host.attachShadow({ mode: "open" }) : host;
      for (let i = 0; i < 3; i++) {
        const fig = w.DgcVideo.figure({ id: `job${i}`, state: "done", result: { path: "/tmp/clip.mp4" } });
        root.append(fig);
        await settle();
        w.DgcVideo.message({ type: "videoData", requestId: sent.at(-1).requestId, data: new Uint8Array([1]) });
        assert.match(fig.querySelector("video").src, /^blob:/);
        fig.remove();
        await settle();
        assert.deepEqual(revoked, created);
      }
      const late = w.DgcVideo.figure({ id: "late", state: "done", result: { path: "/tmp/late.mp4" } });
      root.append(late);
      await settle();
      late.remove();
      w.DgcVideo.message({ type: "videoData", requestId: sent.at(-1).requestId, data: new Uint8Array([1]) });
      await settle();
      assert.deepEqual(revoked, created, "late replies cannot retain new blobs");
      host.remove();
    }
    assert.equal(created.length, 6);
  } finally { w.close(); }
});

test("ChatDGC and Pip cached figures play again after removal", async () => {
  const { JSDOM } = await import("jsdom");
  for (const surface of ["chat", "pip"]) {
    const w = new JSDOM("<body></body>", { runScripts: "outside-only" }).window;
    const sent = [], revoked = [];
    w.CSS = { escape: String };
    w.URL.createObjectURL = () => `blob:${sent.length}`;
    w.URL.revokeObjectURL = (url) => revoked.push(url);
    w.eval(readFileSync(here + "/../media/videoPlayer.js", "utf8"));
    w.DgcVideo.host((m) => sent.push(m));
    const job = { id: "vid_0123456789ab", state: "done", result: { path: "/tmp/clip.mp4" } };
    // Run the actual cache/hydration functions with only their surrounding page services stubbed.
    if (surface === "pip") {
      const source = readFileSync(here + "/../src/pipsClient.js", "utf8");
      w.eval(`const root = document, S = { messages: [{ videos: [${JSON.stringify(job)}] }] };
        ${source.slice(source.indexOf("const messageVideos=new Map();"), source.indexOf("function hydrateMessageImages()"))}
        window.drawVideo = () => {
          document.body.innerHTML = '<div data-message-video="${job.id}"></div>';
          hydrateMessageVideos();
        };`);
    } else {
      const source = readFileSync(here + "/../media/chatdgc.js", "utf8");
      w.eval(`const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls || ''; e.textContent = text || ''; return e; };
        const cardMark = () => el('span'), foldPictures = (_key, box) => box;
        ${source.slice(source.indexOf("const videoFigures = new Map();"), source.indexOf("  function actionCard("))}
        window.drawVideo = () => document.body.replaceChildren(videoCard({ id: 'message' },
          { id: 'card', status: 'done', job: '${job.id}', video: ${JSON.stringify(job.result)} }, false));`);
    }
    try {
      for (let i = 0; i < 2; i++) {
        w.drawVideo();
        await new Promise((resolve) => w.setTimeout(resolve, 0));
        assert.equal(sent.filter((m) => m.type === "videoData").length, i + 1, `${surface}: reopened player requests bytes`);
        w.DgcVideo.message({ type: "videoData", requestId: sent.at(-1).requestId, data: new Uint8Array([1]) });
        assert.match(w.document.querySelector("video").src, /^blob:/);
        w.document.body.replaceChildren();
        await new Promise((resolve) => w.setTimeout(resolve, 0));
        assert.equal(revoked.length, i + 1);
      }
    } finally { w.close(); }
  }
});
