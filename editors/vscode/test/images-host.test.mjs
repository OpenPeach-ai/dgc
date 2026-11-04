// The extension host's half of Settings -> Models -> Images (0.51, src/panel.ts and src/imagesCommands.ts): Settings'
// images_* commands reach DGC checked (only declared fields; a key only with set_key, and nothing beside it), each
// answered to the page by its token; an older CLI is refused and shows no Images; a chat asks once at its handshake so
// its backend says when its model made a picture (images_made), which Settings and the Library hear; and a ComfyUI
// workflow is read only from the file the user picks.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { cleanup, extensionRoot, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

const generated = await build({ entryPoints: [extensionRoot + "/src/protocol.generated.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const protocol = { exports: {} };
new Function("module", "exports", generated.outputFiles[0].text)(protocol, protocol.exports);
const { dgcCommandError } = protocol.exports;
const commands = await build({ entryPoints: [extensionRoot + "/src/imagesCommands.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const checked = { exports: {} };
new Function("module", "exports", commands.outputFiles[0].text)(checked, checked.exports);
const { imagesCommand } = checked.exports;

const IMAGES = { images: { version: 1, commands: ["images_list", "images_update", "images_generate", "images_library"], generators: 2 } };
const STATUS = { generators: [{ id: "fal", name: "fal FLUX schnell", provider: "fal", has_key: true, key_from: "saved" }], default: "fal",
  auto_fallback: false, save_dir: "assets/generated", project_choice: "", chosen: "", through_plugins: ["Runway", "Higgsfield"] };

function withSettings(provider) {
  const page = [];
  provider.settingsEditor = { webview: { postMessage: (m) => { page.push(m); return Promise.resolve(true); } } };
  return page;
}

test("each Settings command is one images_* command the protocol accepts, with nothing it didn't declare", () => {
  const workflow = { 6: { class_type: "CLIPTextEncode", inputs: { text: "a fox" } } };
  const cases = [
    [{ type: "images_list" }, { type: "images_list" }],
    [{ type: "images_list", refresh: true, extra: 1 }, { type: "images_list", refresh: true }],
    [{ type: "images_update", action: "add_generator", provider: "fal", model: "fal-ai/flux/dev", key: "sk-1" },
     { type: "images_update", action: "add_generator", provider: "fal", model: "fal-ai/flux/dev" }],
    [{ type: "images_update", action: "add_generator", provider: "comfyui", base_url: "gpu-box.local:8188", workflow, mapping: { prompt: "6.text", seed: "3.seed", evil: "x.y", width: "not a target" } },
     { type: "images_update", action: "add_generator", provider: "comfyui", base_url: "gpu-box.local:8188", workflow, mapping: { prompt: "6.text", seed: "3.seed" } }],
    [{ type: "images_update", action: "add_generator", provider: "comfyui", workflow, confirm: true },
     { type: "images_update", action: "add_generator", provider: "comfyui", workflow, confirm: true }],
    [{ type: "images_update", action: "set_key", generator: "fal", key: "sk-1", name: "x" }, { type: "images_update", action: "set_key", generator: "fal", key: "sk-1" }],
    [{ type: "images_update", action: "set_key", generator: "fal", key: "" }, { type: "images_update", action: "set_key", generator: "fal", key: "" }],
    [{ type: "images_update", action: "edit_generator", generator: "fal", asks: false, monthly_limit_usd: -1, system: "" },
     { type: "images_update", action: "edit_generator", generator: "fal", asks: false, monthly_limit_usd: -1, system: "" }],
    [{ type: "images_update", action: "remove_generator", generator: "fal" }, { type: "images_update", action: "remove_generator", generator: "fal" }],
    [{ type: "images_update", action: "set_default", generator: "" }, { type: "images_update", action: "set_default", generator: "" }],
    [{ type: "images_update", action: "set_project_choice", generator: "fal" }, { type: "images_update", action: "set_project_choice", generator: "fal" }],
    [{ type: "images_update", action: "set_auto_fallback", auto_fallback: true }, { type: "images_update", action: "set_auto_fallback", auto_fallback: true }],
    [{ type: "images_update", action: "set_save_dir", save_dir: "art/made" }, { type: "images_update", action: "set_save_dir", save_dir: "art/made" }],
    [{ type: "images_update", action: "test" }, { type: "images_update", action: "test" }],
    [{ type: "images_library", surface: "work", limit: 60, offset: 0, query: "fox" }, { type: "images_library", surface: "work", limit: 60, offset: 0, query: "fox" }],
  ];
  for (const [raw, want] of cases) {
    const got = imagesCommand(raw);
    assert.deepEqual(got, want, JSON.stringify(raw));
    assert.equal(dgcCommandError({ ...got, request_id: "images-1" }), undefined, JSON.stringify(got));
  }
  for (const bad of [{ type: "images_update", action: "drop_tables" }, { type: "images_update", action: "set_key", generator: "fal" },
    { type: "images_update", action: "set_key", key: "k" }, { type: "images_update", action: "remove_generator" },
    { type: "images_update", action: "add_generator", provider: "midjourney" }, { type: "images_update", action: "set_auto_fallback" },
    { type: "images_generate", prompt: "x" }, { type: "set_config" }, null]) assert.equal(imagesCommand(bad), undefined, JSON.stringify(bad));
});

test("Settings' command goes to DGC and the answer comes back to the page by its token; a key never comes back", async () => {
  const { provider, backend } = makeProvider({ capabilities: IMAGES });
  const page = withSettings(provider);
  backend.request = (command, type) => { backend.sent.push(command); return Promise.resolve({ type, request_id: command.request_id, status: STATUS,
    change: "Saved the key for fal FLUX schnell", tested: { fal: { ok: true } } }); };
  await provider.onSettingsMessage({ type: "imagesCommand", token: "images-4", command: { type: "images_update", action: "set_key", generator: "fal", key: "fal-secret" } });
  const sent = backend.sent.at(-1);
  assert.equal(sent.type, "images_update");
  assert.equal(sent.key, "fal-secret", "the key goes to DGC once");
  assert.match(sent.request_id, /^images-/);
  const reply = page.find((m) => m.type === "imagesReply");
  assert.deepEqual({ ...reply }, { type: "imagesReply", token: "images-4", ok: true, status: STATUS, change: "Saved the key for fal FLUX schnell", tested: { fal: { ok: true } } });
  assert.doesNotMatch(JSON.stringify(page), /fal-secret/, "and never comes back to the page");
});

test("a workflow's mapping to confirm reaches the page; a refusal, a wrong command and an older CLI are said", async () => {
  const { provider, backend } = makeProvider({ capabilities: IMAGES });
  const page = withSettings(provider);
  const pending = { generator: { name: "ComfyUI" }, mapping: { prompt: "6.text" }, mapping_lines: ["Prompt → node 6 (CLIPTextEncode).text"], notes: ["no SaveImage node"] };
  backend.request = (command, type) => Promise.resolve({ type, request_id: command.request_id, status: STATUS, pending, notes: pending.notes });
  await provider.onSettingsMessage({ type: "imagesCommand", token: "t0", command: { type: "images_update", action: "add_generator", provider: "comfyui", workflow: { 6: {} } } });
  assert.deepEqual(page.at(-1).pending, pending);
  backend.request = () => Promise.reject(new Error("there is no image generator 'mac'"));
  await provider.onSettingsMessage({ type: "imagesCommand", token: "t1", command: { type: "images_update", action: "remove_generator", generator: "mac" } });
  assert.deepEqual(page.at(-1), { type: "imagesReply", token: "t1", ok: false, error: "there is no image generator 'mac'" });
  await provider.onSettingsMessage({ type: "imagesCommand", token: "t2", command: { type: "images_update", action: "explode" } });
  assert.deepEqual(page.at(-1), { type: "imagesReply", token: "t2", ok: false, error: "That isn't an image generator change." });
  const older = makeProvider({ capabilities: {} });
  const olderPage = withSettings(older.provider);
  await older.provider.onSettingsMessage({ type: "imagesCommand", token: "t3", command: { type: "images_list" } });
  assert.deepEqual(olderPage.at(-1), { type: "imagesReply", token: "t3", ok: false, error: "Update the DGC CLI to make images." });
  assert.deepEqual(older.backend.sent, []);
});

test("Settings is told whether this CLI makes images; a chat asks once at its handshake so it hears images_made", () => {
  for (const [caps, capable] of [[IMAGES, true], [{}, false]]) {
    const { provider, backend } = makeProvider({ capabilities: caps });
    const page = withSettings(provider);
    provider.onEvent({ type: "config", model: "m", base_url: "http://localhost:11434/v1" });
    assert.equal(page.find((m) => m.type === "event" && m.event.type === "config").event.images_capable, capable, JSON.stringify(caps));
    provider.finishSessionHandshake(backend);
    assert.equal(backend.sent.some((c) => c.type === "images_list"), capable, "asked once, and only of a CLI that makes images");
    if (capable) assert.equal(dgcCommandError(backend.sent.find((c) => c.type === "images_list")), undefined);
  }
});

test("a picture a chat's model made: Settings reads its list again, and an open Library lists it", () => {
  const { provider } = makeProvider({ capabilities: IMAGES });
  const page = withSettings(provider);
  let library = 0;
  provider.chatdgc = { imagesMade() { library++; } };
  provider.onEvent({ type: "images_made", call_id: "g1", images: [{ path: "/home/me/app/assets/generated/fox.png" }], generator: "comfy" });
  assert.deepEqual(page.filter((m) => m.type === "imagesMade"), [{ type: "imagesMade" }]);
  assert.equal(library, 1);
});

test("a ComfyUI workflow is read only from the file the user picks, and only a workflow's size", async () => {
  const vscode = globalThis.__DGC_TEST_VSCODE;
  const before = { dialog: vscode.window.showOpenDialog, fs: vscode.workspace.fs };
  const { provider } = makeProvider({ capabilities: IMAGES });
  const page = withSettings(provider);
  const read = [];
  try {
    vscode.window.showOpenDialog = async () => undefined;
    vscode.workspace.fs = { stat: async () => ({ size: 120 }), readFile: async (uri) => { read.push(uri.path); return new TextEncoder().encode('{"6": {}}'); } };
    await provider.onSettingsMessage({ type: "imagesPickWorkflow", token: "w1" });
    assert.deepEqual(page.at(-1), { type: "imagesWorkflow", token: "w1", cancelled: true });
    assert.deepEqual(read, [], "nothing read without a choice");
    vscode.window.showOpenDialog = async () => [{ path: "/home/me/flows/portrait_api.json", fsPath: "/home/me/flows/portrait_api.json" }];
    await provider.onSettingsMessage({ type: "imagesPickWorkflow", token: "w2" });
    assert.deepEqual(page.at(-1), { type: "imagesWorkflow", token: "w2", text: '{"6": {}}', name: "portrait_api.json" });
    vscode.workspace.fs = { stat: async () => ({ size: 50_000_000 }), readFile: async () => { throw new Error("read"); } };
    await provider.onSettingsMessage({ type: "imagesPickWorkflow", token: "w3" });
    assert.match(page.at(-1).error, /too large/);
  } finally {
    vscode.window.showOpenDialog = before.dialog;
    vscode.workspace.fs = before.fs;
  }
});
