/** Image generation (0.51): the images_* commands Settings and the Library may send, checked before they reach DGC.
 *  Only the fields the protocol declares for each command (dgc/editor_protocol.py COMMAND_FIELDS), each of its own type
 *  and size; anything else is dropped, and a command that isn't one of these is refused. `key` goes only with
 *  images_update set_key, as the protocol says: DGC keeps it and never sends it back. */
export type ImagesCommand = { type: string; action?: string } & Record<string, unknown>;

export const IMAGE_PROVIDERS = ["comfyui", "a1111", "openai", "xai", "together", "localai", "ollama", "openai_compatible",
  "gemini", "bfl", "fal", "replicate"];
const ACTIONS = new Set(["add_generator", "edit_generator", "remove_generator", "set_default", "set_project_choice",
  "set_auto_fallback", "set_save_dir", "set_key", "test"]);
const MAPPING_FIELDS = new Set(["prompt", "negative", "seed", "steps", "width", "height", "batch", "image", "mask", "denoise",
  "frames", "fps"]);
const MAKES = new Set(["images", "videos", "both"]);
const PIP_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAPPING_TARGET = /^[A-Za-z0-9_:.-]{1,64}\.[A-Za-z0-9_]{1,64}$/;
const SURFACES = new Set(["work", "chat", "pip", "sdk", "cli"]);
/** A ComfyUI workflow in API format is a few kilobytes; a large one with many nodes stays well under this. */
export const MAX_WORKFLOW_CHARS = 1_000_000;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const long = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : undefined;
const whole = (value: unknown, low: number, high: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high ? value : undefined;

/** A workflow object as JSON allows it, within the size DGC takes. */
function workflow(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try { return JSON.stringify(value).length <= MAX_WORKFLOW_CHARS ? value as Record<string, unknown> : undefined; } catch { return undefined; }
}

/** {prompt: "6.text", seed: "3.seed", ...}: only the inputs DGC maps, each "NODE.input". */
function mapping(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(value as Record<string, unknown>)) {
    if (MAPPING_FIELDS.has(key) && typeof target === "string" && MAPPING_TARGET.test(target)) out[key] = target;
  }
  return Object.keys(out).length ? out : undefined;
}

export function imagesCommand(raw: any): ImagesCommand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const type = String(raw.type || "");
  if (type === "images_list") return { type, ...(raw.refresh === true ? { refresh: true } : {}) };
  if (type === "images_library") {
    const query = text(raw.query, 200), surface = SURFACES.has(String(raw.surface)) ? String(raw.surface) : undefined;
    const limit = whole(raw.limit, 1, 200), offset = whole(raw.offset, 0, 1_000_000);
    return { type, ...(query ? { query } : {}), ...(surface ? { surface } : {}), ...(limit !== undefined ? { limit } : {}),
             ...(offset !== undefined ? { offset } : {}) };
  }
  if (type !== "images_update") return undefined;
  const action = String(raw.action || "");
  if (!ACTIONS.has(action)) return undefined;
  const cmd: ImagesCommand = { type, action };
  const generator = text(raw.generator, 64);
  if (generator !== undefined) cmd.generator = generator;
  if (action === "set_key") {
    // The one command that carries a key: to the generator named, and nothing else beside it.
    const key = text(raw.key, 16384);
    if (key === undefined || !generator) return undefined;
    return { type, action, generator, key };
  }
  if (action === "add_generator") {
    const provider = String(raw.provider || "");
    if (!IMAGE_PROVIDERS.includes(provider)) return undefined;
    cmd.provider = provider;
  }
  for (const [field, max] of [["base_url", 2048], ["name", 64], ["id", 32], ["model", 256], ["size", 16], ["good_for", 200],
    ["system", 64]] as const) {
    const value = text(raw[field], max);
    if (value !== undefined) cmd[field] = value;
  }
  const negative = long(raw.negative_prompt, 2000);
  if (negative !== undefined) cmd.negative_prompt = negative;
  const steps = whole(raw.steps, 1, 200);
  if (steps !== undefined) cmd.steps = steps;
  for (const field of ["asks", "enabled", "default", "confirm"] as const) if (typeof raw[field] === "boolean") cmd[field] = raw[field];
  // -1 clears a monthly limit (edit_generator), as "" does.
  if (typeof raw.monthly_limit_usd === "number" && Number.isFinite(raw.monthly_limit_usd)
      && (raw.monthly_limit_usd === -1 || (raw.monthly_limit_usd >= 0 && raw.monthly_limit_usd <= 100000))) {
    cmd.monthly_limit_usd = raw.monthly_limit_usd;
  }
  // Video (0.51): what a generator makes, whether its videos ask, and the Pips whose routines may make them. Sent only
  // when the page offers video (a CLI with ready.capabilities.videos), so an older CLI is never sent one.
  if (typeof raw.makes === "string" && MAKES.has(raw.makes)) cmd.makes = raw.makes;
  if (typeof raw.video_asks === "boolean") cmd.video_asks = raw.video_asks;
  if (Array.isArray(raw.video_pips) && raw.video_pips.length <= 64 && raw.video_pips.every((p: unknown) => typeof p === "string" && PIP_ID.test(p))) {
    cmd.video_pips = [...raw.video_pips];
  }
  const flow = workflow(raw.workflow);
  if (flow) cmd.workflow = flow;
  const mapped = mapping(raw.mapping);
  if (mapped) cmd.mapping = mapped;
  if (action === "set_auto_fallback") {
    if (typeof raw.auto_fallback !== "boolean") return undefined;
    cmd.auto_fallback = raw.auto_fallback;
  }
  if (action === "set_save_dir") {
    const dir = text(raw.save_dir, 256);
    if (dir === undefined) return undefined;
    cmd.save_dir = dir;
  }
  const needsGenerator = ["edit_generator", "remove_generator"].includes(action);
  if (needsGenerator && !generator) return undefined;
  return cmd;
}
