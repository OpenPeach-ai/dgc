// The voice bar: what a message box shows while you dictate, the same in DGC's chat, ChatDGC and Pips.
//
//   [✕ Cancel]  [ ▁▃▅▂▇▃▁ live waveform ··· 0:07 ]  [■ Stop: add it to the message]  [↑ Stop and send]
//
// The waveform is your microphone, not an animation: DGC Voice reads how loud it is about every 50 ms on the
// computer you're at, and each bar here is 200 ms of that, scrolling in from the right (Codex draws its dictation
// the same way). A flat line for three seconds says so: "Not hearing anything — check your microphone".
//
// A page makes one bar controller for its box (create(scope)), puts markup(scope) where the box's bottom row was,
// and tells the controller what happens: state("starting" | "recording" | "writing" | "idle"), push(levels). The
// controller keeps everything in JavaScript and draws into whatever [data-voicebar=<scope>] is on the page each
// frame, so a page that redraws its whole box (Pips) loses nothing. Clicks come back as data-voice-action buttons.
(function (root) {
  "use strict";
  const BAR_W = 3, PITCH = 6, BAR_MS = 200;     // Codex's scrolling waveform: 3 px bars every 6 px, one per 200 ms
  // Flat this long, this quiet: "not hearing anything". A working microphone's own hiss is above this (about
  // -66 dBFS); one the system withholds reads exactly nothing.
  const QUIET_MS = 3000, QUIET_RMS = 0.0005;
  const SVG = (d, extra = "") => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;
  const ICON = {
    cancel: SVG('<path d="M4 4l8 8M12 4l-8 8"/>'),
    stop: SVG('<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>'),
    send: SVG('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
    done: SVG('<path d="m3.5 8.5 3 3 6-7"/>'),
  };
  const STATUS = {
    starting: "Starting the microphone…",
    writing: "Writing it down…",
    thinking: "Thinking…",
    quiet: "Not hearing anything — check your microphone",
  };
  /** States in which the waveform moves: your microphone (recording, listening) or the reply's voice (speaking). */
  const LIVE = ["recording", "listening", "speaking"];

  /** How tall a bar is for a loudness (RMS 0..1): quiet speech is visible, a shout doesn't flatten the rest. */
  function height(rms) {
    const t = Math.max(0, rms - 0.006) / (0.16 - 0.006);
    return Math.min(1, t) ** 0.6;
  }

  /** Voice mode's bar: End, the waveform with what's happening, and one button that ends your turn now (while it
   *  listens) or stops the reply's voice (while it speaks). */
  function conversationMarkup(s) {
    return `<div class="dgc-voicebar" data-voicebar="${s}" data-variant="conversation" data-state="starting" role="group" aria-label="Voice mode">`
      + `<button type="button" class="vb-btn" data-voice-action="end" aria-label="End voice mode" title="End voice mode (Esc)">${ICON.cancel}</button>`
      + `<div class="vb-center"><canvas class="vb-wave" data-voice-wave aria-hidden="true"></canvas>`
      + `<span class="vb-status" data-voice-status role="status" aria-live="polite"></span>`
      + `<span class="vb-time vb-phase" data-voice-phase></span></div>`
      + `<button type="button" class="vb-send vb-turn" data-voice-action="turn" aria-label="Done talking" title="Done talking: send it now">`
      + `<span class="vb-icon-done">${ICON.done}</span><span class="vb-icon-stop">${ICON.stop}</span><span class="vb-spin" aria-hidden="true"></span></button>`
      + `</div>`;
  }

  function markup(scope, variant) {
    const s = String(scope).replace(/[^a-z0-9-]/gi, "");
    if (variant === "conversation") return conversationMarkup(s);
    return `<div class="dgc-voicebar" data-voicebar="${s}" data-state="starting" role="group" aria-label="Dictation">`
      + `<button type="button" class="vb-btn" data-voice-action="cancel" aria-label="Cancel dictation" title="Cancel (Esc)">${ICON.cancel}</button>`
      + `<div class="vb-center"><canvas class="vb-wave" data-voice-wave aria-hidden="true"></canvas>`
      + `<span class="vb-status" data-voice-status role="status" aria-live="polite"></span>`
      + `<span class="vb-time" data-voice-time aria-label="Recording time">0:00</span></div>`
      + `<button type="button" class="vb-btn" data-voice-action="stop" aria-label="Stop and add it to the message" title="Stop: add it to the message">${ICON.stop}<span class="vb-spin" aria-hidden="true"></span></button>`
      + `<button type="button" class="vb-send" data-voice-action="send" aria-label="Stop and send" title="Stop and send">${ICON.send}<span class="vb-spin" aria-hidden="true"></span></button>`
      + `</div>`;
  }

  /** `within`: where the box's bars are -- the page, or the shadow root a box lives in (Pips in the side bar). */
  function create(scope, within) {
    const s = String(scope).replace(/[^a-z0-9-]/gi, "");
    let state = "idle", pressed = "", began = 0, raf = 0;
    let queue = [], bars = [], lastBar = 0, scroll = 0, heard = false, quietSince = 0, lastFrame = 0;
    const bodies = () => [...(within || document).querySelectorAll(`[data-voicebar="${s}"]`)];

    function reset() {
      queue = []; bars = []; lastBar = performance.now(); scroll = 0; heard = false; quietSince = 0; began = 0;
    }

    /** One 200 ms bar from what arrived: four readings, or what there is; a gap fades rather than drops. */
    function nextBar() {
      if (queue.length > 12) queue.splice(0, queue.length - 8);      // fallen behind: catch up
      const take = queue.splice(0, Math.min(4, queue.length));
      if (take.length) return height(take.reduce((a, b) => a + b, 0) / take.length);
      const prev = bars.length ? bars[bars.length - 1] : -1;
      return prev > 0 ? prev * 0.6 : prev;
    }

    function draw(canvas, now) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      const dpr = root.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(0, h / 2);
      ctx.fillStyle = getComputedStyle(canvas).color || "#ccc";
      const count = Math.floor(w / PITCH) + 1;
      const shown = bars.slice(-count);
      const offset = LIVE.includes(state) ? PITCH * scroll : 0;
      for (let i = 0; i < count; i++) {
        const v = shown[shown.length - count + i];
        const real = typeof v === "number" && v >= 0;
        const bh = Math.max(BAR_W, (h - BAR_W) * (real ? v : 0));
        const x = w - (count - i) * PITCH - offset + PITCH - BAR_W;
        ctx.globalAlpha = real ? 0.55 : 0.2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, -bh / 2, BAR_W, bh, BAR_W / 2); else ctx.rect(x, -bh / 2, BAR_W, bh);
        ctx.fill();
      }
      // Fade both ends, so bars slide in and out rather than pop.
      const fade = ctx.createLinearGradient(0, 0, w, 0), edge = Math.min(0.5, (PITCH * 2) / w);
      fade.addColorStop(0, "rgba(0,0,0,0)"); fade.addColorStop(edge, "rgba(0,0,0,1)");
      fade.addColorStop(1 - edge, "rgba(0,0,0,1)"); fade.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = fade; ctx.fillRect(0, -h / 2, w, h);
      ctx.restore();
    }

    function quiet(now) {
      return (state === "recording" || state === "listening") && heard && quietSince && now - quietSince >= QUIET_MS;
    }

    /** Every bar on the page for this box shows the same state (a page may have drawn a fresh one). */
    function sync(now) {
      const secs = began ? Math.floor((now - began) / 1000) : 0;
      const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      const status = state === "recording" || state === "listening" ? (quiet(now) ? STATUS.quiet : "") : STATUS[state] || "";
      const phase = state === "listening" ? "Listening" : state === "speaking" ? "Speaking" : "";
      for (const body of bodies()) {
        const ph = body.querySelector("[data-voice-phase]");
        if (ph && ph.textContent !== phase) ph.textContent = phase;
        const turn = body.querySelector('[data-voice-action="turn"]');
        if (turn) {
          const label = state === "speaking" ? "Stop speaking" : "Done talking";
          if (turn.getAttribute("aria-label") !== label) { turn.setAttribute("aria-label", label); turn.title = state === "speaking" ? "Stop speaking, and listen" : "Done talking: send it now"; }
        }
        if (body.dataset.state !== state) body.dataset.state = state;
        body.toggleAttribute("data-quiet", !!quiet(now));
        const st = body.querySelector("[data-voice-status]");
        if (st && st.textContent !== status) st.textContent = status;
        const tm = body.querySelector("[data-voice-time]");
        if (tm && tm.textContent !== time) tm.textContent = time;
        for (const b of body.querySelectorAll("[data-voice-action]")) {
          const action = b.dataset.voiceAction;
          const off = action === "end" ? false
            : action === "turn" ? !["listening", "speaking"].includes(state)
            : state === "writing" || (state === "starting" && action !== "cancel");
          if (b.disabled !== off) b.disabled = off;
          b.toggleAttribute("data-busy", state === "writing" && action === pressed);
        }
        const wave = body.querySelector("[data-voice-wave]");
        if (wave && state !== "writing" && state !== "thinking") draw(wave, now);
      }
    }

    function frame(now) {
      raf = 0;
      if (state === "idle") return;
      if (LIVE.includes(state)) {
        scroll += (now - (lastFrame || now)) / BAR_MS;
        while (scroll >= 1) { bars.push(nextBar()); if (bars.length > 400) bars.splice(0, bars.length - 400); scroll -= 1; lastBar = now; }
      }
      lastFrame = now;
      sync(now);
      raf = root.requestAnimationFrame(frame);
    }

    function run() { if (!raf && state !== "idle") { lastFrame = 0; raf = root.requestAnimationFrame(frame); } }

    return {
      scope: s,
      /** A bar for the box, already in the state it's in (a page that redraws gets the right one at once). */
      markup: (variant) => markup(s, variant).replace('data-state="starting"', `data-state="${state === "idle" ? "starting" : state}"`),
      /** Fills in a bar the page just drew (its words, its buttons), without waiting for the next frame. */
      refresh() { if (state !== "idle") sync(performance.now()); },
      /** "starting" | "recording" | "writing" | "idle"; `action` names the button a "writing" came from. */
      state(next, action = "") {
        if (next === state && next !== "writing") return;
        if (next === "starting" || (LIVE.includes(next) && state === "idle")) reset();
        // A turn in voice mode starts its own waveform, and the quiet check starts over.
        if ((next === "listening" || next === "speaking") && state !== next) { queue = []; heard = false; quietSince = 0; }
        if (LIVE.includes(next) && !began) began = performance.now();
        if (next === "writing") pressed = action || pressed || "stop";
        else pressed = "";
        state = next;
        if (state === "idle") { if (raf) root.cancelAnimationFrame(raf); raf = 0; return; }
        sync(performance.now());
        run();
      },
      /** Readings of how loud the microphone was (RMS 0..1, ~50 ms each), oldest first. */
      push(levels) {
        if (!Array.isArray(levels) || !LIVE.includes(state)) return;
        const now = performance.now();
        for (const v of levels) {
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          queue.push(Math.max(0, Math.min(1, n)));
          if (state === "speaking") continue;        // the reply's voice: never "not hearing anything"
          heard = true;
          if (n >= QUIET_RMS) quietSince = 0;
          else if (!quietSince) quietSince = now;
        }
      },
      get current() { return state; },
      /** For tests: the bars drawn so far (0..1, -1 for before it started). */
      get bars() { return bars.slice(); },
    };
  }

  const api = { create, markup, height };
  root.DgcVoiceBar = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
