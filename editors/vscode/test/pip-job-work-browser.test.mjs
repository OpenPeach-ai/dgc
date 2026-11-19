// @ a Pip (Pips API 111) in Work's transcript, in real Chromium: the real panel page (media/main.js with the shared
// modules it loads, media/shared/pipjob.js among them) fed a reloaded history, at 300, 440 and 700 px, dark and light.
// The session handed Tile checker a job with ask_pip; the card comes back from the step's answer (so a reload draws it),
// reads the job through the editor (pipJob / pipJobReply, the window's Pips channel), and shows the answer and the
// change with Apply, Review and Discard; the turn DGC started to tell the model is the Pip's own note ("Tile checker
// answered"), never a bubble of the user's. Read from the DOM and geometry; with DGC_PICTURES_DIR set, also pictures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { BODY_CLASS, THEMES } from "./support/agent-lines-scene.mjs";
import { readStylesheet } from "./support/stylesheet.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const PICTURES = process.env.DGC_PICTURES_DIR || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });

const read = (name) => readFileSync(join(root, name), "utf8");
let assets;
function load() {
  if (assets) return assets;
  const panel = read("src/panel.ts");
  const skeleton = [...panel.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0]).find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  const codicon = read("media/codicon.css").replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);
  const js = ["media/shared/menu.js", "media/shared/icons.js", "media/shared/composer.js", "media/shared/tray.js", "media/shared/card.js", "media/shared/pipjob.js",
              "media/mentions.js", "media/pips/plush.js", "media/main.js"].map(read).join("\n");
  const md = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  assets = { html: skeleton.replace("</head>", `<style>${codicon}</style><style>${readStylesheet(join(root, "media/main.css"))}</style></head>`), js, md };
  return assets;
}

const JOB = "pipjob_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), CHANGE = "pchange_" + "c".repeat(32);
const at = new Date(Date.now() - 4 * 60000).toISOString();
const job = (over = {}) => ({ id: JOB, pip: { id: PIP, name: "Tile checker", pip_type: "patch", status: "active" }, words: "check billing/tax.py's rounding and fix it if it's wrong",
  about: "", asked_from: { kind: "work", id: "s1", title: "Tidy the October invoices" }, state: "done", state_words: "Answered", folder: { name: "lime_tiles", own: true },
  answer: "tax_for rounded to one decimal place, so 0.18 × 12.35 came out as 2.2 instead of 2.22. I changed it to round to cents in my copy.",
  change: { id: CHANGE, status: "pending", name: "lime_tiles", digest: "d".repeat(64), files: [{ path: "billing/tax.py", change: "modified", plus: 1, minus: 1 }], more: 0, plus: 1, minus: 1, result: null },
  created_at: at, updated_at: at, ended_at: at, ...over });
const history = [
  { type: "turn_start", turn_id: "h1", prompt: "Tile checker check billing/tax.py's rounding and fix it if it's wrong", kind: "prompt" },
  { type: "tool_call", call_id: "c1", name: "ask_pip", args: { pip: "Tile checker", job: "check billing/tax.py's rounding and fix it if it's wrong", about: "" }, summary: "Hand Tile checker a job" },
  { type: "tool_result", call_id: "c1", name: "ask_pip", output: `Handed to Tile checker (job ${JOB}). Its answer comes back to this chat as a card, and DGC tells you when it is done. Tile checker is working on it.`, is_error: false, is_diff: false },
  { type: "text_delta", text: "Tile checker has it: it's checking the rounding in its own copy of lime_tiles." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
  { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" },
  { type: "turn_start", turn_id: "h2", prompt: "pip-job: Tile checker · answered", kind: "monitor" },
  { type: "text_delta", text: "Tile checker found the rounding bug and fixed it in its copy: Apply on its card puts it in your folder." }, { type: "stream_end", message_id: "h2:1", phase: "answer" },
  { type: "turn_end", turn_id: "h2", reason: "completed", final_message_id: "h2:1" }];

async function open(width, theme) {
  const { html, js, md } = load();
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme] || ""} }` });
  await page.evaluate((cls) => { document.body.classList.add(cls); document.documentElement.dataset.pipsDocumentId = "doc1"; }, BODY_CLASS[theme] || "vscode-dark");
  await page.evaluate(([code, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
    window.__post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
    window.__post({ type: "session_ready", sessionId: "s1" });
    window.__post({ type: "event", event: { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { history_snapshot: true }, model: "deepseek-v4.1-flash:cloud", mode: "default",
      think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" } });
  }, [js, md]);
  await page.evaluate((items) => window.__post({ type: "event", event: { type: "history", items, complete: true } }), history);
  let now = job();
  const answered = new Set();
  const serve = async () => {
    for (const m of await page.evaluate(() => window.__posted.filter((x) => x.type === "pipJob"))) {
      if (answered.has(m.id)) continue;
      answered.add(m.id);
      if (m.request.type === "apply_pip_project_change") now = job({ change: { ...job().change, status: "applied", result: { applied: ["billing/tax.py"], held_back: [] } } });
      const result = m.request.type === "get_pip_job" ? { job: now } : {};
      await page.evaluate(([id, r]) => window.__post({ type: "pipJobReply", id, ok: true, result: r }), [m.id, result]);
    }
  };
  for (let i = 0; i < 40 && !(await page.locator('.pipjob[data-state="done"] .pipjob-change').count()); i++) { await serve(); await page.waitForTimeout(50); }
  return { page, errors, serve };
}
const look = (page, selector) => page.evaluate((s) => { const n = document.querySelector(s); if (!n) return null; const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: r.left, right: r.right, height: Math.round(r.height), radius: c.borderTopLeftRadius, cut: n.scrollWidth > n.clientWidth + 1, shown: n.checkVisibility({ visibilityProperty: true }), text: n.textContent.replace(/\s+/g, " ").trim() }; }, selector);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`${theme} at ${width}px: Work's turn that handed the job shows its card; the answer's turn is the Pip's note`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors, serve } = await open(width, theme);
    try {
      assert.deepEqual(errors, []);
      assert.equal((await look(page, ".pipjob .dgc-card-title"))?.text, "Tile checker answered");
      assert.match((await look(page, ".pipjob .dgc-card-sub")).text, /for this session · Open its chat$/);
      assert.equal((await look(page, ".pipjob .pipjob-change")).text, "1 file · +1 −1 · not in your folder yet");
      assert.ok(await page.locator(".pipjob .dgc-card-face .dgc-plush").count(), "the Pip's own face");
      for (const [sel, what] of [['.pipjob [data-pipjob-act="apply"]', "Apply"], ['.pipjob [data-pipjob-act="review"]', "Review"]]) {
        const b = await look(page, sel);
        assert.ok(b?.shown && b.radius === "6px" && [26, 28].includes(b.height) && !b.cut, `${what}: shown, 6 px corner, a button height, whole (${JSON.stringify(b)})`);
      }
      const note = await look(page, ".pip-job-note");
      assert.equal(note?.text, "Tile checker answered", "DGC's turn, drawn as the Pip's note");
      assert.equal(await page.locator('.pip-job-note .note-icon[data-icon="message-square"]').count(), 1, "a message mark, never the generic fallback");
      assert.equal(await page.locator(".msg.user:has-text('pip-job:')").count(), 0, "never a bubble of the user's");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "nothing scrolls sideways");
      const asked = await page.evaluate(() => window.__posted.filter((m) => m.type === "pipJob").map((m) => [m.request.type, m.request.job_id]));
      assert.deepEqual(asked[0], ["get_pip_job", JOB], "the job, through the editor's Pips channel");
      if (PICTURES) {
        await page.evaluate(() => document.querySelector(".pipjob").scrollIntoView({ block: "center" }));
        await page.waitForTimeout(120);
        await page.screenshot({ path: join(PICTURES, `work-${theme.split("-")[0]}-${width}.png`) });
      }
      await page.click('.pipjob [data-pipjob-act="apply"]');
      for (let i = 0; i < 40 && !(await page.locator('.pipjob [data-pipjob-act="undo"]').count()); i++) { await serve(); await page.waitForTimeout(40); }
      const sent = await page.evaluate(() => window.__posted.find((m) => m.type === "pipJob" && m.request.type === "apply_pip_project_change")?.request);
      assert.deepEqual(sent, { type: "apply_pip_project_change", pip_id: PIP, change_id: CHANGE, expected_digest: "d".repeat(64) });
      assert.equal((await look(page, ".pipjob .pipjob-change")).text, "1 file · +1 −1 · applied to your folder");
      await page.click('.pipjob [data-pipjob-act="open"]');
      const opened = await page.evaluate(() => window.__posted.filter((m) => m.type === "pipJobOpen").map((m) => [m.pip.id, m.pip.name]));
      assert.deepEqual(opened, [[PIP, "Tile checker"]]);
    } finally { await page.close(); }
  });
}
