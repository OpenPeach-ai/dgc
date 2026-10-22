// The context meter says when the window in use is the model's own maximum (0.48).
//
// The window you choose is remembered per model and a switch back restores it; a model that holds
// less than that (its reported maximum, or the limit an overflow refusal named) is used at its own
// size. The meter then says so -- "256k · this model's max" -- in its menu and its tooltip. No popup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const context = (size, used = 12000) => ({ type: "context", used, size, compact_threshold: 0.85,
  compact_at: Math.floor(size * 0.85), input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
  reasoning_tokens: 0, requests: 0 });

test("the meter names the model's own maximum when it is below the chosen window", () => {
  const { errors, send, doc } = makeDom();
  const event = (ev) => send({ type: "event", event: ev });
  event({ type: "ready", capabilities: {} });
  event({ type: "config", model: "deepseek-chat", mode: "default", base_url: "https://api.deepseek.com/v1",
          context_size: 1048576 });
  event(context(1048576));
  const max = doc.getElementById("ctx-max"), button = doc.getElementById("btn-ctx");
  assert.equal(max.hidden, true, "the model holds what was chosen: nothing to say");
  assert.doesNotMatch(button.title, /this model's max/);

  // An overflow refusal taught DGC this model holds 256k: the window in use drops, the choice stays.
  event(context(262144));
  assert.equal(max.hidden, false);
  assert.equal(max.textContent, "256k · this model's max");
  assert.match(button.title, /\(256k · this model's max\)/);
  doc.getElementById("btn-ctx").click();
  assert.equal(doc.getElementById("ctxmenu").hidden, false);
  assert.match(doc.querySelector(".context-head").textContent, /256k · this model's max/);

  // A 1M model at 1M, and a window that is not a power of two.
  event(context(1048576));
  assert.equal(max.hidden, true);
  event({ type: "config", model: "m", mode: "default", base_url: "https://x.example/v1", context_size: 400000 });
  event(context(128000));
  assert.equal(max.textContent, "125k · this model's max");
  event({ type: "config", model: "m", mode: "default", base_url: "https://x.example/v1", context_size: 2097152 });
  event(context(1048576));
  assert.equal(max.textContent, "1M · this model's max");
  assert.deepEqual(errors, []);
});
