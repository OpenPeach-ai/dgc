// @ a Pip (Pips API 111): a job a chat handed a Pip is ONE card, drawn by one module (media/shared/pipjob.js, with
// media/shared/card.css and pipjob.css) in Work's transcript, a ChatDGC reply and a Pip's chat. It reads the job with
// get_pip_job while it goes, says where it stands in plain words, shows the Pip's answer, and its change with Apply,
// Review, Discard and Undo: the SAME change id the Pip's chat shows, so Apply here is the command the Pip's chat sends.
// In the Pip's own chat the job is its "From <where it was asked>: <the words>" line, and one waiting at Ask me first is
// a card with Start and Not now. Every page loads the one module and keeps no copy of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const JOB = "pipjob_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), CHANGE = "pchange_" + "c".repeat(32);

function world() {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/card.js") + "\n" + read("media/shared/pipjob.js"));
  return { dom, J: dom.window.DgcPipJob, doc: dom.window.document };
}
const job = (over = {}) => ({ id: JOB, pip: { id: PIP, name: "Tax check", pip_type: "lens", status: "active" },
  words: "check billing/tax.py's rounding", about: "", asked_from: { kind: "work", id: "sess-1", title: "Tidy the October invoices" },
  state: "done", state_words: "Answered", answer: "Rounding was half-down; I fixed it in my copy.", folder: { name: "lime_tiles", own: true },
  change: { id: CHANGE, status: "pending", name: "lime_tiles", digest: "d".repeat(64), files: [{ path: "billing/tax.py", change: "modified", plus: 2, minus: 1 }],
            more: 0, plus: 2, minus: 1, result: null },
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ended_at: new Date().toISOString(), ...over });
const text = (node) => node.textContent.replace(/\s+/g, " ").trim();
const tick = () => new Promise((r) => setTimeout(r, 0));
const plain = (v) => JSON.parse(JSON.stringify(v));   // (made in the page's own realm)

test("every surface loads the one module and keeps no copy of its own", () => {
  const panel = read("src/panel.ts"), chatdgc = read("src/chatdgc.ts"), pips = read("src/pipsClient.js"), css = read("media/main.css");
  assert.match(panel, /"media", "shared", "pipjob\.js"/);
  assert.ok(panel.indexOf("${pipJobJs}") > panel.indexOf("${cardJs}"), "after the card it draws with");
  assert.match(chatdgc, /media\/shared\/pipjob\.js/);
  assert.match(css, /@import url\("\.\/shared\/pipjob\.css"\);/, "Work and ChatDGC (whose page loads main.css) both have its look");
  assert.match(pips, /import '\.\.\/media\/shared\/pipjob\.js';/);
  assert.match(pips, /import '\.\.\/media\/shared\/pipjob\.css';/);
  // Work's and ChatDGC's cards read the job through the window's Pips channel, only with the commands a card sends.
  assert.match(panel, /case "pipJob": \{/);
  assert.match(chatdgc, /case "pipJob": \{/);
  const view = read("src/pipsView.ts");
  assert.match(view, /pipJob\(type: string, fields: Record<string, unknown>\): Promise<any> \{/);
  assert.match(view, /'get_pip_job', 'start_pip_job', 'decline_pip_job', 'get_pip_project_change', 'apply_pip_project_change',\s+'discard_pip_project_change', 'undo_pip_project_change'/);
  for (const page of ["media/main.js", "media/chatdgc.js", "src/pipsClient.js"])
    assert.ok(!/function changeLine|pipjob-diff-add/.test(read(page)), `${page} draws no job card of its own`);
});

test("a tool's answer names its job, and only a job", () => {
  const { J } = world();
  assert.equal(J.jobIdIn(`Handed to Tax check (job ${JOB}). Its answer comes back…`), JOB);
  assert.equal(J.jobIdIn("Handed to Tax check."), "");
  assert.equal(J.TOOL, "ask_pip");
  assert.equal(J.API, 111);
});

test("each state in plain words, the answer, and the change with Apply, Review, Discard and Open its chat", () => {
  const { J, doc } = world();
  const draw = (value, place = "work") => { const box = doc.createElement("div"); box.innerHTML = J.markup(J.checked(value), { place }); return box.firstElementChild; };
  const done = draw(job());
  assert.equal(done.querySelector(".dgc-card-title").textContent, "Tax check answered");
  assert.match(done.querySelector(".dgc-card-sub").textContent, /for this session · Open its chat$/);
  assert.match(text(done.querySelector(".pipjob-answer")), /Rounding was half-down/);
  assert.equal(text(done.querySelector(".pipjob-change")), "1 file · +2 −1 · not in your folder yet");
  assert.deepEqual([...done.querySelectorAll(".dgc-card-actions button")].map((b) => b.textContent), ["Apply", "Review", "Discard"]);
  assert.equal(done.querySelector(".dgc-card-sub .pipjob-open").textContent, "Open its chat", "in the quiet line under the title");
  assert.ok(done.querySelector('[data-pipjob-act="apply"]').classList.contains("primary"), "one filled answer");
  assert.ok(done.querySelector('[data-pipjob-act="discard"]').classList.contains("dgc-card-link"), "Discard is the quiet link");
  assert.equal(done.querySelectorAll(".dgc-card-actions svg").length, 0, "words only: no action wears an icon of its own");
  assert.ok(done.querySelector(".dgc-card-face"), "the Pip's face");
  const applied = draw(job({ change: { ...job().change, status: "applied", result: { applied: ["billing/tax.py"], held_back: [], by: "pip-level:full" } } }));
  assert.equal(text(applied.querySelector(".pipjob-change")), "1 file · +2 −1 · applied by itself (Do it all)");
  assert.deepEqual([...applied.querySelectorAll(".dgc-card-actions button")].map((b) => b.textContent), ["Undo", "Review"]);
  const working = draw(job({ state: "working", state_words: "Working in its own copy", answer: undefined, change: null, ended_at: undefined }));
  assert.equal(working.querySelector(".dgc-card-title").textContent, "Tax check is on it");
  assert.match(text(working.querySelector(".dgc-card-sub")), /Working in its own copy · Open its chat/);
  assert.ok(working.querySelector(".dgc-card-sub .pipjob-pulse"), "a slow pulse while it works");
  const queued = draw(job({ state: "queued", state_words: "Starts after its current reply", change: null, answer: undefined }));
  assert.match(text(queued), /Starts after its current reply/);
  const asking = draw(job({ state: "asking", state_words: "Waiting for you in Tax check's chat", change: null, answer: undefined }));
  assert.equal(asking.querySelector(".dgc-card-title").textContent, "Waiting for you in Tax check's chat");
  assert.equal(asking.querySelector(".dgc-card-actions"), null);
  assert.equal(asking.querySelector(".pipjob-open").textContent, "Open its chat", "a way to open it");
  const chat = draw(job({ state: "done", change: null }), "chatdgc");
  assert.match(chat.querySelector(".dgc-card-sub").textContent, /for this chat · Open its chat$/);
  assert.equal(chat.querySelector(".pipjob-change"), null, "an answer only");
  const failed = draw(job({ state: "failed", error: "The model didn't answer.", change: null, answer: undefined }));
  assert.equal(failed.querySelector(".dgc-card-title").textContent, "Tax check couldn't finish");
  assert.match(text(failed), /The model didn't answer\./);
  const declined = draw(job({ state: "declined", change: null, answer: undefined }));
  assert.match(text(declined), /You said not now in its chat/);
});

test("the answer is drawn as the page's words, never as markup it brings", () => {
  const { J, doc } = world();
  const box = doc.createElement("div");
  box.innerHTML = J.markup(J.checked(job({ answer: "<img src=x onerror=alert(1)> **bold**" })), { place: "work", render: (t) => `<p>${t.replace(/[<>&]/g, "")}</p>` });
  assert.equal(box.querySelector("img"), null);
  box.innerHTML = J.markup(J.checked(job({ answer: "<script>bad()</script>" })), { place: "work" });
  assert.equal(box.querySelector("script"), null, "without a page renderer, escaped");
});

test("the store follows the job, and Apply, Undo and Review read the same change the Pip's chat shows", async () => {
  const { J, doc } = world();
  const asked = [];
  let now = job({ state: "working", change: null, answer: undefined });
  const ask = async (type, fields) => {
    asked.push([type, fields]);
    if (type === "get_pip_job") return { job: now };
    if (type === "apply_pip_project_change") { now = job({ change: { ...job().change, status: "applied", result: { applied: ["billing/tax.py"], held_back: [] } } }); return {}; }
    if (type === "undo_pip_project_change") { now = job({ change: { ...job().change, status: "undone" } }); return {}; }
    if (type === "get_pip_project_change") return { diff: "--- a/billing/tax.py\n+++ b/billing/tax.py\n-x = 1\n+x = 2\n" };
    throw new Error("not asked");
  };
  const opened = [];
  const store = J.store({ ask, place: "work", document: doc, openChat: (pip, conv) => opened.push([pip.id, conv]) });
  const card = store.mount(JOB, { pip: { name: "Tax check" } });
  doc.body.append(card);
  assert.match(text(card), /Tax check/);
  await tick(); await tick();
  assert.equal(card.dataset.state, "working");
  now = job();
  await store.read(JOB);
  assert.equal(card.dataset.state, "done");
  assert.match(text(card), /Rounding was half-down/);
  // Apply: the change's own command, with the digest DGC showed (so a change that grew since is refused).
  store.click(card.querySelector('[data-pipjob-act="apply"]'));
  await tick(); await tick(); await tick();
  const apply = asked.find(([t]) => t === "apply_pip_project_change");
  assert.deepEqual(plain(apply[1]), { pip_id: PIP, change_id: CHANGE, expected_digest: "d".repeat(64) });
  assert.match(text(card.querySelector(".pipjob-change")), /applied to your folder/);
  // Review: the files, each one's diff in place.
  store.click(card.querySelector('[data-pipjob-act="review"]'));
  assert.equal(card.querySelector(".pipjob-files").hidden, false);
  store.click(card.querySelector('[data-pipjob-act="file"]'));
  await tick(); await tick();
  assert.match(card.querySelector(".pipjob-diff").textContent, /\+x = 2/);
  assert.ok(card.querySelector(".pipjob-diff-add"));
  store.click(card.querySelector('[data-pipjob-act="undo"]'));
  await tick(); await tick(); await tick();
  assert.match(text(card.querySelector(".pipjob-change")), /undone/);
  store.click(card.querySelector('[data-pipjob-act="open"]'));
  assert.deepEqual(plain(opened), [[PIP, ""]]);
  store.stop();
});

test("an Apply DGC refuses says why in the card, and the card reads the job again", async () => {
  const { J, doc } = world();
  const ask = async (type) => {
    if (type === "get_pip_job") return { job: job() };
    throw new Error("The Pip changed more since you looked. Look at it again, then Apply.");
  };
  const store = J.store({ ask, place: "chatdgc", document: doc });
  const card = store.mount(JOB);
  doc.body.append(card);
  await store.read(JOB);
  store.click(card.querySelector('[data-pipjob-act="apply"]'));
  await tick(); await tick(); await tick();
  assert.match(card.querySelector(".dgc-card-error").textContent, /changed more since you looked/);
  store.stop();
});

test("in the Pip's own chat: the From line, linked back, and Start or Not now at Ask me first", async () => {
  const { J, doc } = world();
  const box = doc.createElement("div");
  box.innerHTML = J.fromLine(job(), { openAsker: true });
  assert.equal(text(box), "From your Work session Tidy the October invoices: check billing/tax.py's rounding");
  const link = box.querySelector('[data-pipjob-act="asker"]');
  assert.deepEqual([link.dataset.kind, link.dataset.id], ["work", "sess-1"]);
  const asked = [], opened = [];
  const own = J.store({ ask: async (type, fields) => { asked.push([type, fields]); return type === "get_pip_job" ? { job: job({ state: "working", change: null }) } : {}; },
                        place: "pip-own", document: doc, openAsker: (from) => opened.push(from) });
  own.click(link);
  assert.deepEqual(plain(opened), [{ kind: "work", id: "sess-1", title: "Tidy the October invoices" }]);
  box.innerHTML = J.askingHtml(job({ state: "asking", change: null, answer: undefined }), { openAsker: true });
  assert.match(text(box), /A job from “Tidy the October invoices”/);
  assert.match(text(box), /It waits for your Start/);
  assert.deepEqual([...box.querySelectorAll(".dgc-card-actions button")].map((b) => b.textContent), ["Start", "Not now", "Open where it was asked"]);
  own.click(box.querySelector('[data-pipjob-act="start"]'));
  await tick(); await tick();
  assert.deepEqual(plain(asked[0]), ["start_pip_job", { pip_id: PIP, job_id: JOB }]);
  own.stop();
});

test("Work draws the card from ask_pip's answer (live and on a reload), and the answer's turn as the Pip's", () => {
  const main = read("media/main.js");
  assert.match(main, /String\(ev\.name \|\| c\.dataset\.toolName \|\| ""\) === "ask_pip"\) pipJobCardFrom\(c/, "from the step's result, so a replayed history draws it too");
  assert.match(main, /pip-job: \(\.\{1,200\}\?\) · \(answered\|couldn't finish\|not now\|stopped\)/, "the turn DGC started is the Pip's note, never a bubble");
  assert.match(main, /pipTarget: p/, "every Pip in Work's @ menu");
  const chat = read("media/chatdgc.js");
  assert.match(chat, /card\.kind === "pip_job"\) return pipJobNode\(card\)/);
  assert.match(chat, /pipjob_\[0-9a-f\]\{32\}/);
  assert.match(chat, /detail: typeof p\.folder === "string" && p\.folder \? `Works in \$\{p\.folder\}` : "No folder"/, "every Pip, with where it works");
  assert.match(read("media/mentions.js"), /if \(pipsOffered && query\) for \(const p of \(source\.pips \|\| \[\]\)\.filter\(\(row\) => String\(row\.name \|\| ""\)\.toLowerCase\(\)\.includes\(query\)\)/,
    "ChatDGC's and a Pip's chat's @ list a Pip by its name too");
});
