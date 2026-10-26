// The prompt cache's clock in the Work composer (0.48), copied from Claude Code.
//
// warm -> a clock and the whole minutes left ("4m", tabular figures), changed at most once a minute,
// never seconds, no animation; cold -> the clock alone in the error colour, with the reason in its
// tooltip. Reopening a chat whose cache went cold adds one note to the transcript. unknown (0.48.3) ->
// the clock still there, dimmed, no minutes, its tooltip naming the provider that doesn't say how long
// it caches (it was hidden, and the founder, on Ollama Cloud, took the missing clock for a broken one).
// A click opens the context meter's details, with the tokens the provider reported as cached.
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

test("a click on the clock opens the context meter's details, which say how much the provider reported as cached", () => {
  const x = clockDom();
  route(x, { model: "deepseek-v4.1-flash:cloud", base_url: "http://127.0.0.1:11434/v1" });
  x.event({ type: "cache_clock", state: "unknown" });
  x.event({ type: "context", used: 9000, size: 65536, compact_threshold: .85, input_tokens: 41000, output_tokens: 900,
            cached_input_tokens: 38400, reasoning_tokens: 0, requests: 3 });
  const menu = x.doc.getElementById("ctxmenu"), meter = x.doc.getElementById("btn-ctx");
  assert.equal(menu.hidden, true);
  x.node.click();
  assert.equal(menu.hidden, false, "the click opened it (and the page's outside-click didn't close it again)");
  assert.equal(meter.getAttribute("aria-expanded"), "true", "the meter says its details are open");
  assert.equal(x.doc.getElementById("ctx-usage").textContent, "41,000 in · 900 out · 38,400 cached · 3 requests");
  assert.ok(x.posted.some((m) => m.type === "contextBreakdown"), "and asked what fills the window, as the meter does");
  x.node.click();
  assert.equal(menu.hidden, true, "a second click closes it");
  // Warm and cold open it too: one place for the cache's numbers, whatever the clock shows.
  x.event({ type: "cache_clock", state: "cold", reason: "expired", source: "anthropic", anchor_ms: T0 - 12 * 60000 });
  x.node.click();
  assert.equal(menu.hidden, false);
  x.doc.body.click();
  assert.equal(menu.hidden, true, "a click elsewhere closes it, as for the meter");
  assert.deepEqual(x.errors, []);
});

test("dimmed is the unknown state's alone: warm and cold keep 0.48.0's look", () => {
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
  assert.match(mainCss, /\.cache-clock\.cold\s*\{[^}]*color:\s*var\(--vscode-errorForeground/, "cold: the error colour, as before");
  assert.doesNotMatch(panelSrc.match(/<span id="cache-clock"[^>]*>/)[0], /\shidden/, "no longer hidden in the markup");
});
