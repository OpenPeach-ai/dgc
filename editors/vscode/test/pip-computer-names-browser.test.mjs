// A Pip's computers have names (pips-17d; Pips API 86), in real Chromium with the real client and its CSS
// (test/support/pip-chat-scene.mjs, opts.convs.computers and .states). With more than one computer, the computer icon
// in its chat opens a menu right under it: "Its computers", then each one with a dot for its state, its name and the
// state in words; a row opens that computer's tab, its pencil renames it in place, and "Add another" sits below a
// hairline while it may have more. Arrows move, Enter opens, Escape goes back to the icon. The icon carries one small
// dot for the most urgent state. With one computer, or a runtime before API 86, the icon opens it at once, as before.
// Its Settings page lists the names under "Computers: N", each with Rename.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat, PIP } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const STATES = ["closed", { state: "working", doing: "Find a flat in Pune" }, "needs_you"];
const open = (opts = {}) => openChat(browser, { width: 700, height: 800, api: 86, ...opts, convs: { computers: 3, states: STATES, ...(opts.convs || {}) } });
const inPage = (p, fn, arg) => p.evaluate(([code, a]) => new Function("root", "arg", `return (${code})(root, arg)`)(window.__pipsRoot || document, a), [fn.toString(), arg]);
const focused = (p) => inPage(p, (root) => root.activeElement?.id || "");
const posted = (p) => p.evaluate(() => (window.__posted || []).filter((m) => m.type === "pipsOpenComputer"));
const sent = (p, type) => p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t), type);
const rows = (p) => inPage(p, (root) => [...root.querySelectorAll("#computer-menu .computer-row")].map((r) => [r.querySelector(".dgc-menu-label").textContent, r.querySelector(".computer-state").dataset.state, r.querySelector(".dgc-menu-sub").textContent]));
const menuOpen = async (p) => { await p.click("#pip-computer-open"); await p.waitForSelector("#computer-menu .computer-row"); };

test("with several computers the icon opens a menu right under it: each one's name, a dot for its state and the state in words", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, where] of [[700, "tab"], [300, "side"]]) {
    const x = await open({ width, where });
    try {
      await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
      assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-menu")), null, "closed until asked for");
      await menuOpen(x.p);
      assert.equal(await inPage(x.p, (root) => root.querySelector("#pip-computer-open").getAttribute("aria-expanded")), "true");
      assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-menu .dgc-menu-head").textContent), "Its computers");
      assert.deepEqual(await rows(x.p), [["Juniper", "closed", "Closed"], ["Wren", "working", "Working: Find a flat in Pune"], ["Maple", "needs_you", "Needs you"]]);
      assert.deepEqual(await posted(x.p), [], "opening the menu opens no computer");
      const box = await inPage(x.p, (root) => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
        const menu = root.querySelector("#computer-menu"), icon = root.querySelector("#pip-computer-open");
        return { menu: r(menu), icon: r(icon), view: [innerWidth, innerHeight], classes: menu.className, role: menu.getAttribute("role"),
          rows: [...menu.querySelectorAll(".computer-row")].map((e) => ({ ...r(e), clipped: e.querySelector(".dgc-menu-label").scrollWidth > e.querySelector(".dgc-menu-label").clientWidth + 1 })),
          dots: [...menu.querySelectorAll(".computer-state")].map((e) => { const s = getComputedStyle(e, "::before"); return { state: e.dataset.state, ground: s.backgroundColor, edge: parseFloat(s.borderTopWidth) || 0, size: parseFloat(s.width) }; }),
          scrolls: (root.host || document.documentElement).scrollWidth > innerWidth + 1 };
      });
      assert.match(box.classes, /\bdgc-menu\b/, "the shared menu");
      assert.equal(box.role, "menu");
      assert.ok(box.menu.top >= box.icon.bottom - 6 && box.menu.top <= box.icon.bottom + 12, `right under the icon at ${width}px: ${box.menu.top} vs ${box.icon.bottom}`);
      const middle = (box.icon.left + box.icon.right) / 2;
      assert.ok(box.menu.left <= middle && middle <= box.menu.right, `under the icon, not elsewhere, at ${width}px`);
      assert.ok(box.menu.left >= 0 && box.menu.right <= box.view[0] + 0.5, `inside the page at ${width}px: ${box.menu.left}..${box.menu.right}`);
      assert.equal(box.scrolls, false, "the page doesn't scroll sideways");
      for (const row of box.rows) { assert.ok(row.height >= 32, "a row is tall enough to press"); assert.equal(row.clipped, false, "a short name shows whole"); }
      const dot = Object.fromEntries(box.dots.map((d) => [d.state, d]));
      assert.equal(dot.closed.ground, "rgba(0, 0, 0, 0)", "closed is a hollow ring");
      assert.ok(dot.closed.edge >= 1, "with an edge");
      assert.notEqual(dot.working.ground, "rgba(0, 0, 0, 0)");
      assert.equal(dot.needs_you.ground, "rgb(209, 144, 43)", "needs you is amber");
      assert.notEqual(dot.working.ground, dot.needs_you.ground);
      assert.ok(box.dots.every((d) => d.size >= 6 && d.size <= 9), "small dots");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("an open computer's dot is filled and neutral, and the icon's own dot says the most urgent state", async (t) => {
  if (skipOrFail(t)) return;
  const corner = (p) => inPage(p, (root) => { const b = root.querySelector("#pip-computer-open"), d = b.querySelector(".computer-corner"); return [d ? d.dataset.state : "", b.getAttribute("aria-label")]; });
  const x = await open({ convs: { computers: 3, states: ["open", { state: "working", doing: "Book the train" }, "needs_you"] } });
  try {
    await x.p.waitForSelector("#pip-computer-open .computer-corner");
    assert.deepEqual(await corner(x.p), ["needs_you", "Computers: one needs you"]);
    await menuOpen(x.p);
    const styles = await inPage(x.p, (root) => Object.fromEntries([...root.querySelectorAll("#computer-menu .computer-state")].map((e) => [e.dataset.state, getComputedStyle(e, "::before").backgroundColor])));
    assert.notEqual(styles.open, "rgba(0, 0, 0, 0)", "open is filled");
    assert.notEqual(styles.open, styles.working, "and not the running colour");
    assert.notEqual(styles.open, styles.needs_you);
    assert.deepEqual((await rows(x.p)).map((r) => r[2]), ["Open", "Working: Book the train", "Needs you"]);
  } finally { await x.close(); }
  const working = await open({ convs: { computers: 2, states: ["open", "working"] } });
  try {
    await working.p.waitForSelector("#pip-computer-open .computer-corner");
    assert.deepEqual(await corner(working.p), ["working", "Computers: one is working"]);
  } finally { await working.close(); }
  const quiet = await open({ convs: { computers: 2, states: ["open", "closed"] } });
  try {
    await quiet.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    assert.deepEqual(await corner(quiet.p), ["", "Computers"], "no dot when all are closed or open");
  } finally { await quiet.close(); }
});

test("a row opens that computer's tab, by its number", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    await menuOpen(x.p);
    await x.p.click("#computer-row-2");
    await x.p.waitForFunction(() => (window.__posted || []).some((m) => m.type === "pipsOpenComputer"));
    const asked = await posted(x.p);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].pip.id, PIP);
    assert.equal(asked[0].number, 2);
    assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-menu")), null, "the menu closes");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the keys: Enter on the icon opens the menu on its first row, arrows move, Enter opens, Escape goes back to the icon", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ convs: { limit: 4 } });
  try {
    await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    await x.p.focus("#pip-computer-open");
    await x.p.keyboard.press("Enter");
    await x.p.waitForSelector("#computer-menu .computer-row");
    assert.equal(await focused(x.p), "computer-row-1", "focus lands on the first computer");
    await x.p.keyboard.press("ArrowDown");
    assert.equal(await focused(x.p), "computer-row-2");
    await x.p.keyboard.press("ArrowRight");
    assert.equal(await focused(x.p), "computer-rename-2", "Right reaches the row's Rename");
    await x.p.keyboard.press("ArrowLeft");
    assert.equal(await focused(x.p), "computer-row-2");
    await x.p.keyboard.press("ArrowDown"); await x.p.keyboard.press("ArrowDown");
    assert.equal(await focused(x.p), "computer-add", "Add another is the last stop while it may have more");
    await x.p.keyboard.press("ArrowDown");
    assert.equal(await focused(x.p), "computer-row-1", "and round again");
    await x.p.keyboard.press("ArrowUp"); await x.p.keyboard.press("ArrowUp");
    assert.equal(await focused(x.p), "computer-row-3");
    await x.p.keyboard.press("Escape");
    await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("#computer-menu"));
    assert.equal(await focused(x.p), "pip-computer-open", "Escape gives focus back to the icon");
    assert.deepEqual(await posted(x.p), []);
    await x.p.keyboard.press("ArrowDown");
    await x.p.waitForSelector("#computer-menu .computer-row");
    assert.equal(await focused(x.p), "computer-row-1", "Down on the icon opens it too");
    await x.p.keyboard.press("ArrowDown"); await x.p.keyboard.press("ArrowDown");
    await x.p.keyboard.press("Enter");
    await x.p.waitForFunction(() => (window.__posted || []).some((m) => m.type === "pipsOpenComputer"));
    assert.equal((await posted(x.p))[0].number, 3, "Enter opens the focused one");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Rename is done in the row: Enter saves, Escape cancels, and a refused name says why in the menu", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 300, where: "side" });
  try {
    await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    await menuOpen(x.p);
    assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-rename-1").getAttribute("aria-label")), "Rename Juniper");
    await x.p.hover("#computer-row-1");
    await x.p.click("#computer-rename-1");
    await x.p.waitForSelector("#computer-rename-input");
    assert.equal(await focused(x.p), "computer-rename-input");
    const box = await inPage(x.p, (root) => { const i = root.querySelector("#computer-rename-input"), r = i.getBoundingClientRect(), m = root.querySelector("#computer-menu").getBoundingClientRect();
      return { value: i.value, picked: [i.selectionStart, i.selectionEnd], max: i.maxLength, inside: r.left >= m.left && r.right <= m.right, width: r.width, rows: root.querySelectorAll("#computer-menu .computer-row").length }; });
    assert.equal(box.value, "Juniper"); assert.deepEqual(box.picked, [0, 7], "its name is selected, ready to type over");
    assert.equal(box.max, 30); assert.ok(box.inside && box.width >= 120, "the box fits the menu at 300 px");
    assert.equal(box.rows, 2, "the other rows stay");
    await x.p.keyboard.type("Shopping desk");
    await x.p.keyboard.press("Escape");
    await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("#computer-rename-input"));
    assert.equal(await focused(x.p), "computer-row-1", "Escape leaves the name and stays in the menu");
    assert.deepEqual(await sent(x.p, "rename_pip_computer"), []);
    assert.equal((await rows(x.p))[0][0], "Juniper");

    await x.p.click("#computer-rename-1");
    await x.p.waitForSelector("#computer-rename-input");
    await x.p.keyboard.type("Shopping desk");
    await x.p.keyboard.press("Enter");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector("#computer-row-1 .dgc-menu-label")?.textContent === "Shopping desk");
    assert.deepEqual(await sent(x.p, "rename_pip_computer"), [{ type: "rename_pip_computer", pip_id: PIP, number: 1, name: "Shopping desk" }]);
    assert.equal(await focused(x.p), "computer-row-1", "focus goes back to its row");

    // A name another of them was given is refused, in DGC's own words, and the box stays for another go.
    await x.p.click("#computer-rename-2");
    await x.p.waitForSelector("#computer-rename-input");
    await x.p.keyboard.type("shopping desk");
    await x.p.keyboard.press("Enter");
    await x.p.waitForSelector("#computer-menu [role=alert]");
    assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-menu [role=alert]").textContent), "Another of its computers is called shopping desk. Choose another name.");
    assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-rename-input").value), "shopping desk");
    // A name it can't have never leaves the page.
    await x.p.fill("#computer-rename-input", "!!");
    const before = (await sent(x.p, "rename_pip_computer")).length;
    await x.p.keyboard.press("Enter");
    await x.p.waitForFunction(() => /letters, digits/.test((window.__pipsRoot || document).querySelector("#computer-menu [role=alert]")?.textContent || ""));
    assert.equal((await sent(x.p, "rename_pip_computer")).length, before, "not sent");
    // An empty name gives it back its first name.
    await x.p.fill("#computer-rename-input", "");
    await x.p.keyboard.press("Escape");
    await x.p.click("#computer-rename-1");
    await x.p.waitForSelector("#computer-rename-input");
    await x.p.fill("#computer-rename-input", "");
    await x.p.keyboard.press("Enter");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector("#computer-row-1 .dgc-menu-label")?.textContent === "Juniper");
    assert.equal((await sent(x.p, "rename_pip_computer")).at(-1).name, "");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Add another sits below a hairline while it may have more, and says which one was added", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ convs: { computers: 2, states: [] } });
  try {
    await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    await menuOpen(x.p);
    const order = await inPage(x.p, (root) => [...root.querySelector("#computer-menu").children].map((e) => e.id || (e.getAttribute("role") === "separator" ? "hairline" : e.className.split(" ")[0])));
    assert.deepEqual(order.slice(-2), ["hairline", "computer-add"]);
    assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-add").textContent.trim()), "Add another");
    await x.p.click("#computer-add");
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelectorAll("#computer-menu .computer-row").length === 3);
    assert.deepEqual((await rows(x.p)).map((r) => r[0]), ["Juniper", "Wren", "Maple"]);
    assert.match(await inPage(x.p, (root) => root.querySelector(".notice")?.textContent || ""), /^Added Maple\./);
    assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-add")), null, "three is its limit: nothing to add");
    assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-menu [role=separator]")), null, "and no hairline over nothing");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("New conversation → Add another says which one was added", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ convs: { computers: 1, states: [] } });
  try {
    await x.p.waitForSelector("#pip-convs");
    await x.p.click("#pip-convs");
    await x.p.click("#conv-menu [data-conv-new]");
    await x.p.waitForSelector("#conv-menu .conv-new-step");
    await x.p.check('#conv-menu .conv-new-step input[value="add"]');
    await x.p.click("#conv-menu .conv-new-step button[type=submit]");
    await x.p.waitForFunction(() => window.__convs.added === 1 && window.__convs.next === 1);
    await x.p.waitForFunction(() => /Added Wren\./.test((window.__pipsRoot || document).querySelector(".notice")?.textContent || ""));
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("the menu reads its computers again while it is open, so a state that changes shows", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ convs: { computers: 2, states: [] } });
  try {
    await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    await menuOpen(x.p);
    assert.deepEqual((await rows(x.p)).map((r) => r[2]), ["Closed", "Closed"]);
    await x.p.focus("#computer-row-2");
    const asked = (await sent(x.p, "get_pip_computer")).length;
    await x.p.evaluate(() => { Object.assign(window.__convs.names[1], { state: "working", doing: "Fill in the visa form" }); });
    await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector("#computer-row-2 .dgc-menu-sub")?.textContent === "Working: Fill in the visa form", null, { timeout: 8000 });
    assert.ok((await sent(x.p, "get_pip_computer")).length > asked, "it asked again by itself");
    assert.equal(await focused(x.p), "computer-row-2", "the redraw keeps the row you were on");
    assert.equal(await inPage(x.p, (root) => root.querySelector("#pip-computer-open .computer-corner")?.dataset.state), "working", "and the icon's dot follows");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a click outside closes the menu; one computer, or a runtime before API 86, opens at once with no number", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    await menuOpen(x.p);
    await x.p.click("#chatText");
    await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("#computer-menu"));
    assert.deepEqual(await posted(x.p), []);
  } finally { await x.close(); }
  for (const [name, opts] of [["one computer", { convs: { computers: 1, states: ["working"] } }], ["API 85", { api: 85 }]]) {
    const y = await open(opts);
    try {
      await y.p.waitForSelector("#pip-computer-open");
      await y.p.waitForFunction(() => (window.__sent || []).some((r) => r.type === "get_pip_computer"));
      await y.p.waitForTimeout(150);
      assert.equal(await inPage(y.p, (root) => root.querySelector("#pip-computer-open").getAttribute("aria-haspopup")), null, `${name}: no menu`);
      await y.p.click("#pip-computer-open");
      await y.p.waitForFunction(() => (window.__posted || []).some((m) => m.type === "pipsOpenComputer"));
      const asked = await posted(y.p);
      assert.equal(asked.length, 1, name);
      assert.equal("number" in asked[0], false, `${name}: no number is sent`);
      assert.equal(await inPage(y.p, (root) => root.querySelector("#computer-menu")), null);
      assert.deepEqual(y.errors, []);
    } finally { await y.close(); }
  }
  // One computer still shows what it is doing on the icon.
  const one = await open({ convs: { computers: 1, states: ["working"] } });
  try {
    await one.p.waitForSelector("#pip-computer-open .computer-corner");
    assert.equal(await inPage(one.p, (root) => root.querySelector("#pip-computer-open").getAttribute("aria-label")), "Computer: working");
  } finally { await one.close(); }
});

test("its Settings page lists the names under “Computers: N”, each with Rename", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 300]) {
    const x = await open({ settings: true, width, where: width === 300 ? "side" : "tab", convs: { computers: 2, states: [] } });
    try {
      await x.p.waitForSelector("#pip-convs");
      await inPage(x.p, (root) => root.querySelector('[data-tab="job"]').click());
      await x.p.waitForSelector("[data-computers] .computer-names li");
      assert.equal(await inPage(x.p, (root) => root.querySelector("[data-computers] .row-words strong").textContent), "Computers: 2");
      assert.deepEqual(await inPage(x.p, (root) => [...root.querySelectorAll(".computer-names li")].map((li) => [li.querySelector(".computer-name").textContent, li.querySelector("button").textContent, li.querySelector("button").getAttribute("aria-label")])),
        [["Juniper", "Rename", "Rename Juniper"], ["Wren", "Rename", "Rename Wren"]]);
      const fit = await inPage(x.p, (root) => { const list = root.querySelector(".computer-names").getBoundingClientRect(); return [...root.querySelectorAll(".computer-names li button")].every((b) => { const r = b.getBoundingClientRect(); return r.right <= list.right + 0.5 && r.left >= list.left && r.height >= 22; }) && list.right <= innerWidth; });
      assert.ok(fit, `each Rename fits its row at ${width}px`);
      await x.p.click('[data-computer-name-rename="2"]');
      await x.p.waitForSelector("#computer-name-input");
      assert.equal(await focused(x.p), "computer-name-input");
      assert.equal(await inPage(x.p, (root) => root.querySelector("#computer-name-input").value), "Wren");
      await x.p.keyboard.type("Travel");
      await x.p.keyboard.press("Enter");
      await x.p.waitForFunction(() => [...(window.__pipsRoot || document).querySelectorAll(".computer-names .computer-name")].map((e) => e.textContent).join() === "Juniper,Travel");
      assert.deepEqual((await sent(x.p, "rename_pip_computer")).at(-1), { type: "rename_pip_computer", pip_id: PIP, number: 2, name: "Travel" });
      // Escape leaves a name as it was.
      await x.p.click('[data-computer-name-rename="1"]');
      await x.p.waitForSelector("#computer-name-input");
      await x.p.keyboard.type("Nope");
      await x.p.keyboard.press("Escape");
      await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector("#computer-name-input"));
      assert.equal((await sent(x.p, "rename_pip_computer")).length, 1);
      // Add another names the new one.
      await x.p.click("#add-computer");
      await x.p.waitForSelector('[data-computers="3"]');
      assert.match(await inPage(x.p, (root) => root.querySelector(".notice")?.textContent || ""), /^Added Maple\. Mornings has 3 computers now/);
      assert.deepEqual(await inPage(x.p, (root) => [...root.querySelectorAll(".computer-names .computer-name")].map((e) => e.textContent)), ["Juniper", "Travel", "Maple"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
