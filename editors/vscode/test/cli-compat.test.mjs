// The extension must not send a command the CLI it claims to support cannot parse.
//
// This is the test that was missing when 0.27.0 shipped. Every other suite — and the live video
// harness — runs the extension against a CLI built from the SAME commit, so the extension always
// talks to a CLI that declares whatever it sends. Real users are never in that configuration: the
// Marketplace updates the extension on its own while the CLI is updated separately.
//
// 0.27.0 declared `dgcCliVersion: 0.41.6` and sent `open_asks` on set_workspace_roots. That field
// exists only from CLI 0.42.0, and the protocol rejects a command carrying an undeclared field, so
// against 0.41.x the handshake command was refused outright and no chat could start.
//
// The invariant: every field the extension sends UNCONDITIONALLY must exist in the schema of the
// oldest CLI it claims to support. Conditional fields (spread behind a `capabilities` check) are
// exempt, because a CLI that never declared the capability never receives them.
//
// Limitation, stated so a failure is read correctly: this sees a conditional SPREAD, not an `if`
// around a whole send(). A field gated by an if-statement is reported too. That is deliberate --
// for a check whose failure mode was every chat refusing to start, a false alarm a human dismisses
// is cheaper than a silent pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const MIN_CLI = String(manifest.dgcCliVersion || "");

function schemaAt(tag) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${tag}:schemas/editor-protocol-v14.schema.json`],
      { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return null;                    // tag not present in this clone
  }
}

/** command name → the set of field names that CLI's schema declares. */
function declaredFields(schema) {
  const out = new Map();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const props = node.properties;
    if (props && props.type && typeof props.type === "object" && props.type.const) {
      const set = out.get(props.type.const) || new Set();
      for (const key of Object.keys(props)) set.add(key);
      out.set(props.type.const, set);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(schema);
  return out;
}

test("every field the extension always sends exists in the oldest CLI it supports", () => {
  assert.match(MIN_CLI, /^\d+\.\d+\.\d+$/, "package.json must pin a minimum CLI version");
  const oldSchema = schemaAt(`v${MIN_CLI}`);
  if (!oldSchema) { console.log(`# no tag v${MIN_CLI} in this clone — skipping`); return; }

  // What THIS checkout's CLI understands, minus what the pinned one does: every name in the gap
  // is a field or command an older CLI rejects outright, taking the whole command with it.
  const current = JSON.parse(readFileSync(join(repo, "schemas/editor-protocol-v14.schema.json"), "utf8"));
  const before = declaredFields(oldSchema);
  const now = declaredFields(current);
  const gap = new Set();
  for (const [command, fields] of now) {
    const known = before.get(command);
    for (const field of fields) {
      if (field === "type") continue;
      if (!known || !known.has(field)) gap.add(field);
    }
  }
  if (!gap.size) { console.log(`# CLI ${MIN_CLI} understands everything this checkout sends`); return; }

  // Each of those may appear in the extension ONLY inside a conditional spread — the shape that
  // withholds it from a CLI that never declared the capability.
  const sources = ["src/panel.ts", "src/backend.ts"].map((rel) => ({
    rel, text: readFileSync(join(here, "..", rel), "utf8"),
  }));
  const problems = [];
  for (const { rel, text } of sources) {
    // Remove conditional spreads, block comments and line comments; what is left is unconditional.
    const bare = text
      .replace(/\.\.\.\([^]*?\)\s*,?/g, "")
      .replace(/\/\*[^]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const field of gap) {
      const sent = new RegExp(`(?:^|[{,(]\\s*)${field}\\s*:`, "m");
      if (sent.test(bare)) {
        problems.push(`${rel} sends "${field}" unconditionally; CLI ${MIN_CLI} does not declare it`);
      }
    }
  }
  assert.deepEqual(problems, [],
    `a CLI the extension claims to support would reject these commands entirely:\n  `
    + problems.join("\n  "));
});

test("the pinned minimum is a CLI that was actually released", () => {
  const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: repo, encoding: "utf8" })
    .split("\n").map((t) => t.trim()).filter(Boolean);
  assert.ok(tags.includes(`v${MIN_CLI}`) || tags.length === 0,
    `dgcCliVersion is ${MIN_CLI}, which has no release tag`);
});
