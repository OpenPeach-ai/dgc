// The unread numbers are asked only of the workspaces that hold Pips (14 Nov, his "DGC is busy. Reconnect and try
// again." on the Pips tab): one list_pip_unread per workspace, all at once, every 15 s, over a profile with ~190
// workspaces (test folders left behind) went past the 48 requests the page lets wait and the 64 the editor does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setup as open } from "./support/one-pips-node.mjs";

const windows = []; after(() => windows.forEach((w) => w.close()));

test("a profile with 150 workspaces that hold no Pips asks unread only of the ones that do, and never says DGC is busy", async () => {
  const x = open({ api: 96, scene: { leftovers: 150 } }); windows.push(x.w);
  await x.drain();
  const asked = x.requests("list_pip_unread").map((r) => r.workspace_id);
  assert.ok(asked.length > 0, "unread is still asked");
  const holding = new Set(x.backend.state.pips ? x.backend.state.pips.map((p) => p.workspace_id) : []);
  assert.ok(asked.every((id) => !id.startsWith("ws_fff")), `no workspace without Pips is asked (${asked.filter((id) => id.startsWith("ws_fff")).length} were)`);
  assert.ok(new Set(asked).size <= 4, `at most the Personal one and the three projects with Pips (${new Set(asked).size})`);
  assert.doesNotMatch(x.text(), /DGC is busy/);
});
