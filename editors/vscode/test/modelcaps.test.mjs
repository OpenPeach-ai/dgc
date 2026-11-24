// What a provider says each of its models can do (src/modelcaps.ts, 24 Nov): the model picker's marks come from the
// provider's own list where it says them (Ollama's /api/tags `capabilities`; an OpenAI-compatible /models only where
// its rows state them), read once per host and kept a short while, so a picker opening asks each host once. The owner,
// 24 Nov: "for ollama, they only show cloud icon and bulb icon, what about image icon too? ... ollama models directory
// does offer which models have what capabilities". Only model names and what each can do come back: no address, no key.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-model-caps-"));
const bundle = join(scratch, "modelcaps.cjs");
await build({ entryPoints: [join(here, "../src/modelcaps.ts")], bundle: true, format: "cjs",
              platform: "node", target: "node18", outfile: bundle, logLevel: "silent" });
const { capsFromList, capsUrls, ModelCaps } = createRequire(import.meta.url)(bundle);

// Ollama's own list, as the live host answered it on 24 Nov (trimmed): each model with what it can do.
const TAGS = { models: [
  { name: "kimi-k3.1-pro:cloud", model: "kimi-k3.1-pro:cloud", remote_host: "https://ollama.com", capabilities: ["vision", "thinking", "completion", "tools"] },
  { name: "deepseek-v4.1-flash:cloud", model: "deepseek-v4.1-flash:cloud", remote_host: "https://ollama.com", capabilities: ["completion", "thinking", "tools", "vision"] },
  { name: "glm-5.3:cloud", model: "glm-5.3:cloud", remote_host: "https://ollama.com", capabilities: ["completion", "thinking", "tools"] },
  { name: "qwen3.8-bf16-40k:latest", model: "qwen3.8-bf16-40k:latest", capabilities: ["completion", "tools", "thinking", "vision"] },
  { name: "qwen2.5:14b", model: "qwen2.5:14b", capabilities: ["completion", "tools"] },
  { name: "codellama:13b", model: "codellama:13b", capabilities: ["completion"] },
  { name: "qwen2.5vl:7b", model: "qwen2.5vl:7b", capabilities: ["vision", "completion"] },
  { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", capabilities: ["embedding"] },
  { name: "an-older-ollama:7b", model: "an-older-ollama:7b" },                       // an older Ollama says nothing
] };

test("Ollama's list: vision is images, thinking thinks, and a model without tools is said to have none", () => {
  const caps = capsFromList(TAGS);
  assert.deepEqual(caps["deepseek-v4.1-flash:cloud"], { thinks: true, images: true, tools: true }, "it sees images: the mark it was missing");
  assert.deepEqual(caps["kimi-k3.1-pro:cloud"], { thinks: true, images: true, tools: true });
  assert.deepEqual(caps["glm-5.3:cloud"], { thinks: true, images: false, tools: true }, "it does not see images");
  assert.deepEqual(caps["qwen2.5:14b"], { thinks: false, images: false, tools: true });
  assert.deepEqual(caps["codellama:13b"], { thinks: false, images: false, tools: false }, "no tools");
  assert.deepEqual(caps["qwen2.5vl:7b"], { thinks: false, images: true, tools: false });
  assert.deepEqual(caps["nomic-embed-text:latest"], { thinks: false, images: false, tools: false });
  assert.deepEqual(caps["qwen3.8-bf16-40k"], caps["qwen3.8-bf16-40k:latest"], "a :latest model is found by its short name too");
  assert.equal(Object.hasOwn(caps, "an-older-ollama:7b"), false, "nothing said: the picker keeps its guess from the name");
  assert.doesNotMatch(JSON.stringify(caps), /https?:|ollama\.com/, "names and abilities only: no address");
});

test("an OpenAI-compatible list counts only where its rows say something: OpenRouter's, Mistral's, LM Studio's", () => {
  const router = capsFromList({ data: [
    { id: "anthropic/claude-opus-5-5", architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools", "reasoning", "max_tokens"] },
    { id: "meta/llama-text", architecture: { input_modalities: ["text"] }, supported_parameters: ["max_tokens", "temperature"] },
  ] });
  assert.deepEqual(router["anthropic/claude-opus-5-5"], { thinks: true, images: true, tools: true });
  assert.deepEqual(router["meta/llama-text"], { thinks: false, images: false, tools: false });
  // Mistral says images and tools; it doesn't say thinking, so that stays the name's guess.
  const mistral = capsFromList({ data: [{ id: "pixtral-large", capabilities: { completion_chat: true, function_calling: true, vision: true } },
    { id: "codestral-mamba", capabilities: { completion_chat: true, function_calling: false, vision: false } }] });
  assert.deepEqual(mistral["pixtral-large"], { images: true, tools: true });
  assert.deepEqual(mistral["codestral-mamba"], { images: false, tools: false });
  // LM Studio says which see images; any of its models can be given tools, so it is never "No tools" but an embedder.
  const studio = capsFromList({ data: [{ id: "qwen3-vl-8b", type: "vlm", capabilities: ["tool_use"] }, { id: "qwen3-14b-mlx", type: "llm" }, { id: "nomic-embed", type: "embeddings" }] });
  assert.deepEqual(studio["qwen3-vl-8b"], { images: true, tools: true });
  assert.deepEqual(studio["qwen3-14b-mlx"], { images: false });
  assert.deepEqual(studio["nomic-embed"], { images: false, tools: false });
  // OpenAI, Groq, Together…: names only. Nothing said, nothing kept.
  assert.deepEqual(capsFromList({ data: [{ id: "gpt-5.6", object: "model", owned_by: "openai" }, { id: "llama-3.3-70b", type: "chat", context_window: 131072 }] }), {});
  assert.deepEqual(capsFromList(null), {});
  assert.deepEqual(capsFromList({ models: [{ name: 7, capabilities: ["vision"] }, { name: "x".repeat(600), capabilities: ["vision"] }, "plain"] }), {});
});

test("which list says a host's abilities: Ollama's /api/tags, LM Studio's own list, a stating /models; none for a host that says nothing", () => {
  assert.deepEqual(capsUrls("http://localhost:11434/v1", "Ollama"), ["http://localhost:11434/api/tags"]);
  assert.deepEqual(capsUrls("http://127.0.0.1:11434", ""), ["http://127.0.0.1:11434/api/tags"], "Ollama's port says what it is");
  assert.deepEqual(capsUrls("https://ollama.com/v1", "Ollama Cloud"), ["https://ollama.com/api/tags"]);
  assert.deepEqual(capsUrls("https://openrouter.ai/api/v1", "OpenRouter"), ["https://openrouter.ai/api/v1/models"]);
  assert.deepEqual(capsUrls("https://api.mistral.ai/v1", "Mistral"), ["https://api.mistral.ai/v1/models"]);
  assert.deepEqual(capsUrls("http://localhost:1234/v1", "LM Studio"), ["http://localhost:1234/api/v0/models"]);
  for (const [base, name] of [["https://api.openai.com/v1", "OpenAI"], ["https://api.anthropic.com/v1", "Anthropic"], ["https://api.groq.com/openai/v1", "Groq"],
    ["https://api.deepseek.com/v1", "DeepSeek"], ["http://localhost:8080/v1", "llama.cpp"], ["http://localhost:8000/v1", "vLLM"]]) assert.deepEqual(capsUrls(base, name), [], `${name}: its list says nothing, so it isn't asked`);
  assert.deepEqual(capsUrls("http://10.0.0.40:9000/v1", "NAS workstation"), ["http://10.0.0.40:9000/api/tags", "http://10.0.0.40:9000/v1/models"], "a host DGC doesn't know: Ollama's list, then /models");
  assert.deepEqual(capsUrls("file:///etc/passwd", "Ollama"), []);
  assert.deepEqual(capsUrls("", "Ollama"), []);
});

// A provider's host, for the reader: Ollama's list at /api/tags, a host that lists nothing, one that never answers.
const seen = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization || "" });
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/api/tags") return send(200, TAGS);
  if (req.url === "/gw/api/tags") return send(404, { error: "not found" });
  if (req.url === "/gw/v1/models") return send(200, { data: [{ id: "gw-vision", architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"] }] });
  send(404, { error: "not found" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); rmSync(scratch, { recursive: true, force: true }); });

test("the reader asks a host once and keeps its answer a while; asked again later, it reads the list again", async () => {
  let now = 1_000_000;
  const caps = new ModelCaps({ now: () => now });
  seen.length = 0;
  const [a, b] = await Promise.all([caps.get({ base_url: `${origin}/v1`, api_key: "ollama", name: "Ollama" }), caps.get({ base_url: `${origin}`, api_key: "ollama", name: "Ollama" })]);
  assert.deepEqual(seen.map((s) => s.url), ["/api/tags"], "two asks at once, one list: the same host however its address is written");
  assert.equal(seen[0].auth, "", "the keyless placeholder is never sent as a credential");
  assert.deepEqual(a["deepseek-v4.1-flash:cloud"], { thinks: true, images: true, tools: true });
  assert.deepEqual(a, b);
  now += 5_000;
  await caps.get({ base_url: `${origin}/v1`, name: "Ollama" });
  assert.equal(seen.length, 1, "a picker opened again soon after: the answer it has");
  now += 60_000;
  await caps.get({ base_url: `${origin}/v1`, name: "Ollama" });
  assert.equal(seen.length, 2, "later: the list again, as the model list is read again");
});

test("a host DGC doesn't know is asked Ollama's list, then /models; a key goes only to its own host; one that fails gives nothing", async () => {
  const caps = new ModelCaps();
  seen.length = 0;
  const got = await caps.get({ base_url: `${origin}/gw/v1`, api_key: "sk-test", name: "Work gateway" });
  assert.deepEqual(seen.map((s) => s.url), ["/gw/api/tags", "/gw/v1/models"]);
  assert.ok(seen.every((s) => s.auth === "Bearer sk-test"));
  assert.deepEqual(got, { "gw-vision": { thinks: false, images: true, tools: true } }, "its settings name tools but not reasoning: it does not think");
  // Nothing listening there: no throw, no marks from it (the picker keeps its guess from the name).
  const gone = await caps.get({ base_url: "http://127.0.0.1:9/v1", name: "Ollama" });
  assert.deepEqual(gone, {});
  assert.deepEqual(await caps.get({ base_url: "https://api.openai.com/v1", api_key: "sk-test", name: "OpenAI" }), {}, "a host whose list says nothing is never asked");
});
