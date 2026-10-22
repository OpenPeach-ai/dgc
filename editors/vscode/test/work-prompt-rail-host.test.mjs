// The Work chat's prompt rail asks the CLI for every prompt of the session (get_outline) through the real panel: only
// a CLI that offers it (ready.capabilities.outline) is asked, the webview's token comes back as the request id, and
// the answer reaches the webview as any event does. An older CLI would refuse the command, so it is never sent one.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

test("the rail's ask reaches a CLI that offers the outline, with the webview's token as its request id; the answer reaches the webview", async () => {
  const { provider, backend, posted } = makeProvider({ capabilities: { outline: 1, history_snapshot: true } });
  await provider.onMessage({ type: "getOutline", token: 3 });
  assert.deepEqual(backend.sent.filter((c) => c.type === "get_outline"), [{ type: "get_outline", request_id: "outline-3" }]);
  const answer = { type: "outline", seq: 9, request_id: "outline-3", session_id: "s1",
                   prompts: [{ id: "a0", text: "Set up the repo", archived: true }, { id: "h1", text: "Fix the test", at: 1760000000 }] };
  provider.onEvent(answer);
  assert.deepEqual(posted.filter((m) => m.type === "event" && m.event.type === "outline").map((m) => m.event), [answer]);
});

test("an older CLI is never asked, and a token that isn't one sends nothing", async () => {
  const older = makeProvider({ capabilities: { history_snapshot: true } });
  await older.provider.onMessage({ type: "getOutline", token: 1 });
  assert.equal(older.backend.sent.some((c) => c.type === "get_outline"), false);
  const { provider, backend } = makeProvider({ capabilities: { outline: 1 } });
  for (const token of [0, -1, 1.5, "2", "x", undefined]) await provider.onMessage({ type: "getOutline", token });
  assert.equal(backend.sent.some((c) => c.type === "get_outline"), false);
});
