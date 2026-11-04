// The extension host's half of DGC Router (0.51, src/panel.ts and src/routerCommands.ts): Settings' router_* commands
// reach DGC checked (only declared fields; a key only with set_key), each answered to the page by its token; router
// status from any chat moves the status line's `Router 9/11` and Settings; and a chat asks once at its handshake so
// it hears router_changed (the agent map's "on <system>"). Plus a plugin sign-in whose browser is on another computer:
// a code on another device offered in a remote window, and "Signed in but nothing happened?" handing the address the
// browser ended on to the sign-in still waiting here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { cleanup, extensionRoot, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

const generated = await build({ entryPoints: [extensionRoot + "/src/protocol.generated.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const protocol = { exports: {} };
new Function("module", "exports", generated.outputFiles[0].text)(protocol, protocol.exports);
const { dgcCommandError } = protocol.exports;
const commands = await build({ entryPoints: [extensionRoot + "/src/routerCommands.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const checked = { exports: {} };
new Function("module", "exports", commands.outputFiles[0].text)(checked, checked.exports);
const { routerCommand } = checked.exports;

const ROUTER = { router: { version: 1, commands: ["router_status", "router_update", "router_probe", "router_find", "router_hardware", "router_suggest"], enabled: true, pips_default: 1, status: 2 } };
const STATUS = { enabled: true, when_busy: "wait", workers: { total: 11, free: 9, busy: 2 }, systems: [
  { id: "gpu", name: "GPU box", enabled: true, health: { state: "online" }, leases: [{ owner: "agent-3", model: "qwen3:8b" }] },
  { id: "nas", name: "NAS", enabled: true, health: { state: "offline" }, leases: [] }] };

function withSettings(provider) {
  const page = [];
  provider.settingsEditor = { webview: { postMessage: (m) => { page.push(m); return Promise.resolve(true); } } };
  return page;
}

test("each Settings command is one router_* command the protocol accepts, with nothing it didn't declare", () => {
  const cases = [
    [{ type: "router_status" }, { type: "router_status" }],
    [{ type: "router_update", action: "turn_on", extra: 1 }, { type: "router_update", action: "turn_on" }],
    [{ type: "router_update", action: "add_system", base_url: "gpu-box.local", name: "GPU box" },
     { type: "router_update", action: "add_system", base_url: "gpu-box.local", name: "GPU box" }],
    [{ type: "router_update", action: "set_model", system: "gpu", model: "qwen3:8b", workers: 2, context: 32768, use: true, note: "small" },
     { type: "router_update", action: "set_model", system: "gpu", model: "qwen3:8b", workers: 2, context: 32768, use: true, note: "small" }],
    [{ type: "router_update", action: "set_key", system: "gpu", key: "sk-1" }, { type: "router_update", action: "set_key", system: "gpu", key: "sk-1" }],
    [{ type: "router_update", action: "edit_system", system: "gpu", key: "sk-1", workers: 3 },
     { type: "router_update", action: "edit_system", system: "gpu", workers: 3 }],
    [{ type: "router_probe", system: "gpu", checks: ["models", "bogus"] }, { type: "router_probe", system: "gpu", checks: ["models"] }],
    [{ type: "router_hardware", system: "gpu", url: "http://gpu-box.local:8577", token: "t" },
     { type: "router_hardware", system: "gpu", url: "http://gpu-box.local:8577", token: "t" }],
    [{ type: "router_suggest", system: "gpu" }, { type: "router_suggest", system: "gpu" }],
    [{ type: "router_find" }, { type: "router_find" }],
  ];
  for (const [raw, want] of cases) {
    const got = routerCommand(raw);
    assert.deepEqual(got, want, JSON.stringify(raw));
    assert.equal(dgcCommandError({ ...got, request_id: "router-1" }), undefined, JSON.stringify(got));
  }
  for (const bad of [{ type: "router_update", action: "drop_tables" }, { type: "router_update", action: "set_key", system: "gpu" },
    { type: "router_update", action: "remove_system" }, { type: "router_update", action: "add_system" }, { type: "router_probe" },
    { type: "set_config" }, null]) assert.equal(routerCommand(bad), undefined, JSON.stringify(bad));
});

test("Settings' command goes to DGC and the answer comes back to the page by its token", async () => {
  const { provider, backend } = makeProvider({ capabilities: ROUTER });
  const page = withSettings(provider);
  backend.request = (command, type) => { backend.sent.push(command); return Promise.resolve({ type, request_id: command.request_id, status: STATUS, change: "Saved the key for GPU box" }); };
  await provider.onSettingsMessage({ type: "routerCommand", token: "router-7", command: { type: "router_update", action: "set_key", system: "gpu", key: "sk-secret" } });
  const sent = backend.sent.at(-1);
  assert.equal(sent.type, "router_update");
  assert.equal(sent.key, "sk-secret", "the key goes to DGC once");
  assert.match(sent.request_id, /^router-/);
  const reply = page.find((m) => m.type === "routerReply");
  assert.deepEqual({ ...reply }, { type: "routerReply", token: "router-7", ok: true, status: STATUS, change: "Saved the key for GPU box" });
  assert.doesNotMatch(JSON.stringify(page), /sk-secret/, "and never comes back to the page");
  assert.ok(page.some((m) => m.type === "routerStatus"), "the page's list follows the answer's status");
});

test("a refused change and an older CLI are said on the page", async () => {
  const { provider, backend } = makeProvider({ capabilities: ROUTER });
  const page = withSettings(provider);
  backend.request = () => Promise.reject(new Error("there is no system 'mac'"));
  await provider.onSettingsMessage({ type: "routerCommand", token: "t1", command: { type: "router_update", action: "remove_system", system: "mac" } });
  assert.deepEqual(page.at(-1), { type: "routerReply", token: "t1", ok: false, error: "there is no system 'mac'" });
  await provider.onSettingsMessage({ type: "routerCommand", token: "t2", command: { type: "router_update", action: "explode" } });
  assert.deepEqual(page.at(-1), { type: "routerReply", token: "t2", ok: false, error: "That isn't a DGC Router change." });
  const older = makeProvider({ capabilities: {} });
  const olderPage = withSettings(older.provider);
  await older.provider.onSettingsMessage({ type: "routerCommand", token: "t3", command: { type: "router_status" } });
  assert.deepEqual(olderPage.at(-1), { type: "routerReply", token: "t3", ok: false, error: "Update the DGC CLI to use DGC Router." });
  assert.deepEqual(older.backend.sent, []);
});

test("the status line says Router free/total while it is on, opens Settings at DGC Router, and goes when it is off", () => {
  const { provider } = makeProvider({ capabilities: ROUTER });
  const page = withSettings(provider);
  let shown = null;
  provider.context.subscriptions = [];
  provider.noteRouterStatus(STATUS);
  shown = provider.routerSb;
  assert.equal(shown.text, "$(server-environment) Router 9/11");
  assert.equal(shown.command, "dgc.routerSettings");
  assert.match(shown.tooltip, /9 of 11 workers free on 2 systems \(1 offline\)/);
  assert.deepEqual(page.at(-1), { type: "routerStatus", status: STATUS });
  let hidden = false;
  shown.hide = () => { hidden = true; };
  provider.noteRouterStatus({ ...STATUS, enabled: false });
  assert.equal(hidden, true);
});

test("a router event from the backend reaches the status line, Settings and the chat (for the agent map)", () => {
  const { provider, posted } = makeProvider({ capabilities: ROUTER });
  const page = withSettings(provider);
  provider.onEvent({ type: "router_changed", status: STATUS, why: "leased" });
  assert.ok(page.some((m) => m.type === "routerStatus"));
  assert.ok(posted.some((m) => m.type === "event" && m.event.type === "router_changed"), "the chat webview hears it");
});

test("a chat asks for the Router's status once at its handshake, so it hears router_changed; an older CLI is never asked", () => {
  for (const [caps, asked] of [[ROUTER, true], [{}, false]]) {
    const { provider, backend } = makeProvider({ capabilities: caps });
    provider.finishSessionHandshake(backend);
    assert.equal(backend.sent.some((c) => c.type === "router_status"), asked, JSON.stringify(caps));
  }
});

test("Settings -> agents and router open Models at their place", () => {
  const { provider } = makeProvider({ capabilities: ROUTER });
  let opened = "";
  provider.openEditorSettings = (section) => { opened = section; };
  provider.openSettings("router");
  assert.equal(opened, "router");
});

// ---- sign-in when the browser is on another computer ----
function listener() {
  return new Promise((resolve) => {
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url);
      const ok = new URL(req.url, "http://x").searchParams.get("state") === "s1";
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" });
      res.end(ok ? "<p>DGC is signed in. You can close this tab.</p>" : "<p>This sign-in link doesn't match the one DGC opened.</p>");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, hits, port: server.address().port }));
  });
}

test("Signed in but nothing happened: the pasted address goes to the waiting listener, and only that one", async () => {
  const { server, hits, port } = await listener();
  try {
    const { provider } = makeProvider({ capabilities: {} });
    const page = withSettings(provider);
    provider.pendingSignIn = { url: "https://as.example/authorize", callbackUrl: `http://localhost:${port}/oauth/callback` };
    const hand = async (url) => { await provider.onSettingsMessage({ type: "signInReturn", url }); return page.at(-1); };
    assert.deepEqual(await hand(`http://localhost:${port + 1}/oauth/callback?code=c&state=s1`),
      { type: "signInReturned", ok: false, message: `That isn't the address this sign-in returns to. It starts with http://localhost:${port}/oauth/callback.` });
    assert.equal((await hand(`http://localhost:${port}/oauth/callback?foo=1`)).ok, false, "no answer from the service in it");
    assert.equal((await hand(`https://evil.example:${port}/oauth/callback?code=c&state=s1`)).ok, false, "never another host");
    assert.deepEqual(hits, [], "nothing reached the listener yet");
    assert.deepEqual(await hand(`http://localhost:${port}/oauth/callback?code=the-code&state=s1`),
      { type: "signInReturned", ok: true, message: "Handed to DGC. It finishes signing in now." });
    assert.deepEqual(hits, ["/oauth/callback?code=the-code&state=s1"]);
    assert.deepEqual(await hand(`http://127.0.0.1:${port}/oauth/callback?code=x&state=old`),
      { type: "signInReturned", ok: false, message: "This sign-in link doesn't match the one DGC opened." }, "the listener's own words");
    provider.pendingSignIn = undefined;
    assert.equal((await hand(`http://localhost:${port}/oauth/callback?code=c&state=s1`)).message, "No sign-in is waiting now. Choose Connect again.");
  } finally { server.close(); }
});

test("a remote window offers a code on another device where the service takes one; choosing it answers the card so", async () => {
  const vscode = globalThis.__DGC_TEST_VSCODE;
  const asked = [];
  const before = vscode.window.showInformationMessage;
  try {
    for (const [remote, offer, pick, expect] of [
      ["ssh-remote", true, "Sign in with a code on another device", { action: "accept", content: { _dgc_device: true } }],
      ["ssh-remote", true, undefined, { action: "cancel" }],
      ["", true, null, null],                      // here: the browser opens as before, nothing asked
      ["ssh-remote", false, null, null]]) {         // no code offered: nothing asked
      vscode.env.remoteName = remote || undefined;
      vscode.window.showInformationMessage = async (message, options, ...items) => { asked.push({ message, items }); return pick; };
      const { provider, backend } = makeProvider({ capabilities: {} });
      provider.mcpUrls.set("r1", { url: "https://clerk.example/oauth/authorize?redirect_uri=x", callbackUrl: "http://localhost:4567/oauth/callback", ...(offer ? { deviceOffer: true } : {}) });
      const count = asked.length;
      await provider.confirmMcpBrowser("r1", "cardboard");
      if (expect) {
        assert.deepEqual(asked.at(-1).items, ["Open the sign-in page", "Sign in with a code on another device"]);
        const answer = backend.sent.find((c) => c.type === "mcp_input_response");
        assert.deepEqual({ action: answer.action, ...(answer.content ? { content: answer.content } : {}) }, expect);
        assert.equal(dgcCommandError(answer), undefined);
      } else {
        assert.equal(asked.length, count, `${remote || "local"}, offer ${offer}: no question`);
      }
    }
  } finally {
    vscode.window.showInformationMessage = before;
    delete vscode.env.remoteName;
  }
});
