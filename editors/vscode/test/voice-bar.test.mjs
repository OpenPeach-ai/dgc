// The voice bar (media/voicebar.js): what DGC's chat, ChatDGC and Pips show in place of a box's bottom row while
// you dictate -- Cancel, a live waveform with the time, Stop (the words go in the box) and Send. In real Chromium:
// the waveform is measured by the ink on its canvas, so a bar that draws nothing, or draws the same for silence as
// for speech, fails here. ChatDGC's flow is in chatdgc-screen.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, buildSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const voicebarJs = readFileSync(join(root, "media/voicebar.js"), "utf8");
const voicebarCss = readFileSync(join(root, "media/voicebar.css"), "utf8");
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
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

/** How much a canvas has drawn: opaque pixels, and the tallest run of them in any column -- of the whole canvas, or
 *  of its newest `recent` CSS pixels at the right (the last few seconds; older bars are still on screen). */
const INK = `(canvas, recent = 0) => {
  const c = canvas.getContext("2d"), { width: w, height: h } = canvas, d = c.getImageData(0, 0, w, h).data;
  const from = recent ? Math.max(0, w - Math.round(recent * w / canvas.clientWidth)) : 0;
  let ink = 0, tallest = 0;
  for (let x = from; x < w; x++) { let col = 0; for (let y = 0; y < h; y++) if (d[(y * w + x) * 4 + 3] > 40) { ink++; col++; } tallest = Math.max(tallest, col); }
  return { ink, tallest: tallest / h };
}`;

/** Feeds a page's box speech-like levels (or silence) the way the host does: a batch every 100 ms. */
const feed = (page, from, speech, ms) => page.evaluate(([from, speech, ms]) => new Promise((done) => {
  let t = 0;
  const timer = setInterval(() => {
    t += 100;
    const levels = speech ? [0.06 + 0.08 * Math.abs(Math.sin(t / 90)), 0.1 + 0.05 * Math.abs(Math.cos(t / 70))] : [0.0005, 0.0004];
    window.postMessage({ type: "micLevels", ...(from ? { from } : {}), levels }, "*");
    if (t >= ms) { clearInterval(timer); setTimeout(done, 250); }
  }, 100);
}), [from, speech, ms]);

test("the bar: the waveform rises with speech and lies flat in silence; quiet for three seconds says so; one box's bar never draws another's", async (t) => {
  if (skipOrFail(t)) return;
  const page = await browser.newPage({ viewport: { width: 700, height: 300 } });
  try {
    await page.setContent(`<style>${voicebarCss} body{background:#1f1f1f;color:#ddd;font:13px sans-serif} .box{width:600px;margin:20px}</style>
      <div class="box" id="a"></div><div class="box" id="b"></div><div class="box" id="shadow-host"></div>`);
    await page.addScriptTag({ content: voicebarJs });
    await page.evaluate(() => {
      window.A = DgcVoiceBar.create("a"); document.getElementById("a").innerHTML = A.markup();
      window.B = DgcVoiceBar.create("b"); document.getElementById("b").innerHTML = B.markup();
      // a box in a shadow root (Pips in the side bar)
      const shadow = document.getElementById("shadow-host").attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>${document.querySelector("style").textContent}</style>`;
      window.S = DgcVoiceBar.create("s", shadow); shadow.innerHTML += S.markup();
      window.addEventListener("message", (e) => { if (e.data?.type === "micLevels") { A.push(e.data.levels); S.push(e.data.levels); } });
    });
    const ink = (sel, recent = 0) => page.evaluate(([sel, INK, recent]) => {
      const host = sel === "s" ? document.getElementById("shadow-host").shadowRoot : document;
      return eval(INK)(host.querySelector(`[data-voicebar="${sel}"] canvas`), recent);
    }, [sel, INK, recent]);
    // Starting: words, not a waveform; only Cancel works yet.
    await page.evaluate(() => { A.state("starting"); S.state("starting"); });
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-status]').textContent(), "Starting the microphone…");
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-action="stop"]').isDisabled(), true);
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-action="cancel"]').isDisabled(), false);

    await page.evaluate(() => { A.state("recording"); S.state("recording"); });
    await feed(page, "", true, 1500);
    const speaking = await ink("a"), shadowSpeaking = await ink("s"), other = await ink("b");
    assert.ok(speaking.tallest > 0.5, `speech draws tall bars: ${JSON.stringify(speaking)}`);
    assert.ok(shadowSpeaking.tallest > 0.5, `in a shadow root too: ${JSON.stringify(shadowSpeaking)}`);
    assert.equal(other.ink, 0, "an idle box's bar is untouched");
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-status]').textContent(), "", "no words over a waveform that's moving");
    assert.match(await page.locator('[data-voicebar="a"] [data-voice-time]').textContent(), /^0:0[12]$/);
    const bars = await page.evaluate(() => A.bars.filter((v) => v >= 0));
    assert.ok(bars.length >= 6 && bars.length <= 9, `one bar per 200 ms: ${bars.length}`);

    // Silence: the bars that scroll in lie flat, and after three seconds the bar says it hears nothing.
    await feed(page, "", false, 3600);
    // The last ~3 s: 15 bars of 6 px at the right (the speech before is further left, still on screen).
    const silent = await ink("a", 84);
    assert.ok(silent.ink > 0 && silent.tallest < 0.25, `silence is flat, not blank: ${JSON.stringify(silent)}`);
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-status]').textContent(), "Not hearing anything — check your microphone");
    assert.equal(await page.locator('[data-voicebar="a"]').getAttribute("data-quiet"), "");
    await feed(page, "", true, 400);
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-status]').textContent(), "", "speech again: the warning goes");

    // Writing it down: words in place of the waveform, the pressed button spins, nothing else can be pressed.
    await page.evaluate(() => A.state("writing", "send"));
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-status]').textContent(), "Writing it down…");
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-action="send"]').getAttribute("data-busy"), "");
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-action="stop"]').getAttribute("data-busy"), null);
    assert.equal(await page.locator('[data-voicebar="a"] [data-voice-action="cancel"]').isDisabled(), true);
    // A box that redraws its whole bar (Pips) gets the same state on the new one.
    await page.evaluate(() => { document.getElementById("a").innerHTML = A.markup(); });
    await page.waitForTimeout(60);
    assert.equal(await page.locator('[data-voicebar="a"]').getAttribute("data-state"), "writing");
    if (process.env.DGC_SHOTS) await page.screenshot({ path: join(process.env.DGC_SHOTS, "voicebar-states.png") });
  } finally { await page.close(); }
});

// ---- main DGC's chat ----------------------------------------------------------------------------------------

async function mainPage(width = 520) {
  const panelSrc = readFileSync(join(root, "src/panel.ts"), "utf8");
  const css = readFileSync(join(root, "media/main.css"), "utf8"), codicon = readFileSync(join(root, "media/codicon.css"), "utf8");
  const mainJs = readFileSync(join(root, "media/main.js"), "utf8");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown",
    write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((c) => c.includes('id="input"')).replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "");
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setContent(skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style><style>${voicebarCss}</style></head>`), { waitUntil: "load" });
  await page.evaluate(([vb, mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(vb);
    eval(mjs);
    window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
  }, [voicebarJs, mainJs, markdownJs]);
  const posted = (type) => page.evaluate((type) => window.__posted.filter((m) => m.type === type), type);
  // Delivered at once (a posted message arrives later, and a check right after would race it).
  const say = (m) => page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), m);
  return { page, posted, say, errors };
}

test("main DGC's chat: the microphone beside Send; while it records the footer is the voice bar; Stop puts the words at the caret, Send sends them", async (t) => {
  if (skipOrFail(t)) return;
  const { page, posted, say, errors } = await mainPage();
  try {
    const footer = page.locator("#cfooter"), bar = page.locator('#cvoice [data-voicebar="chat"]');
    assert.equal(await page.locator("#btn-mic").isVisible(), true);
    assert.equal(await bar.isVisible(), false);
    await page.locator("#input").click();
    await page.keyboard.type("Plan a trip to Lisbon");
    await page.evaluate(() => {   // the caret after "Plan a trip"
      const node = document.getElementById("input").firstChild, r = document.createRange();
      r.setStart(node, 11); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.locator("#btn-mic").click();
    assert.deepEqual(await posted("micStart"), [{ type: "micStart", from: "chat" }]);
    assert.equal(await footer.isVisible(), false, "the footer gives way to the voice bar");
    assert.equal(await bar.isVisible(), true);
    assert.equal(await bar.getAttribute("data-state"), "starting");
    await say({ type: "mic", from: "chat", state: "recording" });
    await feed(page, "chat", true, 1200);
    const drawn = await page.evaluate((INK) => eval(INK)(document.querySelector('#cvoice canvas')), INK);
    assert.ok(drawn.tallest > 0.5, `the waveform moves with the voice: ${JSON.stringify(drawn)}`);
    // The Pips box on the same page dictates on its own: its messages leave this box alone.
    await say({ type: "mic", from: "pips", state: "idle" });
    assert.equal(await bar.getAttribute("data-state"), "recording");
    // The bar sits where the footer was, inside the box, in order: Cancel, waveform, Stop, Send.
    const box = await page.locator("#cbox").boundingBox();
    const at = async (s) => page.locator(`#cvoice ${s}`).boundingBox();
    const [cancel, wave, stop, send] = [await at('[data-voice-action="cancel"]'), await at("canvas"), await at('[data-voice-action="stop"]'), await at('[data-voice-action="send"]')];
    assert.ok(cancel.x >= box.x && send.x + send.width <= box.x + box.width + 1, "inside the box");
    assert.ok(cancel.x < wave.x && wave.x + wave.width <= stop.x && stop.x < send.x, "Cancel, waveform, Stop, Send");
    assert.ok(wave.width > box.width * 0.5, `the waveform has the room: ${wave.width} of ${box.width}`);
    if (process.env.DGC_SHOTS) await page.locator("#cbox").screenshot({ path: join(process.env.DGC_SHOTS, "voicebar-main.png") });

    await page.locator('#cvoice [data-voice-action="stop"]').click();
    assert.deepEqual(await posted("micStop"), [{ type: "micStop", mode: "insert", from: "chat" }]);
    assert.equal(await bar.getAttribute("data-state"), "writing");
    await say({ type: "mic", from: "chat", state: "idle", text: "for two people", mode: "insert" });
    assert.equal(await footer.isVisible(), true);
    assert.equal(await page.locator("#input").innerText(), "Plan a trip for two people to Lisbon");

    // Send: the words go in, and the message goes.
    await page.locator("#input").press("End");
    await page.locator("#btn-mic").click();
    await say({ type: "mic", from: "chat", state: "recording" });
    await page.locator('#cvoice [data-voice-action="send"]').click();
    assert.deepEqual((await posted("micStop")).at(-1), { type: "micStop", mode: "send", from: "chat" });
    const before = (await page.evaluate(() => window.__posted.length));
    await say({ type: "mic", from: "chat", state: "idle", text: "Book the hotel too.", mode: "send" });
    let sent;
    for (let i = 0; i < 40 && !sent; i++) {
      sent = (await page.evaluate((n) => window.__posted.slice(n), before)).find((m) => m.type === "prompt");
      if (!sent) await page.waitForTimeout(50);
    }
    assert.ok(sent, "the message went, with what was said");
    assert.equal(sent.text, "Plan a trip for two people to Lisbon Book the hotel too.");

    // Esc cancels; nothing lands.
    await page.locator("#btn-mic").click();
    await say({ type: "mic", from: "chat", state: "recording" });
    await page.locator("#input").press("Escape");
    assert.deepEqual((await posted("micCancel")).at(-1), { type: "micCancel", from: "chat" });
    assert.equal(await footer.isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

// ---- Pips ----------------------------------------------------------------------------------------------------

test("Pips, in the side bar's shadow root: the same microphone, the same bar in place of the controls, the words into the Pip's box", async (t) => {
  if (skipOrFail(t)) return;
  const client = (await build({ entryPoints: [join(root, "src/pipsClient.js")], bundle: true, write: false, format: "iife", loader: { ".css": "empty" } })).outputFiles[0].text;
  const css = ["src/pips.css", "src/pipsTranscript.css", "media/voicebar.css"].map((f) => readFileSync(join(root, f), "utf8").replace(/^@import[^;]+;/gm, "")).join("\n");
  const page = await browser.newPage({ viewport: { width: 520, height: 700 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.route("**/*", (route) => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: "text/html", body: '<style>html,body{margin:0;height:100%;background:#1f1f1f}#host{width:100%;height:100%}</style><div id="host"></div>' })
      : route.abort());
    await page.goto("https://pips-voice.invalid/");
    await page.addScriptTag({ content: client });
    await page.evaluate((css) => {
      window.__posted = [];
      window.setInterval = (fn) => { window.__pipPoll = fn; return 1; };
      const ws = { id: "ws", name: "Project" };
      const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
        description: "Read committed source", available: ["rook", "scout", "lens", "lock"].includes(id), unavailable_reason: ["rook", "scout", "lens", "lock"].includes(id) ? null : "Unavailable",
        default_name: id, default_goal: "Read source", engine: ["rook", "scout", "lens", "lock"].includes(id) ? "source_audit" : null }));
      const pip = { id: "a", workspace_id: "ws", pip_type: "rook", name: "Review a", goal: "Inspect source", source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", proposals: [], model_choice: { mode: "default" } };
      const runner = { runner_id: "runner", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } };
      const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "The provider may interpret thinking levels differently.", context_note: "The provider can enforce a smaller window." };
      const result = (r) => ({ list_workspaces: { workspaces: [ws], current_workspace_id: "ws" }, list_pip_types: { types }, list_pips: { pips: [pip] }, list_pip_setups: { setups: [] },
        get_workspace_context: { context: { workspace_id: "ws", revision: 0, entries: [] } }, get_pip_runner: { runner }, get_pip: { pip }, list_pip_runs: { runs: [] },
        list_pip_models: { default_model: "local-default", models: [{ id: "model-a", name: "Local A" }], connection: "configured" },
        list_pip_messages: { pip_id: "a", workspace_id: "ws", messages: [], next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls },
        send_pip_message: { message: { id: "u1", pip_id: "a", workspace_id: "ws", role: "user", text: r.text, created_at: "2026-10-12T10:00:00Z", status: "succeeded" } } }[r.type]);
      const shadow = document.getElementById("host").attachShadow({ mode: "open" });
      let receive;
      window.__receive = (m) => receive(m);
      window.DgcPips.mount({ root: shadow, stylesheetText: css, onMessage: (fn) => { receive = fn; },
        postMessage: (msg) => { window.__posted.push(msg); queueMicrotask(() => {
          if (msg.type === "pipsReady") receive({ type: "pipsConnection", apiVersion: 24, generation: 1, connected: true, supported: true, enabled: true });
          else if (msg.type === "pipsRequest") { const answer = result(msg.request); if (answer !== undefined) receive({ type: "pipsReply", id: msg.id, ok: true, result: answer }); }
        }); } });
    }, css);
    await page.locator("[data-job=a]").click();
    await page.locator("#chatText").waitFor({ state: "visible" });
    const posted = (type) => page.evaluate((type) => window.__posted.filter((m) => m.type === type), type);
    const say = (m) => page.evaluate((m) => window.__receive(m), m);
    assert.equal(await page.locator("#chat-mic").isVisible(), true, "a microphone beside Send");
    await page.locator("#chatText").fill("Remind me at four");
    await page.locator("#chatText").evaluate((el) => el.setSelectionRange(9, 9));   // after "Remind me"
    await page.locator("#chat-mic").click();
    assert.deepEqual(await posted("micStart"), [{ type: "micStart", from: "pips" }]);
    const bar = page.locator('[data-voicebar="pips"]');
    assert.equal(await bar.isVisible(), true);
    assert.equal(await page.locator("#chat-model").count(), 0, "the bar takes the controls' place");
    await say({ type: "mic", from: "pips", state: "recording" });
    // The page's main chat dictating is none of this box's business.
    await say({ type: "mic", from: "chat", state: "idle", text: "not mine" });
    for (let i = 0; i < 12; i++) { await say({ type: "micLevels", from: "pips", levels: [0.09, 0.12] }); await page.waitForTimeout(100); }
    await page.waitForTimeout(250);
    const drawn = await page.evaluate((INK) => eval(INK)(document.getElementById("host").shadowRoot.querySelector('[data-voicebar="pips"] canvas')), INK);
    assert.ok(drawn.tallest > 0.5, `the waveform moves in the shadow root: ${JSON.stringify(drawn)}`);
    if (process.env.DGC_SHOTS) await page.locator("#chat-form").screenshot({ path: join(process.env.DGC_SHOTS, "voicebar-pips.png") });

    await bar.locator('[data-voice-action="send"]').click();
    assert.deepEqual((await posted("micStop")).at(-1), { type: "micStop", mode: "send", from: "pips" });
    await say({ type: "mic", from: "pips", state: "idle", text: "to call the dentist", mode: "send" });
    await page.waitForTimeout(100);
    const sent = (await posted("pipsRequest")).filter((m) => m.request.type === "send_pip_message");
    assert.equal(sent.length, 1, "the Pip got the message");
    assert.equal(sent[0].request.text, "Remind me to call the dentist at four", "at the caret, though the box was redrawn while it recorded");
    assert.equal(await page.locator("#chat-model").count(), 1, "the controls are back");

    // Esc cancels.
    await page.locator("#chat-mic").click();
    await say({ type: "mic", from: "pips", state: "recording" });
    await page.locator("#chatText").press("Escape");
    assert.deepEqual((await posted("micCancel")).at(-1), { type: "micCancel", from: "pips" });
    assert.equal(await page.locator("#chat-model").count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
