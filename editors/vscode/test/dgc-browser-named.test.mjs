// A browser call DGC sent to DGC Browser because the user's message named it (dgc/agent.py _steer_to_dgc_browser,
// 27 Nov: "Use the DGC browser: open example.com" was now and then opened with the browser tool, "as instructed" by the
// order rule for "my browser") is not a refusal: its card isn't red and says where the page opens instead.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor } from "./support/ut2b-common.mjs";
import * as S from "./support/uir2a-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const open = (opts = {}) => S.openWork(C.state.browser, { width: 440, turns: 1, ...opts });

test("a browser call sent to DGC Browser, as the message asked, reads as that, not as denied", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await open();
  try {
    const id = await x.say("Use the DGC browser: open https://example.com and tell me its heading");
    await x.event({ type: "prompt_accepted", request_id: id, state: "started" });
    await x.event({ type: "turn_start", turn_id: "n1", prompt: "", kind: "prompt", request_id: id });
    await x.event({ type: "tool_denied", call_id: "b1", name: "browser", args: { operation: "open", url: "https://example.com" }, reason: "you asked for DGC Browser" });
    await x.event({ type: "tool_denied", call_id: "b2", name: "bash", args: { command: "rm -rf build" }, reason: "The user denied this action" });
    await x.page.waitForTimeout(80);
    const cards = await x.page.evaluate(() => ["b1", "b2"].map((id) => {
      const c = [...document.querySelectorAll("#log .tool, #log [data-call-id]")].find((n) => n.dataset.callId === id || n.dataset.call === id) ||
        [...document.querySelectorAll("#log [data-status]")].filter((n) => n.dataset.toolName === (id === "b1" ? "browser" : "bash")).pop();
      return c ? { status: c.dataset.status, dot: c.querySelector(".dot")?.className || "", verb: c.querySelector(".verb")?.textContent || "", text: c.textContent.replace(/\s+/g, " ") } : null;
    }));
    assert.ok(cards[0] && cards[1], `both cards drawn (${JSON.stringify(cards)})`);
    assert.equal(cards[0].status, "redirected");
    assert.equal(cards[0].dot, "dot ok", "not the red deny dot");
    assert.equal(cards[0].verb, "Opening it in DGC Browser instead");
    assert.match(cards[0].text, /You asked for DGC Browser, so the page opens there instead\./);
    assert.deepEqual([cards[1].status, cards[1].dot], ["denied", "dot deny"], "a real refusal still reads as one");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
