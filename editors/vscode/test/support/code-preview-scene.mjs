// A reply that writes an icon set as two blocks, its demo HTML and its stylesheet, in each of the three chats (Work,
// ChatDGC and a Pip's chat), and the preview tab's own page as src/codePreview.ts writes it. Shared by
// code-preview-browser.test.mjs and render-code-preview.mjs. Not a *.test.mjs file.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The file-kind marks' font, which the panel loads from the extension (media/main.css: url("./seti.woff")); a page
// set from a string has no folder to load it from, so it is given here.
const seti = () => `@font-face { font-family: seti; src: url("data:font/woff;base64,${readFileSync(join(root, "media/seti.woff")).toString("base64")}") format("woff"); }`;

const CUBES = [["Ruby", "ruby"], ["Amber", "amber"], ["Mint", "mint"], ["Sky", "sky"], ["Iris", "iris"], ["Slate", "slate"]];
export const ICONS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cube icon set</title>
<link rel="stylesheet" href="icons.css">
</head>
<body>
<h1>Cube icons</h1>
<ul class="grid">
${CUBES.map(([name, id]) => `  <li><span class="cube cube-${id}"></span><span class="name">${name}</span></li>`).join("\n")}
</ul>
<p class="detail"><span class="cube cube-iris big"></span> 64 px, on a card</p>
</body>
</html>`;
export const ICONS_CSS = `body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; }
h1 { font-size: 18px; margin: 0 0 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 12px; list-style: none; margin: 0; padding: 0; }
.grid li { display: grid; justify-items: center; gap: 8px; padding: 14px 8px; border: 1px solid rgb(128 128 128 / .3); border-radius: 12px; }
.cube { width: 32px; height: 32px; border-radius: 8px; background: var(--c); box-shadow: inset 0 -6px 0 rgb(0 0 0 / .18), inset 0 6px 0 rgb(255 255 255 / .25); }
.cube.big { width: 64px; height: 64px; border-radius: 16px; display: inline-block; vertical-align: middle; margin-right: 12px; animation: bob 2.4s ease-in-out infinite; }
.cube-ruby { --c: #e5484d; } .cube-amber { --c: #f5a524; } .cube-mint { --c: #3dd68c; }
.cube-sky { --c: #3b9eff; } .cube-iris { --c: #8e8cf5; } .cube-slate { --c: #8b8d98; }
.name { font-size: 12px; }
.detail { margin-top: 20px; }
@keyframes bob { 50% { transform: translateY(-6px); } }`;
const fence = (lang, body) => "```" + lang + "\n" + body + "\n```";
/** The reply: a sentence, the demo page, the stylesheet, and a link to an image as a session shows one. */
export const REPLY = `Here is the cube icon set. The demo page:\n\n${fence("html", ICONS_HTML)}\n\nUpdated CSS:\n\n${fence("css", ICONS_CSS)}\n\nA picture of it is in ![the sheet](assets/cubes.png).`;
export const PROMPT = "Make me a small set of cube icons, with a demo page.";

/** Work, in a session tab: the prompt and the finished reply. */
export async function openWork(browser, { width = 700, height = 760, theme = "dark-modern" } = {}) {
  const { openWorkTab } = await import("./work-tab-scene.mjs");
  const { READY } = await import("./dgc-look-scene.mjs");
  const x = await openWorkTab(browser, { width, height, theme });
  const event = (e) => x.send({ type: "event", event: e });
  await x.page.addStyleTag({ content: seti() });
  await x.send({ type: "session_ready", sessionId: "s1" }); await event(READY);
  await x.page.fill("#input", PROMPT); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(60);
  const id = String((await x.posted("prompt")).pop()?.requestId || "");
  await event({ type: "prompt_accepted", request_id: id, state: "started" }); await event({ type: "turn_start", turn_id: "t1", prompt: "" });
  await event({ type: "text_delta", text: REPLY }); await event({ type: "stream_end", message_id: "t1:1", phase: "final_answer" });
  await event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1", elapsed_seconds: 12 });
  await x.page.waitForTimeout(200);
  return { page: x.page, errors: x.errors, posted: () => x.posted("codePreview"), close: () => x.page.close() };
}

/** ChatDGC: the same prompt and reply in a chat. */
export async function openChatDgc(browser, { width = 700, height = 760, theme = "dark-modern" } = {}) {
  const chat = await import("./chat-scene.mjs"), at = "2026-11-12T09:30:00Z";
  const x = await chat.openChat(browser, { width, height, theme });
  await x.page.addStyleTag({ content: seti() });
  await x.send({ type: "opened", conversation: chat.conversation({ title: "Cube icons" }), earlier: 0, busy: false, messages: [
    { id: chat.M(1), role: "user", text: PROMPT, created_at: at },
    { id: chat.M(2), role: "assistant", text: REPLY, created_at: at, finish: "stop", model: "qwen3.8:27b" }] });
  await x.send({ type: "models", ids: ["qwen3.8:27b"], current: "qwen3.8:27b" });
  await x.page.waitForTimeout(200);
  return { page: x.page, errors: x.errors, posted: () => x.posted("codePreview"), close: () => x.page.close() };
}

/** A Pip's chat (in the side bar under 400 px, in its own tab above), its latest reply the icon set. */
export async function openPip(browser, { width = 700, height = 760, theme = "dark-modern" } = {}) {
  const pips = await import("./pip-chat-scene.mjs");
  const x = await pips.openChat(browser, { width, height, theme: theme.startsWith("light") ? "light" : "dark", where: width > 400 ? "tab" : "side", reply: REPLY, replyTo: PROMPT, scale: 2 });
  await x.p.waitForSelector(".code-preview, pre.code");
  await x.p.waitForTimeout(200);
  return { page: x.p, errors: x.errors, close: x.close,
    posted: () => x.p.evaluate(() => (window.__posted || window.__sent || []).filter((m) => m && m.type === "codePreview")) };
}
export const CHATS = { work: openWork, chatdgc: openChatDgc, pip: openPip };

let host;
/** src/codePreview.ts, bundled with no editor behind it: what writes the tab's page. */
export function previewHost() {
  if (host) return host;
  const out = mkdtempSync(join(tmpdir(), "dgc-code-preview-scene-"));
  try {
    const code = buildSync({ entryPoints: [join(root, "src/codePreview.ts")], bundle: true, format: "cjs", platform: "node",
      target: "node18", write: false, external: ["vscode"], logLevel: "silent" }).outputFiles[0].text.replace(/require\("vscode"\)/g, "({})");
    writeFileSync(join(out, "codePreview.cjs"), code);
    host = createRequire(import.meta.url)(join(out, "codePreview.cjs"));
  } finally { rmSync(out, { recursive: true, force: true }); }
  return host;
}
const EDITOR = { dark: ["vscode-dark", "#1f1f1f", "#cccccc", "#2b2b2b", "#0078d4", "#9d9d9d"], light: ["vscode-light", "#ffffff", "#3b3b3b", "#e5e5e5", "#005fb8", "#616161"] };
/** The tab's page in Chromium at `width`, in a dark or light editor. Every request the page makes is counted. */
export async function openTab(browser, { width = 700, height = 620, theme = "dark", view = { kind: "html", title: "Cube icon set", html: ICONS_HTML + "\n", css: [ICONS_CSS + "\n"] } } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [], requests = [], refused = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // `requests`: what set off for the network (it is stopped here, and counted). `refused`: what the page's policy turned
  // away before it could set off; the browser still names it, with why.
  await page.route((url) => !/^(data|about|blob):/.test(String(url)), (route) => { requests.push(route.request().url()); return route.abort(); });
  page.on("requestfailed", (r) => refused.push(`${r.failure()?.errorText} ${r.url()}`));
  const [kind, ground, words, line, focus, muted] = EDITOR[theme];
  // The editor gives a webview its theme as a class on the body and as variables on the root; it does so from outside
  // the page, scripts or no scripts. Here that is written into the markup, since this page can run nothing.
  const doc = previewHost().previewDocument(view).replace("<body", `<body class="${kind}"`)
    .replace("<html", `<html style="--vscode-editor-background:${ground};--vscode-foreground:${words};--vscode-widget-border:${line};--vscode-focusBorder:${focus};--vscode-descriptionForeground:${muted};--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px"`);
  await page.setContent(doc, { waitUntil: "load" });
  await page.waitForTimeout(150);
  return { page, errors, requests, refused, close: () => page.close() };
}
