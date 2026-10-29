// The extension host's half of the user's mods (src/panel.ts, src/chatdgc.ts): a page's request becomes exactly one
// backend command the protocol accepts, only for a CLI that offers mods (and offers the question about written mods),
// with the page's own request id; ChatDGC's carry surface "chat"; anything malformed is dropped; one that can't be
// sent is answered at once as the backend would refuse it. ChatDGC's frames (surface "chat", or answers to its
// request ids) go to its tabs, never Work's transcript. Settings' Mods section asks the same backend.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, extensionRoot, makeProvider } from "./support/panel-bundle.mjs";
import { build } from "esbuild";

after(cleanup);

const generated = await build({ entryPoints: [extensionRoot + "/src/protocol.generated.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const protocol = { exports: {} };
new Function("module", "exports", generated.outputFiles[0].text)(protocol, protocol.exports);
const { dgcCommandError } = protocol.exports;

const MODS = { mods: { version: 1, offers: 1 } };

test("Settings forwards the shown permission review only to a CLI that supports it", async () => {
  const review = "b".repeat(64);
  for (const enabled of [false, true]) {
    const { provider, backend } = makeProvider({ capabilities: { mods: { version: 1, consent_reviews: enabled ? 1 : 0 } } });
    await provider.onSettingsMessage({ type: "modSet", name: "guard", op: "allow", review });
    assert.equal(backend.sent.at(-1).review, enabled ? review : undefined);
    assert.equal(dgcCommandError(backend.sent.at(-1)), undefined);
  }
});

test("permission reviews are forwarded for Work and Chat only when the CLI offers them", () => {
  const review = "a".repeat(64);
  for (const surface of ["work", "chat"]) {
    for (const enabled of [false, true]) {
      const { provider, backend } = makeProvider({ capabilities: { mods: { version: 1, consent_reviews: enabled ? 1 : 0 } } });
      const request_id = surface === "chat" ? "chatdgc-mods-review" : "wmods-review";
      provider.modsCommand({ op: "set", action: "allow", request_id, name: "guard", review }, surface);
      const command = backend.sent.at(-1);
      assert.equal(command.type, "mod_set");
      assert.equal(command.review, enabled ? review : undefined);
      assert.equal(dgcCommandError(command), undefined);
    }
  }
});

test("each request a page makes is one command the backend accepts, with the page's own request id", () => {
  const { provider, backend } = makeProvider({ capabilities: MODS });
  const ask = (msg) => provider.onMessage({ type: "mods", ...msg });
  ask({ op: "list", request_id: "wmods-a-1" });
  ask({ op: "watch" });
  ask({ op: "set", request_id: "wmods-a-2", name: "guard", action: "allow" });
  ask({ op: "command", request_id: "wmods-a-3", name: "tally", args: "by tool" });
  ask({ op: "action", name: "tally", id: "reset", value: "x" });
  ask({ op: "offer", request_id: "wmods-a-4", id: "mo_0123456789abcdef", allow: true });
  assert.deepEqual(backend.sent, [
    { type: "mods_list", request_id: "wmods-a-1" },
    { type: "watch_mod_offers" },
    { type: "mod_set", request_id: "wmods-a-2", name: "guard", op: "allow" },
    { type: "mod_command", request_id: "wmods-a-3", name: "tally", args: "by tool" },
    { type: "mod_action", name: "tally", id: "reset", value: "x" },
    { type: "mod_offer_answer", request_id: "wmods-a-4", id: "mo_0123456789abcdef", allow: true },
  ]);
  for (const command of backend.sent) assert.equal(dgcCommandError(command), undefined, JSON.stringify(command));
});

test("nothing malformed, nothing to an older CLI, and no question asked of one that never offered it", () => {
  const { provider, backend } = makeProvider({ capabilities: MODS });
  const ask = (msg) => provider.onMessage({ type: "mods", ...msg });
  ask({ op: "set", request_id: "wmods-1", name: "guard", action: "approve" });
  ask({ op: "set", request_id: "chatdgc-mods-1", name: "guard", action: "allow" });       // not this page's id
  ask({ op: "command", request_id: "wmods-2", name: "Tally!" });
  ask({ op: "action", name: "../x", id: "reset" });
  ask({ op: "action", name: "tally", id: "a b" });
  ask({ op: "offer", request_id: "wmods-3", id: "nope", allow: true });
  ask({ op: "launch" });
  assert.deepEqual(backend.sent, []);
  const old = makeProvider({ capabilities: {} });
  old.provider.onMessage({ type: "mods", op: "list", request_id: "wmods-1" });
  assert.deepEqual(old.backend.sent, []);
  const noOffers = makeProvider({ capabilities: { mods: { version: 1 } } });
  noOffers.provider.onMessage({ type: "mods", op: "watch" });
  noOffers.provider.onMessage({ type: "mods", op: "offer", request_id: "wmods-1", id: "mo_0123456789abcdef", allow: false });
  assert.deepEqual(noOffers.backend.sent, []);
});

test("a request that can't reach the backend is answered at once, so its card says so", () => {
  const { provider, backend, posted } = makeProvider({ capabilities: MODS });
  backend.send = () => false;
  provider.onMessage({ type: "mods", op: "command", request_id: "wmods-9", name: "tally" });
  const refused = posted.find((m) => m.type === "event")?.event;
  assert.equal(refused.type, "command_rejected");
  assert.equal(refused.request_id, "wmods-9");
  assert.match(refused.message, /isn't connected/);
});

test("ChatDGC's requests carry surface chat, and its frames go to its tabs, never Work's transcript", () => {
  const { provider, backend, posted } = makeProvider({ capabilities: { ...MODS, chatdgc: { version: 1 } } });
  const tabs = [];
  provider.chatdgc = { onModsEvent: (ev) => tabs.push(ev), onEvent: () => {} };
  provider.modsCommand({ op: "command", request_id: "chatdgc-mods-1", name: "tally" }, "chat");
  assert.deepEqual(backend.sent.at(-1), { type: "mod_command", request_id: "chatdgc-mods-1", name: "tally", surface: "chat" });
  assert.equal(dgcCommandError(backend.sent.at(-1)), undefined);
  const slot = { id: "s1" };
  provider.activeSlotId = "s1";
  const work = [];
  provider.onEvent = (ev) => work.push(ev);
  for (const ev of [{ type: "mods", mods: [], on: true, surface: "chat" }, { type: "mod_ui", name: "t", mod: "T", slot: "status", tree: null, surface: "chat" },
                    { type: "mod_result", request_id: "chatdgc-mods-1", name: "tally", mod: "Tally", text: "3" },
                    { type: "command_rejected", command: "mod_command", request_id: "chatdgc-mods-2", message: "no" },
                    { type: "mod_offer", id: "mo_1", name: "c", mod: "C", version: "1.0.0", folder: "m", asks: [], more: false, surface: "chat" }]) {
    provider.routeEvent(slot, { seq: 1, ...ev });
  }
  assert.deepEqual(tabs.map((ev) => ev.type), ["mods", "mod_ui", "mod_result", "command_rejected", "mod_offer"]);
  assert.deepEqual(work, []);
  provider.routeEvent(slot, { seq: 2, type: "mods", mods: [], on: true });
  provider.routeEvent(slot, { seq: 3, type: "mod_result", request_id: "wmods-1", name: "tally", mod: "Tally" });
  assert.deepEqual(work.map((ev) => ev.type), ["mods", "mod_result"], "Work's own stay Work's");
});

test("Settings' Mods section asks the active chat's backend, and hears its list as it changes", async () => {
  const { provider, backend } = makeProvider({ capabilities: MODS });
  const toSettings = [];
  provider.settingsEditor = { webview: { postMessage: (m) => toSettings.push(m) } };
  await provider.onSettingsMessage({ type: "modsList" });
  await provider.onSettingsMessage({ type: "modSet", name: "guard", op: "off" });
  await provider.onSettingsMessage({ type: "modSet", name: "guard", op: "delete" });
  assert.deepEqual(backend.sent.map((c) => [c.type, c.name, c.op]), [["mods_list", undefined, undefined], ["mod_set", "guard", "off"]]);
  assert.ok(backend.sent.every((c) => /^settings-mods-/.test(c.request_id)));
  const old = makeProvider({ capabilities: {} });
  const said = [];
  old.provider.settingsEditor = { webview: { postMessage: (m) => said.push(m) } };
  await old.provider.onSettingsMessage({ type: "modsList" });
  assert.deepEqual(said, [{ type: "mods", unsupported: true }]);
  assert.deepEqual(old.backend.sent, []);
  provider.onEvent({ seq: 1, type: "mods", mods: [{ name: "guard", state: "off" }], on: true });
  provider.onEvent({ seq: 2, type: "mods", mods: [{ name: "tally" }], on: true, surface: "chat" });
  assert.deepEqual(toSettings.filter((m) => m.type === "mods"), [{ type: "mods", mods: [{ name: "guard", state: "off" }], on: true }],
                   "this chat's list, as it changes; never ChatDGC's");
  provider.onEvent({ seq: 3, type: "command_rejected", command: "mod_set", request_id: backend.sent[1].request_id, message: "Allow guard first." });
  assert.deepEqual(toSettings.at(-1), { type: "modsError", message: "Allow guard first." });
});
