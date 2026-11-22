// Favorites in the Library, from the editor's side bar to DGC (0.52), on the real src/panel.ts (bundled against a stub
// vscode) with a backend that records what it is sent. The Library's host asks the panel for the favorites; the panel
// asks DGC: favorites_list to read them, favorites_set to star an item or take its star off, each with a request of
// its own and nothing but the item's kind and id. An older DGC, which doesn't say it keeps favorites, is sent neither.
// Then, in jsdom, the star's one glyph (media/shared/icons.js) and the Library's own module (media/library.js): what it
// draws and what it asks its host.
// (The host's own checks, and its side bar allowlist, are in test/chatdgc-tabs.test.mjs; DGC's in tests/test_favorites.py.)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

test("the panel reads and changes DGC's favorites with favorites_list and favorites_set, only on a DGC that keeps them", async () => {
  const x = makeProvider({ capabilities: { favorites: 1 } });
  assert.equal(x.provider.favoritesCapable(), true);
  await x.provider.favorites();
  await x.provider.favorites({ kind: "artifact", id: "ar_" + "1".repeat(16), on: true, title: "never sent", path: "/never/sent" });
  await x.provider.favorites({ kind: "image", id: "/home/me/.dgc/images/a.png", on: false });
  const sent = x.backend.sent.filter((c) => /^favorites_/.test(c.type));
  assert.deepEqual(sent.map(({ request_id, ...rest }) => rest), [{ type: "favorites_list" },
    { type: "favorites_set", kind: "artifact", id: "ar_" + "1".repeat(16), on: true }, { type: "favorites_set", kind: "image", id: "/home/me/.dgc/images/a.png", on: false }]);
  assert.ok(sent.every((c) => typeof c.request_id === "string" && c.request_id.length > 0 && c.request_id.length <= 128), "each names its request");
  assert.equal(new Set(sent.map((c) => c.request_id)).size, 3);
});

test("an older DGC is sent neither: the Library is told it keeps no favorites", async () => {
  for (const capabilities of [{}, { favorites: 0 }, { favorites: true }]) {
    const x = makeProvider({ capabilities });
    assert.equal(x.provider.favoritesCapable(), false);
    await assert.rejects(() => x.provider.favorites(), /Update the DGC CLI/);
    await assert.rejects(() => x.provider.favorites({ kind: "artifact", id: "ar_" + "1".repeat(16), on: true }), /Update the DGC CLI/);
    assert.deepEqual(x.backend.sent.filter((c) => /^favorites_/.test(c.type)), []);
  }
});

// ---- the page's own module and the star's glyph, in jsdom (no browser): what is drawn and what is asked ---------------
const { JSDOM } = await import("jsdom");
const { readFileSync } = await import("node:fs");
const media = (name) => readFileSync(new URL(`../media/${name}`, import.meta.url), "utf8");
function libraryDom() {
  const dom = new JSDOM('<!doctype html><body><div id="lib"></div></body>', { runScripts: "outside-only", pretendToBeVisual: true });
  for (const file of ["shared/menu.js", "shared/icons.js", "shared/blob.js", "shared/filemenu.js", "library.js"]) dom.window.eval(media(file));
  const posted = [], kept = [];
  const library = dom.window.DgcLibrary.mount({ host: dom.window.document.getElementById("lib"), place: "tab", post: (m) => posted.push(JSON.parse(JSON.stringify(m))), keep: (k) => kept.push(JSON.parse(JSON.stringify(k))) });
  const ar = (n) => "ar_" + String(n).repeat(16);
  const items = [1, 2, 3].map((n) => ({ id: ar(n), type: "doc", title: `Doc ${n}`, version: 1, updated: `2026-11-1${n}T00:00:00Z`, made_by: { kind: "session", id: "s1", name: "Fix totals" } }));
  library.message({ type: "artifactsOffered", on: true }); library.message({ type: "artifacts", items });
  const $$ = (sel) => [...dom.window.document.querySelectorAll(sel)];
  return { dom, library, posted, kept, ar, $$, rows: () => $$("#library-list .lib-row").map((r) => r.dataset.key) };
}

test("the star is one glyph on every surface: an outline to add, the same star filled to take off, by the icon module", () => {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.eval(media("shared/menu.js")); dom.window.eval(media("shared/icons.js"));
  const I = dom.window.DgcIcons, draw = (action, opts) => { dom.window.document.body.innerHTML = I.html(action, opts); return dom.window.document.body.querySelector("svg"); };
  assert.deepEqual([I.ACTIONS.favorite, I.ACTIONS.unfavorite], ["favorite", "unfavorite"]);
  const add = draw("favorite"), addSaid = [add.dataset.icon, add.getAttribute("fill"), add.getAttribute("stroke"), add.getAttribute("width")], addPath = add.querySelector("path").getAttribute("d");
  const off = draw("unfavorite");
  assert.deepEqual(addSaid, ["favorite", "none", "currentColor", "16"]);
  assert.deepEqual([off.dataset.icon, off.getAttribute("fill"), off.getAttribute("stroke")], ["unfavorite", "currentColor", "currentColor"], "filled with the text's colour: the control's own colour makes it purple");
  assert.equal(addPath, off.querySelector("path").getAttribute("d"), "one star");
  assert.equal(draw("favorite", { size: 15 }).getAttribute("width"), "15", "a menu row's size");
  assert.doesNotMatch(I.html("favorite") + I.html("unfavorite"), /#[0-9a-f]{3,8}\b/i, "never a colour of its own");
  for (const [label, action] of [["Add to Favorites", "favorite"], ["Add Launch notes to Favorites", "favorite"], ["Remove from Favorites", "unfavorite"], ["Remove Launch notes from Favorites", "unfavorite"],
    ["Remove…", "delete"], ["Add a copy to a space…", "add"]]) assert.equal(I.forLabel(label), action, label);
});

test("the Library's module: no star until the host says this DGC keeps favorites; then a star a row, the filter, and what it asks the host", () => {
  const x = libraryDom(), doc = x.dom.window.document;
  assert.equal(x.$$(".lib-fav").length, 0); assert.equal(doc.getElementById("library-filter-fav"), null, "an older DGC: nothing of it");
  x.library.message({ type: "favorites", offered: true, keys: [`artifact:${x.ar(2)}`, "image:/not/on/this/tab.png", 7, null] });
  assert.equal(x.$$(".lib-fav").length, 3, "a star on every row");
  const stars = Object.fromEntries(x.$$("#library-list .lib-row").map((r) => [r.dataset.key, r.querySelector(".lib-fav")]));
  assert.deepEqual(Object.values(stars).map((s) => [s.tagName, s.type, s.getAttribute("aria-pressed"), s.getAttribute("aria-label")]),
    [["BUTTON", "button", "false", "Add Doc 3 to Favorites"], ["BUTTON", "button", "true", "Remove Doc 2 from Favorites"], ["BUTTON", "button", "false", "Add Doc 1 to Favorites"]]);
  assert.equal(stars[`artifact:${x.ar(2)}`].querySelector("svg").dataset.icon, "unfavorite"); assert.equal(stars[`artifact:${x.ar(3)}`].querySelector("svg").dataset.icon, "favorite");
  // A click on the star asks the host by the item's kind and id, shows it at once, and does not open the row.
  x.posted.length = 0;
  stars[`artifact:${x.ar(3)}`].click();
  assert.deepEqual(x.posted, [{ type: "favorite", item: { kind: "artifact", id: x.ar(3) }, on: true }]);
  assert.equal(doc.querySelector(`[data-key="artifact:${x.ar(3)}"] .lib-fav`).getAttribute("aria-pressed"), "true");
  assert.equal(doc.getElementById("library-said").textContent, "Added to Favorites");
  // The host's answer is the list: what DGC did not keep goes back.
  x.library.message({ type: "favorites", offered: true, keys: [`artifact:${x.ar(2)}`] });
  assert.equal(doc.querySelector(`[data-key="artifact:${x.ar(3)}"] .lib-fav`).getAttribute("aria-pressed"), "false");
  // The filter: a button; pressed, only the starred show, and it is kept with the tab's other filters.
  const filter = () => doc.getElementById("library-filter-fav");
  assert.deepEqual([filter().tagName, filter().getAttribute("aria-pressed"), filter().querySelector(".lib-fav-word").textContent, filter().getAttribute("aria-label")], ["BUTTON", "false", "Favorites", "Favorites: show only your favorites"]);
  filter().click();
  assert.deepEqual(x.rows(), [`artifact:${x.ar(2)}`]); assert.equal(filter().getAttribute("aria-pressed"), "true");
  assert.equal(x.kept.at(-1).favorites.artifacts, true); assert.equal(x.library.state().favorites.artifacts, true);
  doc.querySelector(".lib-fav").click();
  assert.deepEqual(x.rows(), []); assert.equal(doc.getElementById("library-status").textContent, "No favorites here yet. Star an item to keep it here.");
  filter().click();
  assert.equal(x.rows().length, 3); assert.equal("favorites" in x.kept.at(-1), false, "off on every tab: nothing kept for it");
  // The host stops offering them: the stars and the filter go.
  x.library.message({ type: "favorites", offered: false, keys: [] });
  assert.equal(x.$$(".lib-fav").length, 0); assert.equal(filter(), null);
});
