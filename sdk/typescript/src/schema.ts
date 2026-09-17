/** Harness-side JSON Schema subset used for outputSchema. Unsupported keywords are rejected. */

const ALLOWED = new Set([
  "type", "properties", "required", "items", "enum", "additionalProperties",
  "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems",
  "description", "title", "default",
]);
const JSON_FENCE = /```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/;

export function assertSupported(schema: unknown): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || !Object.keys(schema).length) {
    throw new Error("outputSchema must be a non-empty object");
  }
  walk(schema);
}

function walk(node: unknown): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  if ("$ref" in record || "$id" in record || "$schema" in record) {
    throw new Error("outputSchema must not use $ref, $id, or $schema");
  }
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) throw new Error(`outputSchema has unsupported keyword: ${key}`);
  }
  if (record.properties && typeof record.properties === "object") {
    for (const child of Object.values(record.properties as Record<string, unknown>)) walk(child);
  }
  if (record.items && typeof record.items === "object") walk(record.items);
}

export function extractJson(text: string): unknown {
  let raw = (text || "").trim();
  if (!raw) throw new Error("final text is empty");
  const fenced = JSON_FENCE.exec(raw);
  if (fenced) raw = fenced[1];
  else {
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
  if ("enum" in schema && !((schema.enum as unknown[]) || []).includes(value)) {
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
      if (!(key in record)) errors.push(`${path}.${key} is required`);
    }
    const additional = schema.additionalProperties === undefined ? true : schema.additionalProperties;
    for (const [key, item] of Object.entries(record)) {
      if (key in props) errors.push(...validate(item, props[key], `${path}.${key}`));
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
