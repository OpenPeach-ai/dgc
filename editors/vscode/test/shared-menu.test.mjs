import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { readStylesheet, TOKENS_CSS } from "./support/stylesheet.mjs";
import { THEMES } from "./support/options-scene.mjs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { openChat, conversation, OFFER } from "./support/chat-scene.mjs";

// One menu for "+" and every picker (0.52, UI step 2; the U2 reference: three groups). Work, ChatDGC and the Pips each drew their
// own menus: a heavy black shadow, 24 px rows, monospace hints, uppercase kickers, and keys that worked in some and not
// others (Work's "+" menu answered no arrow keys at all; ChatDGC's model menu neither). Now media/shared/menu.css is how
// every one of them looks and media/shared/menu.js answers the same keys in all of them.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// Every top-level await before the first test() (see node-test top-level-await race).
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};

test("every menu in Work, ChatDGC and a Pip's chat is the shared menu", () => {
  const panel = read("src/panel.ts");
  for (const id of ["addmenu", "modemenu", "outputmenu", "ctxmenu", "cachemenu"]) {
    assert.match(panel, new RegExp(`id="${id}" class="[^"]*\\bdgc-menu\\b`), `Work's #${id}`);
  }
  const chat = read("src/chatdgc.ts");
  for (const id of ["cd-output-menu", "cd-folder-menu"]) {
    assert.match(chat, new RegExp(`id="${id}" class="[^"]*\\bdgc-menu\\b`), `ChatDGC's #${id}`);
  }
  const pips = read("src/pipsClient.js");
  for (const kind of ["composer-model-menu composer-context-menu", "pip-routines-popover"]) {
    assert.match(pips, new RegExp(`class="${kind} dgc-menu\\b`), `a Pip's ${kind}`);
  }
  const pageMenus = pips.match(/class="tabs-menu[^"]*"/g) || [];
  assert.ok(pageMenus.length >= 3 && pageMenus.every((c) => c === 'class="tabs-menu dgc-menu dgc-menu-rows"'), "a Pip's page menus");
  // The model picker is one module for all three (media/shared/modelpicker.js), and its rows are the shared menu's rows:
  // none of the three keeps a model menu of its own.
  const picker = read("media/shared/modelpicker.js");
  assert.match(picker, /class="dgc-mp dgc-dialog dgc-menu"/, "the picker's rows sit in a shared menu");
  assert.match(picker, /class="dgc-menu-row dgc-mp-row/, "and are shared rows");
  assert.match(read("media/main.js"), /MP\.open\(document\.body, modelPickerView\(\)/, "Work opens it");
  assert.match(read("media/chatdgc.js"), /MP\.open\(document\.body, pickerView\(\)/, "ChatDGC opens it");
  assert.match(pips, /globalThis\.DgcModelPicker\.open\(host,pipPickerView\(\)/, "a Pip's chat opens it");
  assert.doesNotMatch(panel, /id="modelmenu"/); assert.doesNotMatch(chat, /id="cd-model-menu"/);
  assert.doesNotMatch(pips, /composer-model-menu composer-reasoning|composer-model-option|chat-model-summary/, "no model menu of a Pip's own");
});

test("no menu keeps a look of its own: surface, corner, shadow and rows are the shared menu's", () => {
  const surfaces = [["media/main.css", /(^|\n)\.cmenu \{[^}]*\}/],
    ["media/chatdgc.css", /\.cd-output-menu \{[^}]*\}/], ["src/pips.css", /\.composer-model-menu\{[^}]*\}/],
    ["src/pips.css", /\.pip-routines-popover\{[^}]*\}/], ["src/pips.css", /\.tabs-menu\{position[^}]*\}/]];
  for (const [file, rule] of surfaces) {
    const found = read(file).match(rule)?.[0];
    assert.ok(found, `${file} still places ${rule}`);
    assert.doesNotMatch(found, /box-shadow|border-radius|background|border:/, `${file}: ${found.trim().slice(0, 50)}… draws its own surface`);
  }
  assert.doesNotMatch(read("media/main.css"), /\.cmenu \.mrow \{|\.cmenu \.mhead \{|#addmenu \.mrow-hint/, "Work's rows");
  assert.doesNotMatch(read("media/chatdgc.css"), /\.cd-menu-row \{|\.cd-output-item \{|\.cd-menu-kicker \{|\.cd-output-head \{/, "ChatDGC's rows and kickers");
  assert.doesNotMatch(read("src/pips.css"), /\.tabs-menu button\{|\.composer-model-options button\{/, "the Pips' rows");
});

test("every page loads the shared menu: Work and ChatDGC before their own script, the Pips in their bundle", () => {
  const panel = read("src/panel.ts");
  assert.ok(panel.indexOf('src="${menuJs}"') > 0 && panel.indexOf('src="${menuJs}"') < panel.indexOf('src="${js}"'), "Work: menu.js before main.js");
  const chat = read("src/chatdgc.ts");
  const at = (name) => chat.indexOf(`asset("media/${name}")`);
  assert.ok(at("shared/menu.js") > 0 && at("shared/menu.js") < at("chatdgc.js"), "ChatDGC: menu.js before chatdgc.js");
  assert.match(read("src/pipsClient.js"), /import '\.\.\/media\/shared\/menu\.css';\nimport '\.\.\/media\/shared\/menu\.js';/);
  assert.match(read("media/main.css"), /^@import url\("\.\/shared\/tokens\.css"\);\n@import url\("\.\/shared\/menu\.css"\);/);
});

// ---- window.DgcMenu itself
function page(markup) {
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/menu.js") + "\n" + read("media/shared/icons.js"));
  return dom;
}
const key = (dom, target, k) => {
  const event = new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

test("the keys, the same in every menu: arrows wrap over the rows it can stop on, Home and End, Escape returns to its button, Tab closes", () => {
  const dom = page(`<button id="open">Open</button><div id="menu"><input id="search"><button class="dgc-menu-row" id="a">A</button>
    <button class="dgc-menu-row" id="b" disabled>B</button><div hidden><button class="dgc-menu-row" id="h">H</button></div>
    <button class="dgc-menu-row" id="c" aria-disabled="true">C</button><button class="dgc-menu-row" id="d">D</button><input type="range" id="slider"></div>`);
  const doc = dom.window.document, $ = (id) => doc.getElementById(id), closed = [];
  dom.window.DgcMenu.keys($("menu"), { close: (viaEscape) => closed.push(viaEscape), trigger: $("open") });
  $("a").focus();
  key(dom, $("a"), "ArrowDown"); assert.equal(doc.activeElement.id, "c", "a disabled row and a hidden one are skipped; an aria-disabled one is said, so it stops");
  key(dom, $("c"), "ArrowDown"); assert.equal(doc.activeElement.id, "d");
  key(dom, $("d"), "ArrowDown"); assert.equal(doc.activeElement.id, "a", "Down from the last wraps to the first");
  key(dom, $("a"), "ArrowUp"); assert.equal(doc.activeElement.id, "d", "Up from the first wraps to the last");
  key(dom, $("d"), "Home"); assert.equal(doc.activeElement.id, "a");
  key(dom, $("a"), "End"); assert.equal(doc.activeElement.id, "d");
  $("search").focus();
  assert.equal(key(dom, $("search"), "Home"), false, "Home in a search box is the box's");
  key(dom, $("search"), "ArrowDown"); assert.equal(doc.activeElement.id, "a", "Down from the search box goes to the first row");
  $("slider").focus();
  assert.equal(key(dom, $("slider"), "ArrowDown"), false, "a slider keeps its arrows");
  $("d").focus();
  key(dom, $("d"), "Escape");
  assert.deepEqual(closed, [true]); assert.equal(doc.activeElement.id, "open", "Escape returns to the button that opened it");
  key(dom, $("a"), "Tab");
  assert.deepEqual(closed, [true, false], "Tab closes and lets the focus move on");
});

test("the keys work inside a shadow root too, as a Pip's menus sit in Work's side bar", () => {
  const dom = page(`<div id="host"></div>`);
  const doc = dom.window.document, shadow = doc.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = `<div id="menu"><button class="dgc-menu-row" id="a">A</button><button class="dgc-menu-row" id="b">B</button><button class="dgc-menu-row" id="c">C</button></div>`;
  const menu = shadow.getElementById("menu");
  dom.window.DgcMenu.keys(menu, {});
  shadow.getElementById("a").focus();
  key(dom, shadow.getElementById("a"), "ArrowDown"); assert.equal(shadow.activeElement.id, "b");
  key(dom, shadow.getElementById("b"), "ArrowDown"); assert.equal(shadow.activeElement.id, "c", "the second Down moves on (it restarted at the top: the document's focus is the host)");
});

test("rows in groups: a heading each, a hairline between, a key cap for a key, quiet words for the rest", () => {
  const dom = page(`<div id="menu"></div>`);
  const menu = dom.window.document.getElementById("menu");
  menu.innerHTML = dom.window.DgcMenu.html([
    { name: "Add to the message", rows: [{ id: "files", icon: "file-directory", label: "Files and folders", hint: "@" }, { id: "mcp", label: "MCP context", hint: "Resources and prompts" }] },
    { name: "This session", rows: [] },
    { name: "Go to", rows: [{ id: "pips", label: "Pips", hint: "Your Pips" }] }], { data: "add", rowClass: "mrow" });
  assert.deepEqual([...menu.querySelectorAll(".dgc-menu-head")].map((h) => h.textContent), ["Add to the message", "Go to"], "an empty group is left out");
  assert.equal(menu.querySelectorAll(".dgc-menu-div").length, 1);
  const rows = [...menu.querySelectorAll("button.dgc-menu-row.mrow")];
  assert.deepEqual(rows.map((r) => r.dataset.add), ["files", "mcp", "pips"]);
  assert.equal(rows[0].querySelector("kbd.dgc-key")?.textContent, "@");
  assert.equal(rows[1].querySelector("kbd"), null);
  assert.equal(rows[1].querySelector(".dgc-menu-hint").textContent, "Resources and prompts");
  assert.ok(rows.every((r) => r.getAttribute("role") === "menuitem"));
  const picker = page(`<div id="m"></div>`);
  picker.window.document.getElementById("m").innerHTML = picker.window.DgcMenu.html([{ rows: [{ id: "a", label: "A", checked: true }, { id: "b", label: "B" }] }], { role: "menuitemradio" });
  assert.deepEqual([...picker.window.document.querySelectorAll("[role=menuitemradio]")].map((r) => r.getAttribute("aria-checked")), ["true", "false"]);
  assert.match(picker.window.DgcMenu.html([{ rows: [{ id: "x", label: "<b>" }] }]), /&lt;b&gt;/, "labels are text, never markup");
});

// ---- in Chromium: the same menu in all three chats
const LOOK = ([menuSel, rowSel]) => {
  const menu = document.querySelector(menuSel), row = menu.querySelector(rowSel), cm = getComputedStyle(menu), cr = getComputedStyle(row);
  return { menuRadius: cm.borderTopLeftRadius, shadow: cm.boxShadow, border: cm.borderTopColor, menuPad: cm.paddingTop,
           rowHeight: row.offsetHeight /* layout, not the 150 ms open's scale */, rowRadius: cr.borderTopLeftRadius, rowPad: cr.paddingLeft,
           rowFont: cr.fontSize, rowWeight: cr.fontWeight };
};

test("Work's + menu: three groups with headings, key caps for the keys, plain words, and the keys", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWorkTab(browser, { width: 900, height: 760 });
  try {
    await s.page.click("#btn-add");
    const menu = await s.page.evaluate(() => {
      const m = document.getElementById("addmenu");
      return { heads: [...m.querySelectorAll(".dgc-menu-head")].map((h) => h.textContent),
               keys: [...m.querySelectorAll("kbd")].map((k) => k.textContent),
               rows: [...m.querySelectorAll(".dgc-menu-row")].map((r) => r.dataset.add),
               hintFont: getComputedStyle(m.querySelector(".dgc-menu-hint")).fontFamily,
               focused: document.activeElement?.dataset?.add };
    });
    assert.deepEqual(menu.heads, ["Add to the message", "This session", "Go to"]);
    assert.deepEqual(menu.keys, ["@", "$", "/"], "the keys you can type instead, as key caps");
    assert.deepEqual(menu.rows.filter((r) => r !== "mcp"), ["files", "skill", "command", "goal", "plan", "pips", "memory"]);
    assert.doesNotMatch(menu.hintFont, /mono/i, "hints in the UI font, not monospace");
    assert.equal(menu.focused, "files", "it opens on its first row");
    const look = await s.page.evaluate(LOOK, ["#addmenu", ".dgc-menu-row"]);
    assert.equal(look.rowHeight, 30); assert.equal(look.rowRadius, "10px"); assert.equal(look.menuRadius, "15px");   // the shared corner scale, a quarter rounder (0.52 look)
    assert.match(look.shadow, /0px 0px 0px 0\.5px, rgba\(0, 0, 0, 0\.12\) 0px 8px 16px -4px/, "the 0.52 lift: a half-pixel ring and one low shadow, not the old black hole of shadow");
    await s.page.keyboard.press("ArrowDown");
    assert.equal(await s.page.evaluate(() => document.activeElement.dataset.add), "skill", "Down moves (it answered no arrows before)");
    await s.page.keyboard.press("End");
    assert.equal(await s.page.evaluate(() => document.activeElement.dataset.add), "memory");
    await s.page.keyboard.press("Escape");
    assert.deepEqual(await s.page.evaluate(() => [document.getElementById("addmenu").hidden, document.activeElement.id]), [true, "btn-add"]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("ChatDGC's and a Pip's menus draw exactly as Work's, and ChatDGC's model picker has the same rows and answers a list's keys", async (t) => {
  if (skipOrFail(t)) return;
  const work = await openWorkTab(browser, { width: 900, height: 760 });
  let workLook;
  try {
    await work.page.click("#btn-mode");
    workLook = await work.page.evaluate(LOOK, ["#modemenu", ".dgc-menu-row"]);
  } finally { await work.page.close(); }

  const chat = await openChat(browser, { width: 900, height: 700 });
  try {
    await chat.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await chat.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud", "qwen3.6:cloud"], current: "glm-5.3:cloud" });
    // Its model picker (media/shared/modelpicker.js): the same rows, and the keys a list answers.
    await chat.page.click("#cd-model-pill");
    const rowLook = await chat.page.evaluate(() => { const r = document.querySelector(".dgc-mp .dgc-mp-row:not([aria-selected='true'])"), s = getComputedStyle(r); return { rowRadius: s.borderTopLeftRadius, rowFont: s.fontSize }; });
    assert.deepEqual(rowLook, { rowRadius: workLook.rowRadius, rowFont: workLook.rowFont }, "the picker's rows are the shared menu's rows");
    const focused = () => chat.page.evaluate(() => document.activeElement?.querySelector?.(".dgc-mp-name")?.textContent || document.activeElement?.className);
    const order = await chat.page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-name")].map((r) => r.textContent));
    const opened = await focused();
    assert.match(opened, /glm-5\.3/, "it opens on the chosen model");
    await chat.page.keyboard.press("ArrowDown");
    assert.equal(await focused(), order[order.indexOf(opened) + 1], "Down moves to the next row");
    await chat.page.keyboard.press("ArrowUp");
    assert.equal(await focused(), opened, "and Up back");
    await chat.page.keyboard.press("Escape");
    assert.deepEqual(await chat.page.evaluate(() => [!document.querySelector(".dgc-mp-layer"), document.activeElement.id]), [true, "cd-model-pill"]);
    await chat.send({ type: "artifacts", offered: OFFER });
    await chat.page.click("#cd-output");
    assert.deepEqual(await chat.page.evaluate(LOOK, ["#cd-output-menu", ".dgc-menu-row"]), workLook, "and so is its Artifact menu");
    // Its words' own width against the box they got: half a pixel short draws "A…" (seen live, 9 Nov).
    const auto = await chat.page.evaluate(() => {
      const l = document.querySelector('#cd-output-menu [data-output="auto"] .dgc-menu-label'), range = document.createRange();
      range.selectNodeContents(l);
      return [range.getBoundingClientRect().width, l.getBoundingClientRect().width];
    });
    assert.ok(auto[1] >= auto[0] - 0.01, `a long hint is cut before the row's name ("Auto" read "A…"): words ${auto[0]}, box ${auto[1]}`);
    await chat.page.keyboard.press("End");
    await chat.page.keyboard.press("Escape");
    assert.deepEqual(await chat.page.evaluate(() => [document.getElementById("cd-output-menu").hidden, document.activeElement.id]), [true, "cd-output"]);
    assert.deepEqual(chat.errors, []);
  } finally { await chat.page.close(); }

  // A Pip's menus, as its bundle styles them (tokens, the shared menu, then pips.css), with the classes its markup carries.
  const pip = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
  try {
    const css = readStylesheet(TOKENS_CSS) + readStylesheet(new URL("../media/shared/menu.css", import.meta.url)) + readStylesheet(new URL("../src/pips.css", import.meta.url));
    await pip.setContent(`<style>${css}</style><style>:root{--vscode-font-family:system-ui,sans-serif;--vscode-editor-font-family:ui-monospace,monospace;${THEMES["dark-modern"]}}</style>
      <body class="vscode-dark pip-app-root"><div class="pip-composer" style="position:relative;margin:420px 40px 0;width:400px">
      <div class="composer-add-menu dgc-menu" role="menu"><div class="dgc-menu-head">Add to the message</div>
      <button type="button" class="dgc-menu-row" role="menuitem" aria-checked="true"><span class="dgc-menu-icon"></span><span class="dgc-menu-label">Upload pictures and files</span></button>
      <button type="button" class="dgc-menu-row" role="menuitem"><span class="dgc-menu-icon"></span><span class="dgc-menu-label">Take a screenshot</span></button></div></div>
      <details class="pip-menu" open style="margin:20px 40px"><summary>More</summary><div class="tabs-menu dgc-menu dgc-menu-rows"><button type="button">Workspace context</button><button type="button">Notifications</button></div></details></body>`);
    const pipLook = await pip.evaluate(LOOK, [".composer-add-menu", ".dgc-menu-row"]);
    assert.deepEqual(pipLook, { ...workLook, menuPad: pipLook.menuPad }, "a Pip's Add menu is Work's menu");
    assert.equal(pipLook.menuPad, workLook.menuPad, "with the same padding");
    const pageLook = await pip.evaluate(LOOK, [".tabs-menu", "button"]);
    assert.deepEqual(pageLook, workLook, "and so is a Pip's page menu");
  } finally { await pip.close(); }
});

test("the ⋯ fades in, but goes at once when the pointer leaves: a Main or Fallback word never slides under it (9 Nov)", async () => {
  // Seen live: the row's room for the ⋯ goes at once when the pointer leaves, so for the 100 ms the ⋯ took to fade out,
  // the word moved back under it.
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../media/shared/menu.css", import.meta.url), "utf8");
  const resting = css.match(/\.dgc-menu \.dgc-menu-more \{([^}]*)\}/)[1];
  assert.doesNotMatch(resting.match(/transition:[^;]*/)?.[0] || "", /opacity/, "at rest it has no fade: leaving takes it away at once");
  const shown = css.match(/\.dgc-menu \.dgc-menu-item:is\(:hover, :has\(:focus-visible\)\) > \.dgc-menu-more, \.dgc-menu \.dgc-menu-more\[aria-expanded="true"\] \{([^}]*)\}/)[1];
  assert.match(shown, /opacity: 1/);
  assert.match(shown, /transition:[^;]*opacity/, "it still fades in");
});

test("a long name stays on one line and slides to show its end while its row is pointed at or focused; a short one never moves (9 Nov)", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="m" class="dgc-menu"><button class="dgc-menu-row" id="long"><span class="dgc-menu-label">deepseek-v4.1-flash:cloud</span></button><button class="dgc-menu-row" id="short"><span class="dgc-menu-label">glm</span></button></div></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/menu.js") + "\n" + read("media/shared/icons.js"));
  const $ = (id) => dom.window.document.getElementById(id);
  const label = (id) => $(id).querySelector(".dgc-menu-label");
  for (const [id, scroll, client] of [["long", 260, 180], ["short", 40, 180]]) {
    Object.defineProperty(label(id), "scrollWidth", { value: scroll });
    Object.defineProperty(label(id), "clientWidth", { value: client });
  }
  dom.window.DgcMenu.slide($("m"));
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  $("long").dispatchEvent(new dom.window.Event("pointerover", { bubbles: true })); await frame(); await frame();
  assert.ok(label("long").classList.contains("is-sliding"), "pointed at: it slides");
  assert.equal(label("long").style.getPropertyValue("--dgc-slide"), "-80px", "as far as its hidden end, no further");
  $("long").dispatchEvent(new dom.window.Event("pointerout", { bubbles: true }));
  assert.ok(!label("long").classList.contains("is-sliding"), "left: it stops, at rest with its …");
  $("short").dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); await frame(); await frame();
  assert.ok(!label("short").classList.contains("is-sliding"), "a name that fits never moves");
  const own = $("long").matches.bind($("long"));
  $("long").matches = (selector) => (selector === ":focus-visible" ? true : own(selector));     // reached by the keyboard
  $("long").dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); await frame(); await frame();
  assert.ok(label("long").classList.contains("is-sliding"), "reached by the keyboard: it slides too");
  const css = read("media/shared/menu.css");
  assert.match(css, /\.dgc-menu \.dgc-menu-label\.is-sliding \{[^}]*animation: dgc-menu-slide/);
  assert.match(css, /@keyframes dgc-menu-slide/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.dgc-menu \.dgc-menu-label\.is-sliding \{ animation: none;/, "still for reduced motion");
});

test("a menu that redraws its rows keeps the pointed or focused long name sliding from where it was (9 Nov)", async () => {
  // Seen live: a Pip's menu redraws every second or so, and each redraw stopped the slide (a new row, at rest).
  const dom = new JSDOM(`<!doctype html><body><div id="m" class="dgc-menu"></div></body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/menu.js") + "\n" + read("media/shared/icons.js"));
  const doc = dom.window.document, menu = doc.getElementById("m");
  const draw = () => {
    menu.innerHTML = `<button class="dgc-menu-row" data-chat-model="default"><span class="dgc-menu-label">Default (deepseek-v4.1-flash:cloud)</span></button>`;
    const label = menu.querySelector(".dgc-menu-label");
    Object.defineProperty(label, "scrollWidth", { value: 240 });
    Object.defineProperty(label, "clientWidth", { value: 200 });
    return menu.querySelector(".dgc-menu-row");
  };
  dom.window.DgcMenu.slide(menu);
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  let row = draw();
  row.focus(); row.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); await frame(); await frame();
  assert.ok(row.querySelector(".dgc-menu-label").classList.contains("is-sliding"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  row = draw(); row.focus();                       // the menu redraws; the same row keeps the focus
  await frame(); await frame(); await frame();
  const label = row.querySelector(".dgc-menu-label");
  assert.ok(label.classList.contains("is-sliding"), "the new row slides too");
  assert.match(label.style.getPropertyValue("--dgc-slide-delay"), /^-0\.[0-9]+s$/, "from where it was: its animation started that far back");
});

test("a row the menu focused by itself (on opening) doesn't slide; one reached by the keyboard does; a start no longer wanted is dropped (9 Nov)", async () => {
  const dom = new JSDOM(`<!doctype html><body><div id="m" class="dgc-menu"><button class="dgc-menu-row" id="r"><span class="dgc-menu-label">deepseek-v4.1-flash:cloud</span></button></div></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/menu.js") + "\n" + read("media/shared/icons.js"));
  const row = dom.window.document.getElementById("r"), label = row.querySelector(".dgc-menu-label");
  Object.defineProperty(label, "scrollWidth", { value: 260 });
  Object.defineProperty(label, "clientWidth", { value: 180 });
  let keyboard = false;
  const matches = row.matches.bind(row);
  row.matches = (selector) => (selector === ":focus-visible" ? keyboard : matches(selector));
  dom.window.DgcMenu.slide(dom.window.document.getElementById("m"));
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  row.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); await frame(); await frame();
  assert.ok(!label.classList.contains("is-sliding"), "focused by the menu as it opened: still");
  keyboard = true;
  row.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); await frame(); await frame();
  assert.ok(label.classList.contains("is-sliding"), "reached by the keyboard: it slides");
  keyboard = false;
  row.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
  assert.ok(!label.classList.contains("is-sliding"), "the focus gone: still");
  row.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
  row.dispatchEvent(new dom.window.Event("pointerout", { bubbles: true }));   // gone before its frame came
  await frame(); await frame();
  assert.ok(!label.classList.contains("is-sliding"), "a start no longer wanted is dropped");
});

test("a row redrawn under a pointer that doesn't move keeps its long name sliding (found by where the pointer is) (9 Nov)", async () => {
  // Seen live: choosing a fallback redraws Work's menu, and a redrawn row isn't hovered until the pointer moves.
  const dom = new JSDOM(`<!doctype html><body><div id="m" class="dgc-menu"></div></body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/menu.js") + "\n" + read("media/shared/icons.js"));
  const doc = dom.window.document, menu = doc.getElementById("m");
  const draw = () => {
    menu.innerHTML = `<button class="dgc-menu-row" data-i="2"><span class="dgc-menu-label">deepseek-v4.1-flash:cloud</span></button>`;
    const label = menu.querySelector(".dgc-menu-label");
    Object.defineProperty(label, "scrollWidth", { value: 260 });
    Object.defineProperty(label, "clientWidth", { value: 180 });
    return menu.querySelector(".dgc-menu-row");
  };
  doc.elementFromPoint = () => menu.querySelector(".dgc-menu-label");
  dom.window.DgcMenu.slide(menu);
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  const first = draw();
  first.dispatchEvent(new dom.window.MouseEvent("pointerover", { bubbles: true, clientX: 60, clientY: 15 }));
  draw();                                          // redrawn before its first frame, the pointer still
  await frame(); await frame(); await frame();
  assert.ok(menu.querySelector(".dgc-menu-label").classList.contains("is-sliding"), "the new row under the pointer slides");
});

test("while a long name slides, its tooltip stays away (it would cover the row above); still, for reduced motion, it keeps it (9 Nov)", async () => {
  for (const reduced of [false, true]) {
    const dom = new JSDOM(`<!doctype html><body><div id="m" class="dgc-menu"><button class="dgc-menu-row" id="r"><span class="dgc-menu-label" title="deepseek-v4.1-flash:cloud">deepseek-v4.1-flash:cloud</span></button></div></body>`,
      { runScripts: "outside-only", pretendToBeVisual: true });
    dom.window.matchMedia = (query) => ({ matches: reduced && /prefers-reduced-motion: reduce/.test(query) });
    dom.window.eval(read("media/shared/menu.js") + "\n" + read("media/shared/icons.js"));
    const row = dom.window.document.getElementById("r"), label = row.querySelector(".dgc-menu-label");
    Object.defineProperty(label, "scrollWidth", { value: 260 });
    Object.defineProperty(label, "clientWidth", { value: 180 });
    dom.window.DgcMenu.slide(dom.window.document.getElementById("m"));
    const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    row.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true })); await frame(); await frame();
    assert.equal(label.getAttribute("title"), reduced ? "deepseek-v4.1-flash:cloud" : null, reduced ? "still: its tooltip says it" : "sliding: no tooltip over the row above");
    row.dispatchEvent(new dom.window.Event("pointerout", { bubbles: true }));
    assert.equal(label.getAttribute("title"), "deepseek-v4.1-flash:cloud", "at rest its tooltip is back");
  }
});
