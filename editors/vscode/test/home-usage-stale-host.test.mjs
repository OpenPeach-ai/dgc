// Finding 73 (16 Nov): when a turn ends, the side bar's Home is told its token count moved (homeUsageStale), so its
// token card asks the ledger again soon; a Home that isn't shown, or a webview not ready, is told nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(() => cleanup());

test("a turn's end tells Home its token count moved", () => {
  const { provider, posted } = makeProvider();
  provider.home = true;
  provider.onEvent({ type: "turn_start", turn_id: "t1" });
  assert.equal(posted.filter((m) => m.type === "homeUsageStale").length, 0, "nothing used yet");
  provider.onEvent({ type: "turn_end", turn_id: "t1", reason: "complete" });
  assert.equal(posted.filter((m) => m.type === "homeUsageStale").length, 1, "once, at the end");
});

test("a window with no Home showing, or not ready, is told nothing", () => {
  const { provider, posted } = makeProvider();
  provider.home = false;
  provider.onEvent({ type: "turn_end", turn_id: "t2", reason: "complete" });
  provider.home = true; provider.webviewReady = false;
  provider.onEvent({ type: "turn_end", turn_id: "t3", reason: "complete" });
  assert.equal(posted.filter((m) => m.type === "homeUsageStale").length, 0);
});

test("Home's token card asks for every day and the last 7 days' models: it counts one week (17 Nov)", () => {
  const { provider, backend } = makeProvider({ capabilities: { usage_ledger: 1 } });
  provider.home = true;
  provider.askHomeUsage();
  const asked = backend.sent.filter((c) => c.type === "get_usage").map((c) => [c.request_id, c.range]);
  assert.deepEqual(asked, [["home-usage-all", "all"], ["home-usage-7d", "7d"], ["home-usage-today", "today"]]);
  clearTimeout(provider.homeUsage?.timer);
});
