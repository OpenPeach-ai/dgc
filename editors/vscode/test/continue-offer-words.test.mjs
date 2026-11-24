// The card offering Continue says why the last turn stopped in plain words: a signal's name ("SIGTERM — a stop signal
// from another process…", the backend's own log line) read as jargon on it (24 Nov RC check). The log keeps its words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

test("a turn stopped by a signal says so in plain words; any other cause is said as it is", () => {
  const a = makeDom();
  a.send({ type: "continue_offer", windowless: true, cause: "SIGTERM — a stop signal from another process, not a shutdown command from the editor" });
  const card = [...a.doc.querySelectorAll(".card, .recovery-card, [class*=recovery]")].map((c) => c.textContent).join(" | ");
  assert.match(card, /Your last turn was stopped while no window was open \(something on this computer stopped DGC, not the editor\)/);
  assert.doesNotMatch(card, /SIGTERM|SIGKILL|signal/);
  const b = makeDom();
  b.send({ type: "continue_offer", windowless: true, cause: "it waited 1h 0m for your answer" });
  assert.match([...b.doc.querySelectorAll(".card, .recovery-card, [class*=recovery]")].map((c) => c.textContent).join(" | "), /\(it waited 1h 0m for your answer\)/);
  assert.deepEqual([...a.errors, ...b.errors], []);
});
