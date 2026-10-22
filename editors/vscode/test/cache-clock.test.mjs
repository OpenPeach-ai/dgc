// The prompt cache's clock in the Work composer (0.48), copied from Claude Code.
//
// unknown -> hidden; warm -> a clock and the whole minutes left ("4m", tabular figures), changed at
// most once a minute, never seconds, no animation; cold -> the clock alone in the error colour, with
// the reason in its tooltip. Reopening a chat whose cache went cold adds one note to the transcript.
// Main DGC only: ChatDGC and Pips never show it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeDom, mainCss, panelSrc } from "./support/webview-dom.mjs";

const dir = fileURLToPath(new URL("../", import.meta.url));
const T0 = Date.UTC(2026, 9, 22, 9, 0, 0);

function clockDom() {
  const x = makeDom({ clock: true });
  let wall = T0;
  x.dom.window.Date.now = () => wall;
  const tick = (ms) => { wall += ms; x.advance(ms); };
  const event = (ev) => x.send({ type: "event", event: ev });
  event({ type: "ready", capabilities: {} });
  const node = x.doc.getElementById("cache-clock");
  const left = () => x.doc.getElementById("cache-clock-left").textContent;
  return { ...x, tick, event, node, left, now: () => wall };
}

test("a warm Anthropic cache shows the whole minutes left, changed only at minute boundaries", () => {
  const x = clockDom();
  assert.equal(x.node.hidden, true, "unknown: hidden");
  // A 5-minute entry written by a request sent 30 s ago.
  x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: T0 - 30000,
            expires_ms: T0 - 30000 + 300000, ttl_s: 300, tokens: 41000 });
  assert.equal(x.node.hidden, false);
  assert.equal(x.node.dataset.cacheWindow, "warm");
  assert.equal(x.left(), "5m", "4 min 30 s left reads 5m: whole minutes, rounded up, never seconds");
  assert.equal(x.node.title, "Prompt cache warm, about 5 min left.");
  assert.equal(x.node.getAttribute("aria-label"), "Prompt cache warm, about 5 min left.");
  assert.equal(x.node.getAttribute("role"), "status");
  assert.equal(x.node.getAttribute("aria-live"), "off", "never announced as it counts");
  assert.equal(x.node.classList.contains("cold"), false);
  x.tick(29000);
  assert.equal(x.left(), "5m", "nothing moves inside a minute");
  x.tick(2000);
  assert.equal(x.left(), "4m");
  x.tick(58000);                      // 3 min 1 s left
  assert.equal(x.left(), "4m");
  x.tick(2000);                       // 2 min 59 s left
  assert.equal(x.left(), "3m");
  x.tick(3 * 60000);
  assert.equal(x.node.dataset.cacheWindow, "cold", "it runs out by itself");
  assert.equal(x.node.classList.contains("cold"), true);
  assert.equal(x.left(), "", "cold: the clock alone");
  assert.match(x.node.title, /^Prompt cache likely expired \(idle 5m\)\.$/);
  assert.deepEqual(x.errors, []);
});

test("the clock never runs a per-second timer", () => {
  const x = clockDom();
  const scheduled = [];
  const realSet = x.dom.window.setTimeout;
  x.dom.window.setTimeout = (fn, ms) => { scheduled.push(ms); return realSet(fn, ms); };
  x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: T0, expires_ms: T0 + 3600000,
            ttl_s: 3600, tokens: 9000 });
  assert.equal(x.left(), "1h");
  assert.equal(x.node.title, "Prompt cache warm, about 1 h 0 min left.");
  for (let i = 0; i < 10; i++) x.tick(60000);
  assert.equal(x.left(), "50m");
  assert.ok(scheduled.filter((ms) => ms !== undefined && ms < 59000).length === 0,
            `every wake-up is about a minute apart: ${scheduled}`);
});

test("cold reasons: expired, compacted, an Ollama that unloaded the model", () => {
  const x = clockDom();
  x.event({ type: "cache_clock", state: "cold", reason: "compacted", source: "anthropic", anchor_ms: T0 - 60000 });
  assert.equal(x.node.title, "Prompt cache does not cover the compacted conversation.");
  assert.equal(x.node.classList.contains("cold"), true);
  x.event({ type: "cache_clock", state: "cold", reason: "unloaded", source: "ollama", anchor_ms: T0 - 12 * 60000 });
  assert.equal(x.node.title, "Prompt cache expired: Ollama unloaded the model (idle 12m).");
  x.event({ type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", anchor_ms: T0 - 12 * 60000 });
  assert.equal(x.node.title, "Prompt cache likely expired (idle 12m).");
  // A local Ollama kept loaded until it stops: warm, nothing to count.
  x.event({ type: "cache_clock", state: "warm", source: "ollama", anchor_ms: T0 });
  assert.equal(x.left(), "");
  assert.equal(x.node.title, "Prompt cache warm: Ollama keeps the model loaded.");
  x.event({ type: "cache_clock", state: "unknown" });
  assert.equal(x.node.hidden, true, "a provider DGC cannot read hides it");
});

test("reopening a chat whose cache went cold adds one note, once", () => {
  const x = clockDom();
  const notes = () => [...x.doc.querySelectorAll("#log .sys")].map((n) => n.textContent);
  x.event({ type: "session", kind: "resumed", session_id: "s1", message_count: 4 });
  x.event({ type: "history", items: [{ role: "user", text: "Earlier" }] });
  const cold = { type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", resumed: true,
                 anchor_ms: T0 - (2 * 3600 + 5 * 60) * 1000, ttl_s: 300, tokens: 180000, session_id: "s1" };
  x.event(cold);
  assert.deepEqual(notes().filter((t) => t.startsWith("Idle")),
    ["Idle 2h 5m. The prompt cache has likely expired, so your next message will re-cache about 180k tokens."]);
  x.event(cold);
  assert.equal(notes().filter((t) => t.startsWith("Idle")).length, 1, "the same reopen is said once");
  // A warm one on reopen says nothing; a repaint (no `resumed`) never adds a note.
  x.event({ ...cold, state: "warm", reason: undefined, anchor_ms: T0 - 60000, expires_ms: T0 + 240000, resumed: true });
  x.event({ ...cold, resumed: undefined, anchor_ms: T0 - 7200000 });
  assert.equal(notes().filter((t) => t.startsWith("Idle")).length, 1);
  x.event({ type: "cache_clock", state: "cold", reason: "compacted", source: "anthropic", resumed: true,
            anchor_ms: T0 - 60000, session_id: "s1" });
  assert.ok(notes().includes("The conversation was compacted, so your next message will re-cache it."));
  // A new chat starts with no clock until its backend says otherwise.
  x.event({ type: "session", kind: "new", session_id: "s2" });
  assert.equal(x.node.hidden, true);
  assert.deepEqual(x.errors, []);
});

test("it sits right after the context meter, in the error colour when cold, and only in Work", () => {
  const footer = panelSrc.slice(panelSrc.indexOf('<div id="cfooter">'), panelSrc.indexOf('<div class="cf-right">'));
  const meter = footer.indexOf('class="picker context-picker"'), clock = footer.indexOf('id="cache-clock"');
  assert.ok(meter > 0 && clock > meter, "after the context meter");
  assert.ok(clock < footer.indexOf('id="btn-settings"'), "and before the next control");
  assert.match(mainCss, /\.cache-clock\.cold\s*\{[^}]*color:\s*var\(--vscode-errorForeground/);
  assert.match(mainCss, /\.cache-clock \.cache-clock-left\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(mainCss, /\.cache-clock[^{]*\{[^}]*animation/, "no animation");
  for (const file of ["media/chatdgc.js", "src/pipsClient.js", "src/chatdgc.ts", "src/pipsView.ts"]) {
    const source = readFileSync(dir + file, "utf8");
    assert.doesNotMatch(source, /cache[-_]clock|Prompt cache warm/, `${file}: ChatDGC and Pips never show it`);
  }
});
