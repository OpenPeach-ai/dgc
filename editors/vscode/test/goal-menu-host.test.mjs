// The host's side of "a goal starts only from the '/' menu's Goal" (12 Nov), with the real panel code (src/panel.ts)
// and a backend that records what it is sent. The webview now sends "/goal some text", typed without the menu, as an
// ordinary prompt: the host must pass those words to DGC as they are, and start no goal from them. The words that
// manage a goal still take the typed route.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

test('the host passes a typed "/goal some text" prompt to DGC as plain words, and starts no goal', async () => {
  for (const text of ["/goal fix the build", "Verify the release /goal"]) {
    const { provider, backend } = makeProvider();
    await provider.onMessage({ type: "prompt", requestId: "r1", text });
    assert.deepEqual(backend.sent.filter((c) => c.type === "prompt").map((c) => c.text), [text]);
    assert.deepEqual(backend.sent.filter((c) => /goal/.test(c.type)), [], "nothing about a goal is sent");
  }
});

test("a goal's management words, typed, still reach goal management in the host", async () => {
  const { provider, backend } = makeProvider();
  let paused = 0, started = 0;
  provider.pauseGoal = async () => { paused += 1; };
  provider.startGoal = async () => { started += 1; };
  await provider.onMessage({ type: "slashText", text: "/goal pause" });
  assert.deepEqual([paused, started], [1, 0]);
  assert.deepEqual(backend.sent.filter((c) => c.type === "prompt"), []);
});
