// Voice mode: a spoken conversation in ChatDGC and Pips. It listens; when you've finished talking (a moment of quiet
// after speech) it writes down what you said and sends it; it waits for the reply and reads it aloud; then it listens
// again -- until you end it. You can end your turn early (Done) or cut the reply short (Stop), and it listens.
//
// It is made of what dictation and read aloud already are: the page's mic messages (micStart / micStop "send" /
// micCancel), the levels DGC Voice measures on the computer you're at (micLevels), and a read-aloud player. Nothing
// records while it speaks, so the reply's voice never comes back in as your words.
//
// A page makes one for its box: create({bar, reader, post, deliver, messages, show, notify}), where `deliver(text)`
// puts the words in the box and sends them, `messages()` is the box's messages now ({id, role, text}, oldest first),
// `show(on)` swaps the box's bottom row for the bar, and `notify(text, kind)` says something in the page's own way.
// The page passes what the host says to receive(msg) (true when it was voice mode's), and calls check(busy) when its
// messages change or a reply finishes, so voice mode hears the reply.
(function (root) {
  "use strict";

  /** Ends a turn: a moment of quiet after speech, measured against the room's own hiss. */
  function turnDetector(options = {}) {
    const endAfterMs = options.endAfterMs || 1200, maxMs = options.maxMs || 60000, floorReadings = 8;
    let floor = [], heard = false, quietSince = 0, began = 0, speech = 0.015, silence = 0.008;
    return {
      reset(now) { floor = []; heard = false; quietSince = 0; began = now; speech = 0.015; silence = 0.008; },
      /** Readings (RMS 0..1, ~50 ms each), oldest first, as they arrive at `now`: true when the turn is over. */
      push(levels, now) {
        for (const raw of levels) {
          const v = Number(raw);
          if (!Number.isFinite(v)) continue;
          // The first 400 ms are the room: how loud it is when nobody speaks sets what counts as speech. (Capped, so
          // someone who starts talking at once still is heard over the bar their own voice set.)
          if (floor.length < floorReadings) {
            floor.push(v);
            if (floor.length === floorReadings) {
              const sorted = floor.slice().sort((a, b) => a - b), median = sorted[sorted.length >> 1];
              speech = Math.min(0.08, Math.max(0.015, median * 3)); silence = Math.min(0.05, Math.max(0.008, median * 1.8));
            }
            continue;
          }
          if (v >= speech) { heard = true; quietSince = 0; }
          else if (heard && v < silence) { if (!quietSince) quietSince = now; }
          else if (heard) quietSince = 0;
        }
        return heard && ((quietSince && now - quietSince >= endAfterMs) || now - began >= maxMs);
      },
      get heard() { return heard; },
    };
  }

  function create(o) {
    const bar = o.bar, reader = o.reader, detector = turnDetector(o.turn);
    let phase = "off", known = new Set(), speakingId = "", meter = 0, recording = false;

    function set(next, action = "") {
      phase = next;
      if (meter) { clearInterval(meter); meter = 0; }
      bar.state(next === "off" ? "idle" : next, action);
      if (next === "speaking") meter = setInterval(() => bar.push([reader.level()]), 50);   // the reply's own voice
      o.show(next !== "off");
    }
    function listen() { set("starting"); recording = true; o.post({ type: "micStart" }); }
    function endTurn() { set("writing", "turn"); recording = false; o.post({ type: "micStop", mode: "send" }); }
    function stopAll(say) {
      const was = phase;
      if (recording) { recording = false; o.post({ type: "micCancel" }); }   // only a recording it asked for
      if (was === "speaking" || reader.current) reader.stop();
      set("off");
      if (say) o.notify(say, "info");
    }

    reader.onEnd((id, why) => {
      if (phase !== "speaking" || id !== speakingId) return;
      speakingId = "";
      if (why === "error") { set("off"); return; }
      listen();                                   // ended, or cut short: your turn
    });

    return {
      get active() { return phase !== "off"; },
      get phase() { return phase; },
      /** From the click on the voice mode button: checks there's a voice to listen with and one to answer in. */
      start() {
        if (phase !== "off") return;
        reader.prepare?.();                       // sound can start only from a click: ready it now
        set("starting");
        o.post({ type: "voiceCheck" });
      },
      end() { stopAll(""); },
      /** A click on one of the bar's buttons. */
      action(name) {
        if (name === "end") stopAll("");
        else if (name === "turn") {
          if (phase === "listening") endTurn();
          else if (phase === "speaking") reader.stop();   // onEnd -> listen
        }
      },
      /** What the host says; true when it was voice mode's to handle. */
      receive(msg) {
        if (phase === "off") return false;
        if (msg.type === "voiceReady") {
          if (msg.dictation && msg.readAloud) listen();
          else stopAll(String(msg.message || "Voice mode needs a dictation model and a voice: choose them in Settings → Voice."));
          return true;
        }
        if (msg.type === "micLevels") {
          if (phase === "listening") { bar.push(msg.levels); if (detector.push(msg.levels || [], performance.now())) endTurn(); }
          return true;
        }
        if (msg.type !== "mic") return false;
        if (msg.state === "recording") { set("listening"); detector.reset(performance.now()); return true; }
        if (msg.state === "writing") return true;
        if (msg.state === "idle") {
          recording = false;
          if (msg.error) { stopAll(""); o.notify(String(msg.error), msg.kind === "info" ? "info" : "error"); return true; }
          if (typeof msg.text === "string") {
            if (!msg.text.trim()) { listen(); return true; }   // nothing heard: listen again
            // The replies there are now: the one to read is the first that isn't one of these.
            known = new Set((o.messages() || []).filter((m) => m && m.role === "assistant").map((m) => m.id));
            set("thinking");
            o.deliver(msg.text);
            return true;
          }
          if (phase === "starting" || phase === "listening") set("off");   // cancelled elsewhere
          return true;
        }
        return true;
      },
      /** The box's messages changed, or a reply finished: `busy` while a reply is still coming. */
      check(busy) {
        if (phase !== "thinking" || busy) return;
        const replies = (o.messages() || []).filter((m) => m && m.role === "assistant");
        const reply = replies.find((m) => !known.has(m.id) && String(m.text || "").trim());
        if (!reply) return;
        known.add(reply.id);
        speakingId = reply.id;
        set("speaking");
        reader.toggle(reply.id, reply.text);
      },
    };
  }

  const api = { create, turnDetector };
  root.DgcVoiceMode = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
