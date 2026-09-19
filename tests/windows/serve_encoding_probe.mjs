/**
 * M0 diagnostic (Node side of serve_encoding_probe.py): what does the Node SDK make of a
 * `dgc serve` whose stdout is not UTF-8? The Node transport decodes stdout leniently, so a bad
 * byte is not an error: it becomes U+FFFD, and a frame serve could not encode at all is dropped.
 * The model answers "héllo → 你好 🍑" (é is cp1252-encodable; → 你好 🍑 are not).
 *
 *   DGC_PYTHON=<python with the dgc CLI> node tests/windows/serve_encoding_probe.mjs <sdk dist/index.js>
 *
 * Variants: utf-8 and cp1252 (forced through PYTHONIOENCODING) and native (no override: the
 * interpreter's own default, i.e. what a Windows user gets). Always exits 0; the findings are the
 * ASCII-only `M0-RESULT` lines.
 */
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = resolve(process.argv[2] || "");
const PY = process.env.DGC_PYTHON;
if (!PY) throw new Error("set DGC_PYTHON to the python that has the dgc CLI installed");
const { DGC } = await import(pathToFileURL(entry).href);

const ANSWER = "héllo → 你好 🍑";
const MARKERS = ["héllo", "你好", "🍑"];
const ascii = (value) => JSON.stringify(value).replace(/[^\x20-\x7e]/g,
  (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
const sse = (delta, finish = null) => "data: " + JSON.stringify({ id: "mock", object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "sdk-model" }] }));
    return;
  }
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse({ content: ANSWER }) + sse({}, "stop") + "data: [DONE]\n\n");
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const work = mkdtempSync(join(tmpdir(), "dgc-enc-work-"));
writeFileSync(join(work, "README.md"), "hi\n");

for (const variant of ["utf-8", "cp1252", "native"]) {
  const extraEnv = variant === "native" ? {} : { PYTHONIOENCODING: variant };
  const dgc = new DGC({ stateDir: mkdtempSync(join(tmpdir(), "dgc-enc-state-")), model: "sdk-model", baseUrl,
    apiKey: "sk-local", runtime: [PY, "-m", "dgc", "serve"], extraEnv });
  let line;
  try {
    const session = await dgc.session({ cwd: work, permissions: { mode: "auto", unhandled: "deny" } });
    const result = await session.run("Say the greeting exactly.", { timeoutMs: 120_000 });
    const present = MARKERS.filter((m) => (result.finalText || "").includes(m));
    const intact = result.finalText === ANSWER;
    line = `status=${result.status} non_ascii_intact=${intact ? "YES" : "NO"} ` +
      `markers=${ascii(present.join(","))} final_text=${ascii(result.finalText)} error=None`;
  } catch (error) {
    line = `status=None non_ascii_intact=NO markers="" final_text=None ` +
      `error=${ascii(`${error?.name}: ${String(error?.message || error).slice(0, 200)}`)}`;
  } finally {
    try { await dgc.close(); } catch { /* recorded above if it mattered */ }
  }
  console.log(`M0-RESULT windows-encoding-node platform=${process.platform} enc=${variant} ${line}`);
}
server.close();
process.exit(0);
