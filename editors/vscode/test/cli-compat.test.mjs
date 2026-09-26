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
// Inspect TypeScript command objects (not incoming event records). New plugin commands use
// one capability-gated sender whose behavior against release backends is tested separately.
// Other if-statement guards still require human review; conditional fields use spreads.
import ts from "typescript";
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

// Methods that send a command only when the CLI declared the capability, and the flag each one
// must still check. A command sent from inside one of these is exempt from the oldest-CLI rule --
// and the test below asserts the guard is really there, so the exemption cannot be claimed falsely.
const GATED_SENDERS = [{ method: "editorState", guard: "editorStateSupported" }].map(g => g.method);
const GATED_SENDER_GUARDS = { editorState: "editorStateSupported" };

/** Is this node inside a method with the given name? */
function insideMethod(node, name) {
  for (let up = node.parent; up; up = up.parent) {
    if ((ts.isMethodDeclaration(up) || ts.isFunctionDeclaration(up))
        && up.name?.getText?.() === name) { return true; }
  }
  return false;
}

test("a capability-gated sender still refuses to send when the CLI did not declare it", () => {
  // The exemption above is only honest while this holds. A sender that lost its guard would send a
  // command every 20 seconds to a CLI that answers command_rejected every time.
  const text = readFileSync(join(here, "..", "src/backend.ts"), "utf8");
  const tree = ts.createSourceFile("src/backend.ts", text, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name?.getText?.() in GATED_SENDER_GUARDS) {
      const name = node.name.getText();
      found.push(name);
      assert.match(node.getText(tree), new RegExp(`!this\\.${GATED_SENDER_GUARDS[name]}\\b`),
        `${name}() must return early unless the CLI declared ${GATED_SENDER_GUARDS[name]}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.deepEqual(found.sort(), Object.keys(GATED_SENDER_GUARDS).sort(),
    "every named gated sender must exist; a renamed one would silently lose its exemption");
});

test("every field the extension always sends exists in the oldest CLI it supports", () => {
  assert.match(MIN_CLI, /^\d+\.\d+\.\d+$/, "package.json must pin a minimum CLI version");
  const oldSchema = schemaAt(`v${MIN_CLI}`);
  if (!oldSchema) { console.log(`# no tag v${MIN_CLI} in this clone — skipping`); return; }

  // Compare commands individually. A newly added event's `items` or a new command's
  // `request_id` must not make the same fields on every old command look incompatible.
  const current = JSON.parse(readFileSync(join(repo, "schemas/editor-protocol-v14.schema.json"), "utf8"));
  const before = declaredFields(oldSchema.$defs.command);
  const now = declaredFields(current.$defs.command);
  const problems = [];
  for (const rel of ["src/panel.ts", "src/backend.ts"]) {
    const text = readFileSync(join(here, "..", rel), "utf8");
    const tree = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        const type = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === "type");
        if (type && ts.isStringLiteral(type.initializer)) {
          const command = type.initializer.text, known = before.get(command);
          // Dedicated senders are capability-gated: they refuse to send unless the CLI declared
          // support in `ready.capabilities`. Naming them here is only safe because the assertion
          // below proves each one still carries its guard -- delete the guard and this test fails.
          const parent = node.parent;
          const gated = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
            && parent.expression.name.text === "sendPluginCommand";
          const gatedSelf = GATED_SENDERS.some((sender) => insideMethod(node, sender));
          const localMessage = ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
            && ["post", "postMessage", "onMessage"].includes(parent.expression.name.text);
          if (now.has(command) && !gated && !gatedSelf && !localMessage) {
            if (!known) problems.push(`${rel} sends unsupported command "${command}" directly`);
            else for (const prop of node.properties) {
              // Capability-dependent spreads do not unconditionally send new fields.
              if (ts.isSpreadAssignment(prop)) continue;
              const field = prop.name?.getText(tree).replace(/^['"]|['"]$/g, "");
              if (field && !known.has(field)) problems.push(`${rel} sends "${command}.${field}" unconditionally; CLI ${MIN_CLI} does not declare it`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
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
