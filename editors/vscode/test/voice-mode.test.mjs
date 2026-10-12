// Voice mode (media/voicemode.js): when a turn ends -- the part a spoken conversation stands or falls on. Its flow in
// ChatDGC and Pips runs in real Chromium in chatdgc-screen.test.mjs and voice-bar.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { turnDetector } = createRequire(import.meta.url)("../media/voicemode.js");

/** Feeds readings the way they arrive: two per 100 ms; returns when (ms) the turn ended, or null. */
function run(detector, readings) {
  detector.reset(0);
  for (let i = 0; i < readings.length; i += 2) {
    const now = (i / 2 + 1) * 100;
    if (detector.push(readings.slice(i, i + 2), now)) return now;
  }
  return null;
}
const hold = (v, ms) => Array.from({ length: Math.round(ms / 50) }, () => v);

test("a turn ends a moment after you stop talking, not while you pause for breath", () => {
  const room = 0.002, speech = 0.08;
  const ended = run(turnDetector(), [...hold(room, 600), ...hold(speech, 1500), ...hold(room, 2000)]);
  assert.ok(ended >= 600 + 1500 + 1200 && ended <= 600 + 1500 + 1400, `ended at ${ended} ms`);
  // A half-second pause between sentences doesn't end it.
  const paused = run(turnDetector(), [...hold(room, 600), ...hold(speech, 800), ...hold(room, 500), ...hold(speech, 800), ...hold(room, 2000)]);
  assert.ok(paused >= 600 + 800 + 500 + 800 + 1200, `a pause is not the end: ${paused} ms`);
});

test("nothing said, nothing ends: silence before you speak waits for you", () => {
  assert.equal(run(turnDetector(), hold(0.002, 10000)), null);
  assert.equal(run(turnDetector(), hold(0, 10000)), null, "nor does a microphone that reads nothing");
});

test("a noisy room sets its own bar: its hum is not speech, and speech over it still ends", () => {
  const hum = 0.02;                                    // above the quiet-room threshold of 0.015
  assert.equal(run(turnDetector(), hold(hum, 5000)), null, "the hum alone never counts as talking");
  const ended = run(turnDetector(), [...hold(hum, 600), ...hold(0.12, 1500), ...hold(hum, 2500)]);
  assert.ok(ended !== null && ended <= 600 + 1500 + 1500, `speech over the hum ends: ${ended} ms`);
});

test("a turn that never pauses ends at a minute", () => {
  const ended = run(turnDetector({ maxMs: 60000 }), [...hold(0.002, 400), ...hold(0.09, 70000)]);
  assert.equal(ended, 60000);
});

test("someone who starts talking at once is still heard, and their turn still ends", () => {
  const ended = run(turnDetector(), [...hold(0.1, 2000), ...hold(0.002, 2000)]);
  assert.ok(ended !== null && ended <= 2000 + 1400, `ended at ${ended} ms`);
});
