/** Harness-side JSON Schema subset used for outputSchema. Unsupported keywords are rejected. */
import { isDeepStrictEqual } from "node:util";

const ALLOWED = new Set([
  "type", "properties", "required", "items", "enum", "additionalProperties",
  "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems",
  "description", "title", "default",
]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const COUNTS = ["minLength", "maxLength", "minItems", "maxItems"];
const LIMITS = ["minimum", "maximum"];

export function assertSupported(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || !Object.keys(schema).length) {
    throw new Error("outputSchema must be a non-empty object");
  }
  walk(schema, new Set<object>(), 0);
}

function walk(node: unknown, ancestors: Set<object>, depth: number): void {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > 64 || ancestors.has(node)) {
    throw new Error("outputSchema must contain finite, acyclic schema objects");
  }
  ancestors.add(node);
  try {
    checkNode(node as Record<string, unknown>, ancestors, depth);
  } finally {
    ancestors.delete(node);
  }
}

function checkNode(record: Record<string, unknown>, ancestors: Set<object>, depth: number): void {
  if ("$ref" in record || "$id" in record || "$schema" in record) {
    throw new Error("outputSchema must not use $ref, $id, or $schema");
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) throw new Error(`outputSchema has unsupported keyword: ${key}`);
  }
  if ("type" in record) {
    const types = Array.isArray(record.type) ? record.type : [record.type];
    if (!types.length || types.some((kind) => typeof kind !== "string" || !TYPES.has(kind))) {
      throw new Error("outputSchema type must name supported JSON types");
    }
  }
  if ("required" in record && (!Array.isArray(record.required) ||
    record.required.some((key) => typeof key !== "string"))) {
    throw new Error("outputSchema required must be an array of strings");
  }
  if ("enum" in record && (!Array.isArray(record.enum) || !record.enum.length)) {
    throw new Error("outputSchema enum must be a non-empty array");
  }
  for (const key of ["enum", "default"]) {
    if (key in record && !isJsonValue(record[key], new Set<object>(), 0)) {
      throw new Error(`outputSchema ${key} must contain JSON values`);
    }
  }
  for (const key of COUNTS) {
    if (key in record && (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0)) {
      throw new Error(`outputSchema ${key} must be a non-negative integer`);
    }
  }
  for (const key of LIMITS) {
    if (key in record && (typeof record[key] !== "number" || !Number.isFinite(record[key]))) {
      throw new Error(`outputSchema ${key} must be a finite number`);
    }
  }
  for (const key of ["title", "description"]) {
    if (key in record && typeof record[key] !== "string") {
      throw new Error(`outputSchema ${key} must be a string`);
    }
  }
  if ("properties" in record) {
    if (!record.properties || typeof record.properties !== "object" || Array.isArray(record.properties)) {
      throw new Error("outputSchema properties must be an object");
    }
    for (const child of Object.values(record.properties)) walk(child, ancestors, depth + 1);
  }
  if ("items" in record) walk(record.items, ancestors, depth + 1);
  if ("additionalProperties" in record && typeof record.additionalProperties !== "boolean") {
    walk(record.additionalProperties, ancestors, depth + 1);
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 64 || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, ancestors, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value).every((entry) => isJsonValue(entry, ancestors, depth + 1));
  } finally {
    ancestors.delete(value);
  }
}

export function extractJson(text: string): unknown {
  let raw = (text || "").trim();
  if (!raw) throw new Error("final text is empty");
  const fenceStart = raw.indexOf("```");
  let fenced = false;
  if (fenceStart >= 0) {
    let bodyStart = fenceStart + 3;
    if (raw.slice(bodyStart, bodyStart + 4).toLowerCase() === "json") bodyStart += 4;
    while (bodyStart < raw.length && /\s/.test(raw[bodyStart])) bodyStart++;
    const fenceEnd = raw.indexOf("```", bodyStart);
    if (fenceEnd >= 0 && (raw[bodyStart] === "{" || raw[bodyStart] === "[")) {
      raw = raw.slice(bodyStart, fenceEnd).trim();
      fenced = true;
    }
  }
  if (!fenced) {
    const obj = raw.indexOf("{");
    const arr = raw.indexOf("[");
    const starts = [obj, arr].filter((index) => index >= 0);
    if (starts.length) raw = raw.slice(Math.min(...starts));
  }
  return JSON.parse(raw);
}

export function validate(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errors: string[] = [];
  const expected = schema.type;
  if (expected) {
    const types = Array.isArray(expected) ? expected : [expected];
    if (!types.some((kind) => isType(value, String(kind)))) {
      errors.push(`${path} should be ${expected as string}`);
      return errors;
    }
  }
  if ("enum" in schema && !(schema.enum as unknown[]).some((entry) => isDeepStrictEqual(entry, value))) {
    errors.push(`${path} is not one of the allowed values`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} is shorter than minLength`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} is longer than maxLength`);
    }
  }
  if (typeof value === "number" && !Number.isNaN(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((item, index) => {
        errors.push(...validate(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
      });
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const props = (schema.properties && typeof schema.properties === "object")
      ? schema.properties as Record<string, Record<string, unknown>> : {};
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) {
      if (!Object.hasOwn(record, key)) errors.push(`${path}.${key} is required`);
    }
    const additional = schema.additionalProperties === undefined ? true : schema.additionalProperties;
    for (const [key, item] of Object.entries(record)) {
      if (Object.hasOwn(props, key)) errors.push(...validate(item, props[key], `${path}.${key}`));
      else if (additional === false) errors.push(`${path}.${key} is not allowed`);
      else if (additional && typeof additional === "object") {
        errors.push(...validate(item, additional as Record<string, unknown>, `${path}.${key}`));
      }
    }
  }
  return errors;
}

function isType(value: unknown, kind: string): boolean {
  if (kind === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (kind === "array") return Array.isArray(value);
  if (kind === "string") return typeof value === "string";
  if (kind === "integer") return typeof value === "number" && Number.isInteger(value);
  if (kind === "number") return typeof value === "number" && !Number.isNaN(value);
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "null") return value === null;
  return false;
}
