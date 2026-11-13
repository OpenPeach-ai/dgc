// What is pinned to the dock and each session's colour, as the extension keeps them (src/dock.ts, bundled against a
// stub `vscode`): pins hold in global state across reloads and windows; a Work session and a project's Pip show only in
// the folder they were pinned in; past the most, pinning asks which to take off; deleting a pinned thing takes it off;
// the three Dock settings are read and clamped; a session's colour is one of twelve palettes. (How a palette is given
// out, and a tab's icon, are in session-icons-host.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const settings = {}, asked = [];
let answer, folder = "/home/me/shop", onConfig = [], onWindow = [];
globalThis.__DOCK_VSCODE = {
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }), parse: (text) => ({ toString: () => text, text }) },
  workspace: {
    get workspaceFolders() { return folder ? [{ uri: { fsPath: folder } }] : undefined; },
    getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback), update: async (key, value) => { settings[key] = value; for (const l of onConfig) l({ affectsConfiguration: (name) => `dgc.${key}`.startsWith(name) }); } }),
    onDidChangeConfiguration: (l) => { onConfig.push(l); return { dispose() { onConfig = onConfig.filter((x) => x !== l); } }; },
  },
  window: {
    showQuickPick: async (items, options) => { asked.push({ items, options }); return typeof answer === "function" ? answer(items) : answer; },
    onDidChangeWindowState: (l) => { onWindow.push(l); return { dispose() {} }; },
  },
};
const out = await build({ entryPoints: [root + "src/dock.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__DOCK_VSCODE;" })); } }] });
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, (await import("node:module")).createRequire(import.meta.url));
const { Dock, dockOf, dockSettings, setDockSetting } = mod.exports;

const store = () => { const kept = new Map(); return { globalState: { get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, JSON.parse(JSON.stringify(v))); } }, kept }; };
const S = (c) => `2026110${c}-101500-a1`, CHAT = (c) => "chat_" + c.repeat(32), PIP = (c) => "pip_" + c.repeat(32);
const tick = () => new Promise((done) => setTimeout(done, 5));

test("pins are kept on this computer: a reload, and another window, find them as they were left", async () => {
  const context = store(), dock = new Dock(context);
  assert.deepEqual(dock.state().pins, []);
  assert.equal(await dock.pin({ kind: "work", id: S("1"), title: "Fix the login redirect" }), true);
  await dock.pin({ kind: "chat", id: CHAT("a"), title: "A week in Goa" });
  await dock.pin({ kind: "pip", id: PIP("b"), title: "Mail watch", look: { body: "scout" } });
  await dock.pin({ kind: "artifact", id: "ar_" + "1".repeat(16), title: "Tide pools", sub: "Page · version 1", look: { type: "page" }, ref: { file: "index.html" } });
  assert.deepEqual(dock.state().pins.map((p) => p.key), [`work:${S("1")}`, `chat:${CHAT("a")}`, `pip:${PIP("b")}`, `artifact:ar_${"1".repeat(16)}`]);
  // "A reload": a new Dock over the same global state. "Another window": the same.
  const again = new Dock(context);
  assert.deepEqual(again.state().pins, dock.state().pins);
  assert.deepEqual(again.state().pins[3], { key: `artifact:ar_${"1".repeat(16)}`, kind: "artifact", id: "ar_" + "1".repeat(16), title: "Tide pools", sub: "Page · version 1", look: { type: "page" }, ref: { file: "index.html" } });
  assert.equal("where" in again.state().pins[0], false, "a page is never told a folder's path");
  // Pinning what is pinned changes nothing; unpin and move.
  await dock.pin({ kind: "chat", id: CHAT("a"), title: "A week in Goa" });
  assert.equal(dock.pins().length, 4);
  await dock.move(`pip:${PIP("b")}`, -1);
  assert.deepEqual(dock.pins().map((p) => p.kind), ["work", "pip", "chat", "artifact"]);
  await dock.move(`work:${S("1")}`, -1); await dock.move(`artifact:ar_${"1".repeat(16)}`, 1);
  assert.deepEqual(dock.pins().map((p) => p.kind), ["work", "pip", "chat", "artifact"], "the first cannot move left, nor the last right");
  await dock.unpin(`pip:${PIP("b")}`);
  assert.deepEqual(new Dock(context).pins().map((p) => p.kind), ["work", "chat", "artifact"]);
});

test("a page's messages: ready, pin, toggle, unpin, move, colour, a newer name; anything else is not the dock's", async () => {
  const context = store(), dock = new Dock(context);
  const said = [];
  dock.onChange(() => said.push(dock.state().pins.map((p) => p.title).join(",")));
  let state;
  assert.equal(dock.handle({ type: "dockReady" }, (s) => { state = s; }), true);
  assert.deepEqual([state.type, state.show, state.most, state.size], ["dock", "always", 8, 34], "the defaults: Always, 8 items, 34 px");
  assert.equal(dock.handle({ type: "dockToggle", item: { kind: "work", id: S("1"), title: "One" } }), true); await tick();
  assert.equal(dock.handle({ type: "dockPin", item: { kind: "chat", id: CHAT("a"), title: "Two" } }), true); await tick();
  assert.deepEqual(said, ["One", "One,Two"], "every page is told of a change");
  dock.handle({ type: "dockMove", key: `chat:${CHAT("a")}`, by: -1 }); await tick();
  assert.equal(said.at(-1), "Two,One");
  dock.handle({ type: "dockSeen", items: [{ key: `work:${S("1")}`, title: "One, renamed" }] }); await tick();
  assert.equal(dock.pins()[1].title, "One, renamed");
  dock.handle({ type: "dockToggle", item: { kind: "work", id: S("1"), title: "One" } }); await tick();
  dock.handle({ type: "dockUnpin", key: `chat:${CHAT("a")}` }); await tick();
  assert.deepEqual(dock.pins(), []);
  assert.equal(dock.handle({ type: "sessionsList" }), false);
  assert.equal(dock.handle({ type: "dockPin", item: { kind: "nonsense", id: "x" } }), true); await tick();
  dock.handle({ type: "dockPin", item: { kind: "work", id: "../../etc", title: "x" } }); await tick();
  assert.deepEqual(dock.pins(), [], "what is not a pin is never kept");
});

test("a Work session and a project's Pip show only in their own folder; the rest show in every window", async () => {
  const context = store();
  folder = "/home/me/shop";
  const shop = new Dock(context);
  await shop.pin({ kind: "work", id: S("1"), title: "Shop session" });
  await shop.pin({ kind: "pip", id: PIP("c"), title: "Billing review", scope: "project" });
  await shop.pin({ kind: "pip", id: PIP("d"), title: "Mornings" });
  await shop.pin({ kind: "chat", id: CHAT("a"), title: "Goa" });
  folder = "/home/me/garden";
  const garden = new Dock(context);
  assert.deepEqual(garden.pins().map((p) => p.title), ["Mornings", "Goa"], "another folder's window: the Personal Pip and the chat");
  await garden.pin({ kind: "work", id: S("2"), title: "Garden session" });
  assert.deepEqual(garden.pins().map((p) => p.title), ["Mornings", "Goa", "Garden session"]);
  await garden.move(`work:${S("2")}`, -1);
  assert.deepEqual(garden.pins().map((p) => p.title), ["Mornings", "Garden session", "Goa"]);
  folder = "/home/me/shop";
  assert.deepEqual(new Dock(context).pins().map((p) => p.title), ["Shop session", "Billing review", "Mornings", "Goa"], "and the shop's are as they were, in order");
});

test("past the most, pinning asks which item to take off; Escape leaves the dock as it was", async () => {
  const context = store(), dock = new Dock(context);
  folder = "/home/me/shop"; settings["dock.mostItems"] = 3; asked.length = 0;
  for (const c of ["1", "2", "3"]) await dock.pin({ kind: "work", id: S(c), title: `Session ${c}` });
  assert.equal(asked.length, 0, "up to the most, nothing is asked");
  answer = undefined;
  assert.equal(await dock.pin({ kind: "chat", id: CHAT("a"), title: "Goa" }), false);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].items.map((i) => [i.label, i.description]), [["Session 1", "Work session"], ["Session 2", "Work session"], ["Session 3", "Work session"]]);
  assert.match(asked[0].options.title, /^The dock holds 3$/);
  assert.match(asked[0].options.placeHolder, /Pick one to take off, to make room for “Goa”/);
  assert.deepEqual(dock.pins().map((p) => p.title), ["Session 1", "Session 2", "Session 3"], "Escape: nothing changes");
  answer = (items) => items[1];
  assert.equal(await dock.pin({ kind: "chat", id: CHAT("a"), title: "Goa" }), true);
  assert.deepEqual(dock.pins().map((p) => p.title), ["Session 1", "Session 3", "Goa"], "the one picked goes; the new one is last");
  delete settings["dock.mostItems"];
});

test("deleting a pinned session or chat takes it off the dock, and its colour goes with it", async () => {
  const context = store(), dock = new Dock(context);
  await dock.pin({ kind: "work", id: S("1"), title: "One" }); await dock.pin({ kind: "chat", id: CHAT("a"), title: "Two" });
  await dock.setColour(`work:${S("1")}`, "rose");
  assert.equal(dock.colour("work", S("1")), "rose");
  let changes = 0; dock.onChange(() => changes++);
  await dock.forget("work", S("1"));
  assert.deepEqual(dock.pins().map((p) => p.title), ["Two"]);
  assert.equal(`work:${S("1")}` in dock.colours(), false);
  assert.ok(changes >= 1, "and the pages are told");
  await dock.forget("chat", CHAT("z"));
  assert.deepEqual(dock.pins().map((p) => p.title), ["Two"], "something never pinned: nothing changes");
});

test("a session's colour: one of twelve palettes, kept with the session's id; anything else changes nothing", async () => {
  const context = store(), dock = new Dock(context), key = `chat:${CHAT("a")}`;
  assert.equal(key in dock.colours(), false);
  dock.handle({ type: "dockColour", key, colour: "iris" }); await tick();
  assert.equal(new Dock(context).colour("chat", CHAT("a")), "iris", "kept across a reload");
  assert.deepEqual(dock.state().colours, { [key]: "iris" });
  for (const bad of ["citron", "lime", 0, 3, "Iris", "", undefined, null]) { await dock.setColour(key, bad); assert.equal(dock.colour("chat", CHAT("a")), "iris", `${bad} is not one of the twelve: nothing changes`); }
  await dock.setColour("pip:x", "rose"); await dock.setColour("work:../x", "rose");
  assert.deepEqual(dock.state().colours, { [key]: "iris" }, "only a session or a chat has a colour");
});

test("Settings → General → Dock: Always by default, the most from 1 to 16, the icon size from 24 to 48", async () => {
  for (const key of Object.keys(settings)) delete settings[key];
  assert.deepEqual(dockSettings(), { show: "always", most: 8, size: 34 });
  let changes = 0; const dock = new Dock(store()); dock.onChange(() => changes++);
  assert.equal(await setDockSetting({ type: "dockSetting", name: "show", value: "hover" }), true);
  assert.equal(await setDockSetting({ type: "dockSetting", name: "most", value: 16 }), true);
  assert.equal(await setDockSetting({ type: "dockSetting", name: "size", value: 44 }), true);
  assert.deepEqual(dockSettings(), { show: "hover", most: 16, size: 44 });
  assert.equal(changes, 3, "each change reaches every dock at once");
  for (const bad of [{ name: "show", value: "sometimes" }, { name: "most", value: 17 }, { name: "most", value: 0 }, { name: "size", value: 23 }, { name: "size", value: 49 }, { name: "size", value: "big" }]) await setDockSetting({ type: "dockSetting", ...bad });
  assert.deepEqual(dockSettings(), { show: "hover", most: 16, size: 44 }, "nothing out of range is saved");
  Object.assign(settings, { "dock.show": "never", "dock.mostItems": 99, "dock.iconSize": 2 });
  assert.deepEqual(dockSettings(), { show: "never", most: 16, size: 24 }, "a value typed into settings.json is brought into range");
  assert.equal(await setDockSetting({ type: "saveSettings" }), false);
  for (const key of Object.keys(settings)) delete settings[key];
  // The manifest offers the same three, with the same limits.
  const props = JSON.parse(readFileSync(root + "package.json", "utf8")).contributes.configuration.properties;
  assert.deepEqual(props["dgc.dock.show"].enum, ["always", "hover", "never"]); assert.equal(props["dgc.dock.show"].default, "always");
  assert.deepEqual([props["dgc.dock.mostItems"].default, props["dgc.dock.mostItems"].minimum, props["dgc.dock.mostItems"].maximum], [8, 1, 16]);
  assert.deepEqual([props["dgc.dock.iconSize"].default, props["dgc.dock.iconSize"].minimum, props["dgc.dock.iconSize"].maximum], [34, 24, 48]);
});

test("a window looked at again reads the dock again: another window may have pinned something meanwhile", async () => {
  const context = store(), here = new Dock(context), there = new Dock(context);
  let told = 0; here.onChange(() => told++);
  await there.pin({ kind: "chat", id: CHAT("a"), title: "Goa" });
  assert.equal(told, 0, "another window's pin isn't told here by itself");
  for (const l of onWindow) l({ focused: true });
  assert.ok(told >= 1); assert.deepEqual(here.state().pins.map((p) => p.title), ["Goa"]);
});

test("one dock for the whole extension", () => {
  const context = store();
  assert.equal(dockOf(context), dockOf(context));
  assert.notEqual(dockOf(context), dockOf(store()));
});

test("a drag's drop: dockPlace puts a pin at a place among what this window shows, and keeps the rest in order", async () => {
  const context = store(), dock = new Dock(context);
  for (const [kind, id, title] of [["work", S("1"), "One"], ["chat", CHAT("a"), "Two"], ["pip", PIP("b"), "Three"], ["work", S("2"), "Four"]]) { dock.handle({ type: "dockPin", item: { kind, id, title } }); await tick(); }
  const order = () => new Dock(context).pins().map((p) => p.title);
  assert.deepEqual(order(), ["One", "Two", "Three", "Four"]);
  assert.equal(dock.handle({ type: "dockPlace", key: `work:${S("1")}`, to: 2 }), true); await tick();
  assert.deepEqual(order(), ["Two", "Three", "One", "Four"], "the first, dropped third: the two it passed move up, kept on this computer");
  dock.handle({ type: "dockPlace", key: `work:${S("2")}`, to: 0 }); await tick();
  assert.deepEqual(order(), ["Four", "Two", "Three", "One"], "the last, dropped first");
  dock.handle({ type: "dockPlace", key: `chat:${CHAT("a")}`, to: 99 }); await tick();
  assert.deepEqual(order(), ["Four", "Three", "One", "Two"], "past the end is the end");
  const before = order();
  for (const bad of [{ key: "work:nope", to: 1 }, { key: `pip:${PIP("b")}`, to: "2" }, { key: `pip:${PIP("b")}`, to: -1.5 }, { key: `pip:${PIP("b")}` }]) { dock.handle({ type: "dockPlace", ...bad }); await tick(); }
  assert.deepEqual(order(), before, "what is not a pin here, or not a place, moves nothing");
});

// ---- a ChatDGC project on the dock, and its pinwheel's palette (13 Nov) ----
test("a ChatDGC project can be pinned, shows in every window, and keeps the palette its pinwheel was given; its owner may choose another", async () => {
  const context = store(), dock = new Dock(context), P = (c) => "project_" + c.repeat(32);
  assert.equal(await dock.pin({ kind: "project", id: P("a"), title: "Goa trip" }), true, "a project is something the dock holds");
  assert.deepEqual(dock.state().pins.map((p) => [p.key, p.kind, p.title]), [[`project:${P("a")}`, "project", "Goa trip"]]);
  folder = "/home/me/other";
  assert.equal(new Dock(context).state().pins.length, 1, "a project is the same in every folder");
  folder = "/home/me/shop";
  // Its palette: given once (the first not worn by the projects beside it), kept, never given again.
  await dock.wear("project", [{ id: P("a") }, { id: P("b") }, { id: P("c") }]);
  const worn = ["a", "b", "c"].map((c) => dock.state().colours[`project:${P(c)}`]);
  assert.equal(new Set(worn).size, 3, `three projects side by side wear three palettes (${worn})`);
  await dock.wear("project", [{ id: P("c") }, { id: P("a") }]);
  assert.deepEqual(["a", "b", "c"].map((c) => new Dock(context).state().colours[`project:${P(c)}`]), worn, "kept as given, across a reload");
  await dock.setColour(`project:${P("a")}`, "rose");
  assert.equal(dock.state().colours[`project:${P("a")}`], "rose", "chosen by its owner from its “…”");
  await dock.setColour(`project:${P("a")}`, "citron");
  assert.equal(dock.state().colours[`project:${P("a")}`], "rose", "only one of the twelve");
});
