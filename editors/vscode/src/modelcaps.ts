// What a provider says each of its models can do: whether it thinks, whether it takes images, whether it can use tools.
// The model picker (media/shared/modelpicker.js) shows those as a row's marks wherever the provider says them, and its
// guess from the model's name everywhere else. One module for every page with a picker: Work's, ChatDGC's and a Pip's
// chat each get a connection's map as a page message of their own (never a field on DGC's own events).
//
// Read from the provider's own list where it says them: Ollama's /api/tags (each model's `capabilities`, on this
// computer and at ollama.com), LM Studio's own list (which models take images), and an OpenAI-compatible /models whose
// rows state them (OpenRouter's `architecture` and `supported_parameters`, Mistral's `capabilities`). A host whose list
// names its models and nothing more is never asked. Each host's answer is kept a short while, so a picker opening
// asks a host once, and opening it again later reads the list again, as the model list itself is read again.
//
// Only model names and what each can do come back: never an address, never a key.
import modelPicker from "../media/shared/modelpicker.js";
import { hostKey, readJson } from "./endpointmodels";

/** What a provider says of one model; a word it doesn't say is left out (the picker's guess stands for it). */
export type ModelSaid = { thinks?: boolean; images?: boolean; tools?: boolean };
/** A connection's models, by name: what its provider says of each. */
export type CapsMap = Record<string, ModelSaid>;

const MAX_MODELS = 4096;
const FRESH_MS = 30_000;          // a picker opened again within this: the answer already read
const QUIET_MS = 300_000;         // a host that said nothing, or didn't answer: asked again after this
// Hosts whose model list names models and nothing more: asking them would tell the picker nothing.
const SAYS_NOTHING = new Set(["anthropic", "claudecode", "openai", "deepseek", "groq", "together", "gemini", "xai", "moonshot", "kimi", "qwen", "copilot",
  "llamacpp", "vllm", "dgc"]);
// Ollama's own words for what a model can do (`capabilities` in /api/tags).
const OLLAMA_WORDS = new Set(["completion", "tools", "thinking", "vision", "embedding", "insert"]);

const words = (list: unknown[]): Set<string> => new Set(list.filter((w): w is string => typeof w === "string").map((w) => w.toLowerCase()));

/** What one row of a provider's list says, or null where it says nothing. */
function saidOf(row: any): ModelSaid | null {
  if (!row || typeof row !== "object") return null;
  const said: ModelSaid = {};
  const caps = row.capabilities;
  if (Array.isArray(caps)) {
    const has = words(caps);
    if ([...has].some((w) => OLLAMA_WORDS.has(w))) {
      // Ollama's list says every one of them: what isn't there, the model can't do.
      said.thinks = has.has("thinking"); said.images = has.has("vision"); said.tools = has.has("tools");
    } else {
      // Another list in other words (LM Studio's "tool_use"): only what it names.
      if (has.has("tool_use") || has.has("function_calling") || has.has("tool_calls")) said.tools = true;
      if (has.has("vision")) said.images = true;
      if (has.has("reasoning")) said.thinks = true;
    }
  } else if (caps && typeof caps === "object") {
    // Mistral's: each ability true or false.
    const flag = (...keys: string[]) => { for (const key of keys) if (typeof caps[key] === "boolean") return caps[key] as boolean; return undefined; };
    const images = flag("vision", "images"), tools = flag("function_calling", "tools", "tool_calls", "tool_use"), thinks = flag("reasoning", "thinking");
    if (images !== undefined) said.images = images;
    if (tools !== undefined) said.tools = tools;
    if (thinks !== undefined) said.thinks = thinks;
  }
  // OpenRouter's: what a model takes in, and which settings it accepts (tools, reasoning).
  const takes = row.architecture && Array.isArray(row.architecture.input_modalities) ? words(row.architecture.input_modalities) : null;
  if (takes && said.images === undefined) said.images = takes.has("image");
  if (Array.isArray(row.supported_parameters)) {
    const accepts = words(row.supported_parameters);
    if (said.tools === undefined) said.tools = accepts.has("tools");
    if (said.thinks === undefined) said.thinks = accepts.has("reasoning") || accepts.has("include_reasoning");
  }
  // LM Studio's kind of model: one that sees ("vlm"), one that writes, an embedder (which can't use tools at all).
  if (typeof row.type === "string" && ["llm", "vlm", "embeddings"].includes(row.type)) {
    if (said.images === undefined) said.images = row.type === "vlm";
    if (row.type === "embeddings" && said.tools === undefined) said.tools = false;
  }
  return Object.keys(said).length ? said : null;
}

/** What a provider's list says of its models, by name: Ollama's `models[]` or an OpenAI-compatible `data[]`. A model
 *  the list says nothing of isn't in it. An Ollama name ending ":latest" is found by its short name too. */
export function capsFromList(payload: unknown): CapsMap {
  const body = payload as { models?: unknown; data?: unknown } | null;
  const rows = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
  const out: CapsMap = Object.create(null);
  for (const row of rows.slice(0, MAX_MODELS) as any[]) {
    const said = saidOf(row);
    if (!said) continue;
    for (const id of [row.name, row.model, row.id]) {
      if (typeof id !== "string" || !id || id.length > 512) continue;
      out[id] = said;
      if (id.endsWith(":latest") && !(id.slice(0, -7) in out)) out[id.slice(0, -7)] = said;
    }
  }
  return { ...out };
}

/** Which list says a host's models' abilities, by the mark the host wears (media/shared/modelpicker.js markOf): none
 *  for a host whose list says nothing; Ollama's and then /models for a host DGC doesn't know. */
export function capsUrls(base: string, name = ""): string[] {
  let url: URL;
  try { url = new URL(String(base || "")); } catch { return []; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];
  const { mark } = modelPicker.markOf({ base_url: url.href, name });
  const path = url.pathname.replace(/\/+$/, ""), root = path.replace(/\/v1$/i, "");
  const tags = `${url.origin}${root}/api/tags`, models = `${url.origin}${path}${/\/v1$/i.test(path) ? "" : "/v1"}/models`;
  if (mark === "ollama") return [tags];
  if (mark === "lmstudio") return [`${url.origin}/api/v0/models`];
  if (mark === "openrouter" || mark === "mistral") return [models];
  if (SAYS_NOTHING.has(mark)) return [];
  return [tags, models];
}

type Held = { at: number; for: number; caps: CapsMap; pending?: Promise<CapsMap> };

/** The reader: one list per host, kept FRESH_MS (QUIET_MS for a host that said nothing or didn't answer). */
export class ModelCaps {
  private held = new Map<string, Held>();
  private read: (url: string, apiKey: string) => Promise<unknown>;
  private now: () => number;
  constructor({ read = readJson, now = Date.now }: { read?: (url: string, apiKey: string) => Promise<unknown>; now?: () => number } = {}) {
    this.read = read; this.now = now;
  }

  /** What the host at `base_url` says of its models. Never throws: a host that can't be read says nothing. `name` is
   *  the connection's saved name (it can say what the host is, as the picker's mark does). */
  async get({ base_url, api_key = "", name = "" }: { base_url: string; api_key?: string; name?: string }): Promise<CapsMap> {
    const urls = capsUrls(base_url, name);
    const key = hostKey(base_url);
    if (!urls.length || !key) return {};
    const now = this.now(), held = this.held.get(key);
    if (held?.pending) return held.pending;
    if (held && now - held.at < held.for) return held.caps;
    const pending = (async () => {
      let caps: CapsMap = {};
      for (const url of urls) {
        try {
          const body: any = await this.read(url, api_key);
          caps = capsFromList(body);
          if (Array.isArray(body?.models) || Array.isArray(body?.data)) break;     // (a list, though it may say nothing)
        } catch { /* the next list, or nothing */ }
      }
      return caps;
    })();
    this.held.set(key, { at: now, for: FRESH_MS, caps: held?.caps || {}, pending });
    const caps = await pending;
    this.held.set(key, { at: this.now(), for: Object.keys(caps).length ? FRESH_MS : QUIET_MS, caps });
    return caps;
  }
}

/** The one reader the extension's host keeps: every page's picker asks through it, so a host is read once. */
export const modelCaps = new ModelCaps();
