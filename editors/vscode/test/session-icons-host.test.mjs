// The marks' palettes as the extension's host keeps them, and a tab's icon (src/dock.ts over media/shared/marks.js,
// bundled against a stub `vscode`). A Work session's mark is a Voxel and a ChatDGC chat's a Mote, the maintainer's own
// designs, each in one of twelve palettes (the sheets' fourteen without Citron and Lime). What is held here:
//   - a new session gets the first palette not worn by the sessions around it (its list's rows, the nearest first)
//   - what it was given is kept: a reload, another order and a longer list never change it
//   - a session from before the marks keeps the palette nearest its old colour (the one chosen, or its id's own)
//   - its owner's choice is one of the twelve
//   - a tab's icon is its palette's PNG from media/session-icons/, inside a data: URI
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const marks = createRequire(import.meta.url)(root + "media/shared/marks.js");
globalThis.__ICONS_VSCODE = {
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }), parse: (text) => ({ toString: () => text, text }) },
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { showQuickPick: async () => undefined, onDidChangeWindowState: () => ({ dispose() {} }) },
};
const out = await build({ entryPoints: [root + "src/dock.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__ICONS_VSCODE;" })); } }] });
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
const { Dock, markIcon, sessionIcon } = mod.exports;

const TWELVE = ["ember", "peach", "saffron", "fern", "mint", "lagoon", "ice", "azure", "iris", "lilac", "orchid", "rose"];
const store = (first = {}) => { const kept = new Map(Object.entries(first)); return { globalState: { get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, JSON.parse(JSON.stringify(v))); } }, kept }; };
const S = (n) => `202611${String(10 + n).padStart(2, "0")}-101500-a${n}`, CHAT = (c) => "chat_" + c.repeat(32);
const born = (id) => marks.born(id);
const tick = () => new Promise((done) => setTimeout(done, 5));
const ext = { fsPath: root.replace(/\/$/, "") };

test("twelve palettes, in the chosen order, and never Citron or Lime", () => {
  assert.deepEqual([...marks.PALETTES], TWELVE);
  for (const sheet of ["mote", "voxel"]) {
    const css = readFileSync(`${root}media/shared/${sheet}.css`, "utf8");
    for (const name of TWELVE) {
      const hue = new RegExp(`\\.${sheet}--${name}\\{--h:(\\d+);`).exec(css);
      assert.ok(hue, `${sheet}.css has ${name}`);
      assert.equal(Number(hue[1]), marks.HUES[name], `${name}'s hue is the sheet's`);
    }
  }
  for (const bad of ["citron", "lime", "Lagoon", "", 3, null, undefined]) assert.equal(marks.isPalette(bad), false, `${bad} is not one of the twelve`);
  // Whatever is asked for, a mark is never drawn in either.
  for (const set of ["mote", "voxel"]) for (const bad of ["citron", "lime"]) assert.doesNotMatch(marks.html(set, bad), /citron|lime/);
  assert.equal(marks.html("mote", "rose", { size: 24 }), '<span class="mote mote--rose" data-mark="mote" data-palette="rose" style="--size:24px;--mote-play:paused" aria-hidden="true"><i></i><i></i><i></i></span>',
    "the sheet's markup: span.mote.mote--<palette> > i*3, sized by --size, paused by --mote-play");
  assert.match(marks.html("voxel", "azure", { moving: true, id: "x" }), /^<span class="voxel voxel--azure" data-mark="voxel" data-palette="azure" data-moving style="--phase:-\ds" aria-hidden="true">(<i><\/i>){6}<\/span>$/,
    "span.voxel.voxel--<palette> > i*6; the one that moves is not paused, and --phase offsets where it starts");
  assert.match(marks.html("mote", "ice", { name: 'Plan "A" & B' }), / role="img" aria-label="Plan &quot;A&quot; &amp; B">/, "alone, it is named for a screen reader");
});

test("a session from before the marks keeps the palette nearest its old colour in hue", () => {
  // The seven old pairs' first colours (media/shared/tokens.css had them as --blob-1a ... --blob-7a).
  const old = ["a855f7", "3b82f6", "22d3ee", "4ade80", "facc15", "fb923c", "ef4444"];
  const hueOf = (hex) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    return Math.round(60 * ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) + 6) % 360); };
  const away = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  old.forEach((hex, i) => {
    const hue = hueOf(hex), nearest = [...TWELVE].sort((a, b) => away(marks.HUES[a], hue) - away(marks.HUES[b], hue))[0];
    assert.equal(marks.fromOld(i + 1), nearest, `pair ${i + 1} (#${hex}, hue ${hue}) is ${nearest}`);
  });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(marks.fromOld), ["lilac", "azure", "ice", "fern", "saffron", "peach", "ember"]);
  for (const bad of [0, 8, 2.5, "3", undefined]) assert.equal(marks.fromOld(bad), "", `${bad} was never a colour`);
  // The pair an id had by itself was one of 2 to 7, the same every time.
  const seen = new Set();
  for (let i = 0; i < 400; i++) { const pair = marks.oldPair(`2026-s${i}`); assert.equal(pair, marks.oldPair(`2026-s${i}`)); seen.add(pair); }
  assert.deepEqual([...seen].sort(), [2, 3, 4, 5, 6, 7]);
});

test("a new session's palette differs from its neighbours', and is the first of the twelve that is free", async () => {
  const context = store({ "dgc.sessionPalettesSince": 1 }), dock = new Dock(context);          // the marks arrived long ago: every session here is new
  const list = [1, 2, 3, 4, 5, 6].map((n) => ({ id: S(n), born: born(S(n)) }));
  let told = 0; dock.onChange(() => told++);
  assert.equal(dock.handle({ type: "dockPalettes", kind: "work", list }), true); await tick();
  const first = list.map((row) => dock.colours()[`work:${row.id}`]);
  assert.deepEqual(first, TWELVE.slice(0, 6), "six rows with nothing around them: the first six, in the list's order");
  assert.ok(told >= 1, "every page is told what was given");
  // One more, at the top of the list: not what the six in view wear.
  const seventh = { id: S(7), born: born(S(7)) };
  await dock.wear("work", [seventh, ...list]);
  assert.equal(dock.colour("work", seventh.id), "ice", "the first palette none of the six wears");
  // A thirteenth has no free palette among twelve neighbours: it takes the one worn farthest away, never its neighbour's.
  const more = [8, 9, 10, 11, 12].map((n) => ({ id: S(n), born: born(S(n)) }));
  await dock.wear("work", [...more, seventh, ...list]);
  assert.equal(new Set([...more, seventh, ...list].map((row) => dock.colour("work", row.id))).size, 12, "twelve sessions: twelve palettes, none twice");
  const late = { id: S(13), born: born(S(13)) }, all = [late, ...more, seventh, ...list];
  await dock.wear("work", all);
  const worn = all.map((row) => dock.colour("work", row.id));
  assert.equal(worn[0], worn.at(-1), "the palette of the row farthest from it");
  for (let i = 1; i < 12; i++) assert.notEqual(worn[0], worn[i], `not the palette of the row ${i} away`);
  for (const palette of Object.values(dock.colours())) assert.ok(TWELVE.includes(palette), `${palette} is one of the twelve`);
});

test("what a session was given is kept: a reload, another order and a longer list never change it", async () => {
  const context = store({ "dgc.sessionPalettesSince": 1 }), dock = new Dock(context);
  const list = [1, 2, 3, 4].map((n) => ({ id: S(n), born: born(S(n)) }));
  await dock.wear("work", list);
  const given = { ...dock.colours() };
  assert.equal(Object.keys(given).length, 4);
  // "A reload": a new Dock over the same global state.
  const again = new Dock(context);
  assert.deepEqual(again.colours(), given);
  assert.deepEqual(again.state().colours, given, "and the pages are told the same");
  // The list in another order, and with two more: the four keep theirs.
  await again.wear("work", [list[3], { id: S(5), born: born(S(5)) }, list[1], list[0], { id: S(6), born: born(S(6)) }, list[2]]);
  for (const [key, palette] of Object.entries(given)) assert.equal(again.colours()[key], palette, `${key} is still ${palette}`);
  assert.equal(Object.keys(again.colours()).length, 6);
  // Asked again for the same list: nothing changes, and nothing is told.
  let told = 0; again.onChange(() => told++);
  const before = JSON.stringify(again.colours());
  await again.wear("work", list);
  assert.equal(JSON.stringify(again.colours()), before); assert.equal(told, 0);
  // A session alone (its own tab, no list): not what the sessions given a palette most recently wear.
  await again.wear("work", [{ id: S(7), born: born(S(7)) }]);
  assert.equal(Object.values(again.colours()).filter((p) => p === again.colour("work", S(7))).length, 1, "a palette no recent session wears");
  // Chats have their own neighbours: a first chat starts at the first palette again.
  await again.wear("chat", [{ id: CHAT("a") }]);
  assert.equal(again.colour("chat", CHAT("a")), "ember");
  // What is not a session is given nothing.
  await again.wear("pip", [{ id: "pip_x" }]); await again.wear("work", [{ id: "../etc" }, { id: "" }, null, 7]); await again.wear("work", "nonsense");
  assert.equal(Object.keys(again.colours()).length, 8);
});

test("a session from before the marks keeps its old colour's palette: the one chosen, or its id's own", async () => {
  const since = new Date(2026, 10, 12, 9, 0, 0).getTime();
  const chosen = `work:${S(1)}`;                                                       // (S(1) was made on 11 Nov, before `since`)
  const context = store({ "dgc.sessionPalettesSince": since, "dgc.sessionColours": { [chosen]: 1, [`chat:${CHAT("b")}`]: 7, "work:nonsense": 12 } }), dock = new Dock(context);
  assert.equal(dock.state().since, since);
  assert.equal(dock.colour("work", S(1)), "lilac", "a colour chosen before the marks (1, purple to pink) is Lilac at once");
  assert.equal(dock.colour("chat", CHAT("b")), "ember", "7, red to orange, is Ember");
  assert.deepEqual(dock.state().colours, { [chosen]: "lilac", [`chat:${CHAT("b")}`]: "ember" });
  const beforeMarks = { id: S(0), born: born(S(0)) }, afterMarks = { id: S(5), born: born(S(5)) };   // 10 Nov, and 15 Nov
  assert.ok(beforeMarks.born < since && afterMarks.born > since);
  await dock.wear("work", [afterMarks, { id: S(1), born: born(S(1)) }, beforeMarks]);
  assert.equal(dock.colour("work", S(1)), "lilac", "the chosen one keeps its palette");
  assert.equal(dock.colour("work", beforeMarks.id), marks.fromOld(marks.oldPair(beforeMarks.id)), "one made before the marks: the palette of the colour its id gave it");
  assert.equal(dock.colour("work", afterMarks.id), marks.pick(["lilac", dock.colour("work", beforeMarks.id)]), "one made since: the first palette its neighbours don't wear");
  // Until a page has drawn it, a session's tab wears what its id alone gives, the same every time.
  assert.equal(dock.colour("work", S(9)), marks.fallback("work", S(9)));
  assert.equal(`work:${S(9)}` in dock.colours(), false, "and nothing is kept for it yet");
  // With no date kept yet, the marks arrive now, and the date is kept.
  const fresh = store(), now = new Dock(fresh).state().since;
  assert.ok(Math.abs(now - Date.now()) < 5000); await tick();
  assert.equal(fresh.kept.get("dgc.sessionPalettesSince"), now);
  assert.equal(new Dock(fresh).state().since, now, "the same after a reload");
});

test("a deleted session's palette goes with it, a colour chosen before the marks too", async () => {
  const key = `work:${S(1)}`, context = store({ "dgc.sessionPalettesSince": 1, "dgc.sessionColours": { [key]: 3 } }), dock = new Dock(context);
  assert.equal(dock.colour("work", S(1)), "ice");
  await dock.setColour(key, "rose");
  assert.equal(new Dock(context).colour("work", S(1)), "rose", "a choice among the twelve replaces it");
  await dock.forget("work", S(1));
  assert.equal(key in new Dock(context).colours(), false, "gone, and its old colour does not bring it back");
});

// ---- a tab's icon -----------------------------------------------------------------------------------------------------
function decode(file) {
  assert.deepEqual([...file.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "a PNG");
  let at = 8, width = 0, height = 0, kind = []; const data = [];
  while (at < file.length) { const n = file.readUInt32BE(at), type = file.toString("ascii", at + 4, at + 8), body = file.subarray(at + 8, at + 8 + n);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); kind = [body[8], body[9], body[12]]; }
    if (type === "IDAT") data.push(body); at += 12 + n; }
  assert.deepEqual(kind, [8, 6, 0], "8-bit RGBA, not interlaced");
  const raw = inflateSync(Buffer.concat(data)), stride = width * 4 + 1, px = Buffer.alloc(width * height * 4);
  // (Undo the PNG's line filters.)
  for (let y = 0; y < height; y++) { const f = raw[y * stride];
    for (let x = 0; x < width * 4; x++) { const a = x >= 4 ? px[y * width * 4 + x - 4] : 0, b = y ? px[(y - 1) * width * 4 + x] : 0, c = x >= 4 && y ? px[(y - 1) * width * 4 + x - 4] : 0, v = raw[y * stride + 1 + x];
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      px[y * width * 4 + x] = (v + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255; } }
  return { width, height, at: (x, y) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] };
}
const hueOf = ([r, g, b]) => { const max = Math.max(r, g, b), d = max - Math.min(r, g, b); return d ? (60 * ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4)) + 360) % 360 : 0; };

test("the pictures: each mark at rest for each of the twelve palettes, 64 px, clear around it, in its palette's hue", () => {
  const files = readdirSync(`${root}media/session-icons`).filter((name) => /^(mote|voxel)-/.test(name)).sort();
  assert.deepEqual(files, ["mote", "voxel"].flatMap((set) => [...TWELVE].sort().map((name) => `${set}-${name}.png`)), "12 Motes and 12 Voxels, and no Citron or Lime");
  for (const name of files) {
    const [, set, palette] = /^(\w+)-(\w+)\.png$/.exec(name), png = decode(readFileSync(`${root}media/session-icons/${name}`));
    assert.deepEqual([png.width, png.height], [64, 64], name);
    for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63]]) assert.equal(png.at(x, y)[3], 0, `${name}: clear at the corner`);
    for (let i = 0; i < 64; i++) for (const [x, y] of [[i, 0], [i, 63], [0, i], [63, i]]) assert.equal(png.at(x, y)[3], 0, `${name}: nothing cut off at its edge (${x},${y})`);
    assert.equal(png.at(32, 36)[3], 255, `${name}: filled in the middle`);
    // Its body's colour, away from the highlights: the palette's hue.
    const hues = [[30, 44], [36, 46], [26, 40]].map(([x, y]) => hueOf(png.at(x, y))), want = marks.HUES[palette];
    for (const hue of hues) assert.ok(Math.min(Math.abs(hue - want), 360 - Math.abs(hue - want)) <= 14, `${name}: hue ${Math.round(hue)} for ${palette}'s ${want}`);
    assert.ok(set === "mote" ? png.at(6, 20)[3] === 0 || png.at(58, 6)[3] === 0 : png.at(32, 5)[3] > 0 && png.at(6, 8)[3] === 0, `${name}: the ${set}'s own outline`);
  }
});

test("a tab's icon is its palette's PNG: a Voxel for a Work session, a Mote for a ChatDGC chat, inside the URI", () => {
  const file = (name) => `data:image/png;base64,${readFileSync(`${root}media/session-icons/${name}.png`).toString("base64")}`;
  for (const palette of TWELVE) {
    assert.equal(String(sessionIcon(ext, "work", S(1), palette).text), file(`voxel-${palette}`), `a Work session in ${palette}`);
    assert.equal(String(sessionIcon(ext, "chat", CHAT("a"), palette).text), file(`mote-${palette}`), `a chat in ${palette}`);
  }
  assert.equal(sessionIcon(ext, "work", "", "rose"), undefined, "a session with no id yet keeps the plain mark");
  assert.equal(String(sessionIcon(ext, "work", S(2), "citron").text), file(`voxel-${marks.fallback("work", S(2))}`), "what is not one of the twelve is never drawn: its id's own instead");
  assert.equal(sessionIcon(ext, "work", S(1), "rose"), sessionIcon(ext, "work", S(3), "rose"), "one picture per mark and palette, read once");
  assert.equal(String(sessionIcon(ext, "chat", CHAT("a"), "rose").text).includes("media"), false, "nothing names the extension's folder");
  for (const bad of [["mote", "citron"], ["mote", "lime"], ["blob", "rose"], ["voxel", ""]]) assert.equal(markIcon(ext, ...bad), undefined, `${bad.join("-")}: no such picture`);
  assert.equal(markIcon({ fsPath: "/nowhere" }, "mote", "rose"), undefined, "a picture that cannot be read: the tab keeps the plain mark");
  // The code that drew the old blob, pixel by pixel, is gone.
  const src = readFileSync(`${root}src/dock.ts`, "utf8") + readFileSync(`${root}src/sessionTabs.ts`, "utf8") + readFileSync(`${root}src/chatdgc.ts`, "utf8");
  assert.doesNotMatch(src, /blobPixels|blobIcon|deflateSync/);
});
