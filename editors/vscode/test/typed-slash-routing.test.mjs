// Typed slash commands must reach the same handlers the command palette uses.
//
// /branch [NAME] and its /fork alias are advertised by dgc/commands.py and implemented by
// branchChat, but nothing routed the typed form there — it fell through to the backend, which
// rejects it as an unknown command (built-in names are reserved, so a custom /branch.md cannot
// fill the gap either). /artifact stop <id> had the opposite problem: the routing table keys on
// the command name alone, so every form of it opened the artifacts list and dropped the argument.
//
// These tests type the command into the real panel and watch where it lands. An earlier version
// read the routing table out of panel.ts as text, which cannot tell a route that exists from a
// route that runs — nor notice an earlier branch in slashText swallowing the command first.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

/** Type `text` into the composer as a slash command and report where it went. */
async function type(text, { capabilities = {} } = {}) {
  const { provider, backend, posted } = makeProvider({ capabilities });
  const palette = [];
  const branched = [];
  provider.slash = (name) => { palette.push(name); };
  provider.branchChat = async (name) => { branched.push(name); };
  await provider.slashText(text);
  return { palette, branched, sent: backend.sent, posted, provider };
}

test("/branch reaches branchChat with the name that was typed", async () => {
  const { branched, sent } = await type("/branch auth-rewrite");
  assert.deepEqual(branched, ["auth-rewrite"],
    "a typed /branch must be routed, not sent to the backend as an unknown command");
  assert.equal(sent.length, 0, "and it must not also reach the backend");
});

test("/fork is the same command under its documented alias", async () => {
  const { branched } = await type("/fork auth-rewrite");
  assert.deepEqual(branched, ["auth-rewrite"]);
});

test("/branch with no name still branches", async () => {
  const { branched } = await type("/branch");
  assert.deepEqual(branched, [""], "branchChat names the chat itself when given nothing");
});

test("/artifact with an argument goes to the backend, not the list view", async () => {
  const { palette, sent } = await type("/artifact stop ar_12");
  assert.deepEqual(palette, [], "/artifact stop <id> must not be collapsed into the artifacts list");
  assert.deepEqual(sent, [{ type: "slash_command", text: "/artifact stop ar_12" }],
    "the argument has to survive the trip");
});

test("bare /artifact still opens the list", async () => {
  const { palette, sent } = await type("/artifact");
  assert.deepEqual(palette, ["artifacts"]);
  assert.equal(sent.length, 0);
});

test("the routing table still covers the commands it always did", async () => {
  const expected = {
    "/view-plan": "viewPlan", "/monitors": "monitors", "/status": "status",
    "/compact": "compact", "/resume": "resume", "/rewind": "rewind",
  };
  for (const [typed, handler] of Object.entries(expected)) {
    const { palette, sent } = await type(typed);
    assert.deepEqual(palette, [handler], `${typed} lost its route`);
    assert.equal(sent.length, 0, `${typed} fell through to the backend`);
  }
});

test("an unknown command is still the backend's to answer", async () => {
  // Custom commands live in the project, so the editor cannot know their names: anything it does
  // not route has to be passed on rather than rejected locally.
  const { palette, sent } = await type("/deploy-staging now");
  assert.deepEqual(palette, []);
  assert.deepEqual(sent, [{ type: "slash_command", text: "/deploy-staging now" }]);
});
