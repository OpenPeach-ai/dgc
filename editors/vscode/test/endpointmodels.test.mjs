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
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-endpoint-models-"));
const bundle = join(scratch, "endpointmodels.cjs");
await build({ entryPoints: [join(here, "../src/endpointmodels.ts")], bundle: true, format: "cjs",
              platform: "node", target: "node18", outfile: bundle, logLevel: "silent" });
const { listEndpointModels, modelIds } = createRequire(import.meta.url)(bundle);

const seen = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization || "" });
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/api/tags") return send(200, { models: [{ name: "qwen3.8:27b" }, { name: "glm-5.3:cloud" }, { name: "qwen3.8:27b" }] });
  if (req.url === "/openai/v1/models") return send(200, { data: [{ id: "gpt-x" }, { id: "gpt-y" }] });
  if (req.url === "/huge/api/tags") { res.writeHead(200); res.end("x".repeat(3 * 1024 * 1024)); return; }
  send(404, { error: "not found" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); rmSync(scratch, { recursive: true, force: true }); });

test("an Ollama host lists its models from /api/tags, sorted and unique", async () => {
  seen.length = 0;
  assert.deepEqual(await listEndpointModels(`${origin}/v1`, "ollama"), ["glm-5.3:cloud", "qwen3.8:27b"]);
  assert.equal(seen[0].url, "/api/tags");
  assert.equal(seen[0].auth, "", "the keyless placeholder is never sent as a credential");
});

test("an OpenAI-compatible host lists /v1/models, with the key it was given", async () => {
  seen.length = 0;
  assert.deepEqual(await listEndpointModels(`${origin}/openai/v1`, "sk-test"), ["gpt-x", "gpt-y"]);
  assert.deepEqual(seen.map((s) => s.url), ["/openai/api/tags", "/openai/v1/models"]);
  assert.ok(seen.every((s) => s.auth === "Bearer sk-test"));
});

test("a host that lists nothing says so; a bad or oversized answer is an error", async () => {
  await assert.rejects(listEndpointModels(`${origin}/nothing/v1`), /Couldn't list models at 127\.0\.0\.1/);
  await assert.rejects(listEndpointModels(`${origin}/huge`), /Couldn't list models/);
  await assert.rejects(listEndpointModels("file:///etc/passwd"), /http:\/\/ or https:\/\//);
  assert.deepEqual(modelIds({ data: [{ id: "a" }, { id: 7 }, "b", null] }), ["a", "b"]);
});
