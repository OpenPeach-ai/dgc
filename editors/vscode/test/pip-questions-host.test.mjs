// A question card in a Pip's chat, the extension host's half (src/pipsView.ts, Pips API 106): answer_pip_questions
// goes through the Pips control channel only to a runtime that has it, well formed (the reply's id; its answers with a
// retry key, or dismissed: true); send_pip_message's `questions` (this view draws the card) reaches only such a runtime;
// an answer that DGC took tells the other pages showing that Pip's chat to read it again, as a message does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scratch = mkdtempSync(join(tmpdir(), "dgc-pip-questions-host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const outfile = join(scratch, "pipsView.cjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/pipsView.ts", import.meta.url))], bundle: true, outfile, platform: "node", format: "cjs",
  external: ["vscode"], loader: { ".css": "empty" }, logLevel: "silent" });
const require = createRequire(import.meta.url);
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const { PipsEditor, questionsRefusal, QUESTIONS_API } = require(outfile);
Module._load = load;

const PIP = "pip_" + "a".repeat(32), REPLY = "message_" + "b".repeat(32);
function editor(apiVersion) {
  const sent = [], posted = [];
  const e = new PipsEditor({ fsPath: "/ext" }, (m) => { sent.push(m); return true; }, () => {});
  e.attach((m) => posted.push(m));
  e.ready({ pips_supported: true, pips_enabled: true, pips_api_version: apiVersion });
  const ask = (request, id = "c1") => e.receive({ type: "pipsRequest", id, request });
  const reply = (id) => posted.find((m) => m.type === "pipsReply" && m.id === id);
  return { e, sent, posted, ask, reply };
}
const ANSWER = { type: "answer_pip_questions", pip_id: PIP, message_id: REPLY, idempotency_key: "pip-answer-1", answers: { q1: { selected: [0], other: "" } } };

test("an answer or a dismissal goes to a runtime that has the card, and only to one", () => {
  assert.equal(QUESTIONS_API, 106);
  const x = editor(106);
  x.ask(ANSWER);
  x.ask({ type: "answer_pip_questions", pip_id: PIP, message_id: REPLY, dismissed: true }, "c2");
  assert.deepEqual(x.sent.map((m) => [m.type, m.request.type]), [["pips_control", "answer_pip_questions"], ["pips_control", "answer_pip_questions"]]);
  assert.deepEqual({ ...x.sent[0].request, request_id: "" }, { ...ANSWER, request_id: "" });
  const old = editor(105);
  old.ask(ANSWER);
  assert.deepEqual(old.sent, [], "an older runtime is never asked");
  assert.match(old.reply("c1").error.message, /Update DGC/);
});

test("a malformed answer never leaves the editor", () => {
  for (const bad of [{ ...ANSWER, message_id: "m1" }, { ...ANSWER, dismissed: true }, { ...ANSWER, answers: {} }, { ...ANSWER, answers: [] },
    { type: "answer_pip_questions", pip_id: PIP, message_id: REPLY }, { type: "answer_pip_questions", pip_id: PIP, message_id: REPLY, dismissed: false },
    { ...ANSWER, idempotency_key: undefined }, { ...ANSWER, answers: { a: {}, b: {}, c: {}, d: {}, e: {} } }]) {
    assert.ok(questionsRefusal(bad, 106), JSON.stringify(bad));
    const x = editor(106);
    x.ask(bad);
    assert.deepEqual(x.sent, [], JSON.stringify(bad));
    assert.equal(x.reply("c1").ok, false);
  }
  assert.equal(questionsRefusal(ANSWER, 106), "");
  assert.equal(questionsRefusal({ type: "send_pip_message" }, 1), "", "only the card's own command");
});

test("four questions, each with its own long answer, still fit the request", () => {
  const words = "é".repeat(4096), answers = Object.fromEntries(["q1", "q2", "q3", "q4"].map((q) => [q, { selected: [], other: words }]));
  const x = editor(106);
  x.ask({ ...ANSWER, answers });
  assert.equal(x.sent.length, 1, JSON.stringify(x.reply("c1") || null));
});

test("send_pip_message says this view draws the card only to a runtime that has it", () => {
  const message = { type: "send_pip_message", pip_id: PIP, text: "Propose me options", idempotency_key: "k1", questions: true };
  const x = editor(106);
  x.ask(message);
  assert.equal(x.sent[0].request.questions, true);
  const old = editor(105);
  old.ask(message);
  assert.equal(old.sent.length, 1, "the message still goes");
  assert.equal("questions" in old.sent[0].request, false, "without the flag an older DGC would refuse");
  const odd = editor(106);
  odd.ask({ ...message, questions: "yes" });
  assert.equal("questions" in odd.sent[0].request, false, "true, or nothing");
});
