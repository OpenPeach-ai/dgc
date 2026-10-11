// Main DGC's context menu asks the CLI what fills the window (context_breakdown) and draws the answer. Driven
// through the real panel: in the live run of 2026-10-11 the webview's ask was handled only as a typed action,
// never as the message the webview posts, so the menu opened with no parts and no test noticed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

const answer = { type: "context_breakdown", window: 32768, used: 1300, source: "estimated", compact_at: 27852,
                 buffer: 4916, free: 26552, categories: [{ id: "system_tools", label: "Tools", tokens: 1000,
                 items: [{ name: "read_file", tokens: 400 }] }, { id: "messages", label: "Messages", tokens: 300 }] };

test("the menu's ask reaches the CLI with its request id, and the answer reaches the menu", async () => {
  const { provider, backend, posted } = makeProvider({ capabilities: { context_breakdown: 1, correlated_state_requests: true } });
  provider.correlatedStateRequests = true;
  backend.request = (command) => { backend.requested.push(command); return Promise.resolve({ ...answer, request_id: command.request_id }); };
  await provider.onMessage({ type: "contextBreakdown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.requested.length, 1);
  assert.equal(backend.requested[0].type, "context_breakdown");
  assert.match(String(backend.requested[0].request_id), /^ctx-breakdown/);
  const shown = posted.find((m) => m.type === "contextBreakdown");
  assert.ok(shown, "the webview gets the parts");
  assert.deepEqual(shown.breakdown.categories, answer.categories);
  assert.equal(shown.breakdown.window, 32768);
});

test("a CLI that can't count it is never asked", async () => {
  const { provider, backend, posted } = makeProvider({ capabilities: {} });
  await provider.onMessage({ type: "contextBreakdown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backend.requested.length, 0);
  assert.equal(posted.some((m) => m.type === "contextBreakdown"), false);
});
