// @ a Pip (Pips API 111) through the editor's Pips bridge (src/pipsView.ts): the Pips page's job card reads the job
// (get_pip_job) and answers Start / Not now on one waiting at Ask me first (start_pip_job, decline_pip_job); the jobs a
// Pip was handed are list_pip_jobs. Each goes to DGC as a Pips control, only with well-formed ids, never to an older
// DGC. The same commands reach a ChatDGC or Work card through the host's pipJob().
import { test } from "node:test";
import assert from "node:assert/strict";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const viewModule = await pipsViewModule();
const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, f) => f }) }, window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }) } };
const PIP = "pip_" + "a".repeat(32), JOB = "pipjob_" + "b".repeat(32);

function bridge(api) {
  const { PipsEditor } = viewModule(vscode);
  const page = [], sent = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach((m) => page.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
  editor.receive({ type: "pipsReady" });
  const generation = page.filter((m) => m.type === "pipsConnection").at(-1).generation;
  const ask = (id, request) => editor.receive({ type: "pipsRequest", id, generation, request });
  return { editor, page, sent, ask, replies: () => page.filter((m) => m.type === "pipsReply") };
}

test("the Pips page's job card reads a job, and Start / Not now go to DGC as Pips controls", () => {
  const b = bridge(111);
  b.ask("r1", { type: "get_pip_job", job_id: JOB });
  b.ask("r2", { type: "list_pip_jobs", pip_id: PIP });
  b.ask("r3", { type: "start_pip_job", pip_id: PIP, job_id: JOB });
  b.ask("r4", { type: "decline_pip_job", pip_id: PIP, job_id: JOB });
  const controls = b.sent.filter((m) => m.type === "pips_control").map((m) => m.request);
  assert.deepEqual(controls.map((r) => r.type), ["get_pip_job", "list_pip_jobs", "start_pip_job", "decline_pip_job"]);
  assert.equal(controls[0].job_id, JOB);
  assert.deepEqual([controls[2].pip_id, controls[2].job_id], [PIP, JOB]);
  assert.deepEqual(b.replies().filter((m) => m.ok === false), [], "none refused");
});

test("a job command with a made-up id is refused in plain words, and nothing is sent", () => {
  const b = bridge(111);
  b.ask("r1", { type: "get_pip_job", job_id: "../../etc" });
  b.ask("r2", { type: "start_pip_job", pip_id: PIP });
  b.ask("r3", { type: "list_pip_jobs", pip_id: "pip_x" });
  assert.deepEqual(b.sent.filter((m) => m.type === "pips_control"), []);
  assert.deepEqual(b.replies().map((m) => [m.id, m.ok, m.error?.message]),
    [["r1", false, "Choose a job."], ["r2", false, "Choose a job."], ["r3", false, "Choose a Pip."]]);
});

test("an older DGC (Pips API 110) is sent none of them", async () => {
  const b = bridge(110);
  b.ask("r1", { type: "get_pip_job", job_id: JOB });
  assert.deepEqual(b.sent.filter((m) => m.type === "pips_control"), []);
  assert.equal(b.replies()[0].error.message, "Update DGC to follow a Pip’s job here.");
  await assert.rejects(b.editor.pipJob("get_pip_job", { job_id: JOB }), /Update DGC to follow a Pip’s job here/);
});

test("a ChatDGC or Work card asks through pipJob(): only a card's own commands, with well-formed ids", async () => {
  const b = bridge(111);
  await assert.rejects(b.editor.pipJob("send_pip_message", { pip_id: PIP, text: "hi" }), /A job’s card can’t ask that/);
  await assert.rejects(b.editor.pipJob("get_pip_job", { job_id: "nope" }), /Choose a job/);
  assert.deepEqual(b.sent.filter((m) => m.type === "pips_control" || /pip/.test(m.type || "")).map((m) => m.request?.type).filter(Boolean), []);
});
