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
// Every post-baseline field must therefore be behind a `capabilities` check from `ready`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { panelSrc } from "./support/webview-dom.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backendSrc = readFileSync(join(here, "../src/backend.ts"), "utf8");

test("spooled_images is only produced for a CLI that declared image_spool", () => {
  // Indirect: the prompt spreads `spooled_images` only when spoolImages() returned something, and
  // spoolImages() refuses unless the capability and its directory are both present.
  const index = panelSrc.indexOf("private async spoolImages(");
  assert.ok(index > 0, "spoolImages still exists");
  const body = panelSrc.slice(index, panelSrc.indexOf("\n  }\n", index));
  assert.match(body, /caps\?\.image_spool !== true/,
    "spoolImages must return undefined unless the CLI declared image_spool");
  assert.match(panelSrc, /\.\.\.\(spooled \? \{ spooled_images: spooled \} : \{\}\)/,
    "and the prompt must only carry the field when it did");
});

test("answers is only sent to a CLI that declared open_asks", () => {
  const index = panelSrc.indexOf("answers.length");
  assert.ok(index > 0, "the answers field is still sent");
  const line = panelSrc.slice(index, panelSrc.indexOf("\n", index + 200));
  assert.match(panelSrc.slice(index, index + 200), /capabilities\?\.open_asks/,
    `answers must be gated on the capability: ${line.slice(0, 120)}`);
});

test("the liveness ping is only sent to a CLI that declared it", () => {
  // `ping` is a whole command that did not exist before 0.42.0.
  const index = backendSrc.indexOf("startLivenessPings(this.proc)");
  assert.ok(index > 0, "the liveness timer still exists");
  const before = backendSrc.slice(Math.max(0, index - 400), index);
  assert.match(before, /capabilities\?\.editor_liveness/,
    "an older CLI would answer every ping with command_rejected");
});

test("set_workspace_roots is built with a capability check in scope", () => {
  // This is the handshake command: getting it wrong stops every chat from starting, which is why
  // it gets its own assertion rather than relying on the loop above.
  const index = panelSrc.indexOf('type: "set_workspace_roots"');
  assert.ok(index > 0);
  const command = panelSrc.slice(index, panelSrc.indexOf("});", index) + 3);
  // The field must be spread conditionally. An unconditional `open_asks: true` inside the object
  // is precisely what shipped in 0.27.0 — a capability check somewhere nearby is not the same as
  // applying it, which is how the first version of this test passed against the bug.
  assert.match(command, /\.\.\.\(\s*supportsOpenAsks\s*\?/,
    "open_asks must be spread only when the CLI declared the capability");
  // Remove every conditional spread; anything left mentioning the field is unconditional.
  const unconditional = command.replace(/\.\.\.\([^)]*\)/g, "");
  assert.doesNotMatch(unconditional, /open_asks/,
    `set_workspace_roots carries open_asks unconditionally:\n${command}`);
});
