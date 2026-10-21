// Memory that learns, on screen: the quiet "Remembered: … · Forget" line a Work session's look back adds; /learn's
// skill card, written only on Save; Settings → Memory's history with Undo; a Personal Pip's working notes, daily
// log and /learn card (Pips API 57). The one memory DGC keeps, improved: never a second one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { makeDom, panelSrc } from "./support/webview-dom.mjs";

const require = createRequire(import.meta.url);
const src = fileURLToPath(new URL("../src/", import.meta.url));
const windows = [];
after(() => windows.forEach((w) => w.close()));

// ---- Work: the line and the card -------------------------------------------------------------

test("Work: what a look back kept shows once as a quiet line, and Forget forgets it everywhere", () => {
  const { doc, send, posted, errors } = makeDom();
  send({ type: "event", event: { type: "memory_learned", surface: "work",
    facts: [{ id: "mem_aaaaaaaaaaaa", text: "Prefers pnpm over npm", kind: "preference" }, { id: "not-an-id", text: "x" }] } });
  const line = doc.querySelector("#log .memory-learned");
  assert.ok(line, "the line is in the chat");
  assert.equal(line.getAttribute("role"), "note");
  assert.match(line.textContent, /Remembered: Prefers pnpm over npm · Forget/);
  assert.doesNotMatch(line.textContent, /not-an-id|: x/, "only a real memory");
  line.querySelector(".memory-learned-forget").click();
  assert.deepEqual({ ...posted.at(-1) }, { type: "memoryForgetFact", id: "mem_aaaaaaaaaaaa" });
  assert.match(line.textContent, /Forgotten: Prefers pnpm over npm/);
  assert.equal(line.querySelector("button"), null, "Forget once");
  assert.deepEqual(errors, []);
});

test("Work: /learn shows the skill with Save, Edit and Cancel, and writes nothing until Save", () => {
  const { doc, send, posted, errors } = makeDom();
  send({ type: "learn_started", requestId: "learn-1", request: "pnpm setup" });
  assert.match(doc.querySelector("#log .learn-card").textContent, /Writing a skill from this session: pnpm setup…/);
  const markdown = "---\nname: pnpm-setup\ndescription: \"Set a repo up to use pnpm.\"\n---\n\n# pnpm setup\n\n## Steps\n1. Run `corepack enable`.";
  send({ type: "event", event: { type: "skill_draft", request_id: "learn-1", ok: true, name: "pnpm-setup",
    description: "Set a repo up to use pnpm.", markdown, scope: "project", folder: "/w/proj/.dgc/skills" } });
  const card = doc.querySelector("#log .learn-card");
  assert.match(card.textContent, /New skill: pnpm-setup/);
  assert.match(card.textContent, /Set a repo up to use pnpm\./);
  assert.match(card.textContent, /Save puts it in this project's skills \(\.dgc\/skills\)\. Nothing is written until you save\./);
  assert.match(card.querySelector(".learn-body").textContent, /Run corepack enable/, "the skill itself, shown");
  assert.doesNotMatch(card.querySelector(".learn-body").textContent, /description:/, "its frontmatter isn't");
  const buttons = () => [...card.querySelectorAll("button")].map((b) => b.textContent);
  assert.deepEqual(buttons(), ["Save", "Edit", "Cancel"]);
  assert.equal(posted.filter((m) => m.type === "learnSave").length, 0, "nothing saved yet");
  [...card.querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
  const area = card.querySelector("textarea.learn-edit");
  assert.equal(area.value, markdown);
  area.value = markdown.replace("corepack enable", "corepack enable pnpm");
  area.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  [...card.querySelectorAll("button")].find((b) => b.textContent === "Save").click();
  const save = posted.findLast((m) => m.type === "learnSave");
  assert.equal(save.scope, "project");
  assert.match(save.markdown, /corepack enable pnpm/, "the edited skill is what's saved");
  assert.ok([...card.querySelectorAll("button")].every((b) => b.disabled), "one Save at a time");
  send({ type: "event", event: { type: "skill_saved", request_id: save.requestId, ok: false,
    message: "A skill named pnpm-setup already exists. Change its name in Edit, then save." } });
  assert.match(card.querySelector("[role=alert]").textContent, /already exists/);
  assert.ok(![...card.querySelectorAll("button")].some((b) => b.disabled), "it can be fixed and saved again");
  send({ type: "event", event: { type: "skill_saved", request_id: save.requestId, ok: true, name: "pnpm-setup",
    path: "/w/proj/.dgc/skills/pnpm-setup/SKILL.md", scope: "project" } });
  assert.match(card.textContent, /Saved the skill pnpm-setup\..*Undo is in Settings → Memory\./);
  card.querySelector(".learn-memory").click();
  assert.deepEqual({ ...posted.at(-1) }, { type: "openSettings", section: "memory" });
  assert.deepEqual(errors, []);
});

test("Work: Cancel discards the draft, and a draft that couldn't be written says why", () => {
  const { doc, send, posted } = makeDom();
  send({ type: "event", event: { type: "skill_draft", request_id: "learn-2", ok: true, name: "x-skill", description: "Do x.",
    markdown: "---\nname: x-skill\ndescription: Do x.\n---\n\nDo it.", scope: "user", folder: "/home/u/.dgc/skills" } });
  const card = doc.querySelector("#log .learn-card");
  assert.match(card.textContent, /your own skills \(~\/\.dgc\/skills\)/);
  [...card.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
  assert.match(card.textContent, /Not saved: the skill x-skill was discarded\./);
  assert.equal(posted.filter((m) => m.type === "learnSave").length, 0);
  send({ type: "event", event: { type: "skill_draft", request_id: "learn-3", ok: false,
    message: "There's nothing here to learn from yet: do the task first, then /learn." } });
  assert.match(doc.querySelectorAll("#log .learn-card")[1].textContent, /nothing here to learn from yet/);
});

test("the panel asks for the line only from a backend that offers it, and routes /learn", () => {
  assert.match(panelSrc, /memory\?\.learned\) >= 1\) \{\s*this\.backend\?\.send\(\{ type: "memory_watch"/);
  assert.match(panelSrc, /if \(name === "learn"\) \{ this\.learn\(rest\); return; \}/);
  assert.match(panelSrc, /learn\?\.version\) >= 1\)\) \{[\s\S]*?Update the DGC CLI to turn what you just did into a skill/);
  assert.match(panelSrc, /type: "learn_skill", request_id: requestId/);
  assert.match(panelSrc, /case "learnSave": \{[\s\S]*?type: "save_skill"/);
  assert.match(panelSrc, /case "memoryForgetFact": \{[\s\S]*?type: "memory_forget"/);
  assert.match(panelSrc, /"memory_state", "memory_history"\]\.includes\(ev\.type\)/, "Settings → Memory gets the history");
});

// ---- Settings → Memory: who, when, and Undo ----------------------------------------------------

const settings = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false,
  loader: { ".css": "empty", ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" }, format: "iife" });
const settingsView = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
const settingsModule = { exports: {} };
new Function("module", "exports", settingsView.outputFiles[0].text)(settingsModule, settingsModule.exports);
function settingsPage() {
  const dom = new JSDOM(settingsModule.exports.settingsDocument(), { runScripts: "outside-only" });
  const w = dom.window; windows.push(w);
  const sent = [];
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
  w.eval(settings.outputFiles[0].text);
  const message = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  message({ type: "event", event: { type: "config", base_url: "https://m.example/v1", model: "m", mode: "default", think: "off" } });
  return { w, d: w.document, sent, message, click: (s) => w.document.querySelector(s).click() };
}
const state = { type: "memory_state", enabled: true, projects: [], facts: [
  { id: "mem_aaaaaaaaaaaa", text: "Pays bills with UPI", kind: "preference", created_at: "2026-10-20T10:00:00Z",
    updated_at: "2026-10-20T10:00:00Z", source: { surface: "chat", where: "Bills", by: "review" } },
  { id: "mem_bbbbbbbbbbbb", text: "Is in Goa until Friday", kind: "fact", until: "2026-10-18", expired: true,
    created_at: "2026-10-15T10:00:00Z", updated_at: "2026-10-15T10:00:00Z", source: { surface: "work", where: "proj", by: "tool" } }] };
const history = { type: "memory_history", entries: [
  { id: "memj_000000000003", at: "2026-10-21T09:15:00Z", op: "learn", by: "you", surface: "work", where: "proj",
    text: "pnpm-setup", scope: "project", path: "/w/proj/.dgc/skills/pnpm-setup/SKILL.md", undone: false, undoable: true },
  { id: "memj_000000000002", at: "2026-10-21T09:10:00Z", op: "forget", by: "you", surface: "pip", where: "",
    text: "Lives in Pune", undone: false, undoable: true },
  { id: "memj_000000000001", at: "2026-10-21T09:00:00Z", op: "add", by: "review", surface: "chat", where: "Bills",
    text: "Pays bills with UPI", kind: "preference", undone: true, undoable: false }] };

test("Settings → Memory: each fact says its kind, where it was learned and when it stops; the history has Undo", () => {
  const x = settingsPage();
  x.click("[data-nav=memory]");
  assert.deepEqual(x.sent.slice(-2).map((m) => m.type), ["getMemory", "getMemoryHistory"]);
  x.message({ type: "event", event: state });
  const facts = x.d.querySelector(".memory-facts").textContent;
  assert.match(facts, /Preference · Learned from a chat: Bills · 2026-10-20/);
  assert.match(facts, /Fact · From a Work session: proj · 2026-10-15 · ended 2026-10-18, no longer used/);
  assert.match(x.d.querySelector(".memory-history summary").textContent, /History/);
  assert.match(x.d.body.textContent, /Reading the history…/);
  x.message({ type: "event", event: history });
  const rows = [...x.d.querySelectorAll(".memory-change")];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Saved the skill pnpm-setup \(this project\).*By you in Work \(proj\) · 2026-10-21 09:15/);
  assert.match(rows[1].textContent, /Forgot “Lives in Pune”.*By you in a Pip/);
  assert.match(rows[2].textContent, /Learned “Pays bills with UPI”.*By DGC, looking back over a conversation in ChatDGC \(Bills\).*undone/);
  assert.equal(rows[2].querySelector("button"), null, "an undone change has no Undo");
  rows[1].querySelector("[data-memory-undo]").click();
  assert.deepEqual({ ...x.sent.at(-1) }, { type: "memoryUndo", id: "memj_000000000002" });
  x.message({ type: "event", event: { ...history, request_id: "memory-1", error: "It's already back." } });
  assert.match(x.d.querySelector(".memory-history [role=alert]").textContent, /already back/);
  x.click("[data-memory-clear]");
  assert.match(x.d.querySelector("[role=alertdialog]").textContent, /Undo in History brings them back\./);
});

test("Settings → Memory on an older CLI: no history, and Delete all still says it can't be undone", () => {
  const x = settingsPage();
  x.click("[data-nav=memory]");
  x.message({ type: "memory_history_unavailable" });
  x.message({ type: "event", event: state });
  assert.equal(x.d.querySelector(".memory-history"), null);
  x.click("[data-memory-clear]");
  assert.match(x.d.querySelector("[role=alertdialog]").textContent, /This can't be undone\./);
});
