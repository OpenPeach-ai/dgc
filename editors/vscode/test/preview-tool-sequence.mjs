// Review the real DGC webview renderer with a recorded-format tool event sequence.
// This builds a local, sample-data page; no backend or workspace tool is invoked.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const output = resolve(process.argv[2] || resolve(root, "shots-tool-sequence"));
mkdirSync(output, { recursive: true });
const panelSource = readFileSync(resolve(root, "src/panel.ts"), "utf8");
const skeleton = [...panelSource.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)]
  .map((match) => match[0]).find((html) => html.includes('id="input"'))
  .replace(/\$\{[^}]*\}/g, "");
const css = readFileSync(resolve(root, "media/main.css"), "utf8");
mkdirSync(resolve(output, "pips"), { recursive: true });
writeFileSync(resolve(output, "pips/wordmark.css"), readFileSync(resolve(root, "media/pips/wordmark.css")));
writeFileSync(resolve(output, "dgc.svg"), readFileSync(resolve(root, "media/dgc.svg")));
const codicon = readFileSync(resolve(root, "media/codicon.css"), "utf8")
  .replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(resolve(root, "media/codicon.ttf")).toString("base64")}")`);
const main = readFileSync(resolve(root, "media/main.js"), "utf8");
const numberedList = readFileSync(resolve(root, "media/numbered-list.js"), "utf8");
const markdown = buildSync({ entryPoints: [resolve(root, "src/markdown.ts")], bundle: true,
  format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
const boot = `<script>
window.addEventListener("load", () => {
  window.acquireVsCodeApi = () => ({
    postMessage(message) { parent.postMessage({ kind: "dgc-response", message }, "*"); },
    getState() { return undefined; }, setState() {},
  });
  const decode = (encoded) => new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
  eval(decode(${JSON.stringify(Buffer.from(markdown + "\nglobalThis.DgcMarkdown = DgcMarkdown;", "utf8").toString("base64"))}));
  eval(decode(${JSON.stringify(Buffer.from(numberedList, "utf8").toString("base64"))}));
  eval(decode(${JSON.stringify(Buffer.from(main, "utf8").toString("base64"))}));
  const send = (event) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } }));
  send({ type: "ready", capabilities: {}, model: "deepseek-v4.1-flash:cloud", mode: "default",
    think: "off", base_url: "http://127.0.0.1:11434/v1", commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "preview" });
  send({ type: "config", model: "deepseek-v4.1-flash:cloud", mode: "default", think: "off",
    base_url: "http://127.0.0.1:11434/v1", context_size: 65536 });
  window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state: {
    model: "deepseek-v4.1-flash:cloud", mode: "default", think: "off",
    baseUrl: "http://127.0.0.1:11434/v1", goal: { text: "", status: "none" },
  } } }));
  window.addEventListener("message", (message) => { if (message.data?.previewEvent) send(message.data.previewEvent); });
  parent.postMessage({ kind: "dgc-preview-ready" }, "*");
});
</script>`;
const panel = skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style><style>
  :root { --vscode-font-family: system-ui,sans-serif; --vscode-editor-font-family: ui-monospace,monospace; }
  body { background: var(--bg); color: var(--text); }
</style></head>`).replace("</body>", `${boot}</body>`);
writeFileSync(resolve(output, "panel.html"), panel);

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<title>DGC · Tool activity review</title><style>
  :root { font-family: system-ui,sans-serif; color: #eeeaf8; background: #0b0b0d; }
  * { box-sizing: border-box; } body { margin: 0; }
  header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 16px 22px; border-bottom: 1px solid #2c2b30; }
  h1 { margin: 0; font-size: 17px; font-weight: 650; } .sub { font-size: 12px; color: #aba7b6; margin-top: 3px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button { border: 1px solid #38363e; background: #222126; color: #f3f0fa; padding: 8px 12px; border-radius: 8px; font: inherit; font-size: 12px; cursor: pointer; }
  button:hover, button:focus-visible { border-color: #8667f7; } button.primary { background: #7653f3; border-color: #7653f3; }
  button:disabled { opacity: .4; cursor: default; }
  main { display: grid; grid-template-columns: minmax(0,1fr) 270px; gap: 22px; padding: 20px; align-items: start; }
  .editor { width: 100%; max-width: 880px; margin-inline: auto; background: #141416; border: 1px solid #333138; box-shadow: 0 18px 60px #0008; }
  .editor.narrow { width: 380px; max-width: 100%; } .tab { height: 38px; border-bottom: 1px solid #323036; display: flex; align-items: center; padding: 0 14px; gap: 10px; font-size: 12px; }
  .mark { width: 18px; height: 18px; margin-right: 3px; }
  iframe { display: block; width: 100%; height: min(800px,calc(100vh - 140px)); min-height: 500px; border: 0; }
  aside { padding: 15px; border: 1px solid #34313a; border-radius: 12px; background: #17161a; }
  aside h2 { font-size: 14px; margin: 0 0 12px; } .phase { color: #b9a4ff; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  aside p, aside li { color: #bcb8c5; font-size: 12px; line-height: 1.6; } ol { padding-left: 18px; } li { margin-bottom: 5px; }
  small { color: #9892a2; } @media(max-width:900px){ main { grid-template-columns: 1fr; } aside { max-width: 880px; margin-inline: auto; width: 100%; } }
</style></head><body>
<header><div><h1>DGC tool activity · extension replay</h1><div class="sub">Actual DGC webview renderer · sample events · no tools are executed</div></div>
<div class="controls"><button id="reset">Reset</button><button id="step">Next event</button><button id="play" class="primary">Play sequence</button><button id="width">Narrow editor</button></div></header>
<main><div class="editor" id="editor"><div class="tab"><img class="mark" src="dgc.svg" alt=""> ERP dashboard check · DGC</div><iframe id="panel" title="DGC extension webview" src="panel.html"></iframe></div>
<aside><h2>What to inspect</h2><div class="phase" id="phase">Ready</div><p id="note">Press Play sequence or Next event.</p><ol>
<li>The marks record calls that happened; they do not predict future work.</li>
<li>Open the work line to inspect each tool and its result.</li>
<li>Progress appears only when a tool reports a real total.</li>
<li>The edit approval stays outside the folded tool group.</li></ol><small>Sample scenario: checking a blank chart in an ERP report. Your ERP is not accessed.</small></aside></main>
<script>
const phases = [
  { label: "User request", note: "DGC begins a turn in Work.", events: [
    {type:"turn_start",turn_id:"sample-turn",prompt:"Find why the monthly sales chart is blank, fix it, and run the checks.",kind:"prompt"},
    {type:"text_delta",text:"I’ll inspect the report, trace the chart height, and check the result."},
    {type:"stream_end",phase:"commentary"}] },
  { label: "Read the report", note: "One observed call appears and starts its clock.", events: [
    {type:"tool_call",call_id:"read-1",name:"read_file",args:{path:"reports/sales/index.html"},summary:"reports/sales/index.html"}] },
  { label: "Read completed", note: "Its mark changes state without rebuilding the group.", events: [
    {type:"tool_result",call_id:"read-1",name:"read_file",output:"<section class=\\"monthly-chart\\">…</section>",is_error:false}] },
  { label: "Search the chart styles", note: "The sequence shows only the calls DGC has actually made.", events: [
    {type:"tool_call",call_id:"search-1",name:"grep",args:{pattern:"height|monthly-chart",path:"reports/sales"},summary:"height|monthly-chart"}] },
  { label: "Search completed", note: "Open the line to read the exact result.", events: [
    {type:"tool_result",call_id:"search-1",name:"grep",output:"index.html:84 .monthly-chart .bar { height: 62%; }\\nindex.html:72 .monthly-chart { display: flex; }",is_error:false}] },
  { label: "Run the checks", note: "The running call and elapsed time appear in the live line.", events: [
    {type:"tool_call",call_id:"test-1",name:"bash",args:{command:"npm test -- chart"},summary:"npm test -- chart"}] },
  { label: "Progress · 16/42", note: "A bar appears because the tool reported 16 completed out of 42.", events: [
    {type:"tool_progress",call_id:"test-1",name:"bash",message:"Checking chart render 16 of 42",progress:16,total:42}] },
  { label: "Progress · 36/42", note: "The same live row updates in place.", events: [
    {type:"tool_progress",call_id:"test-1",name:"bash",message:"Checking chart render 36 of 42",progress:36,total:42}] },
  { label: "A check fails", note: "A red mark and issue count identify the failed call. Open it for the result.", events: [
    {type:"tool_result",call_id:"test-1",name:"bash",output:"41 passed, 1 failed: monthly chart bars have zero computed height",is_error:true}] },
  { label: "Edit needs approval", note: "The proposed file change is shown separately, where you can approve or deny it.", events: [
    {type:"tool_call",call_id:"edit-1",name:"edit_file",args:{path:"reports/sales/index.html",old_string:".monthly-chart { display: flex; }",new_string:".monthly-chart { display: flex; height: 220px; }"},summary:"reports/sales/index.html"},
    {type:"permission_request",id:"approval-1",call_id:"edit-1",name:"edit_file",summary:"reports/sales/index.html",args:{path:"reports/sales/index.html",old_string:".monthly-chart { display: flex; }",new_string:".monthly-chart { display: flex; height: 220px; }"},
      diff:"--- a/reports/sales/index.html\\n+++ b/reports/sales/index.html\\n@@ -72 +72 @@\\n-.monthly-chart { display: flex; }\\n+.monthly-chart { display: flex; height: 220px; }\\n",choices:["once","deny"]}] }
];
const frame = document.getElementById("panel"), phase = document.getElementById("phase"), note = document.getElementById("note");
let index = -1, ready = false, playing = false, timer = 0;
function send(event) { frame.contentWindow?.postMessage({previewEvent:event}, "*"); }
function next() {
  if (!ready || index >= phases.length - 1) return;
  const item = phases[++index]; phase.textContent = item.label; note.textContent = item.note;
  for (const event of item.events) send(event);
  document.getElementById("step").disabled = index === phases.length - 1;
  if (index === phases.length - 1) { playing = false; document.getElementById("play").textContent = "Play sequence"; }
}
function reset() { clearTimeout(timer); playing = false; ready = false; index = -1;
  phase.textContent = "Ready"; note.textContent = "Press Play sequence or Next event.";
  document.getElementById("step").disabled = false; document.getElementById("play").textContent = "Play sequence";
  frame.src = "panel.html?reset=" + Date.now(); }
function tick() { if (!playing || !ready) return; next(); if (index < phases.length - 1) timer = setTimeout(tick, 1100); }
document.getElementById("reset").onclick = reset;
document.getElementById("step").onclick = next;
document.getElementById("play").onclick = () => { if (playing) { playing = false; clearTimeout(timer); document.getElementById("play").textContent = "Play sequence"; return; }
  if (index >= phases.length - 1) reset(); playing = true; document.getElementById("play").textContent = "Pause"; if (ready) tick(); };
document.getElementById("width").onclick = () => { const narrow = document.getElementById("editor").classList.toggle("narrow");
  document.getElementById("width").textContent = narrow ? "Wide editor" : "Narrow editor"; };
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.kind === "dgc-preview-ready") { ready = true; if (playing) tick(); }
  if (event.data?.kind === "dgc-response" && event.data.message?.type === "permission_response") {
    const answer = event.data.message;
    send({type:"permission_resolved",id:"approval-1",decision:answer.decision,message:answer.decision === "deny" ? "Denied for this run" : "Approved for this run"});
    if (answer.decision === "deny") send({type:"tool_denied",call_id:"edit-1",name:"edit_file",reason:"The proposed edit was denied"});
    else send({type:"tool_result",call_id:"edit-1",name:"edit_file",output:"Updated reports/sales/index.html",is_error:false});
    send({type:"text_delta",text:answer.decision === "deny" ? "I left the report unchanged because the edit was denied." : "The chart container now has a definite height. Re-run the visual check before using this report."});
    send({type:"stream_end",phase:"answer"});
    send({type:"turn_end",turn_id:"sample-turn",reason:"completed"});
    phase.textContent = answer.decision === "deny" ? "Edit denied" : "Edit approved";
    note.textContent = "This is sample event playback. No file was edited or test run.";
  }
});
</script></body></html>`;
writeFileSync(resolve(output, "index.html"), page);
console.log(output);
