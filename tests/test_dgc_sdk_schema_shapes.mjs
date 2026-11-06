import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertSupported, extractJson, validate } from "../sdk/typescript/src/schema.ts";

const EXTRACT_CASES = JSON.parse(readFileSync(new URL("./fixtures/sdk_extract_json.json", import.meta.url), "utf8"));

test("malformed output schemas fail at configuration time", () => {
  const invalid = [
    { type: "object", properties: [] },
    { type: "object", properties: { x: null } },
    { type: "array", items: "string" },
    { type: "object", additionalProperties: null },
    { type: "object", required: [null] },
    { type: "object", enum: "x" },
    { type: "string", minLength: null },
    { type: "string", maxLength: -1 },
    { type: "number", minimum: NaN },
    { type: ["string", "unknown"] },
    { type: null },
    { description: false },
    { default: NaN },
    { enum: [undefined] },
  ];
  for (const schema of invalid) assert.throws(() => assertSupported(schema));
  const cycle = { type: "array" };
  cycle.items = cycle;
  assert.throws(() => assertSupported(cycle));
  let deep = { type: "string" };
  for (let i = 0; i < 65; i++) deep = { items: deep };
  assert.throws(() => assertSupported(deep));
});

test("valid nested subset still validates", () => {
  const schema = { type: "object", properties: { x: { type: "string", minLength: 1 } },
    additionalProperties: { type: "number", minimum: 0 } };
  assertSupported(schema);
  assert.deepEqual(validate({ x: "ok", y: 2 }, schema), []);
  assert.deepEqual(validate({}, { type: "object", required: ["toString"] }), ["$.toString is required"]);
  assert.deepEqual(validate({ toString: 1 }, { type: "object", additionalProperties: false }),
    ["$.toString is not allowed"]);
  assert.deepEqual(validate({ x: 1 }, { enum: [{ x: 1 }] }), []);
});

test("the final text is read the same way as the Python SDK reads it (one fixture)", () => {
  for (const item of EXTRACT_CASES) {
    if (item.error) assert.throws(() => extractJson(item.text), undefined, item.why);
    else assert.deepEqual(extractJson(item.text), item.value, item.why);
  }
});
