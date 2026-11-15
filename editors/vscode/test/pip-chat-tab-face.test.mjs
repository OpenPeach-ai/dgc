// A Pip's chat in an editor tab wears that Pip's face as its tab's icon (16 Nov), as a computer's tab wears its Portal.
// The host's side (src/pipsView.ts, src/pipTabFace.ts): the icon is the Pip's character at rest, a 64 px picture from
// media/pips/tab-faces/ carried inside a data: URI (nothing to fetch after a reload: src/tabIcon.ts says why), the same
// for light and dark; it is the character chosen for the Pip, else its own; and it is drawn again when DGC says the Pip's
// character changed, in every bridge's tabs of that Pip and no other's. The pictures are the ones
// scripts/render-pip-tab-faces.mjs draws from the page's own renderer (checked here in real Chromium).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";
import { CHARACTERS, EYES, SIZE, faceFile, renderFace } from "../scripts/render-pip-tab-faces.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// (DGC_PIPS_SRC: another tree's src folder, to see the host as it was.)
const viewModule = await pipsViewModule(process.env.DGC_PIPS_SRC ? process.env.DGC_PIPS_SRC.replace(/\/src\/?$/, "") : undefined);
const editors = [];
after(() => { for (const e of editors) e.dispose(); });
const PIP = { id: "pip_" + "5".repeat(32), name: "GST watchdog", pip_type: "rook" };
const OTHER = { id: "pip_" + "6".repeat(32), name: "Mornings", pip_type: "lens" };
const GOA = "conv_" + "a".repeat(32);
const picture = (character) => `data:image/png;base64,${readFileSync(faceFile(character)).toString("base64")}`;

function host({ ext = root } = {}) {
  const panels = [], disposed = [];
  const vscode = { ViewColumn: { Active: -1, Beside: -2 },
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/"), fsPath: [base.fsPath, ...parts].join("/") }), file: (p) => ({ path: p, fsPath: p }), parse: (text) => ({ toString: () => text, scheme: text.split(":")[0] }) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }),
      createWebviewPanel: (id, title) => { const p = { id, title, revealed: 0, posted: [], receive: null, closed: [], visible: true, iconPath: undefined, icons: [],
        webview: { cspSource: "https://csp.test", html: "", asWebviewUri: (u) => ({ toString: () => "https://csp.test/" + u.path }), postMessage: (m) => { p.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { p.receive = f; } },
        reveal() { p.revealed++; }, onDidDispose: (f) => { p.closed.push(f); }, onDidChangeViewState() {}, dispose() { if (disposed.includes(p)) return; disposed.push(p); for (const f of p.closed) f(); } };
        let icon; Object.defineProperty(p, "iconPath", { get: () => icon, set: (v) => { icon = v; p.icons.push(v); } });
        panels.push(p); return p; } } };
  const { PipsEditor } = viewModule(vscode);
  const make = () => { const main = [], sent = []; const editor = new PipsEditor({ path: "ext", fsPath: ext }, (m) => { sent.push(m); return true; }, () => {}, true);
    editors.push(editor); editor.attach((m) => main.push(m)); editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 99 }, {});
    return { editor, main, sent }; };
  return { ...make(), make, panels, chats: () => panels.filter((p) => p.id === "dgc.pipChat" && !disposed.includes(p)) };
}
const face = (panel) => panel.iconPath && { light: String(panel.iconPath.light), dark: String(panel.iconPath.dark) };
/** DGC answers a page's request. */
function answer(h, page, request, result) {
  const generation = (page.posted || h.main).filter((m) => m.type === "pipsConnection").at(-1).generation, id = "r" + String(Math.random()).slice(2);
  (page.receive ? page.receive : (m) => h.editor.receive(m))({ type: "pipsRequest", id, generation, request });
  const call = h.sent.filter((m) => m.type === "pips_control" && m.request.type === request.type).at(-1);
  h.editor.event({ type: "pips_result", request_id: call.request.request_id, command: request.type, ok: true, result });
}

test("the eight faces are here, each a 64 px PNG", () => {
  for (const character of CHARACTERS) {
    assert.ok(existsSync(faceFile(character)), `${character}.png`);
    const png = readFileSync(faceFile(character));
    assert.equal(png.toString("latin1", 1, 4), "PNG"); assert.equal(png.readUInt32BE(16), SIZE); assert.equal(png.readUInt32BE(20), SIZE);
    assert.ok(png.length < 16000, `${character}.png is small enough to ride inside a tab's URI (${png.length} bytes)`);
  }
});

test("a Pip's chat tab wears its face: the character chosen for it, else its own; the same picture light and dark", () => {
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  h.editor.receive({ type: "pipsOpenChat", pip: { ...OTHER, body: "quill" }, conversation: { id: GOA, title: "Trip to Goa" } });
  const [mine, other] = h.chats();
  assert.deepEqual(face(mine), { light: picture("rook"), dark: picture("rook") }, "no character chosen: its own");
  assert.deepEqual(face(other), { light: picture("quill"), dark: picture("quill") }, "the character chosen for it");
  assert.match(face(mine).light, /^data:image\/png;base64,/, "carried inside the URI");
  // A character that is none of the eight is not a face: its own shows.
  h.editor.receive({ type: "pipsOpenChat", pip: { ...OTHER, body: "../../x" } });
  assert.deepEqual(face(h.chats()[2]), { light: picture("lens"), dark: picture("lens") });
});

test("its face is drawn again when DGC says its character changed, on that Pip's tabs alone", () => {
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  h.editor.receive({ type: "pipsOpenChat", pip: OTHER });
  const [first, second, other] = h.chats();
  for (const p of h.chats()) p.receive({ type: "pipsReady" });
  // Its tab's own page reads the Pip from DGC: the Pip wears a chosen character the opener did not know of.
  answer(h, first, { type: "get_pip", pip_id: PIP.id }, { pip: { ...PIP, profile: { body: "pulse" } } });
  assert.deepEqual([face(first).dark, face(second).dark, face(other).dark], [picture("pulse"), picture("pulse"), picture("lens")], "both its tabs; the other Pip's is its own");
  // Changed on its page (any page of the window): the tabs follow at once.
  answer(h, { posted: h.main }, { type: "set_pip_profile", pip_id: PIP.id, changes: { body: "lock" } }, { pip_id: PIP.id, profile: { title: "", body: "lock", color: null, notify: true } });
  assert.deepEqual([face(first).dark, face(second).dark, face(other).dark], [picture("lock"), picture("lock"), picture("lens")]);
  // Its chosen character taken off: its own face again.
  const before = first.icons.length;
  answer(h, { posted: h.main }, { type: "set_pip_profile", pip_id: PIP.id, changes: { body: null } }, { pip_id: PIP.id, profile: { title: "", body: null, color: null, notify: true } });
  assert.equal(face(first).light, picture("rook"));
  // Said again with nothing changed: the icon is not set again (VS Code redraws a tab whose icon is set).
  answer(h, first, { type: "get_pip", pip_id: PIP.id }, { pip: { ...PIP, profile: { body: null } } });
  assert.equal(first.icons.length, before + 1, "set once for the change, not again for the same face");
  // A tab opened afterwards wears what DGC last said, whatever its opener says.
  answer(h, first, { type: "get_pip", pip_id: PIP.id }, { pip: { ...PIP, profile: { body: "scout" } } });
  first.dispose();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  assert.equal(face(h.chats().at(-1)).dark, picture("scout"));
});

test("another bridge of the window (the side bar's) changes a Pip's character: the tabs kept by this one follow", () => {
  const h = host(), side = h.make();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  const tab = h.chats()[0];
  const generation = side.main.filter((m) => m.type === "pipsConnection").at(-1).generation;
  side.editor.receive({ type: "pipsRequest", id: "p1", generation, request: { type: "set_pip_profile", pip_id: PIP.id, changes: { body: "patch" } } });
  const call = side.sent.filter((m) => m.type === "pips_control" && m.request.type === "set_pip_profile").at(-1);
  side.editor.event({ type: "pips_result", request_id: call.request.request_id, command: "set_pip_profile", ok: true, result: { pip_id: PIP.id, profile: { title: "", body: "patch", color: null, notify: true } } });
  assert.equal(face(tab).dark, picture("patch"));
});

test("pictures that cannot be read: the tab opens with no icon of its own, and nothing throws", () => {
  const h = host({ ext: "/nowhere" });
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  assert.equal(h.chats().length, 1); assert.equal(h.chats()[0].iconPath, undefined);
});

// ---- the pictures are what the page's renderer draws -----------------------------------------------------------------
let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

test("each picture is its character as media/pips/plush.js draws it at rest, eyes bolder; it reads at 16 px on a dark tab and a light one", async (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (reason) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`); t.skip(reason); return; }
  const context = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: "reduce" }), page = await context.newPage();
  try {
    const fresh = {};
    for (const character of CHARACTERS) fresh[character] = "data:image/png;base64," + (await renderFace(page, character)).toString("base64");
    await page.setContent("<!doctype html><html><body></body></html>");
    for (const character of CHARACTERS) {
      const seen = await page.evaluate(async ([kept, now]) => {
        const load = (src) => new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = fail; i.src = src; });
        const data = async (src, size, under) => { const c = Object.assign(document.createElement("canvas"), { width: size, height: size }), g = c.getContext("2d", { willReadFrequently: true });
          if (under) { g.fillStyle = under; g.fillRect(0, 0, size, size); } g.imageSmoothingQuality = "high"; g.drawImage(await load(src), 0, 0, size, size); return g.getImageData(0, 0, size, size).data; };
        const a = await data(kept, 64), b = await data(now, 64); let sum = 0, solid = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        for (let i = 3; i < a.length; i += 4) if (a[i] > 200) solid++;
        // At 16 px, over each tab colour: how far the face stands from the tab, and the eyes from the face.
        const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        const small = {};
        for (const [name, under] of [["dark", "#181818"], ["light", "#f8f8f8"]]) {
          const d = await data(kept, 16, under), base = lum(...(under === "#181818" ? [24, 24, 24] : [248, 248, 248]));
          let away = 0, bright = 0, body = [0, 0, 0], n = 0;
          for (let i = 0; i < d.length; i += 4) { const l = lum(d[i], d[i + 1], d[i + 2]); if (ratio(l, base) >= 1.25) away++; }
          // The eyes: the brightest pixels in the middle band of the face; the body: the rest of that band.
          const band = []; for (let y = 5; y < 12; y++) for (let x = 3; x < 13; x++) { const i = (y * 16 + x) * 4; band.push([d[i], d[i + 1], d[i + 2]]); }
          band.sort((p, q) => lum(...q) - lum(...p)); const eyes = band.slice(0, 4), rest = band.slice(12);
          for (const p of rest) { body[0] += p[0]; body[1] += p[1]; body[2] += p[2]; n++; } bright = eyes.reduce((s, p) => s + lum(...p), 0) / eyes.length;
          small[name] = { away, eyes: ratio(bright, lum(body[0] / n, body[1] / n, body[2] / n)) };
        }
        return { mean: sum / a.length, solid: solid / (64 * 64), small };
      }, [picture(character), fresh[character]]);
      assert.ok(seen.mean < 1.5, `${character}.png is the face plush.js draws (mean difference ${seen.mean.toFixed(2)}): run scripts/render-pip-tab-faces.mjs after changing it`);
      assert.ok(seen.solid > 0.4, `${character} fills its square (${seen.solid.toFixed(2)} of it): large enough for a 16 px tab icon`);
      for (const name of ["dark", "light"]) {
        assert.ok(seen.small[name].away >= 90, `${character} at 16 px on a ${name} tab: its shape stands off the tab (${seen.small[name].away} of 256 pixels)`);
        assert.ok(seen.small[name].eyes >= 1.6, `${character} at 16 px on a ${name} tab: its eyes stand off its body (${seen.small[name].eyes.toFixed(2)}:1)`);
      }
    }
    assert.ok(EYES > 1, "the tab's eyes are drawn heavier than the page's");
  } finally { await context.close(); }
});
