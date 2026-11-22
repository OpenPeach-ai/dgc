// A dashboard that stays live (src/dashboardWatch.ts, media/artifact.js): the choices the editor keeps, the files a
// dashboard reads as paths here, and the watch on them: one call once a burst of changes settles, a save that writes a
// new file and renames it over the old one counts, other files in the folder don't, and stopping stops it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const here = new URL(".", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "dgc-dash-watch-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const out = join(scratch, "watch.cjs");
await build({ entryPoints: [here + "../src/dashboardWatch.ts"], bundle: true, format: "cjs", platform: "node", outfile: out, logLevel: "silent" });
const W = createRequire(import.meta.url)(out);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the choices: by hand, every 1/5/15/60 minutes, or when its files change; nothing else", () => {
  for (const ok of ["", "1m", "5m", "15m", "60m", "files"]) assert.equal(W.cleanEvery(ok), ok);
  for (const no of ["2m", "FILES", 5, null, undefined, {}]) assert.equal(W.cleanEvery(no), undefined);
});

test("its files as paths here: absolute as they are, relative under its project, none without one; at most 20", () => {
  assert.deepEqual(W.filePaths(["/data/ads.csv", "db/shop.db", "/data/ads.csv", "", 7, "x\0y"], "/home/me/shop"),
    ["/data/ads.csv", "/home/me/shop/db/shop.db"]);
  assert.deepEqual(W.filePaths(["db/shop.db"], undefined), [], "a relative path with no project is no path");
  assert.equal(W.filePaths(Array.from({ length: 30 }, (_, i) => `/f/${i}.csv`)).length, 20);
  assert.deepEqual(W.filePaths("not a list"), []);
});

test("the watch: one call once changes settle, a rename over it counts, other files don't, and stop stops it", async () => {
  const folder = mkdtempSync(join(scratch, "data-"));
  const file = join(folder, "ads.csv"), other = join(folder, "notes.txt");
  writeFileSync(file, "a,b\n1,2\n"); writeFileSync(other, "x");
  let calls = 0;
  const stop = W.watchFiles([file], () => { calls += 1; }, 200);
  await sleep(150);
  writeFileSync(other, "y"); await sleep(400);
  assert.equal(calls, 0, "another file in the folder is not its file");
  writeFileSync(file, "a,b\n1,3\n"); writeFileSync(file, "a,b\n1,4\n"); await sleep(500);
  assert.equal(calls, 1, "a burst is one refresh");
  writeFileSync(join(folder, ".ads.csv.tmp"), "a,b\n9,9\n"); renameSync(join(folder, ".ads.csv.tmp"), file); await sleep(500);
  assert.equal(calls, 2, "a save that renames a new file over it counts");
  assert.equal(readFileSync(file, "utf8"), "a,b\n9,9\n");
  stop();
  writeFileSync(file, "a,b\n0,0\n"); await sleep(500);
  assert.equal(calls, 2, "stopped");
  assert.doesNotThrow(() => W.watchFiles([join(scratch, "missing", "x.csv")], () => {})(), "a folder that isn't there: nothing to watch");
});

test("the panel keeps the choice per dashboard, says it with the dashboard, and watches only for its files' choice", () => {
  const src = readFileSync(here + "../src/artifacts.ts", "utf8");
  assert.match(src, /refreshEvery: this\.hub\.refreshEvery\(this\.id\)/);
  assert.match(src, /case "refreshEvery": \{/);
  assert.match(src, /if \(every === "files"\) \{[\s\S]{0,300}watchFiles\(filePaths\(message\.files, project\)/);
  assert.match(src, /panel\.onDidDispose\(\(\) => \{ this\.unwatch\?\.\(\);/);
  assert.match(src, /const REFRESH_KEY = "dgc\.dashboardRefresh";/);
});
