// A field the CLI does not declare makes it reject the WHOLE command.
//
// The editor protocol validates each command against a schema, so a field added in a later CLI
// cannot be sent to an earlier one. Extension 0.27.0 sent `open_asks: true` on every
// set_workspace_roots; the field arrived in CLI 0.42.0, so against 0.41.9 the setup command was
// refused with "invalid command: set_workspace_roots has undeclared field 'open_asks'". That is a
// total failure, not a degraded one: set_workspace_roots is part of the handshake, so no chat
// starts, Cursor reports "timed out waiting for sessions", and Resume says there are no past
// sessions in the project. `dgc.command` can point at any CLI build, so this is not hypothetical.
//
// These tests drive the real panel and read the commands it actually produced, then check them
// against the real schema of the oldest CLI the extension claims to support. An earlier version
// asserted the SHAPE OF THE SOURCE -- that `open_asks` appeared inside a conditional spread --
// which passes just as happily if the spread is there but the capability behind it is never
// false, and says nothing at all about a field gated some other way.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import {
  cleanup, declaredFields, extensionRoot, makeProvider, repoRoot, schemaAtTag,
} from "./support/panel-bundle.mjs";

after(cleanup);

const manifest = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
const MIN_CLI = String(manifest.dgcCliVersion || "");

/** Everything the panel sends during the handshake, for a CLI that declared `capabilities`. */
function handshakeCommands(capabilities) {
  const { provider, backend } = makeProvider({ capabilities });
  provider.turnActive = false;
  provider.workspaceRootsInFlight = undefined;
  provider.workspaceRootsDirty = true;
  provider.syncWorkspaceRoots(backend, true);
  return backend.sent;
}

/** Everything the panel sends for one prompt, for a CLI that declared `capabilities`. */
async function promptCommands(capabilities, message) {
  const { provider, backend } = makeProvider({ capabilities });
  await provider.onMessage({ type: "prompt", requestId: "r1", ...message });
  return backend.sent;
}

const byType = (commands, type) => commands.filter((c) => c && c.type === type);

test("open_asks is withheld from a CLI that did not declare it", () => {
  const without = byType(handshakeCommands({}), "set_workspace_roots");
  assert.equal(without.length, 1, "the handshake command is still sent");
  assert.ok(!("open_asks" in without[0]),
    `an older CLI rejects the whole handshake over this field: ${JSON.stringify(without[0])}`);

  const with_ = byType(handshakeCommands({ open_asks: true }), "set_workspace_roots");
  assert.equal(with_[0].open_asks, true, "and a CLI that declared it still gets it");
});

test("answers is only sent to a CLI that declared open_asks", async () => {
  const answers = [{ ask_id: "q1", question: "Which database?" }];
  const without = byType(await promptCommands({}, { text: "hello", answers }), "prompt");
  assert.equal(without.length, 1);
  assert.ok(!("answers" in without[0]), "the reply still sends, without the tag");

  const with_ = byType(await promptCommands({ open_asks: true }, { text: "hello", answers }), "prompt");
  assert.deepEqual(with_[0].answers, answers);
});

test("spooled_images is only produced for a CLI that declared image_spool", async () => {
  const images = [{ name: "shot.png", media_type: "image/png", data: "iVBORw0KGgo=" }];
  const without = byType(await promptCommands({}, { text: "look", images }), "prompt");
  assert.ok(!("spooled_images" in without[0]),
    "without the capability the images go inline, as they always did");
  assert.ok(without[0].images, "and they are not silently dropped");
});

test("live_steering's delivery field is withheld from a CLI that did not declare it", async () => {
  const without = byType(await promptCommands({}, { text: "hi", delivery: "queue" }), "prompt");
  assert.ok(!("delivery" in without[0]));
  const with_ = byType(await promptCommands({ live_steering: true }, { text: "hi", delivery: "queue" }), "prompt");
  assert.equal(with_[0].delivery, "queue");
});

test("every command the panel sends to a capability-less CLI validates against that CLI's schema", async () => {
  assert.match(MIN_CLI, /^\d+\.\d+\.\d+$/, "package.json must pin a minimum CLI version");
  const schema = schemaAtTag(`v${MIN_CLI}`);
  if (!schema) { console.log(`# no tag v${MIN_CLI} in this clone — skipping`); return; }

  // A CLI that declares nothing is the worst case the extension must survive: every capability
  // gate closed. Whatever it still sends has to be in the oldest supported CLI's vocabulary.
  const commands = [
    ...handshakeCommands({}),
    ...await promptCommands({}, { text: "hello", answers: [{ ask_id: "q1", question: "Which?" }],
                                  images: [{ name: "a.png", media_type: "image/png", data: "iVBORw0KGgo=" }],
                                  delivery: "queue" }),
  ];
  assert.ok(commands.length >= 2, "the panel produced commands to check");
  console.log(`# checked ${commands.length} commands against CLI ${MIN_CLI}: `
    + commands.map((c) => c.type).join(", "));

  const declared = declaredFields(schema);
  const problems = [];
  for (const command of commands) {
    const known = declared.get(command.type);
    if (!known) { problems.push(`CLI ${MIN_CLI} has no command "${command.type}" at all`); continue; }
    for (const field of Object.keys(command)) {
      if (command[field] === undefined) { continue; }        // never serialised
      if (!known.has(field)) {
        problems.push(`${command.type} carries "${field}", which CLI ${MIN_CLI} does not declare`);
      }
    }
  }
  assert.deepEqual(problems, [],
    `a CLI the extension claims to support would reject these outright:\n  ${problems.join("\n  ")}`);
});

test("those commands also pass the CURRENT schema, so the check is not vacuous", async () => {
  // If the captured commands were malformed in some other way, the test above could pass by
  // accident. Validating the same objects against this checkout's schema proves they are real
  // commands a backend would accept, not empty shells.
  const schema = JSON.parse(readFileSync(join(repoRoot, "schemas/editor-protocol-v14.schema.json"), "utf8"));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
  const commands = [
    ...handshakeCommands({ open_asks: true }),
    ...await promptCommands({ open_asks: true, live_steering: true }, { text: "hello" }),
  ];
  for (const command of commands) {
    const stripped = JSON.parse(JSON.stringify(command));     // drop undefined-valued keys
    assert.ok(validate(stripped),
      `${command.type} is not a valid command: ${JSON.stringify(validate.errors)}`);
  }
});

test("the handshake still starts a chat on the CLI that 0.27.0 broke", () => {
  // The specific outage, pinned to the specific schema. 0.41.9 predates `open_asks`, so a panel
  // that has not been told otherwise must produce a set_workspace_roots that CLI accepts --
  // otherwise no chat starts at all and the user sees "timed out waiting for sessions".
  //
  // If the extension one day genuinely requires a CLI newer than this, that is a deliberate
  // decision to drop 0.41.9, and this test is the place to record it.
  const schema = schemaAtTag("v0.41.9");
  if (!schema) { console.log("# no tag v0.41.9 in this clone — skipping"); return; }
  const declared = declaredFields(schema).get("set_workspace_roots");
  assert.ok(declared, "0.41.9 had the handshake command");
  const command = handshakeCommands({}).find((c) => c.type === "set_workspace_roots");
  const undeclared = Object.keys(command).filter((k) => command[k] !== undefined && !declared.has(k));
  assert.deepEqual(undeclared, [],
    `CLI 0.41.9 answers this with "invalid command: set_workspace_roots has undeclared field `
    + `'${undeclared[0]}'" and no chat starts: ${JSON.stringify(command)}`);
});
