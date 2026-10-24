/** Pip templates in code (Pips API 64): your app declares its Personal Pips, and `session.pips.ensure` makes the real
 *  Pips match on each deploy, safely.
 *
 *  A PipTemplate is plain, checked data. DGC checks it again, and against your registered apps, when it is ensured:
 *  what the SDK can't know here (which tools exist, which are changes, which move money, which models the connection
 *  offers) is DGC's to refuse. */
import { DGCConfigError } from "./errors.ts";

export type PipTemplateLevel = "ask" | "approve" | "full";
export type PipTemplateWhen =
  | { kind: "schedule"; schedule: Record<string, unknown> }
  | { kind: "app"; app: string; event: string }
  | { schedule: Record<string, unknown> }
  | { app: string; event: string };
export type PipTemplateRoutine = { title: string; prompt: string; when: PipTemplateWhen };
/** What definePipTemplate takes. `tools`: your apps' tools as "app:<name>/<tool>" (a Pip made from a template uses only
 *  these of your apps' tools) and "computer" for its own computer. `alwaysAllow`: change tools in `tools` it may run
 *  without asking, never a read, never one that moves money. `model`: a model id from list_pip_models, or none for
 *  DGC's own default (on a server, an API-key or self-hosted model). `level`: "ask" (the default), "approve" or "full". */
export type PipTemplateInput = {
  key: string; name: string; instructions: string; model?: string | null; level?: PipTemplateLevel;
  tools?: readonly string[]; routines?: readonly PipTemplateRoutine[]; alwaysAllow?: readonly string[];
};
export type PipTemplate = Readonly<{
  key: string; name: string; instructions: string; model: string | null; level: PipTemplateLevel;
  tools: readonly string[]; routines: readonly Readonly<{ title: string; prompt: string; when: PipTemplateWire["routines"][number]["when"] }>[];
  alwaysAllow: readonly string[];
}>;
export type PipTemplateWire = {
  key: string; name: string; instructions: string; model?: string; level: PipTemplateLevel; tools: string[];
  routines: { title: string; prompt: string; when: { kind: "schedule"; schedule: Record<string, unknown> } | { kind: "app"; app: string; event: string } }[];
  always_allow: string[];
};

const KEY = /^[a-z0-9-]{1,40}$/;
const APP_TOOL = /^app:[a-z0-9-]{1,40}\/[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const APP_NAME = /^[a-z0-9-]{1,40}$/;
const EVENT_NAME = /^[a-z0-9_.-]{1,64}$/;
const LEVELS = ["ask", "approve", "full"];
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fields = (v: Record<string, unknown>) => Object.keys(v).sort().join(",");

function text(value: unknown, limit: number, what: string, line = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\u0000")) {
    throw new DGCConfigError(`a Pip template's ${what} is text of 1 to ${limit} characters`);
  }
  if (line && /[\u0000-\u001f]/.test(value)) throw new DGCConfigError(`a Pip template's ${what} is one line`);
  return value.trim();
}

function when(value: unknown): PipTemplateWire["routines"][number]["when"] {
  let v = value;
  if (isRecord(v) && !Object.hasOwn(v, "kind")) {
    if (fields(v) === "schedule") v = { kind: "schedule", ...v };
    else if (fields(v) === "app,event") v = { kind: "app", ...v };
  }
  if (!isRecord(v) || (v.kind !== "schedule" && v.kind !== "app")) {
    throw new DGCConfigError('a routine\'s when is {kind: "schedule", schedule: {...}} or {kind: "app", app: "shop", event: "order.created"}');
  }
  if (v.kind === "app") {
    if (fields(v) !== "app,event,kind" || typeof v.app !== "string" || !APP_NAME.test(v.app)
      || typeof v.event !== "string" || !EVENT_NAME.test(v.event)) {
      throw new DGCConfigError("a routine on your app's event names the app (as registered) and the event (1 to 64 lowercase letters, digits, dots, hyphens or underscores, such as order.created)");
    }
    return { kind: "app", app: v.app, event: v.event };
  }
  if (fields(v) !== "kind,schedule" || !isRecord(v.schedule)) {
    throw new DGCConfigError('a timed routine\'s when is {kind: "schedule", schedule: {type: "cron", cron: "30 9 * * 1-5", timezone: "Asia/Kolkata"}} (or daily, interval, once)');
  }
  return { kind: "schedule", schedule: JSON.parse(JSON.stringify(v.schedule)) as Record<string, unknown> };
}

function routine(value: unknown): PipTemplateWire["routines"][number] {
  if (!isRecord(value) || fields(value) !== "prompt,title,when") throw new DGCConfigError("each routine of a Pip template is {title, prompt, when}");
  return { title: text(value.title, 160, "routine's title", true).split(/\s+/).join(" "), prompt: text(value.prompt, 4000, "routine's prompt"),
    when: when(value.when) };
}

function list(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DGCConfigError(`a Pip template's ${what} is a list`);
  return [...value] as string[];
}

/** The wire shape (what ensure_pip_template sends), checked: from definePipTemplate's value or the same input. */
export function pipTemplateWire(value: unknown): PipTemplateWire {
  if (!isRecord(value)) throw new DGCConfigError("a Pip template is a definePipTemplate value, or an object of the same fields");
  const allowed = new Set(["key", "name", "instructions", "model", "level", "tools", "routines", "alwaysAllow"]);
  const unknown = Object.keys(value).filter((k) => !allowed.has(k));
  if (unknown.length) throw new DGCConfigError(`a Pip template has no field ${unknown.sort()[0]}${unknown[0] === "always_allow" ? " (it is alwaysAllow)" : ""}`);
  if (typeof value.key !== "string" || !KEY.test(value.key)) {
    throw new DGCConfigError("a Pip template's key is 1 to 40 lowercase letters, digits or hyphens, such as dunning");
  }
  const name = text(value.name, 120, "name", true), instructions = text(value.instructions, 4000, "instructions");
  const model = value.model;
  if (model !== undefined && model !== null && (typeof model !== "string" || !model.trim() || model.length > 200 || /[\u0000- \u007f]/.test(model))) {
    throw new DGCConfigError("a Pip template's model is a model id from list_pip_models, or null for DGC's default");
  }
  const level = value.level === undefined ? "ask" : value.level;
  if (typeof level !== "string" || !LEVELS.includes(level)) throw new DGCConfigError('a Pip template\'s level is "ask", "approve" or "full"');
  const tools = list(value.tools, "tools");
  if (tools.length > 64 || tools.some((t) => typeof t !== "string" || !(t === "computer" || APP_TOOL.test(t)))) {
    throw new DGCConfigError('a Pip template\'s tools are up to 64 of "app:<name>/<tool>" (your app\'s tools, such as app:shop/find_unpaid_orders) and "computer". Gmail, Calendar, plugins and connectors are connected by a person in DGC, never by a template');
  }
  if (new Set(tools).size !== tools.length) throw new DGCConfigError("a Pip template names each tool once");
  const always = list(value.alwaysAllow, "alwaysAllow");
  if (always.some((t) => typeof t !== "string" || !APP_TOOL.test(t)) || new Set(always).size !== always.length) {
    throw new DGCConfigError('a Pip template\'s alwaysAllow names change tools of your app once each, as "app:<name>/<tool>"');
  }
  const missing = always.find((t) => !tools.includes(t));
  if (missing) throw new DGCConfigError(`${missing} is in alwaysAllow but not in tools: a Pip is only allowed a tool it has`);
  const routines = list(value.routines, "routines");
  if (routines.length > 10) throw new DGCConfigError("a Pip template has at most 10 routines");
  const shaped = routines.map(routine);
  if (new Set(shaped.map((r) => r.title)).size !== shaped.length) {
    throw new DGCConfigError("each routine of a Pip template has its own title: a routine is known by it");
  }
  return { key: value.key, name, instructions, ...(typeof model === "string" ? { model: model.trim() } : {}), level: level as PipTemplateLevel,
    tools, routines: shaped, always_allow: always };
}

/** One Personal Pip as your app declares it (Pips API 64), checked and frozen. `key` is its stable id (1 to 40
 *  lowercase letters, digits or hyphens), unique in the profile: the same key is always the same Pip. */
export function definePipTemplate(input: PipTemplateInput): PipTemplate {
  const wire = pipTemplateWire(input);
  return Object.freeze({ key: wire.key, name: wire.name, instructions: wire.instructions, model: wire.model ?? null, level: wire.level,
    tools: Object.freeze([...wire.tools]), routines: Object.freeze(wire.routines.map((r) => Object.freeze({ ...r }))),
    alwaysAllow: Object.freeze([...wire.always_allow]) });
}

/** ensureAll's templates, checked together before anything is sent: each key once. */
export function pipTemplatesWire(templates: unknown): PipTemplateWire[] {
  if (!Array.isArray(templates)) throw new DGCConfigError("ensureAll takes a list of definePipTemplate values");
  if (templates.length > 100) throw new DGCConfigError("ensureAll takes at most 100 templates");
  const wires = templates.map(pipTemplateWire);
  const keys = wires.map((w) => w.key);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw new DGCConfigError(`two templates share the key ${twice}: a key is one Pip`);
  return wires;
}
