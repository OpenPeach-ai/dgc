// Read aloud: the speaker under a reply, the same in DGC's chat, ChatDGC and Pips. DGC's process makes the speech with
// the voice Settings -> Voice chose and sends it as it's made, a sentence or two at a time; this plays each piece the
// moment it arrives, one after another, on the computer you're at.
//
// A page makes one player for its box (create({post, within})), marks each reply's button data-read-aloud="<id>"
// (with a .ra-play and a .ra-stop icon inside), calls toggle(id, text) on a click and receive(message) with what the
// host says. The player keeps every such button in step: data-reading="loading" | "playing" while it reads.
// Voice mode listens for the end (onEnd) and draws the speech's own level (level()).
(function (root) {
  "use strict";

  function create(options) {
    const post = options.post, within = options.within;
    let current = "", state = "idle", ctx = null, analyser = null, next = 0, done = false;
    const sources = new Set(), ends = new Set(), errors = new Set();

    function buttons() { return [...(within || document).querySelectorAll("[data-read-aloud]")]; }
    function sync() {
      for (const b of buttons()) {
        const on = state !== "idle" && b.dataset.readAloud === current;
        if (on) b.dataset.reading = state; else delete b.dataset.reading;
        b.setAttribute("aria-pressed", String(on));
        const label = on ? "Stop reading" : "Read aloud";
        if (b.getAttribute("aria-label") !== label) { b.setAttribute("aria-label", label); b.title = label; }
      }
    }
    function audio() {
      if (!ctx) {
        const Context = root.AudioContext || root.webkitAudioContext;
        if (!Context) return null;
        ctx = new Context();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.connect(ctx.destination);
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }
    /** Stops at once, without telling the host (it already knows, or is being told). */
    function halt(reason) {
      for (const s of sources) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
      sources.clear();
      const was = current;
      current = ""; state = "idle"; done = false; next = 0;
      sync();
      if (was) for (const fn of ends) fn(was, reason);
    }
    function play(base64, rate) {
      const c = audio();
      if (!c || !base64 || !(rate > 0)) return;
      const bytes = atob(base64), n = bytes.length >> 1;
      if (!n) return;
      const buffer = c.createBuffer(1, n, rate), data = buffer.getChannelData(0);
      for (let i = 0; i < n; i++) {
        const v = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
        data[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
      }
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      const at = Math.max(c.currentTime + 0.04, next);
      source.start(at);
      next = at + buffer.duration;
      sources.add(source);
      source.onended = () => { sources.delete(source); if (done && !sources.size) halt("ended"); };
    }

    return {
      /** Starts reading the reply `id`, or stops it when it's the one being read. Call it from the click. */
      toggle(id, text) {
        id = String(id || "");
        if (current === id && state !== "idle") { this.stop(); return; }
        if (current) { post({ type: "speakStop" }); halt("replaced"); }
        audio();                                   // made inside the click: browsers start sound only on a gesture
        current = id; state = "loading"; done = false; next = 0;
        sync();
        post({ type: "speakStart", id, text: String(text || "") });
      },
      /** Readies the sound from a click, for a reading that will start later (voice mode). */
      prepare() { audio(); },
      stop() {
        if (!current) return;
        post({ type: "speakStop" });
        halt("stopped");
      },
      /** What the host says: {type: "speak", id, state, error?} and {type: "speakAudio", id, audio, rate, done}. */
      receive(msg) {
        if (!msg || String(msg.id || "") !== current || !current) return;
        if (msg.type === "speak") {
          if (msg.state === "idle") {
            if (msg.error) for (const fn of errors) fn(String(msg.error), msg.kind === "info" ? "info" : "error");
            // The host is done making it: what's already playing finishes, unless it said why it stopped.
            if (msg.error || !sources.size) halt(msg.error ? "error" : "ended"); else done = true;
          }
          return;
        }
        if (msg.type === "speakAudio") {
          if (msg.audio) { play(String(msg.audio), Number(msg.rate)); if (state !== "playing") { state = "playing"; sync(); } }
          if (msg.done) { done = true; if (!sources.size) halt("ended"); }
        }
      },
      /** A page that redrew its replies: the new buttons show what's being read. */
      sync,
      /** How loud the speech is now (RMS 0..1), for voice mode's waveform. */
      level() {
        if (!analyser || state !== "playing") return 0;
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        return Math.sqrt(sum / data.length);
      },
      onEnd(fn) { ends.add(fn); return () => ends.delete(fn); },
      onError(fn) { errors.add(fn); return () => errors.delete(fn); },
      get current() { return current; },
      get state() { return state; },
    };
  }

  const api = { create };
  root.DgcReadAloud = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
