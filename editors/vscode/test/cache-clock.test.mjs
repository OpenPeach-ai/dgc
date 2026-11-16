// The prompt cache's clock in the Work composer (0.48).
//
// warm -> a clock and the whole minutes left ("4m", tabular figures), changed at most once a minute,
// never seconds, no animation; cold -> the clock alone in the mild notice's colour, with the reason in its
// tooltip. Reopening a chat whose cache went cold adds one note to the transcript, and (0.52) so does an open chat
// left idle past its cache window: the same line, once an idle stretch. unknown (0.48.3) ->
// the clock still there, dimmed, no minutes, its tooltip naming the provider that doesn't say how long
// it caches (it was hidden, and a user, on Ollama Cloud, took the missing clock for a broken one).
// A click opens the clock's own popup: the time left, what the next message does, and the tokens reported as cached.
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
  assert.equal(x.node.dataset.cacheWindow, "unknown", "nothing cached yet");
  // A 5-minute entry written by a request sent 30 s ago.
  x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: T0 - 30000,
            expires_ms: T0 - 30000 + 300000, ttl_s: 300, tokens: 41000 });
  assert.equal(x.node.hidden, false);
  assert.equal(x.node.dataset.cacheWindow, "warm");
  assert.equal(x.left(), "5m", "4 min 30 s left reads 5m: whole minutes, rounded up, never seconds");
  assert.equal(x.node.title, "Prompt cache warm, about 5 min left.");
  assert.equal(x.node.getAttribute("aria-label"), "Prompt cache warm, about 5 min left.");
  assert.equal(x.node.getAttribute("role"), null, "a button that opens its popup");
  assert.equal(x.node.getAttribute("aria-live"), null, "no live region: never announced as it counts");
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
  assert.equal(x.node.hidden, false, "a provider DGC cannot read: still there");
  assert.equal(x.node.dataset.cacheWindow, "unknown");
  assert.equal(x.left(), "", "no minutes");
  assert.equal(x.node.classList.contains("cold"), false);
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
  // A new chat starts with nothing to time until its backend says otherwise.
  x.event({ type: "session", kind: "new", session_id: "s2" });
  assert.equal(x.node.dataset.cacheWindow, "unknown");
  assert.equal(x.node.hidden, false);
  assert.deepEqual(x.errors, []);
});

test("it sits right after the context meter, in the mild notice's colour when cold, and only in Work", () => {
  const footer = panelSrc.slice(panelSrc.indexOf('<div id="cfooter">'), panelSrc.indexOf('<div class="cf-right">'));
  const meter = footer.indexOf('class="picker context-picker"'), clock = footer.indexOf('id="cache-clock"');
  assert.ok(meter > 0 && clock > meter, "after the context meter");
  assert.ok(clock < footer.indexOf('id="btn-settings"'), "and before the next control");
  assert.match(mainCss, /\.cache-clock\.cold\s*\{[^}]*color:\s*var\(--need-text\)/);
  assert.match(mainCss, /\.cache-clock \.cache-clock-left\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(mainCss, /\.cache-clock[^{]*\{[^}]*animation/, "no animation");
  for (const file of ["media/chatdgc.js", "src/pipsClient.js", "src/chatdgc.ts", "src/pipsView.ts"]) {
    const source = readFileSync(dir + file, "utf8");
    assert.doesNotMatch(source, /cache[-_]clock|Prompt cache warm/, `${file}: ChatDGC and Pips never show it`);
  }
});

// ---- 0.48.3: when DGC can't time the cache ---------------------------------------------------------
const UNTIMED = "may cache your prompt, but it doesn't say for how long, so DGC can't show a timer.";
// The chat's route as the panel learns it: the backend's `config`, and the host's `state` (which follows a model change).
function route(x, { model, base_url, api_mode = "auto", prompt_cache = true, subscription = "" }) {
  x.event({ type: "config", model, mode: "default", think: "off", base_url, api_mode, prompt_cache, project_root: "/p", goal: {},
            subscription_engine: subscription });
  x.send({ type: "state", state: { model, mode: "default", think: "off", baseUrl: base_url, subscriptionEngine: subscription,
                                   goal: { text: "", status: "none", elapsed_seconds: 0 } } });
}

test("a provider DGC can't time: the clock stays, dimmed, with no minutes, and its tooltip names the provider", () => {
  const cases = [
    [{ model: "deepseek-v4.1-flash:cloud", base_url: "http://127.0.0.1:11434/v1" },
     "Ollama Cloud may cache your prompt, but it doesn't say for how long, so DGC can't show a timer."],
    [{ model: "gpt-oss:120b-cloud", base_url: "http://localhost:11434/v1", api_mode: "ollama" }, `Ollama Cloud ${UNTIMED}`],
    [{ model: "gpt-oss:120b", base_url: "https://ollama.com/v1" }, `Ollama Cloud ${UNTIMED}`],
    [{ model: "gpt-5.2", base_url: "https://api.openai.com/v1" }, `OpenAI ${UNTIMED}`],
    [{ model: "deepseek-chat", base_url: "https://api.deepseek.com/v1" }, `DeepSeek ${UNTIMED}`],
    [{ model: "qwen/qwen3-coder", base_url: "https://openrouter.ai/api/v1" }, `This model's provider ${UNTIMED}`],
    [{ model: "Claude Code default", base_url: "https://api.anthropic.com/v1", subscription: "claude" }, `This model's provider ${UNTIMED}`],
    // Where DGC can time it, there's just nothing to time yet (or the cache is off).
    [{ model: "claude-sonnet-4-5", base_url: "https://api.anthropic.com/v1" }, "No timer yet: Anthropic says how long its cache lasts after a reply."],
    [{ model: "claude-sonnet-4-5", base_url: "https://gateway.example.com/v1", api_mode: "anthropic" }, "No timer yet: Anthropic says how long its cache lasts after a reply."],
    [{ model: "claude-sonnet-4-5", base_url: "https://api.anthropic.com/v1", prompt_cache: false }, "Prompt caching is off (Settings → Models), so DGC can't show a timer."],
    [{ model: "qwen3:32b", base_url: "http://127.0.0.1:11434/v1" }, "No timer yet: Ollama says how long it keeps the model loaded after a reply."],
    [{ model: "qwen3:32b", base_url: "http://192.168.1.20:11434/v1", api_mode: "ollama" }, "No timer yet: Ollama says how long it keeps the model loaded after a reply."],
    [{ model: "qwen3:32b", base_url: "https://ollama.example.com:11434/v1" }, `This model's provider ${UNTIMED}`],
  ];
  for (const [r, tip] of cases) {
    const x = clockDom();
    route(x, r);
    x.event({ type: "cache_clock", state: "unknown" });
    const where = `${r.model} at ${r.base_url}`;
    assert.equal(x.node.hidden, false, `${where}: shown`);
    assert.equal(x.node.dataset.cacheWindow, "unknown", where);
    assert.equal(x.left(), "", `${where}: no minutes`);
    assert.equal(x.node.classList.contains("cold"), false, where);
    assert.equal(x.node.title, tip, where);
    assert.equal(x.node.getAttribute("aria-label"), tip, `${where}: a screen reader hears the same`);
    assert.deepEqual(x.errors, []);
  }
});

test("before the backend says anything the clock is already there, and a model change renames the provider", () => {
  const x = makeDom({ clock: true });
  const node = x.doc.getElementById("cache-clock");
  assert.equal(node.hidden, false, "in the footer from the first paint");
  assert.equal(node.dataset.cacheWindow, "unknown");
  assert.equal(node.title, `This model's provider ${UNTIMED}`, "a neutral sentence while the provider is unknown");
  const y = clockDom();
  route(y, { model: "deepseek-v4.1-flash:cloud", base_url: "http://127.0.0.1:11434/v1" });
  assert.equal(y.node.title, `Ollama Cloud ${UNTIMED}`);
  // The host's state follows a model change before the backend's next config does.
  y.send({ type: "state", state: { model: "gpt-5.2", mode: "default", think: "off", baseUrl: "https://api.openai.com/v1",
                                   goal: { text: "", status: "none", elapsed_seconds: 0 } } });
  assert.equal(y.node.title, `OpenAI ${UNTIMED}`);
  // A timed provider's clock, once it has something to time, is 0.48.0's: the minutes and the warm tooltip.
  route(y, { model: "claude-sonnet-4-5", base_url: "https://api.anthropic.com/v1" });
  y.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: T0, expires_ms: T0 + 300000, ttl_s: 300, tokens: 9000 });
  assert.equal(y.node.dataset.cacheWindow, "warm");
  assert.equal(y.left(), "5m");
  assert.equal(y.node.title, "Prompt cache warm, about 5 min left.");
  assert.deepEqual(y.errors, []);
});

test("a click on the clock opens its own popup, never the context details, and says what the provider reported as cached", () => {
  const x = clockDom();
  route(x, { model: "deepseek-v4.1-flash:cloud", base_url: "http://127.0.0.1:11434/v1" });
  x.event({ type: "cache_clock", state: "unknown" });
  x.event({ type: "context", used: 9000, size: 65536, compact_threshold: .85, input_tokens: 41000, output_tokens: 900,
            cached_input_tokens: 38400, reasoning_tokens: 0, requests: 3 });
  const menu = x.doc.getElementById("cachemenu"), context = x.doc.getElementById("ctxmenu");
  const text = (id) => x.doc.getElementById(id).textContent;
  assert.equal(x.node.tagName, "BUTTON", "the keyboard can reach it");
  assert.equal(menu.hidden, true);
  x.node.click();
  assert.equal(menu.hidden, false, "the click opened it (and the page's outside-click didn't close it again)");
  assert.equal(context.hidden, true, "the context details stay shut");
  assert.equal(x.doc.getElementById("btn-ctx").getAttribute("aria-expanded"), "false");
  assert.equal(x.node.getAttribute("aria-expanded"), "true");
  assert.equal(x.posted.some((m) => m.type === "contextBreakdown"), false);
  assert.equal(text("cache-state"), "No timer");
  assert.match(text("cache-said"), /Ollama Cloud may cache your prompt/);
  assert.equal(text("cache-usage"), "38,400 cached · 41,000 in");
  x.node.click();
  assert.equal(menu.hidden, true, "a second click closes it");
  // Warm: the time left, and it follows the provider's next report while open.
  x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: T0, expires_ms: T0 + 4 * 60000, ttl_s: 300 });
  x.node.click();
  assert.equal(text("cache-state"), "4 min left");
  assert.equal(x.doc.getElementById("cache-next").hidden, true);
  x.event({ type: "context", used: 9000, size: 65536, compact_threshold: .85, input_tokens: 50000, output_tokens: 900,
            cached_input_tokens: 45000, reasoning_tokens: 0, requests: 4 });
  assert.equal(text("cache-usage"), "45,000 cached · 50,000 in");
  // Cold: what the next message does. A click elsewhere closes it.
  x.event({ type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", tokens: 45000, anchor_ms: T0 - 12 * 60000 });
  assert.equal(text("cache-state"), "Expired");
  assert.match(text("cache-next"), /next message will re-cache about 45k tokens/);
  x.doc.body.click();
  assert.equal(menu.hidden, true, "a click elsewhere closes it");
  // The meter still opens the context details, and that closes the popup.
  x.node.click();
  x.doc.getElementById("btn-ctx").click();
  assert.equal(context.hidden, false);
  assert.equal(menu.hidden, true, "only one of them at a time");
  x.doc.body.click();
  // Escape closes it and returns to the clock.
  x.node.click();
  menu.dispatchEvent(new x.doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(menu.hidden, true);
  assert.equal(x.doc.activeElement, x.node);
  assert.deepEqual(x.errors, []);
});

test("dimmed is the unknown state's alone: warm keeps 0.48.0's look and cold is a mild notice", () => {
  // Innermost rules of the comment-free sheet (a rule inside @media reads its own selector), one selector at a time.
  const css = mainCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
    selectors.split(",").map((selector) => ({ selector: selector.trim(), body })));
  const dim = rules.filter((r) => /\.cache-clock|#cache-clock/.test(r.selector) && /opacity|filter/.test(r.body));
  assert.ok(dim.length > 0, "something dims the clock");
  for (const r of dim) {
    assert.match(r.selector, /\[data-cache-window="unknown"\]/, `only the unknown clock is dimmed: ${r.selector}`);
  }
  const rest = dim.find((r) => !/:hover/.test(r.selector));
  assert.match(rest.body, /opacity:\s*\.5/, "half strength, as the agreed mockup");
  assert.match(mainCss, /\.cache-clock\.cold\s*\{[^}]*color:\s*var\(--need-text\)/, "cold: expired is normal, so never the error colour");
  assert.doesNotMatch(panelSrc.match(/<button type="button" id="cache-clock"[^>]*>/)[0], /\shidden/, "no longer hidden in the markup");
});

test("the popup says expired once: the headline, then what the next message costs", () => {
  const x = clockDom();
  x.event({ type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", tokens: 41000, anchor_ms: T0 - 12 * 60000 });
  x.node.click();
  const said = x.doc.getElementById("cache-said"), next = x.doc.getElementById("cache-next");
  assert.equal(x.doc.getElementById("cache-state").textContent, "Expired");
  assert.equal(said.hidden, true, "no second sentence saying the same");
  assert.equal(said.textContent, "");
  assert.match(next.textContent, /^Idle 12m\. The prompt cache has likely expired, so your next message will re-cache about 41k tokens\.$/);
  assert.match(x.node.title || x.node.getAttribute("aria-label"), /^Prompt cache likely expired \(idle 12m\)\.$/, "the hover label keeps its short form");
  x.event({ type: "cache_clock", state: "cold", reason: "unloaded", source: "ollama", tokens: 41000, anchor_ms: T0 - 12 * 60000 });
  assert.match(next.textContent, /^Ollama unloaded the model \(idle 12m\), so your next message will re-cache about 41k tokens\.$/);
  x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: T0, expires_ms: T0 + 4 * 60000, ttl_s: 300 });
  assert.equal(said.hidden, false, "warm still says its one line");
  assert.notEqual(said.textContent, "");
});

// ---- 0.52: an open chat that sits idle past its cache window says so once, at its end -------------------
// "Idle 1d 17h. The prompt cache has likely expired, so your next message will re-cache about 524k
// tokens." goes under the last reply of a session left idle. Work wrote that line only when a chat was REOPENED cold; a chat
// left open said nothing. Now the open chat says it too: when the clock's own timer runs out, when the provider says
// the cache has gone, or when the window is shown again and finds it gone. One line an idle stretch, the same line as
// the reopen note, its time brought up to date only when the window is shown again.
const IDLE = (said, tokens = "41k") => `Idle ${said}. The prompt cache has likely expired, so your next message will re-cache about ${tokens} tokens.`;
function idleDom() {
  const x = clockDom();
  const lines = () => [...x.doc.querySelectorAll("#log .sys")];
  const notes = () => lines().map((n) => n.textContent);
  // A finished turn: your prompt, a reply, and the clock the reply's own cache report started (sent `ago` ms ago).
  const turn = (id, { ago = 30000, clock = true, ttl = 300, tokens = 41000 } = {}) => {
    x.event({ type: "turn_start", turn_id: id, prompt: "Go" });
    x.event({ type: "text_delta", text: "Done." });
    x.event({ type: "stream_end", message_id: `${id}:1`, phase: "final_answer" });
    if (clock) x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: x.now() - ago, expires_ms: x.now() - ago + ttl * 1000, ttl_s: ttl, tokens, session_id: "s1" });
    x.event({ type: "turn_end", turn_id: id, reason: "completed" });
  };
  // The window is shown again (the side bar reopened, the tab chosen, the editor's window back in front).
  const shown = (how = "visibilitychange") => (how === "focus" ? x.dom.window.dispatchEvent(new x.dom.window.Event("focus")) : x.doc.dispatchEvent(new x.dom.window.Event("visibilitychange")));
  x.event({ type: "session", kind: "new", session_id: "s1" });
  // Time passing as it does: the wall clock and the timers together, half a minute at a step (clockDom's tick moves
  // the wall the whole way first, so a timer due on the way would read the time at the end).
  const pass = (ms) => { for (let left = ms; left > 0; left -= 30000) x.tick(Math.min(30000, left)); };
  return { ...x, tick: pass, lines, notes, turn, shown };
}

test("an open chat left idle past its cache window gets the line once, at its end, when the clock's own timer runs out", () => {
  const x = idleDom();
  x.turn("t1");
  assert.equal(x.node.dataset.cacheWindow, "warm");
  x.tick(4 * 60000);
  assert.deepEqual(x.notes(), [], "nothing while the cache is warm");
  x.tick(60000);                                   // 5 min 30 s after the reply was sent: the window ran out 30 s ago
  assert.equal(x.node.dataset.cacheWindow, "cold");
  assert.deepEqual(x.notes(), [IDLE("5m")], "the idle time counts from the last reply and is said as the line is drawn");
  const [line] = x.lines();
  assert.equal(line.className, "sys cache-idle", "the transcript's quiet note, as the reopen note is");
  assert.equal(line.getAttribute("role"), null, "not an alert");
  assert.equal(x.doc.getElementById("log").lastElementChild, line, "at the end of the chat, under the last reply");
  assert.match(line.previousElementSibling.textContent, /Done\./, "the reply is right above it");
  // Never by a ticking timer: left for two days, nothing wakes up and the line reads as it did.
  const scheduled = [];
  const realSet = x.dom.window.setTimeout;
  x.dom.window.setTimeout = (fn, ms) => { scheduled.push(ms); return realSet(fn, ms); };
  x.tick(41 * 3600000);
  assert.deepEqual(x.notes(), [IDLE("5m")]);
  assert.deepEqual(scheduled, [], "no timer runs for it");
  assert.deepEqual(x.errors, []);
});

test("shown again while still idle: the line's time is brought up to date, and it is never said twice", () => {
  const x = idleDom();
  x.turn("t1");
  x.tick(5 * 60000);
  assert.deepEqual(x.notes(), [IDLE("5m")]);
  const [line] = x.lines();
  x.tick(2 * 3600000);
  x.shown();
  assert.deepEqual(x.notes(), [IDLE("2h 5m")], "the same line, with the time it is now");
  assert.equal(x.lines()[0], line, "the very same line, where it was said");
  x.tick(39 * 3600000 + 10 * 60000);
  x.shown("focus");
  assert.deepEqual(x.notes(), [IDLE("1d 17h")]);
  x.shown(); x.shown("focus");
  assert.deepEqual(x.notes(), [IDLE("1d 17h")], "still one");
  // A repaint of the clock by its backend, and pointing at the clock, don't add one either.
  x.event({ type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", anchor_ms: x.now() - 41 * 3600000 - 15 * 60000, ttl_s: 300, tokens: 41000, session_id: "s1" });
  x.node.dispatchEvent(new x.dom.window.MouseEvent("mouseenter"));
  assert.equal(x.notes().filter((t) => t.startsWith("Idle")).length, 1);
  assert.deepEqual(x.errors, []);
});

test("the window coming back finds the cache cold: the line is written then (a timer that never fired while hidden)", () => {
  const x = idleDom();
  x.turn("t1");
  // The page was hidden and its timer never ran: only the wall clock moved.
  const frozen = x.dom.window.setTimeout;
  x.dom.window.setTimeout = () => 0;
  x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: x.now() - 30000, expires_ms: x.now() + 270000, ttl_s: 300, tokens: 524000, session_id: "s1" });
  x.dom.window.setTimeout = frozen;
  x.tick(41 * 3600000);
  assert.deepEqual(x.notes(), [], "nothing woke it");
  x.shown();
  assert.deepEqual(x.notes(), [IDLE("1d 17h", "524k")], "his example, to the letter");
  assert.equal(x.node.dataset.cacheWindow, "cold", "and the clock in the footer agrees");
  assert.deepEqual(x.errors, []);
});

test("never while a turn is running; the next message ends the idle stretch and the line stays where it was said", () => {
  const x = idleDom();
  x.turn("t1");
  // A second turn that runs for ten minutes without a new request (a long command): the clock runs out under it.
  x.event({ type: "turn_start", turn_id: "t2", prompt: "Run the suite" });
  x.tick(6 * 60000);
  assert.equal(x.node.dataset.cacheWindow, "cold");
  x.shown();
  assert.deepEqual(x.notes(), [], "a turn is running: the chat isn't idle");
  x.event({ type: "text_delta", text: "Green." });
  x.event({ type: "stream_end", message_id: "t2:1", phase: "final_answer" });
  x.event({ type: "cache_clock", state: "warm", source: "anthropic", anchor_ms: x.now() - 1000, expires_ms: x.now() + 299000, ttl_s: 300, tokens: 52000, session_id: "s1" });
  x.event({ type: "turn_end", turn_id: "t2", reason: "completed" });
  assert.deepEqual(x.notes(), []);
  x.tick(12 * 60000);
  assert.deepEqual(x.notes(), [IDLE("5m", "52k")], "idle again: one line for this stretch");
  const [first] = x.lines();
  // The next message: a new turn. The line stays in the transcript above it, as it was said.
  x.tick(3600000);
  x.turn("t3", { ago: 2000, tokens: 60000 });
  x.shown();
  assert.deepEqual(x.notes(), [IDLE("5m", "52k")], "the old line isn't brought up to date once its stretch has ended");
  assert.equal(x.lines()[0], first);
  assert.ok(first.compareDocumentPosition([...x.doc.querySelectorAll("#log .turn")].at(-1)) & 4, "it stays above the turn that followed");
  x.tick(20 * 60000);
  assert.deepEqual(x.notes(), [IDLE("5m", "52k"), IDLE("5m", "60k")], "and the next idle stretch gets its own, at the end");
  assert.equal(x.doc.getElementById("log").lastElementChild, x.lines()[1]);
  x.tick(3600000); x.shown();
  assert.deepEqual(x.notes(), [IDLE("5m", "52k"), IDLE("1h 20m", "60k")], "only the current stretch's line follows the time");
  assert.deepEqual(x.errors, []);
});

test("a chat reopened after going cold shows one line: the reopen note is the idle line", () => {
  const x = clockDom();
  const notes = () => [...x.doc.querySelectorAll("#log .sys")].map((n) => n.textContent);
  x.event({ type: "session", kind: "resumed", session_id: "s1", message_count: 4 });
  x.event({ type: "history", items: [{ role: "user", text: "Earlier" }, { role: "assistant", text: "Done." }] });
  const cold = { type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", resumed: true,
                 anchor_ms: T0 - (2 * 3600 + 5 * 60) * 1000, ttl_s: 300, tokens: 180000, session_id: "s1" };
  x.event(cold);
  assert.deepEqual(notes(), [IDLE("2h 5m", "180k")]);
  x.doc.dispatchEvent(new x.dom.window.Event("visibilitychange"));
  x.tick(60000);
  assert.deepEqual(notes(), [IDLE("2h 5m", "180k")], "reopened and still idle: one, never two");
  x.tick(3 * 3600000);
  x.doc.dispatchEvent(new x.dom.window.Event("visibilitychange"));
  assert.deepEqual(notes(), [IDLE("5h 6m", "180k")], "and it follows the time as any idle line does");
  assert.equal(x.doc.querySelector("#log .sys").className, "sys cache-idle");
  assert.deepEqual(x.errors, []);
});

test("no line for a provider DGC can't time, in a brand-new chat, or for a warm cache", () => {
  // The dimmed clock: nothing to time, so nothing to say, however long the chat sits.
  const x = idleDom();
  route(x, { model: "gpt-5.2", base_url: "https://api.openai.com/v1" });
  x.turn("t1", { clock: false });
  x.event({ type: "cache_clock", state: "unknown" });
  x.tick(41 * 3600000); x.shown(); x.shown("focus");
  assert.equal(x.node.dataset.cacheWindow, "unknown");
  assert.deepEqual(x.notes(), []);
  // A brand-new chat: nothing said yet, so nothing to re-cache.
  const y = idleDom();
  y.event({ type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", anchor_ms: T0 - 3600000, ttl_s: 300, tokens: 41000, session_id: "s1" });
  y.tick(3600000); y.shown();
  assert.equal(y.node.dataset.cacheWindow, "cold");
  assert.deepEqual(y.notes(), []);
  // A local Ollama that keeps the model loaded until it stops: warm for good.
  const z = idleDom();
  z.turn("t1", { clock: false });
  z.event({ type: "cache_clock", state: "warm", source: "ollama", anchor_ms: z.now(), session_id: "s1" });
  z.tick(41 * 3600000); z.shown();
  assert.deepEqual(z.notes(), []);
  assert.deepEqual([...x.errors, ...y.errors, ...z.errors], []);
});

test("the other reasons, in the reopen note's own words: an Ollama that unloaded the model, a compacted conversation", () => {
  // Ollama says when it will unload the model; its backend also says so the moment it has (another model was loaded).
  const x = idleDom();
  x.turn("t1", { clock: false });
  x.event({ type: "cache_clock", state: "warm", source: "ollama", anchor_ms: x.now(), expires_ms: x.now() + 30 * 60000, tokens: 9000, session_id: "s1" });
  x.tick(12 * 60000);
  assert.deepEqual(x.notes(), []);
  x.event({ type: "cache_clock", state: "cold", reason: "unloaded", source: "ollama", anchor_ms: x.now() - 12 * 60000, tokens: 9000, session_id: "s1" });
  assert.deepEqual(x.notes(), ["Ollama unloaded the model (idle 12m), so your next message will re-cache about 9k tokens."]);
  x.tick(3600000); x.shown();
  assert.deepEqual(x.notes(), ["Ollama unloaded the model (idle 1h 12m), so your next message will re-cache about 9k tokens."]);
  // Its own timer running out reads the same.
  const y = idleDom();
  y.turn("t1", { clock: false });
  y.event({ type: "cache_clock", state: "warm", source: "ollama", anchor_ms: y.now(), expires_ms: y.now() + 5 * 60000, tokens: 9000, session_id: "s1" });
  y.tick(5 * 60000 + 1000);
  assert.deepEqual(y.notes(), ["Ollama unloaded the model (idle 5m), so your next message will re-cache about 9k tokens."]);
  // Compacting is something you (or a turn) did, not idling: its event alone says nothing more; the window coming
  // back to a chat still cold says what the next message will do.
  const z = idleDom();
  z.turn("t1");
  z.event({ type: "cache_clock", state: "cold", reason: "compacted", source: "anthropic", anchor_ms: z.now() - 60000, session_id: "s1" });
  assert.deepEqual(z.notes(), [], "not the moment the conversation is compacted");
  z.tick(30 * 60000); z.shown();
  assert.deepEqual(z.notes(), ["The conversation was compacted, so your next message will re-cache it."]);
  z.tick(3600000); z.shown();
  assert.equal(z.notes().length, 1);
  assert.deepEqual([...x.errors, ...y.errors, ...z.errors], []);
});

test("switching to another chat ends the stretch: its line belongs to the chat it was said in", () => {
  const x = idleDom();
  x.turn("t1");
  x.tick(6 * 60000);
  assert.deepEqual(x.notes(), [IDLE("5m")]);
  x.event({ type: "session", kind: "new", session_id: "s2" });
  x.tick(3600000); x.shown();
  assert.deepEqual(x.notes(), [], "a new chat has no line, and the old chat's is not carried into it");
  assert.equal(x.node.dataset.cacheWindow, "unknown");
  assert.deepEqual(x.errors, []);
});
