// A change waiting for you, in words (src/pipChangeCard.js, asked 10 Nov): what the Pip wants as one sentence, what
// exactly as chips, and every value in full for Details. Its card read "Web pages: Search · top India news headlines
// today, Search · world news headlines today, Page · https://www.bbc.com/news/world, Page · …" before: one run-on line
// of its data, which wrapped to twenty lines beside its buttons at 300 px.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const code = (await build({ entryPoints: [src + "pipChangeCard.js"], bundle: true, write: false, platform: "node", format: "cjs", loader: { ".css": "empty" } })).outputFiles[0].text;
const m = { exports: {} }; new Function("module", "exports", "require", code)(m, m.exports, () => ({}));
const { changeCard, scheduleWords, pageWords } = m.exports;

const pip = { name: "Mornings", goal: "Send a short morning news brief.", schedule: null, model_choice: { mode: "default" }, source_policy: { mode: "personal" } };
const proposal = (definition, reason = "So it can pick the morning's top stories.") => ({ id: "p1", expected_version: 2, reason, definition: { name: pip.name, goal: pip.goal, schedule: null, model_choice: pip.model_choice, ...definition } });
const web = { schema_version: 1, reads: [{ kind: "search", query: "top India news headlines today" }, { kind: "page", url: "https://www.bbc.com/news/world" }, { kind: "page", url: "https://www.reuters.com/world/india/" }] };
const labels = (card) => card.chips.map((c) => c.label);
/** No card says its data as a run-on: a sentence has no " · " and no list of three things joined by commas. */
const sentence = (card) => { assert.doesNotMatch(card.title, / · |: .*, .*, /, card.title); assert.ok(card.title.length <= 90, `short enough to read at 300 px: ${card.title}`); };

test("web reads: a sentence, a chip for each read, and each read in full for Details", () => {
  const card = changeCard(proposal({ web_plan: web }), pip);
  assert.equal(card.title, "Mornings wants to read 3 web pages before each run");
  assert.equal(card.sub, "So it can pick the morning's top stories.");
  assert.deepEqual(labels(card), ["Search: top India news headlines today", "bbc.com/news/world", "reuters.com/world/india"]);
  assert.deepEqual(card.rows, [["Search", "top India news headlines today"], ["Page", "https://www.bbc.com/news/world"], ["Page", "https://www.reuters.com/world/india/"], ["Why", "So it can pick the morning's top stories."]]);
  assert.deepEqual(card.kinds, ["web"]);
  assert.equal(card.icon, "web");
  sentence(card);
  assert.equal(changeCard(proposal({ web_plan: { schema_version: 1, reads: [{ kind: "search", query: "rain today" }] } }), pip).title, "Mornings wants to run 1 web search before each run");
  assert.equal(changeCard(proposal({ web_plan: null }), { ...pip, web_plan: web }).title, "Mornings wants to stop reading web pages");
});

test("a schedule: when it would run, in words, with its time zone as the chip", () => {
  const daily = changeCard(proposal({ schedule: { type: "daily", time: "08:00", timezone: "Asia/Kolkata" } }, "You asked for 8:00."), pip);
  assert.equal(daily.title, "Mornings wants to run every day at 08:00");
  assert.deepEqual(labels(daily), ["Asia/Kolkata"]);
  assert.deepEqual(daily.rows[0], ["When", "Daily at 08:00, Asia/Kolkata"]);
  sentence(daily);
  assert.equal(changeCard(proposal({ schedule: { type: "cron", cron: "0 9 * * 1-5", timezone: "Asia/Kolkata" } }), pip).title, "Mornings wants to run on weekdays at 09:00");
  assert.equal(changeCard(proposal({ schedule: { type: "interval", minutes: 60 } }), pip).title, "Mornings wants to run every hour");
  assert.equal(changeCard(proposal({ schedule: { type: "interval", minutes: 45 } }), pip).title, "Mornings wants to run every 45 minutes");
  assert.equal(changeCard(proposal({ schedule: null }), { ...pip, schedule: { type: "interval", minutes: 60 } }).title, "Mornings wants to run only when you ask");
  assert.deepEqual(scheduleWords({ type: "interval", minutes: 120 }), { words: "every 2 hours", zone: "" });
});

test("a name, a model, a computer: each its own sentence", () => {
  assert.equal(changeCard(proposal({ name: "Morning news" }), pip).title, "Mornings wants to be called Morning news");
  const model = changeCard(proposal({ model_choice: { mode: "model", model: "qwen3.8:27b" } }), pip);
  assert.equal(model.title, "Mornings wants to use another model");
  assert.deepEqual(labels(model), ["qwen3.8:27b"]);
  const computer = changeCard(proposal({ computer_plan: { schema_version: 1 } }), pip);
  assert.equal(computer.title, "Mornings wants to get its own computer");
  assert.deepEqual(labels(computer), ["Browser", "Terminal", "Files"]);
  const goal = changeCard(proposal({ goal: "Send a long evening digest instead, with the day's five biggest stories and one chart." }), pip);
  assert.equal(goal.title, "Mornings wants to change what it does");
  assert.match(goal.sub, /^Send a long evening digest/);
  for (const card of [model, computer, goal]) sentence(card);
});

test("several things at once: how many, and one short chip for each", () => {
  const card = changeCard(proposal({ name: "Morning news", schedule: { type: "daily", time: "08:00", timezone: "Asia/Kolkata" }, web_plan: web }), pip);
  assert.equal(card.title, "Mornings wants 3 changes");
  assert.deepEqual(labels(card), ["Name: Morning news", "Runs every day at 08:00", "Reads 3 web pages"]);
  assert.deepEqual(card.kinds, ["name", "schedule", "web"]);
  assert.deepEqual(card.rows.map((r) => r[0]), ["Name", "When", "Search", "Page", "Page", "Why"], "every value, in full, for Details");
  sentence(card);
});

test("a change that differs in nothing this view knows still says why it waits", () => {
  const card = changeCard(proposal({}, "Kept as it was, saved again."), pip);
  assert.equal(card.title, "Mornings has a change for you");
  assert.equal(card.sub, "Kept as it was, saved again.");
  assert.deepEqual(card.chips, []);
});

test("a page is named by its site and path", () => {
  assert.equal(pageWords("https://www.reuters.com/world/india/"), "reuters.com/world/india");
  assert.equal(pageWords("https://news.example/"), "news.example");
  assert.equal(pageWords("not a url"), "not a url");
});
