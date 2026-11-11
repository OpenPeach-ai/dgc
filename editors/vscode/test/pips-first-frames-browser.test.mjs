// No flash before Pips loads (0.51 check): from the first frame the page paints to the frame its list is there, every
// frame shows DGC's loading mark or the list. Never a blank page, plain words ("Connecting to local DGC…", which the
// tab's page held until its script ran), nor a view that isn't the one coming (a project's empty home, with "Can't tell
// if Pips are running" and New Pip, drawn while its Pips were still being read).
// Real Chromium, the real client and its CSS, every frame recorded in the page (support/pip-chat-scene.mjs FRAMES), with a
// backend that answers at once and one that takes a while.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { client, openChat } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
await client();   // built before the first test is registered (a pending top-level await would end the file early)

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
// What the tab's page holds before its script runs: the first thing painted (src/pipsView.ts pipsDocument).
const VIEW = read("pipsView.ts");
const BOOT = VIEW.match(/export function pipsDocument[\s\S]*?<main id="app">([\s\S]*?)<\/main>/)[1].replace("${PIPS_BOOT_MARK}", VIEW.match(/const PIPS_BOOT_MARK = '([^']*)';/)?.[1] ?? "");

test("the tab's page starts on the loading mark the client draws, not on words", () => {
  const mark = read("pipsClient.js").match(/function loadingMark\(\)\{return `([\s\S]*?)`;\}/)[1];
  const paths = (html) => [...html.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.match(BOOT, /^<div class="pips-loading" role="status" aria-label="Loading Pips">/);
  assert.equal(paths(BOOT).length, 3);
  assert.deepEqual(paths(BOOT), paths(mark), "the same mark, so the client's first draw changes nothing in sight");
  assert.doesNotMatch(BOOT.replace(/<[^>]*>/g, ""), /\S/, "no words: nothing to flash before the mark");
});

const WAYS = [["a backend that answers at once", {}], ["a backend that takes a while", { connectAfter: 250, answerAfter: 50 }]];
for (const where of ["side", "tab"]) for (const kind of ["personal", "project"]) for (const [said, timing] of WAYS) {
  test(`${where}, a ${kind} home, ${said}: every frame before the list is the loading mark`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width: 300, theme: "dark", where, home: true, frames: true, motion: "no-preference", project: kind === "project", boot: BOOT, ...timing });
    t.after(x.close);
    await x.p.waitForTimeout(250);
    const frames = await x.p.evaluate(() => window.__frames);
    assert.deepEqual(x.errors, []);
    // The side bar's page mounts Pips from its own script: before that there is no Pips view at all (Work's page shows).
    const drawn = frames.filter(([what]) => what !== "unmounted");
    const told = `frames: ${frames.map(([what, n]) => `${what} ×${n}`).join(", ")}`;
    assert.equal(drawn.at(-1)[0], "list", told);
    assert.deepEqual(drawn.map(([what]) => what).filter((what) => what !== "loading" && what !== "list"), [], `only the mark, then the list. ${told}`);
    assert.equal(drawn.findIndex(([what]) => what === "list"), drawn.length - 1, `once the list is there it stays. ${told}`);
    if (timing.answerAfter) assert.ok(drawn[0][0] === "loading" && drawn[0][1] >= 5, `a slow start shows the mark for all of it. ${told}`);
  });
}
