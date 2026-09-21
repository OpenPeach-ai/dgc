// The specialist chips: their order, their identity marks, and what a RUNNING one looks like.
//
// All three were reported from a real session: the marks rendered as broken-image placeholders,
// the rows swapped places mid-turn, and a working agent looked exactly like a finished one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss, mainJs } from "./support/webview-dom.mjs";

function panel() {
  const { doc, send, dom, posted } = makeDom();
  send({ type: "event", event: { type: "ready", capabilities: { agents: true }, model: "m",
        mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true,
        commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 } });
  return { doc, dom, posted, event: (e) => send({ type: "event", event: e }) };
}

const agent = (id, extra = {}) => ({
  id, description: `specialist ${id}`, state: "running", tool_calls: 0, elapsed_ms: 0, ...extra,
});

const snapshot = (p, ids, extra = {}) => p.event({
  type: "agents", items: ids.map((id) => agent(id, extra[id] || {})),
  total: ids.length, active: ids.length,
});

// The menu re-renders through requestAnimationFrame, which jsdom never fires -- so reading the
// rows straight after a snapshot reads the PREVIOUS render. An earlier version of these tests did
// exactly that and passed with the fix removed. Close and reopen, which renders synchronously.
function rows(p) {
  const pill = p.doc.getElementById("agents-pill");
  pill.dispatchEvent(new p.dom.window.MouseEvent("click", { bubbles: true }));  // close
  pill.dispatchEvent(new p.dom.window.MouseEvent("click", { bubbles: true }));  // open, rendering
  return [...p.doc.querySelectorAll(".agent-row")].map((row) => row.textContent.trim());
}

// ---- order ---------------------------------------------------------------------------------

test("a snapshot in a different order does not move the agents", () => {
  // agentTree() sorts by [started_at, order]. agentRecordFrom hands out a fresh `order` on every
  // call, and the snapshot handler used to call it for every agent every time -- so the tiebreaker
  // was renumbered in whatever order the backend listed, and the rows swapped places under you.
  const p = panel();
  const ids = ["sub-000000000001", "sub-000000000002", "sub-000000000003", "sub-000000000004"];
  snapshot(p, ids);
  const first = rows(p);
  assert.equal(first.length, 4, "all four rendered");

  // The same four, listed back to front.
  snapshot(p, [...ids].reverse());
  assert.deepEqual(rows(p), first, "the rows kept the order they were first seen in");
});

test("a new agent joins at the end, it does not reshuffle the others", () => {
  const p = panel();
  snapshot(p, ["sub-00000000000a", "sub-00000000000b"]);
  const before = rows(p);
  assert.equal(before.length, 2);
  snapshot(p, ["sub-00000000000b", "sub-00000000000c", "sub-00000000000a"]);
  const after = rows(p);
  assert.equal(after.length, 3, "the new one is listed");
  assert.deepEqual(after.slice(0, before.length), before, "the first two stayed put");
});

// ---- the mark ------------------------------------------------------------------------------

test("a mark that cannot load falls back to its shape, not a broken image", () => {
  // :has(img) is true of PRESENCE, not of a successful load -- so a mark that 404s had its
  // coloured fallback turned off and showed the browser's placeholder glyph instead.
  assert.match(mainJs, /addEventListener\("error"/,
               "the mark must react to a failed load");
  assert.match(mainJs, /node\.removeChild\(img\)/,
               "and drop the <img> so :not(:has(img)) applies again");
});

test("every mark has a colour, whether or not its image loaded", () => {
  // --mark used to be declared only on the :not(:has(img)) fallback selector, so a loaded mark
  // had no colour for a glow to use.
  for (let n = 0; n < 8; n += 1) {
    assert.match(mainCss, new RegExp(`\\.agent-mark\\[data-mark="${n}"\\] \\{[^}]*--mark:`),
                 `mark ${n} has no colour outside the fallback`);
  }
});

test("a running agent's mark glows, and a finished one does not", () => {
  // `.agent-mark:has(img) { filter: none }` turned every filter off, so a working agent looked
  // exactly like a finished one once its artwork had loaded.
  assert.match(mainCss, /\.agent-mark:has\(img\)\.is-live \{[^}]*drop-shadow/,
               "a live mark with artwork has no glow");
  assert.match(mainCss, /@keyframes agent-mark-breathe/, "and nothing animates it");
  assert.match(mainCss, /prefers-reduced-motion: reduce\)[^}]*\{\s*\.agent-mark:has\(img\)\.is-live \{ animation: none/,
               "the pulse must stop for reduced motion");
});

test("only a live agent is marked live", () => {
  const p = panel();
  snapshot(p, ["sub-0000000000f1"], { "sub-0000000000f1": { state: "finished" } });
  const marks = [...p.doc.querySelectorAll(".agent-mark")];
  for (const mark of marks) {
    assert.equal(mark.classList.contains("is-live"), false,
                 "a finished agent must not wear the running treatment");
  }
});

test("reduced motion removes the movement, not the fact that it is running", () => {
  // `is-live` used to be set only when animation was also permitted, so a reader who asks for
  // less movement was shown a running agent as though it had finished. The preference is about
  // motion; the stylesheet is where it belongs.
  assert.match(mainJs, /node\.classList\.toggle\("is-live", live === true\)/,
               "is-live must be state alone");
  assert.doesNotMatch(mainJs, /toggle\("is-live",\s*animate\)/,
               "and must not be gated on whether it may animate");
});
