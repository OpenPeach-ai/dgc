// How long ago a Work session is from, in a few characters (media/shared/age.js, DgcAge.sessionAge): one helper for the
// Work list, the dialog that moves a session's Project Pips, and a Project Pip's "Reports to" picker (12 Nov night), so
// all three say a session's age in the same words. And the side bar's Work tab's tooltip, which said "this project's
// sessions" though the Project Folder dropdown lists every project's by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { makeDom } from "./support/webview-dom.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => (existsSync(here + path) ? readFileSync(here + path, "utf8") : "");
function helper() {
  const window = {};
  vm.runInNewContext(read("media/shared/age.js"), { window, Date, Math, String, RegExp });
  return window.DgcAge;
}

test("a session's age: now, minutes, hours, days, weeks, months, years; anything else as it is", () => {
  const age = helper();
  assert.equal(typeof age?.sessionAge, "function", "media/shared/age.js gives DgcAge.sessionAge");
  const now = new Date(2026, 10, 12, 23, 30).getTime();
  const table = [["2026-11-12 23:30", "now"], ["2026-11-12 23:25", "5m"], ["2026-11-12 22:31", "59m"], ["2026-11-12 21:29", "2h"], ["2026-11-11 23:30", "1d"], ["2026-11-06 20:00", "6d"],
    ["2026-11-05 23:30", "1w"], ["2026-10-21 08:00", "3w"], ["2026-10-01 08:00", "1mo"], ["2025-12-01 08:00", "11mo"], ["2024-06-01 08:00", "2y"], ["2026-11-12T21:29:00", "2h"],
    ["yesterday", "yesterday"], ["", ""], [null, ""]];
  assert.deepEqual(table.map(([when]) => age.sessionAge(when, now)), table.map(([, words]) => words));
});

test("the Work page loads the helper before its own script, and has no copy of its own", () => {
  const panel = read("src/panel.ts"), main = read("media/main.js");
  assert.match(panel, /joinPath\(this\.context\.extensionUri, "media", "shared", "age\.js"\)/, "the side bar's page is given media/shared/age.js");
  const tag = /<script nonce="\$\{nonce\}" src="\$\{(\w+)\}"><\/script>/g, order = [...panel.matchAll(tag)].map((m) => m[1]);
  const uri = (/const (\w+) = webview\.asWebviewUri\(vscode\.Uri\.joinPath\(this\.context\.extensionUri, "media", "shared", "age\.js"\)\)/.exec(panel) || [])[1];
  assert.ok(uri && order.includes(uri), "in a script tag with the page's nonce");
  assert.ok(order.indexOf(uri) < order.indexOf("js"), "before media/main.js");
  assert.match(main, /DgcAge/, "main.js says a session's age with it");
  assert.equal((main.match(/function sessionAge\(/g) || []).length, 1);
  const body = main.slice(main.indexOf("function sessionAge("), main.indexOf("function sessionAge(") + 400).split("\n  }")[0];
  assert.doesNotMatch(body, /1440|60000/, "the arithmetic lives in the one helper");
  // The Pips bundle carries it too (the picker is drawn there).
  assert.match(read("src/pipOwner.js"), /import '\.\.\/media\/shared\/age\.js'/);
});

test("the Work tab's tooltip: your Work sessions, not this project's", () => {
  const v = makeDom({});
  const tab = v.doc.getElementById("side-tab-work");
  assert.ok(tab, "the side bar's Work tab");
  assert.equal(tab.title, "Work: your Work sessions");
  assert.doesNotMatch(tab.title, /this project/);
});
