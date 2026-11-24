// User test round 2, W16: Work's @ menu still led with the old "Reference a Pip… · This session's workspace · no work
// starts" row, over the rows that hand a Pip a job; and a Pip with no folder was "For anything" there while its row in
// the Pips list says "No folder" (one kind of Pip, one set of words). Read from the pages' own sources, as
// pip-job-card.test.mjs reads them; a Pip's chat's menu is held on the page in pip-job-chat-browser.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const work = read("media/main.js"), chat = read("media/chatdgc.js"), pips = read("src/pipsClient.js");

test("W16: where Work can hand a Pip a job (Pips API 111), the old reference-only row is not in its @ menu", () => {
  const row = work.split("\n").find((line) => line.includes('label:"Reference a Pip…"') || line.includes('label: "Reference a Pip…"'));
  assert.ok(row, "premise: the row is still there for a DGC that can only reference a Pip");
  assert.match(row, /pipJobBridge\.api\s*<\s*111/, "only with a DGC older than the job rows");
  const jobs = work.split("\n").find((line) => line.includes("pipTarget: p"));
  assert.ok(jobs && /pipJobBridge\.api >= 111/.test(work.slice(work.indexOf(jobs) - 300, work.indexOf(jobs) + jobs.length)), "premise: the job rows are API 111's");
});

test("W16: a Pip with no folder says “No folder” in every @ menu, as its row in the Pips list does", () => {
  for (const [name, source] of [["Work", work], ["ChatDGC", chat], ["a Pip's chat", pips]]) {
    assert.doesNotMatch(source, /For anything/, `${name}: never “For anything”`);
  }
  assert.match(work, /detail: p\.folder \? `Works in \$\{p\.folder\}` : "No folder"/);
  assert.match(chat, /detail: typeof p\.folder === "string" && p\.folder \? `Works in \$\{p\.folder\}` : "No folder"/);
  assert.match(pips, /detail:personalPip\(p\)\?'No folder':`Works in \$\{spaceName\(p\.workspace_id\)\|\|'a folder'\}`/);
});
