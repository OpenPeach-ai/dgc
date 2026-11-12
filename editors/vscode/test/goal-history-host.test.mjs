// The host's side of a session's goal history (src/panel.ts, with the real panel code): the page's goalRuns message
// becomes the goal_runs command only for a DGC whose ready.capabilities.goal_runs says it takes it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

test("goalRuns asks DGC for the session's goals, and only a DGC that has them", async () => {
  const has = makeProvider({ capabilities: { goal_runs: true } });
  await has.provider.onMessage({ type: "goalRuns" });
  assert.deepEqual(has.backend.sent.filter((c) => c.type === "goal_runs").map((c) => Object.keys(c).sort()), [["request_id", "type"]]);
  const old = makeProvider({ capabilities: {} });
  await old.provider.onMessage({ type: "goalRuns" });
  assert.deepEqual(old.backend.sent.filter((c) => c.type === "goal_runs"), [], "an older DGC is never sent it");
});
