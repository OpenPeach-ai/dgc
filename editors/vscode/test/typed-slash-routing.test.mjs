// Typed slash commands must reach the same handlers the command palette uses.
//
// /branch [NAME] and its /fork alias are advertised by dgc/commands.py and implemented by
// branchChat, but nothing routed the typed form there — it fell through to the backend, which
// rejects it as an unknown command (built-in names are reserved, so a custom /branch.md cannot
// fill the gap either). /artifact stop <id> had the opposite problem: the routing table keys on
// the command name alone, so every form of it opened the artifacts list and dropped the argument.
import { test } from "node:test";
import assert from "node:assert/strict";
import { panelSrc } from "./support/webview-dom.mjs";

function slashTextBody() {
  const start = panelSrc.indexOf("const direct: Record<string, string> = {");
  assert.ok(start > 0, "the slash routing table still exists");
  // Everything from the start of slashText's tail routing to the end of the method.
  const from = panelSrc.lastIndexOf("private async slashText(", start);
  assert.ok(from > 0 && from < start);
  return panelSrc.slice(from, panelSrc.indexOf("\n  }\n", start));
}

test("/branch and /fork reach branchChat with the name that was typed", () => {
  const body = slashTextBody();
  assert.match(body, /name === "branch" \|\| name === "fork"/,
    "a typed /branch must be routed, not sent to the backend as an unknown command");
  assert.match(body, /this\.branchChat\(rest\)/,
    "and it must carry its NAME argument, which is what `branch [NAME]` documents");
});

test("/artifact with an argument goes to the backend, not the list view", () => {
  const body = slashTextBody();
  assert.match(body, /name === "artifact" && rest/,
    "/artifact stop <id> must not be collapsed into the artifacts list");
  // The bare form still opens the list.
  assert.match(body, /artifact: "artifacts"/);
});

test("the routing table still covers the commands it always did", () => {
  const body = slashTextBody();
  for (const name of ["view-plan", "monitors", "status", "compact", "resume", "rewind"]) {
    assert.ok(body.includes(`"${name}"`) || body.includes(`${name}:`),
      `${name} lost its route`);
  }
});

test("branchChat exists and takes the name", () => {
  assert.match(panelSrc, /async branchChat\(prompt: string\): Promise<void>/);
  assert.match(panelSrc, /type: "fork_session", name/);
});
