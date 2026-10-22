// vLLM, SGLang and llama.cpp: the window the server was started with (0.48, server_window).
//
// These servers size the window when they start (vLLM --max-model-len, SGLang --context-length, llama.cpp -c); DGC
// reads it and can't change it. The context meter then shows it as "Set by the server: 8K" with one line on how to
// change it there, instead of offering sizes that can't apply; DGC's own smaller window (Settings) only decides when it
// compacts. Settings -> General -> Context size says the same. A backend that offers it is asked once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom } from "./support/webview-dom.mjs";

const context = (size, used = 3000) => ({ type: "context", used, size, compact_threshold: 0.85,
  compact_at: Math.floor(size * 0.85), input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
  reasoning_tokens: 0, requests: 0 });
const config = (context_size) => ({ type: "config", model: "qwen2.5-0.5b", mode: "default",
  base_url: "http://127.0.0.1:18000/v1", context_size });

test("the meter says the server set the window, and how to change it there", () => {
  const { errors, send, doc } = makeDom();
  const event = (ev) => send({ type: "event", event: ev });
  event({ type: "ready", capabilities: { server_window: 1 } });
  event(config(32768));
  event(context(8192));
  const select = doc.getElementById("ctx-size"), served = doc.getElementById("ctx-size-server");
  const note = doc.getElementById("ctx-size-note"), max = doc.getElementById("ctx-max");
  assert.equal(served.hidden, true, "until the backend says so, DGC's own sizes");
  assert.equal(select.hidden, false);
  assert.equal(max.textContent, "8k · this model's max");

  event({ type: "server_window", model: "qwen2.5-0.5b", window: 8192, server: "vllm" });
  doc.getElementById("btn-ctx").click();
  assert.equal(doc.getElementById("ctxmenu").hidden, false);
  assert.equal(select.hidden, true, "no sizes to offer that can't apply");
  assert.equal(doc.getElementById("ctx-size-custom").hidden, true);
  assert.equal(served.hidden, false);
  assert.equal(served.textContent, "Set by the server: 8K");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, "To change it, restart vLLM with --max-model-len.");
  assert.equal(max.hidden, true, "the Window size row says it: not twice");
  assert.match(doc.getElementById("btn-ctx").title, /\(8k · set by the server\)/, "the meter's tooltip, menu closed");

  // Your own smaller window still applies: it only decides when DGC compacts.
  event(config(4096));
  event(context(4096));
  assert.equal(served.textContent, "Set by the server: 8K");
  assert.equal(note.textContent, "To change it, restart vLLM with --max-model-len. DGC keeps to 4K, as set in Settings.");
  assert.equal(max.hidden, true, "the window in use is the one you chose");

  // Each server's own option; one the meter doesn't know gets a plain line.
  for (const [server, line] of [["llamacpp", "To change it, restart llama-server with -c."],
                                ["sglang", "To change it, restart SGLang with --context-length."],
                                ["aphrodite", "To change it, restart the server with a larger context."]]) {
    event({ type: "server_window", model: "m", window: 131072, server });
    event(config(131072));
    event(context(131072));
    assert.equal(served.textContent, "Set by the server: 128K", server);
    assert.equal(note.textContent, line, server);
  }

  // Another model on Ollama or a cloud API: DGC sizes the window again, and the sizes come back.
  event({ type: "server_window", model: "qwen3.8:27b", window: 0 });
  assert.equal(served.hidden, true);
  assert.equal(select.hidden, false);
  assert.equal(note.hidden, true);
  assert.deepEqual(errors, []);
});

test("a new backend starts from DGC's own sizes until it says otherwise", () => {
  const { errors, send, doc } = makeDom();
  const event = (ev) => send({ type: "event", event: ev });
  event({ type: "ready", capabilities: { server_window: 1 } });
  event(config(8192));
  event({ type: "server_window", model: "qwen2.5-0.5b", window: 8192, server: "vllm" });
  event(context(8192));
  assert.equal(doc.getElementById("ctx-size-server").hidden, false);
  event({ type: "ready", capabilities: {} });         // Restart Backend, onto an older CLI
  event(context(8192));
  assert.equal(doc.getElementById("ctx-size-server").hidden, true);
  assert.equal(doc.getElementById("ctx-size").hidden, false);
  assert.deepEqual(errors, []);
});

test("the panel asks a backend that offers it, keeps the answer for Settings, and forwards changes", () => {
  const panel = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
  assert.match(panel, /Number\(\(ev\.capabilities as any\)\?\.server_window\) >= 1\) \{\s*this\.backend\?\.send\(\{ type: "server_window"/);
  assert.match(panel, /case "server_window":\s*this\.serverWindow = \{/);
  assert.match(panel, /\["config", "server_window", "usage_report"/, "Settings gets it as it changes");
  assert.match(panel, /\.\.\.\(this\.serverWindow \? \{ server_window: \{ \.\.\.this\.serverWindow \} \} : \{\}\)/);
  assert.match(panel, /<span id="ctx-size-server" class="context-size-server" hidden><\/span>/);
});
