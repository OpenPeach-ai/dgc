// 2d, the reading half of media/shared/inline.js with no page: what counts as a colour, a keyboard shortcut, a time
// with a zone, a commit, an issue and an API path, and what only looks like one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const box = {}; vm.createContext(box);
vm.runInContext(readFileSync(new URL("../media/shared/inline.js", import.meta.url), "utf8"), box);
const I = box.DgcInline;
const found = (text, opts = {}) => [...I.scan(text, { colours: true, keys: true, ...opts })].map((t) => `${t.kind}:${t.text}`);

test("colours: #RGB, #RRGGBB, #RRGGBBAA, rgb(), rgba(), hsl(), hsla(), oklch()", () => {
  assert.deepEqual(found("Use #fff on #1a2B3c, or #1a2b3c80 for the veil."), ["colour:#fff", "colour:#1a2B3c", "colour:#1a2b3c80"]);
  assert.deepEqual(found("rgb(255, 0, 0) and rgba(0,0,0,.5), hsl(210 50% 40%), hsla(210, 50%, 40%, 0.3), oklch(70% 0.1 200)"),
    ["colour:rgb(255, 0, 0)", "colour:rgba(0,0,0,.5)", "colour:hsl(210 50% 40%)", "colour:hsla(210, 50%, 40%, 0.3)", "colour:oklch(70% 0.1 200)"]);
  assert.deepEqual(found("black is #000 and grey #999"), ["colour:#000", "colour:#999"]);
});
test("colours: never for what only looks like one", () => {
  for (const text of ["See issue #123 and PR #456.", "https://example.com/page#fff is a link", "example.com/a#abc", "the id is abc#fff123x", "#12345 and #1234567", "#ffg", "a#b0b", "&#123;", "Fixes #111", "closes #222",
    "word#fff", "rgb(hello)", "rgb()", "hsl(1,2)", "#fffff", "channel #dev and #bad-idea"]) assert.deepEqual(found(text).filter((t) => t.startsWith("colour")), [], text);
});
test("keyboard shortcuts: a modifier and a key, in words or symbols; in inline code a lone key too", () => {
  assert.deepEqual(found("Press Ctrl+Shift+P, then ⌘K or Alt+Enter."), ["keys:Ctrl+Shift+P", "keys:⌘K", "keys:Alt+Enter"]);
  assert.deepEqual(found("Cmd+S saves; Option+Left jumps a word; ⌥⇧F formats; Ctrl+/ comments"), ["keys:Cmd+S", "keys:Option+Left", "keys:⌥⇧F", "keys:Ctrl+/"]);
  assert.deepEqual(found("F5", { code: true }), ["keys:F5"]);
  assert.deepEqual(found("Esc", { code: true }), ["keys:Esc"]);
  assert.deepEqual(found("Ctrl+Shift+P", { code: true }), ["keys:Ctrl+Shift+P"]);
});
test("keyboard shortcuts: ordinary words are never keys", () => {
  for (const text of ["Enter the value and press on.", "C++ and salt+pepper", "Shift+work is hard", "Alt+ernative", "press F5 to run", "a+b", "Ctrl + C", "Control", "the Tab key", "ctrl+alt", "x⌘", "Cmd+Save"])
    assert.deepEqual(found(text).filter((t) => t.startsWith("keys")), [], text);
  for (const text of ["Enter the value", "git commit", "Home", "F55", "f5 --run", "Delete"]) assert.deepEqual(found(text, { code: true }).filter((t) => t.startsWith("keys")), [], `code: ${text}`);
});
test("keys are named the way this computer names them", () => {
  assert.deepEqual([...I.keysOf("Ctrl+Shift+P", { mac: false })], ["Ctrl", "Shift", "P"]);
  assert.deepEqual([...I.keysOf("⌘K", { mac: false })], ["Ctrl", "K"]);
  assert.deepEqual([...I.keysOf("Option+Left", { mac: false })], ["Alt", "←"]);
  assert.deepEqual([...I.keysOf("Cmd+Shift+P", { mac: true })], ["⌘", "⇧", "P"]);
  assert.deepEqual([...I.keysOf("Alt+Enter", { mac: true })], ["⌥", "Enter"]);
  assert.deepEqual([...I.keysOf("Ctrl+C", { mac: true })], ["⌃", "C"]);
});
test("times: only with a zone", () => {
  const t = (text) => found(text, { times: true }).filter((x) => x.startsWith("time"));
  assert.deepEqual(t("Standup is 09:00 UTC, the demo 3pm PST and the call 14:30 +05:30."), ["time:09:00 UTC", "time:3pm PST", "time:14:30 +05:30"]);
  assert.deepEqual(t("at 9:15 am EST or 18:00 GMT+2 or 07:45 IST"), ["time:9:15 am EST", "time:18:00 GMT+2", "time:07:45 IST"]);
  for (const text of ["at 09:00 sharp", "3pm works", "ratio 14:30", "25:00 UTC", "09:61 UTC", "version 3.10 EST", "12:30 PM", "10:30 ESTIMATE", "at 5 PST"]) assert.deepEqual(t(text), [], text);
});
test("times: the moment in this computer's time, and how far away it is", () => {
  const now = Date.UTC(2026, 10, 16, 7, 0, 0);                              // 16 Nov 2026 07:00 UTC
  const at = (text) => I.scan(text, { times: true, now })[0].at;
  assert.equal(at("09:00 UTC"), Date.UTC(2026, 10, 16, 9, 0));
  assert.equal(at("3pm PST"), Date.UTC(2026, 10, 15, 23, 0), "3pm on the Pacific coast's day, which is still the 15th");
  assert.equal(at("14:30 +05:30"), Date.UTC(2026, 10, 16, 9, 0));
  assert.equal(at("12am UTC"), Date.UTC(2026, 10, 16, 0, 0)); assert.equal(at("12pm UTC"), Date.UTC(2026, 10, 16, 12, 0));
  assert.equal(I.away(now + 2 * 3600e3, now), "in 2 hours"); assert.equal(I.away(now - 8 * 3600e3, now), "8 hours ago");
  assert.equal(I.away(now + 25 * 60e3, now), "in 25 minutes"); assert.equal(I.away(now + 20e3, now), "now"); assert.equal(I.away(now + 3600e3, now), "in 1 hour");
});
test("commits and issues: only where a project's Git says so", () => {
  const r = (text, opts) => found(text, { colours: true, commits: true, issues: true, ...opts }).filter((x) => /^(commit|issue)/.test(x));
  assert.deepEqual(r("Fixed in a1b2c3d and 5a4de9b5c0ffee1234567890abcdef1234567890; see #123 and acme/shop#45."), ["commit:a1b2c3d", "commit:5a4de9b5c0ffee1234567890abcdef1234567890", "issue:#123", "issue:acme/shop#45"]);
  for (const text of ["1234567 rows", "defaced and decade", "#a1b2c3", "a1b2c3", "0x1a2b3c4d", "id-a1b2c3d4", "a1b2c3d4.png", "A1B2C3D4", "https://x.test/a1b2c3d4", "v1a2b3c4d"]) assert.deepEqual(r(text).filter((x) => x.startsWith("commit")), [], text);
  for (const text of ["#0", "issue#12", "a/b/c#3", "#12345678", "&#123;", "x.test/a#12"]) assert.deepEqual(r(text).filter((x) => x.startsWith("issue")), [], text);
  assert.deepEqual(r("a1b2c3d and #123", { commits: false, issues: false }), [], "no project: plain text");
  assert.deepEqual(found("#123 #fff", { issues: true }), ["issue:#123", "colour:#fff"]);
});
test("an API path in inline code", () => {
  for (const text of ["/v1/users/{id}", "GET /api/orders", "POST /v2/charges", "/api/orders/:id", "DELETE /users/{id}/keys"]) assert.deepEqual(found(text, { code: true }).filter((x) => x.startsWith("api")), [`api:${text}`]);
  for (const text of ["/usr/bin/env", "src/upload.py", "GET it", "/home/me", "npm test", "/"]) assert.deepEqual(found(text, { code: true }).filter((x) => x.startsWith("api")), [], text);
  assert.deepEqual(found("the path /v1/users/{id} in a sentence").filter((x) => x.startsWith("api")), [], "only as inline code");
});
test("a colour's three names", () => {
  assert.deepEqual({ ...I.names({ r: 255, g: 0, b: 0, a: 1 }) }, { hex: "#ff0000", rgb: "rgb(255, 0, 0)", hsl: "hsl(0, 100%, 50%)" });
  assert.deepEqual({ ...I.names({ r: 26, g: 43, b: 60, a: 0.5 }) }, { hex: "#1a2b3c80", rgb: "rgba(26, 43, 60, 0.5)", hsl: "hsla(210, 40%, 17%, 0.5)" });
});
