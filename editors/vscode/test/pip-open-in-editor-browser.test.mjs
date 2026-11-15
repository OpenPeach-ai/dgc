// "Open in editor" for a Pip's chat (15 Nov: "each Pip chat should also get the same open in editor icon, in case user
// wants to open a pip chat in editor tab, like we have on work and chat sessions"), the page's side. Measured on the
// real page in real Chromium, dark and light.
//   Where it sits. The chat header is measured to the pixel (pip-chat-header-browser.test.mjs): under 700 px there is
//   no room for one more icon beside the switch, the computer and ⋯ without taking it from the Pip's name, so there it
//   is the first row of ⋯, "Open in editor", as Work's and ChatDGC's rows have it. From 700 px (a tab, a wide side bar)
//   it is also an icon in the header, between the computer and ⋯. A Pip's row in the list has it beside its pin.
//   What it opens. That Pip, that conversation: the page names both and the host opens (or brings forward) its tab.
//   The tab is that conversation's own: no way back to the list, no second "Open in editor", and it tells the host what
//   it shows so the tab's title is right. What is typed in one page shows in the others.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PIP, openChat } from "./support/pip-chat-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const cid = (c) => "conv_" + c.repeat(32);
const GOA = cid("a"), TAX = cid("c");
const ME = { id: PIP, name: "Mornings", pip_type: "lens" };
const open = (o) => openChat(browser, { height: 700, api: 97, convs: true, switches: true, ...o });
const posted = (p, type) => p.evaluate((t) => (window.__posted || []).filter((m) => m.type === t), type);
const bar = (p) => p.evaluate(() => {
  const root = window.__pipsRoot || document, top = root.querySelector(".pip-topbar");
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true }) && n.getBoundingClientRect().width > 0;
  const box = (n) => { if (!seen(n)) return null; const b = n.getBoundingClientRect(), s = getComputedStyle(n); return { left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, width: Math.round(b.width), height: Math.round(b.height), radius: parseFloat(s.borderTopLeftRadius), title: n.getAttribute("title"), label: n.getAttribute("aria-label") }; };
  const pick = top.querySelector("#pip-convs"), b = top.getBoundingClientRect();
  return { open: box(top.querySelector("#pip-open-editor")), computer: box(top.querySelector(".computer-icon")), more: box(top.querySelector(".pip-menu > summary")), back: box(top.querySelector("#simple-back")),
    sw: box(top.querySelector("[role=switch]")), name: box(top.querySelector(".pip-name")), pick: box(pick), centre: (b.left + b.right) / 2, start: b.left, title: top.querySelector(".pip-conv-title")?.textContent || "",
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth || top.scrollWidth > top.clientWidth + 1 };
});
const menu = (p) => p.evaluate(() => { const root = window.__pipsRoot || document, m = root.querySelector(".pip-topbar .pip-menu .tabs-menu");
  return [...m.children].map((n) => n.tagName === "HR" ? "—" : { words: n.textContent.trim(), height: Math.round(n.getBoundingClientRect().height), radius: parseFloat(getComputedStyle(n).borderTopLeftRadius), open: n.hasAttribute("data-open-chat-tab") }); });
const showConv = async (p, id, title) => { const column = await p.evaluate(() => !!(window.__pipsRoot || document).querySelector("#conv-column .conv-row")?.checkVisibility());
  if (column) await p.click(`#conv-column [data-conv="${id}"]`); else { await p.click("#pip-convs"); await p.click(`#conv-menu [data-conv="${id}"]`); }
  await p.waitForFunction(([t]) => ((window.__pipsRoot || document).querySelector(".pip-conv-title")?.textContent || "") === t, [title]); await p.waitForTimeout(120); };

for (const theme of ["dark", "light"]) for (const width of [300, 440]) {
  test(`under 700 px it is the first row of ⋯, and the header keeps its parts as they were (side bar, ${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where: "side", width, theme });
    try {
      await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(200);
      const h = await bar(x.p);
      assert.equal(h.open, null, "no icon is added to a header with no room for one");
      assert.ok(h.back && h.name && h.pick && h.sw && h.computer && h.more, "back, name, threads, switch, computer and ⋯ are all there");
      assert.equal(h.sideways, false);
      await x.p.click(".pip-topbar .pip-menu > summary"); await x.p.waitForTimeout(200);
      const rows = await menu(x.p);
      assert.equal(rows[0].words, "Open in editor", "the same words as Work's and ChatDGC's row");
      assert.equal(rows[0].open, true);
      assert.equal(rows[1], "—", "a line parts it from the Pip's own pages");
      const others = rows.filter((r) => r !== "—" && !r.open);
      assert.ok(others.length >= 3 && others.every((r) => r.height === rows[0].height && r.radius === rows[0].radius), `it is a row like the others: ${JSON.stringify(rows)}`);
      assert.ok(rows[0].radius > 0 && rows[0].radius < rows[0].height / 2, "a row with corners, never a pill");
      await x.p.click(".pip-topbar .pip-menu [data-open-chat-tab]");
      assert.deepEqual(await posted(x.p, "pipsOpenChat"), [{ type: "pipsOpenChat", pip: ME, conversation: { id: "", title: "Chat" } }], "the host is asked for this Pip's chat, this conversation");
      assert.equal(await x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".pip-topbar .pip-menu").open), false, "and the menu closes");
      assert.ok(await x.p.evaluate(() => !!(window.__pipsRoot || document).querySelector("#chat-form")), "the chat stays where it is");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const theme of ["dark", "light"]) for (const [where, width] of [["tab", 700], ["tab", 1100], ["side", 700]]) {
  test(`from 700 px it is also an icon in the header, between the computer and ⋯ (${where === "side" ? "side bar" : "tab"}, ${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where, width, theme });
    try {
      await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(200);
      const h = await bar(x.p);
      assert.ok(h.open, "the icon is drawn");
      assert.equal(h.open.title, "Open in editor"); assert.equal(h.open.label, "Open in editor");
      assert.deepEqual([h.open.width, h.open.height, h.open.radius], [h.computer.width, h.computer.height, h.computer.radius], "one shape with the icons beside it");
      assert.ok(h.open.width === h.open.height && h.open.radius > 0 && h.open.radius < h.open.height / 2, "a square with the header's own corners, never a pill");
      assert.ok(h.sw.right <= h.computer.left && h.computer.right <= h.open.left && h.open.right <= h.more.left, `switch, computer, open, ⋯ in that order, none on another: ${JSON.stringify([h.sw, h.computer, h.open, h.more].map((b) => [b.left, b.right]))}`);
      assert.ok(Math.abs((h.open.left - h.computer.right) - (h.more.left - h.open.right)) <= 0.6, "evenly spaced");
      assert.ok(Math.abs((h.pick.left + h.pick.right) / 2 - h.centre) <= 1, `the thread selector is still centred (${(h.pick.left + h.pick.right) / 2} against ${h.centre})`);
      assert.ok(h.pick.right <= h.sw.left - 4 && h.name.right <= h.pick.left + 0.5, "nothing lies on anything else");
      assert.equal(h.sideways, false);
      await x.p.click("#pip-open-editor");
      assert.deepEqual(await posted(x.p, "pipsOpenChat"), [{ type: "pipsOpenChat", pip: ME, conversation: { id: "", title: "Chat" } }]);
      // The row is in ⋯ here too, as Work has both.
      await x.p.click(".pip-topbar .pip-menu > summary"); await x.p.waitForTimeout(150);
      assert.equal((await menu(x.p))[0].words, "Open in editor");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the icon comes in at 700 px and not before: the header's measured widths are not disturbed", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "side", width: 700 });
  try {
    await x.p.waitForSelector("#pip-convs");
    for (const width of [300, 440, 559, 560, 620, 699, 700, 760, 900]) {
      await x.p.setViewportSize({ width, height: 700 }); await x.p.waitForTimeout(150);
      const h = await bar(x.p);
      assert.equal(!!h.open, width >= 700, `${width}px`);
      if (h.open) assert.ok(h.pick.right <= h.sw.left - 4 && h.open.right <= h.more.left && h.more.right <= width, `${width}px: nothing lies on anything else`);
      assert.equal(h.sideways, false, `${width}px`);
    }
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("it opens the conversation that is shown, by its id and its name", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab", width: 700 });
  try {
    await x.p.waitForSelector("#pip-convs");
    await showConv(x.p, GOA, "Trip to Goa");
    await x.p.click("#pip-open-editor");
    assert.deepEqual(await posted(x.p, "pipsOpenChat"), [{ type: "pipsOpenChat", pip: ME, conversation: { id: GOA, title: "Trip to Goa" } }]);
    assert.equal((await bar(x.p)).title, "Trip to Goa", "the page itself stays on it");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("an older DGC (one chat a Pip) has the row too, and names no conversation", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { where: "side", width: 440, height: 700, api: 78 });
  try {
    await x.p.click(".pip-topbar .pip-menu > summary"); await x.p.waitForTimeout(150);
    assert.equal((await menu(x.p))[0].words, "Open in editor");
    await x.p.click(".pip-topbar .pip-menu [data-open-chat-tab]");
    assert.deepEqual(await posted(x.p, "pipsOpenChat"), [{ type: "pipsOpenChat", pip: ME }]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const theme of ["dark", "light"]) {
  test(`a Pip's row in the list has it beside the row's end, shown when the row is pointed at or reached by Tab (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where: "side", width: 440, theme, home: true });
    try {
      const row = () => x.p.evaluate((pip) => { const root = window.__pipsRoot || document, b = root.querySelector(`[data-open-pip-chat="${pip}"]`), line = root.querySelector(`[data-job="${pip}"]`);
        if (!b) return null; const r = b.getBoundingClientRect(), l = line.getBoundingClientRect(), s = getComputedStyle(b), sw = root.querySelector(`[data-pip-line="${pip}"] [role=switch]`)?.getBoundingClientRect();
        const pin = root.querySelector(`[data-pin-pip="${pip}"]`), pr = pin?.getBoundingClientRect(), ps = pin && getComputedStyle(pin);
        return { opacity: Number(s.opacity), shape: [Math.round(r.width), Math.round(r.height), s.borderTopLeftRadius], inRow: r.left >= l.left && r.right <= l.right + 0.5 && r.top >= l.top && r.bottom <= l.bottom,
          clearOfSwitch: !sw || r.right <= sw.left, label: b.getAttribute("aria-label"), title: b.getAttribute("title"), nameRight: root.querySelector(`[data-job="${pip}"] .pip-row-name`).getBoundingClientRect().right, left: r.left, right: r.right,
          mid: (r.top + r.bottom) / 2, rowMid: (l.top + l.bottom) / 2,
          pin: pin ? { shape: [Math.round(pr.width), Math.round(pr.height), ps.borderTopLeftRadius], left: pr.left, right: pr.right, opacity: Number(ps.opacity), mid: (pr.top + pr.bottom) / 2 } : null }; }, PIP);
      const rest = await row();
      assert.ok(rest, "the row has the control");
      assert.equal(rest.opacity, 0, "at rest the row is as it was");
      await x.p.hover(`[data-job="${PIP}"]`); await x.p.waitForTimeout(250);
      const over = await row();
      assert.equal(over.opacity, 1, "pointed at, it shows");
      assert.equal(over.title, "Open in editor"); assert.equal(over.label, "Open in editor: Mornings");
      assert.ok(over.shape[0] <= 28 && over.shape[1] <= 28 && parseFloat(over.shape[2]) > 0 && parseFloat(over.shape[2]) < over.shape[0] / 2 + 0.01, `a small button with corners, never a pill: ${JSON.stringify(over.shape)}`);
      assert.ok(Math.abs(over.mid - over.rowMid) <= 1, "level with the row's middle");
      assert.ok(over.inRow && over.clearOfSwitch, "inside the row, clear of its switch");
      assert.ok(over.nameRight <= over.left, "the row's words make room for it");
      // With the dock's pin beside it: one shape, side by side, neither on the other, the words clear of both.
      await x.p.evaluate(() => window.postMessage({ type: "dock", pinned: ["work:another"] }, "*")); await x.p.waitForTimeout(200);
      await x.p.hover(`[data-job="${PIP}"]`); await x.p.waitForTimeout(250);
      const both = await row();
      assert.ok(both.pin, "the pin is drawn");
      assert.deepEqual(both.shape, both.pin.shape, "the same button as the pin");
      assert.equal(both.pin.opacity, 1); assert.equal(both.opacity, 1);
      assert.ok(both.right <= both.pin.left && both.pin.left - both.right <= 8, `side by side: ${both.right} then ${both.pin.left}`);
      assert.ok(Math.abs(both.mid - both.pin.mid) <= 0.5, "level with each other");
      assert.ok(both.nameRight <= both.left && both.inRow && both.clearOfSwitch, "the words make room for both");
      await x.p.click(`[data-open-pip-chat="${PIP}"]`);
      assert.deepEqual(await posted(x.p, "pipsOpenChat"), [{ type: "pipsOpenChat", pip: ME }], "the host is asked for that Pip's chat (the conversation it last showed, if any)");
      assert.equal(await x.p.evaluate(() => !!(window.__pipsRoot || document).querySelector("#chat-form")), false, "the list stays: the chat opens in its tab, not here");
      // By keyboard: Tab from the row reaches it, and it shows.
      await x.p.evaluate((pip) => (window.__pipsRoot || document).querySelector(`[data-job="${pip}"]`).focus(), PIP);
      const onIt = () => x.p.evaluate(() => { const a = (window.__pipsRoot || document).activeElement || document.activeElement; return a?.hasAttribute?.("data-open-pip-chat") ? Number(getComputedStyle(a).opacity) : -1; });
      let focused = -1;   // (its "Read" dot, when it has something new, comes first)
      for (let i = 0; i < 2 && focused < 0; i++) { await x.p.keyboard.press("Tab"); await x.p.waitForTimeout(150); focused = await onIt(); }
      assert.equal(focused, 1, "Tab reaches it after its row, and it is in sight");
      // In a side bar of 340 px and under the row has no room for it beside its pin, its dot and its switch without
      // taking the Pip's name: it is not drawn there (the chat's own menu has it), and the name keeps what it had.
      for (const width of [340, 300]) {
        await x.p.setViewportSize({ width, height: 700 }); await x.p.hover(`[data-job="${PIP}"]`); await x.p.waitForTimeout(250);
        const narrow = await x.p.evaluate((pip) => { const root = window.__pipsRoot || document, b = root.querySelector(`[data-open-pip-chat="${pip}"]`), pin = root.querySelector(`[data-pin-pip="${pip}"]`), name = root.querySelector(`[data-job="${pip}"] .pip-row-name`);
          return { open: !!b && b.checkVisibility() && b.getBoundingClientRect().width > 0, pin: !!pin && pin.checkVisibility(), nameRoom: Math.round(pin.getBoundingClientRect().left - name.getBoundingClientRect().left) }; }, PIP);
        assert.equal(narrow.open, false, `${width}px: not drawn`);
        assert.equal(narrow.pin, true, `${width}px: its pin stays`);
        assert.ok(narrow.nameRoom >= 60, `${width}px: the name keeps its room (${narrow.nameRoom}px to the pin)`);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const [width, theme] of [[700, "dark"], [700, "light"], [440, "dark"], [1100, "dark"]]) {
  test(`the editor tab is that conversation's own: no way back to the list, no second Open in editor, and its title follows what it shows (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ where: "tab", width, theme, pinned: { pip: PIP, conversation: GOA } });
    try {
      await x.p.waitForFunction(() => /Bhakti Kutir is held/.test(document.querySelector(".conversation-log")?.textContent || ""), null, { timeout: 6000 });
      const h = await bar(x.p);
      assert.equal(h.back, null, "no Back: there is no list behind this tab");
      assert.equal(h.open, null, "no Open in editor: this is the editor");
      assert.ok(h.name && h.computer && h.more, "its name, its computer and ⋯ are there");
      assert.ok(h.name.left - h.start <= 64, `its face and name start the bar (${h.name.left - h.start}px in)`);
      assert.equal(h.sideways, false);
      await x.p.click(".pip-topbar .pip-menu > summary"); await x.p.waitForTimeout(150);
      assert.equal((await menu(x.p)).some((r) => r !== "—" && r.open), false, "nor is it in ⋯");
      await x.p.keyboard.press("Escape");
      assert.deepEqual((await posted(x.p, "pipsChatShown")).at(-1), { type: "pipsChatShown", pip: { id: PIP, name: "Mornings" }, conversation: { id: GOA, title: "Trip to Goa" } }, "it tells the host what it shows, for the tab's title");
      assert.deepEqual(await posted(x.p, "pipsOpenChat"), []);
      // Another conversation, chosen here, opens in its own tab; this one stays on its own.
      await x.p.evaluate(() => { const m = (window.__pipsRoot || document).querySelector(".pip-topbar .pip-menu"); if (m) m.open = false; });
      const column = await x.p.evaluate(() => !!document.querySelector("#conv-column .conv-row")?.checkVisibility());
      if (column) await x.p.click(`#conv-column [data-conv="${TAX}"]`); else { await x.p.click("#pip-convs"); await x.p.click(`#conv-menu [data-conv="${TAX}"]`); }
      await x.p.waitForTimeout(300);
      assert.deepEqual(await posted(x.p, "pipsOpenChat"), [{ type: "pipsOpenChat", pip: ME, conversation: { id: TAX, title: "Tax papers" } }]);
      assert.match(await x.p.evaluate(() => document.querySelector(".conversation-log").textContent), /Bhakti Kutir is held/, "this tab still shows its own conversation");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a tab on a Pip's first conversation says so, and one whose conversation is gone shows the first and says that", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab", width: 700, pinned: { pip: PIP, conversation: "" } });
  try {
    await x.p.waitForSelector(".pip-message");
    await x.p.waitForFunction(() => (window.__posted || []).some((m) => m.type === "pipsChatShown"));
    assert.deepEqual((await posted(x.p, "pipsChatShown")).at(-1), { type: "pipsChatShown", pip: { id: PIP, name: "Mornings" }, conversation: { id: "", title: "Chat" } });
  } finally { await x.close(); }
  const gone = await open({ where: "tab", width: 700, pinned: { pip: PIP, conversation: cid("1") } });   // (archived: "Old plans")
  try {
    await gone.p.waitForSelector(".pip-message");
    await gone.p.waitForFunction(() => (window.__posted || []).some((m) => m.type === "pipsChatShown" && m.conversation.id === ""), null, { timeout: 6000 });
    assert.equal((await posted(gone.p, "pipsOpenChat")).length, 0, "it asks for no other tab: it is the first conversation's now, and says so");
    assert.deepEqual(gone.errors, []);
  } finally { await gone.close(); }
});

test("what is typed in one page shows in the other: the draft goes to the host as it changes, and one from the host is put in the box", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab", width: 700 });
  try {
    await x.p.waitForSelector("#pip-convs");
    const type = (words) => x.p.evaluate((w) => { const b = document.querySelector("#chatText"); b.focus(); document.execCommand("insertText", false, w); }, words);
    await type("Hold the room");
    await x.p.waitForFunction(() => (window.__posted || []).some((m) => m.type === "pipsChatDraft" && m.text === "Hold the room"), null, { timeout: 3000 });
    const mine = (await posted(x.p, "pipsChatDraft")).at(-1);
    assert.deepEqual({ pip_id: mine.pip_id, conversation_id: mine.conversation_id, text: mine.text }, { pip_id: PIP, conversation_id: "", text: "Hold the room" });
    // From the other page: its words replace the box's, a link in them a pill, and nothing is echoed back.
    const count = (await posted(x.p, "pipsChatDraft")).length;
    await x.p.evaluate((pip) => window.postMessage({ type: "pipsChatDraft", pip_id: pip, conversation_id: "", text: "Hold https://stay.example/42 please",
      parts: ["Hold ", { kind: "link", label: "https://stay.example/42", wire: "https://stay.example/42", identity: "" }, " please"] }, "*"), PIP);
    await x.p.waitForFunction(() => document.querySelector("#chatText").value === "Hold https://stay.example/42 please", null, { timeout: 3000 });
    assert.deepEqual(await x.p.evaluate(() => [...document.querySelectorAll("#chatText [data-pill]")].map((n) => [n.dataset.kind, n.dataset.pill])), [["link", "https://stay.example/42"]]);
    await x.p.waitForTimeout(400);
    assert.equal((await posted(x.p, "pipsChatDraft")).length, count, "what it was told is not said back");
    assert.equal(await x.p.evaluate(() => document.querySelector("#chat-form .chat-send").classList.contains("ready")), true, "Send is ready for it");
    // Another conversation's draft waits for that conversation.
    await x.p.evaluate(([pip, conv]) => window.postMessage({ type: "pipsChatDraft", pip_id: pip, conversation_id: conv, text: "Also the 18th?" }, "*"), [PIP, GOA]);
    await x.p.waitForTimeout(200);
    assert.equal(await x.p.evaluate(() => document.querySelector("#chatText").value), "Hold https://stay.example/42 please", "this conversation's box is untouched");
    await showConv(x.p, GOA, "Trip to Goa");
    assert.equal(await x.p.evaluate(() => document.querySelector("#chatText").value), "Also the 18th?");
    // Cleared there (it was sent): cleared here.
    await x.p.evaluate(([pip, conv]) => window.postMessage({ type: "pipsChatDraft", pip_id: pip, conversation_id: conv, text: "" }, "*"), [PIP, GOA]);
    await x.p.waitForFunction(() => document.querySelector("#chatText").value === "", null, { timeout: 3000 });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("told that a Pip's chat changed in another page, the page reads its messages again at once", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab", width: 700 });
  try {
    await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(300);
    const reads = () => x.p.evaluate(() => (window.__sent || []).filter((r) => r.type === "list_pip_messages").length);
    const before = await reads();
    await x.p.evaluate(() => { const said = window.__convs.messages[window.__convs.list.find((c) => c.first).id];
      said.push({ ...said.find((m) => m.role === "user"), id: "elsewhere1", text: "Sent from the editor tab", status: "queued", created_at: new Date().toISOString() }); });
    await x.p.evaluate((pip) => window.postMessage({ type: "pipsChatChanged", pip_id: pip }, "*"), PIP);
    await x.p.waitForFunction(() => /Sent from the editor tab/.test(document.querySelector(".conversation-log").textContent), null, { timeout: 1500 });
    assert.ok(await reads() > before);
    const other = await reads();
    await x.p.evaluate(() => window.postMessage({ type: "pipsChatChanged", pip_id: "pip_" + "0".repeat(32) }, "*")); await x.p.waitForTimeout(300);
    assert.equal(await reads(), other, "another Pip's chat is not this page's to read");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
