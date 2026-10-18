// The panel's half of a troupe's Stop: sent as stop_troupe only to a CLI that advertised troupes, only for a real run
// id, and answered by the `troupes` snapshot that updates its row above the prompt. And "Open the journal" in the
// troupe's popover: the webview names a run, this side finds its journal under ~/.dgc/troupes and nowhere else.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, makeProvider, notices } from "./support/panel-bundle.mjs";

after(cleanup);

test("Open the journal opens the run's report, else what it has written so far, only under ~/.dgc/troupes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dgc-journal-home-"));
  const priorHome = process.env.HOME;
  const vscode = globalThis.__DGC_TEST_VSCODE;
  const opened = [], priorExecute = vscode.commands.executeCommand;
  process.env.HOME = home;
  vscode.commands.executeCommand = async (command, uri) => { opened.push([command, uri?.fsPath]); };
  t.after(() => { process.env.HOME = priorHome; vscode.commands.executeCommand = priorExecute; rmSync(home, { recursive: true, force: true }); });
  const { provider } = makeProvider({ capabilities: { troupe: 1 } });
  const run = join(home, ".dgc", "troupes", "tr-0123456789");
  const open = (runId) => provider.onMessage({ type: "openTroupeJournal", runId });

  await open("tr-0123456789");
  assert.deepEqual(opened, [], "no journal yet");
  assert.equal(notices.info.at(-1), "This troupe's journal is not on this computer.");

  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "plan.json"), "{}");
  await open("tr-0123456789");
  assert.deepEqual(opened.at(-1), ["vscode.open", join(run, "plan.json")], "just started: its plan");
  writeFileSync(join(run, "results.jsonl"), "{}\n");
  await open("tr-0123456789");
  assert.deepEqual(opened.at(-1), ["vscode.open", join(run, "results.jsonl")], "working: what it has so far");
  writeFileSync(join(run, "report.md"), "# Troupe\n");
  await open("tr-0123456789");
  assert.deepEqual(opened.at(-1), ["vscode.open", join(run, "report.md")], "ended: the report");

  const count = opened.length;
  for (const bad of ["", "tr-xyz", "../etc", "tr-0123456789/../../x", "/etc/passwd", "tr-0123456789; rm"]) await open(bad);
  assert.equal(opened.length, count, "only a well-formed run id is looked up");
  // A journal that is a link out of ~/.dgc/troupes is not opened.
  const outside = mkdtempSync(join(tmpdir(), "dgc-journal-outside-"));
  writeFileSync(join(outside, "report.md"), "elsewhere");
  mkdirSync(join(home, ".dgc", "troupes", "tr-aaaaaaaaaa"));
  symlinkSync(join(outside, "report.md"), join(home, ".dgc", "troupes", "tr-aaaaaaaaaa", "report.md"));
  await open("tr-aaaaaaaaaa");
  assert.equal(opened.length, count, "a link out of the journal folder is refused");
  rmSync(outside, { recursive: true, force: true });
});

test("Stop on a troupe's row reaches a CLI that has troupes, and nothing else does", async () => {
  const { provider, backend } = makeProvider({ capabilities: { troupe: 1 } });
  await provider.stopTroupe("tr-0123456789");
  assert.equal(backend.requested.length, 1);
  assert.equal(backend.requested[0].type, "stop_troupe");
  assert.equal(backend.requested[0].run_id, "tr-0123456789");
  for (const bad of ["", "tr-xyz", "../etc", "tr-0123456789; rm"]) {
    await provider.stopTroupe(bad);
  }
  assert.equal(backend.requested.length, 1, "only a well-formed run id is ever sent");
  const older = makeProvider({ capabilities: {} });
  await older.provider.stopTroupe("tr-0123456789");
  assert.deepEqual(older.backend.requested, [], "an older CLI never had a troupe to stop");
});
