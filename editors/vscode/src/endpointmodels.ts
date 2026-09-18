// The models a provider host offers, read from the host itself so Settings can list them before the
// host is saved. Ollama answers at /api/tags; an OpenAI-compatible host at <base>/models.

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 4096;

function candidates(base: string): string[] {
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The host URL must start with http:// or https://.");
  }
  url.search = ""; url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  const root = path.replace(/\/v1$/, "");
  const list = [`${url.origin}${root}/api/tags`, `${url.origin}${path || ""}${/\/v1$/.test(path) ? "" : "/v1"}/models`];
  return [...new Set(list)];
}

async function readJson(url: string, apiKey: string): Promise<unknown> {
  const headers: Record<string, string> = { "User-Agent": "dgc-vscode", Accept: "application/json" };
  // "ollama" is the placeholder a keyless local host is saved with; it is not a credential.
  if (apiKey && apiKey !== "ollama") { headers.Authorization = `Bearer ${apiKey}`; }
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers });
  if (!response.ok || !response.body) { throw new Error(`HTTP ${response.status}`); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { break; }
      length += value.byteLength;
      if (length > MAX_BYTES) { throw new Error("the model list is too large"); }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Model ids the host lists: Ollama's `models[].name`, or OpenAI's `data[].id`. Sorted, unique. */
export function modelIds(payload: unknown): string[] {
  const body = payload as { models?: unknown; data?: unknown };
  const rows = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
  const ids = rows.map((row: any) => (typeof row === "string" ? row : row?.name ?? row?.model ?? row?.id))
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512);
  return [...new Set(ids)].slice(0, MAX_MODELS).sort();
}

export async function listEndpointModels(base: string, apiKey = ""): Promise<string[]> {
  let last: unknown;
  for (const url of candidates(base)) {
    try {
      const ids = modelIds(await readJson(url, apiKey));
      if (ids.length) { return ids; }
    } catch (err) {
      last = err;
    }
  }
  if (last) { throw new Error(`Couldn't list models at ${new URL(base).host}: ${(last as Error)?.message || last}`); }
  return [];
}
