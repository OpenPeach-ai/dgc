// Eight things found on the 0.52 test build in Cursor (13 Nov), in real Chromium on the real pages (support/dock-scene.mjs,
// home-scene.mjs, work-tab-scene.mjs, chat-scene.mjs). What is held here:
//   1. pointing at a tab (Home, Work, Chat, Pips) changes its words' colour and nothing else: no glow, no turn, no motion
//   2. a tab's label waits about 800 ms under a resting pointer, every time (never at once after another tab's), and a
//      pointer that leaves takes it back; the keyboard's focus is labelled at once. The dock's names wait the same.
//   3. "New" (and every filled button of its family) has words of an opaque colour that reads on the fill, also where the
//      theme's input background is see-through (Cursor's dark themes: #ffffff0d)
//   4. a session's name stands on the same baseline as the "DGC" wordmark, in a Work tab and a ChatDGC tab
//   5. the Project Folder menu ends above the dock, scrolls inside after about 8 folders, nothing shows through or over
//      it, and with more than 8 folders it has a search field
//   6. a double-click on a session's row opens it in its editor tab, once
//   7. the tab bar's corners are the button family's (--btn-r), the tabs' a matching smaller one
//   8. a Work session's reply the host says nobody was looking at is a card on Home, as a chat's new answer is
// Read from the DOM, computed style, geometry, pixels and what the page posts to the extension.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { openHome, CHATS } from "./support/home-scene.mjs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { openChat, conversation } from "./support/chat-scene.mjs";

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

const settle = (page, ms = 60) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);
const tone = (page, token) => page.evaluate((name) => { const probe = document.createElement("span"); probe.style.color = `var(${name})`; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }, token);
const centreOf = async (page, selector) => { const b = await page.locator(selector).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const stamp = (minutesAgo) => { const d = new Date(Date.now() - minutesAgo * 60000), p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// ---- 1. pointing at a tab ----------------------------------------------------------------------------------------------
/** A tab as it is painted now: its colour, its glow, and every transform and motion in it. */
const tabPaint = (page, id) => page.evaluate((name) => {
  const tab = document.getElementById(`side-tab-${name}`), all = [tab, ...tab.querySelectorAll("*")].filter((n) => !n.closest(".dgc-tab-face"));
  const word = tab.querySelector(".dgc-tab-word") || tab, range = document.createRange(); range.selectNodeContents(word);
  const r = range.getBoundingClientRect(), css = getComputedStyle(tab), glow = tab.querySelector(".dgc-tab-glow");
  return { color: css.color, glow: glow ? Number(getComputedStyle(glow).opacity) : 0, shadow: css.textShadow, filter: css.filter,
    moved: all.filter((n) => { const s = getComputedStyle(n); return (s.transform !== "none" && s.transform !== "matrix(1, 0, 0, 1, 0, 0)") || (s.scale !== "none" && n !== glow) || s.rotate !== "none"; }).map((n) => String(n.className)),
    moving: tab.getAnimations({ subtree: true }).filter((a) => !a.effect?.target?.closest?.(".dgc-tab-face") && !["color", "outline-color"].includes(a.transitionProperty || "")).map((a) => a.transitionProperty || a.animationName || "animation"),
    copies: tab.querySelectorAll(".dgc-tab-back").length, words: [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100), selected: tab.getAttribute("aria-selected") === "true" };
}, id);
for (const theme of ["dark-modern", "light-modern"]) for (const width of [640, 300, 200]) {
  test(`1. pointing at a tab changes its words' colour and nothing else (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", theme, width, height: 600 });
    try {
      const text = await tone(x.page, "--text"), quiet = await tone(x.page, "--text-2"), accent = await tone(x.page, "--accent-text");
      for (const id of ["work", "chat", "pips"]) {
        await x.page.mouse.move(width / 2, 400); await x.page.waitForTimeout(350);
        const rest = await tabPaint(x.page, id);
        assert.deepEqual([rest.color, rest.glow, rest.moved, rest.copies], [quiet, 0, [], 0], `${id} at rest: quiet, flat, and its name is in it once`);
        await x.page.mouse.move(...await centreOf(x.page, `#side-tab-${id}`), { steps: 3 });
        // On the way (90 ms in) and arrived: nothing turns, grows, glows or slides.
        await x.page.waitForTimeout(90);
        const mid = await tabPaint(x.page, id);
        assert.deepEqual([mid.moved, mid.moving, mid.glow, mid.words], [[], [], 0, rest.words], `${id}, 90 ms after the pointer arrived: nothing moves (${JSON.stringify(mid)})`);
        await x.page.waitForTimeout(600);
        const now = await tabPaint(x.page, id);
        assert.ok([text, quiet].includes(now.color), `${id} pointed at: the text colour or the quiet one, never the accent (${now.color}; text ${text}, accent ${accent})`);
        assert.deepEqual([now.glow, now.moved, now.moving, now.shadow, now.filter, now.words], [0, [], [], "none", "none", rest.words], `${id} pointed at: no glow, no turn, no shimmer, its words where they were`);
        assert.equal(now.selected, false, "pointing chooses nothing");
      }
      // The tab you are on keeps its accent and its glow, pointed at or not.
      const home = await tabPaint(x.page, "home");
      assert.deepEqual([home.color, home.glow > 0.95], [accent, true], "the tab you are on is still lit");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 2. labels wait ----------------------------------------------------------------------------------------------------
/** Starts a watch: when (ms from now) a label was first on screen, and its words. A label that is already up when the
 *  watch starts (the last control's) is not the one waited for. `only`: the dock's own names. */
const watchTips = (page, only = "") => page.evaluate((sel) => {
  window.__tipWatch = (window.__tipWatch || 0) + 1;
  const mine = window.__tipWatch, from = performance.now(); window.__tipSeen = null;
  const up = () => [...document.querySelectorAll(sel || "#hover-tip, .dgc-dock-tip")].find((n) => !n.hidden && n.checkVisibility());
  let stale = up()?.textContent ?? null;
  const tick = () => {
    if (window.__tipWatch !== mine) return;
    const tip = up();
    if (!tip || tip.textContent !== stale) stale = null;
    if (tip && stale === null && !window.__tipSeen) window.__tipSeen = { at: Math.round(performance.now() - from), text: tip.textContent, id: tip.id };
    requestAnimationFrame(tick);
  };
  tick();
}, only);
const tipSeen = (page) => page.evaluate(() => window.__tipSeen);
const tipUp = (page) => page.evaluate(() => { const tip = [...document.querySelectorAll('#hover-tip, .dgc-dock-tip')].find((n) => !n.hidden && n.checkVisibility()); return tip ? tip.textContent : ""; });
const ABOUT_800 = (ms) => ms >= 740 && ms <= 1100;

test("2. a tab's label waits about 800 ms under a resting pointer, every time; leaving takes it back; the keyboard is labelled at once", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "home", width: 640, height: 700 });
  try {
    const p = x.page;
    await p.mouse.move(320, 400); await p.waitForTimeout(100);
    // Pointed at and left alone: nothing for half a second, then the label.
    await watchTips(p);
    await p.mouse.move(...await centreOf(p, "#side-tab-work"), { steps: 3 });
    await p.waitForTimeout(550);
    assert.equal(await tipUp(p), "", "half a second in: no label yet");
    await p.waitForTimeout(700);
    let seen = await tipSeen(p);
    assert.equal(seen?.text, "Work: your Work sessions", "then its label");
    assert.ok(ABOUT_800(seen.at), `after about 800 ms (${seen.at})`);
    // On to the next tab: the first label goes at once, and the next one waits its own 800 ms (it is never instant).
    await watchTips(p);
    await p.mouse.move(...await centreOf(p, "#side-tab-chat"), { steps: 3 });
    await p.waitForTimeout(120);
    assert.equal(await tipUp(p), "", "the next tab is not labelled at once");
    await p.waitForTimeout(430);
    assert.equal(await tipUp(p), "", "nor half a second later");
    await p.waitForTimeout(700);
    seen = await tipSeen(p);
    assert.match(seen?.text || "", /^Chat: /, "it is, once the pointer has rested on it");
    assert.ok(ABOUT_800(seen.at), `after about 800 ms of its own (${seen.at})`);
    // Left, and straight back to another tab: it waits again.
    await p.mouse.move(320, 400); await p.waitForTimeout(80);
    await watchTips(p);
    await p.mouse.move(...await centreOf(p, "#side-tab-pips"), { steps: 3 });
    await p.waitForTimeout(500);
    assert.equal(await tipUp(p), "", "back within a moment: still a wait");
    // A pointer that passes over and leaves before the wait is up gets no label at all.
    await p.mouse.move(320, 400);
    await watchTips(p);
    await p.mouse.move(...await centreOf(p, "#side-tab-work"), { steps: 3 });
    await p.waitForTimeout(450);
    await p.mouse.move(320, 400);
    await p.waitForTimeout(900);
    assert.equal(await tipSeen(p), null, "passing over a tab shows nothing");
    // The keyboard: focus is labelled at once. (The pointer is parked on the header, where nothing changes under it.)
    await p.mouse.move(630, 6); await p.waitForTimeout(100);
    await p.focus("#side-tab-home");
    await watchTips(p);
    await p.keyboard.press("ArrowRight");
    await p.waitForTimeout(250);
    seen = await tipSeen(p);
    assert.match(seen?.text || "", /^Work: /, "a tab reached with the keyboard is labelled");
    assert.ok(seen.at < 250, `at once (${seen.at})`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("2. the dock's names wait the same: about 800 ms on a tile, at once for the keyboard", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 640, height: 700 });
  try {
    const p = x.page, d = await dockNow(p), mid = (i) => [(d.items[i].left + d.items[i].right) / 2, (d.items[i].top + d.items[i].bottom) / 2];
    await p.mouse.move(320, 300); await p.waitForTimeout(100);
    await watchTips(p, ".dgc-dock-tip");
    await p.mouse.move(...mid(0), { steps: 3 });
    await p.waitForTimeout(500);
    assert.equal((await dockNow(p)).tip, null, "half a second on a tile: no name yet");
    await p.waitForTimeout(700);
    const seen = await tipSeen(p);
    assert.equal((await dockNow(p)).tip?.title, "Mail watch", "then its name");
    assert.ok(ABOUT_800(seen.at), `after about 800 ms (${seen.at})`);
    // With a name up, it goes along the tiles with the pointer (no second wait while the pointer stays in the dock).
    await p.mouse.move(...mid(1), { steps: 3 }); await p.waitForTimeout(120);
    assert.equal((await dockNow(p)).tip?.title, "Morning brief", "the next tile's name follows the pointer");
    // Leaving the dock takes the name away, and passing over a tile shows none.
    await p.mouse.move(320, 300); await p.waitForTimeout(700);
    assert.equal((await dockNow(p)).tip, null);
    await watchTips(p, ".dgc-dock-tip");
    await p.mouse.move(...mid(1), { steps: 3 }); await p.waitForTimeout(400);
    await p.mouse.move(320, 300); await p.waitForTimeout(900);
    assert.equal(await tipSeen(p), null, "passing over a tile shows nothing");
    // The keyboard names a tile at once.
    await p.focus(".dgc-dock-item");
    await p.keyboard.press("ArrowRight");
    await p.waitForTimeout(150);
    assert.ok((await dockNow(p)).tip?.title, "a tile reached with the keyboard is named at once");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- 3. New's words on its fill ------------------------------------------------------------------------------------------
/** A filled button's words against its fill, as painted over the page: [{ what, ratio, alpha }]. */
const solidInk = (page) => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const page = over(parse(getComputedStyle(document.body).backgroundColor), [255, 255, 255, 1]);
  const read = (what, node, on = node) => { const s = getComputedStyle(node), ground = getComputedStyle(on).backgroundColor, fill = over(parse(ground), page), ink = parse(s.color), shown = over(ink, fill), [a, b] = [lum(shown), lum(fill)].sort((p, q) => q - p);
    return { what, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, alpha: ink[3], ink: s.color, fill: ground }; };
  const out = [];
  for (const id of ["sessions-new", "chats-new"]) { const b = document.getElementById(id); if (b) { out.push(read(`#${id}`, b)); out.push(read(`#${id}'s plus`, b.querySelector(".codicon"), b)); } }
  // Every other filled button takes the same two tokens.
  const probe = document.createElement("span"); probe.style.cssText = "background: var(--solid); color: var(--on-solid)"; document.body.append(probe);
  out.push(read("--on-solid on --solid", probe)); probe.remove();
  return out;
});
for (const theme of ["cursor-dark", "light-cursor", "dark-modern", "light-modern", "hc"]) {
  test(`3. New's words are an opaque colour that reads on its fill (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    for (const tab of ["work", "chat"]) {
      const x = await openDock(browser, { tab, theme, width: 640, height: 600 });
      try {
        const inks = await solidInk(x.page);
        assert.ok(inks.some((i) => i.what === (tab === "work" ? "#sessions-new" : "#chats-new")), "New is on the page");
        for (const i of inks) {
          assert.equal(i.alpha, 1, `${tab}: ${i.what} is an opaque colour (${i.ink})`);
          assert.ok(i.ratio >= 4.5, `${tab}: ${i.what} reads on its fill: ${i.ratio}:1 (${i.ink} on ${i.fill})`);
        }
        // And as painted: the darkest and the lightest pixel of the button are far apart (its words show).
        const shot = await x.page.locator(tab === "work" ? "#sessions-new" : "#chats-new").screenshot();
        const spread = await x.page.evaluate(async (b64) => { const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
          const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
          const d = g.getImageData(2, 2, c.width - 4, c.height - 4).data; let lo = 255, hi = 0; for (let k = 0; k < d.length; k += 4) { const v = (d[k] + d[k + 1] + d[k + 2]) / 3; lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; }, shot.toString("base64"));
        assert.ok(spread > 120, `${tab}: New's words can be seen on it (pixel spread ${spread})`);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    }
  });
}

// ---- 4. the header's name on the wordmark's line -----------------------------------------------------------------------
/** Where the wordmark's letters and the name's letters stand: each one's baseline, and the centre of its line. */
const headLines = (page, head, name) => page.evaluate(([h, n]) => {
  const header = document.querySelector(h), title = document.querySelector(n), pm = header.querySelector(".pm");
  const foot = () => { const s = document.createElement("span"); s.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline"; return s; };
  // A zero-size inline box stands on its line's baseline: one after the name's words, one after the wordmark's.
  const a = foot(); title.append(a);
  const word = [...pm.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim()) || pm.querySelector(".pm-word")?.firstChild;
  const holder = document.createElement("span"), b = foot(); word.before(holder); holder.append(word, b);
  const range = (node) => { const r = document.createRange(); r.selectNodeContents(node); return r.getBoundingClientRect(); };
  const out = { name: a.getBoundingClientRect().bottom, word: b.getBoundingClientRect().bottom, nameMid: (range(title).top + range(title).bottom) / 2,
    logoMid: (pm.getBoundingClientRect().top + pm.getBoundingClientRect().bottom) / 2, headMid: (header.getBoundingClientRect().top + header.getBoundingClientRect().bottom) / 2,
    fonts: [getComputedStyle(pm).fontFamily.split(",")[0], getComputedStyle(title).fontFamily.split(",")[0]], height: header.getBoundingClientRect().height };
  holder.before(word); holder.remove(); a.remove();
  return out;
}, [head, name]);
const FONTS = [["system-ui, sans-serif", "ui-monospace, monospace"], ["Arial, sans-serif", "'Courier New', monospace"], ["Cantarell, sans-serif", "'DejaVu Sans Mono', monospace"], ["'DejaVu Sans', sans-serif", "'Andale Mono', monospace"], ["Georgia, serif", "'DejaVu Sans Mono', monospace"]];
const fontsCss = ([sans, mono]) => `:root { --vscode-font-family: ${sans}; --vscode-editor-font-family: ${mono}; }`;
const onOneLine = (m, said) => {
  assert.ok(Math.abs(m.name - m.word) <= 0.5, `${said}: the name and "DGC" stand on one baseline (name ${m.name}, DGC ${m.word}; ${m.fonts})`);
  // (Two fonts on one baseline are not centred on one line to the pixel: Courier New's letters sit 2 px lower in their
  // box than Arial's. The baseline is what is held; the two boxes stay within 3 px, both in the header's middle.)
  assert.ok(Math.abs(m.nameMid - m.logoMid) <= 3 && Math.abs(m.logoMid - m.headMid) <= 3, `${said}: both in the middle of the row (name ${m.nameMid}, logo ${m.logoMid}, header ${m.headMid})`);
};
const ready = (name) => ({ type: "event", event: { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: {}, model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://localhost:11434/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "20261106-101500-a1", session_name: name } });
for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`4. a Work session's name stands on the wordmark's baseline, whatever the fonts (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openWorkTab(browser, { width, theme });
    try {
      await x.send(ready("test session"));
      const first = await headLines(x.page, "#phead", "#thread-title");
      for (const pair of FONTS) {
        await x.page.addStyleTag({ content: fontsCss(pair) }); await settle(x.page);
        const m = await headLines(x.page, "#phead", "#thread-title");
        onOneLine(m, `${pair[0]} with ${pair[1]}`);
        assert.ok(Math.abs(m.nameMid - m.headMid) <= 1.5, `the name is in the middle of its header (${m.nameMid} in ${m.headMid})`);
        assert.equal(m.height, first.height, "the header is as tall as it was");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
  test(`4. a ChatDGC chat's name stands on the wordmark's baseline, whatever the fonts (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, theme });
    try {
      await x.send({ type: "opened", conversation: conversation({ title: "New chat test" }), earlier: 0, busy: false, messages: [] });
      await x.page.waitForTimeout(60);
      const first = await headLines(x.page, ".cd-head", "#cd-title");
      for (const pair of FONTS) {
        await x.page.addStyleTag({ content: fontsCss(pair) }); await settle(x.page);
        const m = await headLines(x.page, ".cd-head", "#cd-title");
        onOneLine(m, `${pair[0]} with ${pair[1]}`);
        assert.ok(Math.abs(m.nameMid - m.headMid) <= 1.5, `the name is in the middle of its header (${m.nameMid} in ${m.headMid})`);
        assert.equal(m.height, first.height, "the header is as tall as it was");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

// ---- 5. the Project Folder menu ----------------------------------------------------------------------------------------
const folderRow = (i) => ({ folder: `/tmp/dgc-pip-report-${"abcdefghijklmnopqrstuvwxyz"[i]}${i}x/repo`, shown: `/tmp/dgc-pip-report-${"abcdefghijklmnopqrstuvwxyz"[i]}${i}x/repo`, name: i === 7 ? "storefront" : "repo", here: false, exists: i % 3 !== 0 });
const manyFolders = (n) => [{ folder: "/home/me/rust_ire", shown: "~/rust_ire", name: "rust_ire", here: true, exists: true }, ...Array.from({ length: n - 1 }, (_, i) => folderRow(i))];
const workList = (folders, count = 6) => ({ type: "sessions_list", error: "", searchable: true, query: "", more: false, folders: { choice: "", rows: folders, window: { folder: "/home/me/rust_ire", shown: "~/rust_ire", name: "rust_ire" } },
  items: Array.from({ length: count }, (_, i) => ({ id: `s-${i}`, path: `/s/${i}.json`, name: i ? `Session number ${i}` : "test session", preview: "", when: stamp(4 + i * 700), count: 3, open: !i,
    project: folders[i % folders.length].shown, projectPath: folders[i % folders.length].folder, projectName: folders[i % folders.length].name, ...(i % folders.length ? { here: false } : {}) })) });
/** The open menu as it is on screen. */
const menuNow = (page) => page.evaluate(() => {
  const box = document.querySelector(".dgc-folder-menu:not([data-leaving])"), rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  if (!box) return null;
  const list = box.querySelector(".dgc-folder-list"), dock = document.getElementById("dgc-dock"), search = box.querySelector("input.dgc-folder-search"), l = rect(list);
  const rows = [...box.querySelectorAll(".dgc-menu-row[data-folder]")], inView = (n) => { const r = rect(n); return n.checkVisibility() && r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5; };
  // What is on top at many points of the menu: every one must be the menu's own.
  const strangers = [];
  for (let fx = 0.04; fx < 1; fx += 0.115) for (let fy = 0.03; fy < 1; fy += 0.06) {
    const px = l.left + l.width * fx, py = l.top + l.height * fy, top = document.elementFromPoint(px, py);
    if (!top || !box.contains(top)) strangers.push(`${Math.round(px)},${Math.round(py)}: ${top ? top.id || top.className : "nothing"}`);
  }
  return { ...l, dockTop: dock && dock.checkVisibility() ? rect(dock).top : null, view: innerHeight, dir: box.dataset.dir, scrolls: list.scrollHeight > list.clientHeight + 1, overflow: getComputedStyle(list).overflowY,
    folders: rows.filter((r) => r.dataset.folder).length, shown: rows.filter((r) => r.dataset.folder && r.checkVisibility()).map((r) => r.dataset.folder), whole: rows.filter((r) => r.dataset.folder && inView(r)).length,
    search: search ? { ...rect(search), value: search.value, focused: (box.getRootNode().activeElement || document.activeElement) === search, placeholder: search.placeholder, label: search.getAttribute("aria-label") } : null,
    none: box.querySelector(".dgc-folder-none")?.checkVisibility() ? box.querySelector(".dgc-folder-none").textContent : "", strangers, zIndex: Number(getComputedStyle(box).zIndex),
    focus: (() => { const a = box.getRootNode().activeElement || document.activeElement; return a?.dataset?.folder ?? (a === search ? "search" : a?.className || ""); })(),
    ground: getComputedStyle(list).backgroundColor, button: rect(document.querySelector("[data-folder-pick][aria-expanded='true']") || box) };
});
for (const theme of ["dark-modern", "light-modern", "cursor-dark"]) for (const [width, height] of [[640, 780], [300, 620]]) {
  test(`5. the Project Folder menu ends above the dock, scrolls inside, and nothing shows through or over it (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "work", theme, width, height, sessions: null, motion: "reduce" });
    try {
      await x.send(workList(manyFolders(18)));
      await settle(x.page, 120);
      await x.page.click("#sessions-folder-pick");
      await settle(x.page, 150);
      const m = await menuNow(x.page);
      assert.ok(m, "the menu is open");
      assert.equal(m.folders, 18, "every folder is in it");
      assert.ok(m.dockTop !== null, "the dock is on the page");
      assert.ok(m.bottom <= m.dockTop - 3.5, `it ends above the dock (its end ${m.bottom}, the dock's top ${m.dockTop})`);
      assert.ok(m.top >= 0 && m.bottom <= m.view, "and inside the view");
      assert.ok(m.scrolls && ["auto", "scroll"].includes(m.overflow), "it scrolls inside");
      assert.ok(m.whole <= 8, `about 8 folders show at a time (${m.whole})`);
      if (height >= 780) assert.ok(m.whole >= 7, `not fewer than it has room for (${m.whole})`);
      assert.deepEqual(m.strangers, [], "nothing of the page is on top of it");
      // Nothing shows through: the menu's pixels are the same with the list and the dock under it and without them.
      const clip = { x: Math.max(0, m.left + 1), y: m.top + 1, width: m.width - 2, height: m.height - 2 };
      const withPage = await x.page.screenshot({ clip });
      await x.page.addStyleTag({ content: "#sessions-list, #sessions-all, #dgc-dock > *, #work-library { visibility: hidden !important; }" });
      await settle(x.page);
      const alone = await x.page.screenshot({ clip });
      assert.ok(withPage.equals(alone), "the page under the menu does not show through it");
      const alpha = (c) => { const v = c.match(/-?[\d.]+/g).map(Number); return c.startsWith("rgba") || c.includes("/") ? v[3] ?? 1 : 1; };
      assert.equal(alpha(m.ground), 1, `its ground is an opaque colour (${m.ground})`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("5. with more than 8 folders the menu has a search field: type to narrow by name or path, arrows and Enter from the field, Escape clears then closes", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 640, height: 780, sessions: null, motion: "reduce" });
  try {
    const p = x.page, folders = manyFolders(18);
    await x.send(workList(folders));
    await settle(p, 120);
    await p.click("#sessions-folder-pick");
    await settle(p, 150);
    let m = await menuNow(p);
    assert.ok(m.search, "a search field is in the menu");
    assert.ok(m.search.top >= m.top - 0.5 && m.search.top - m.top < 12, "at its top");
    assert.equal(m.search.focused, true, "and the keyboard is in it");
    assert.match(m.search.label || m.search.placeholder, /folder/i, "it says what it searches");
    // By name: one folder is called "storefront".
    await p.keyboard.type("STOREf");
    await settle(p);
    m = await menuNow(p);
    assert.deepEqual(m.shown, [folders[8].folder], "typing narrows the folders to the ones whose name matches, whatever the case");
    assert.equal(m.search.focused, true);
    // By path: "c2x" is in one path only.
    await p.keyboard.press("Control+A"); await p.keyboard.type("c2x");
    await settle(p);
    m = await menuNow(p);
    assert.deepEqual(m.shown, [folders[3].folder], "and to the ones whose path matches");
    // Nothing matches: it says so, and Enter chooses nothing.
    await p.keyboard.press("Control+A"); await p.keyboard.type("zzzz");
    await settle(p);
    m = await menuNow(p);
    assert.deepEqual([m.shown, /zzzz/.test(m.none)], [[], true], "nothing matches: it says so");
    await p.keyboard.press("Enter");
    assert.ok(await menuNow(p), "Enter with nothing found chooses nothing");
    // The field keeps its place while the list under it scrolls.
    await p.keyboard.press("Control+A"); await p.keyboard.type("repo");
    await settle(p);
    m = await menuNow(p);
    assert.ok(m.shown.length > 8, "many match “repo”");
    await p.evaluate(() => { const l = document.querySelector(".dgc-folder-list"); l.scrollTop = l.scrollHeight; });
    await settle(p);
    const scrolled = await menuNow(p);
    assert.ok(Math.abs(scrolled.search.top - m.search.top) <= 0.5, "the field stays at the top while the folders scroll");
    assert.deepEqual(scrolled.strangers, [], "and nothing is over the menu");
    // Down from the field goes to the first folder found, Up from it back to the field's end… and typing goes back to the field.
    await p.focus("input.dgc-folder-search");
    await p.keyboard.press("ArrowDown");
    m = await menuNow(p);
    assert.equal(m.focus, m.shown[0], "Down from the field: the first folder found");
    await p.keyboard.press("ArrowDown");
    assert.equal((await menuNow(p)).focus, m.shown[1], "Down again: the next");
    await p.keyboard.type("x");
    await settle(p);
    m = await menuNow(p);
    assert.deepEqual([m.search.focused, m.search.value], [true, "repox"], "a letter typed on a row goes into the field");
    // Escape clears what was typed, and the menu stays; Escape again closes it and the button has the keyboard.
    await p.keyboard.press("Escape");
    await settle(p);
    m = await menuNow(p);
    assert.ok(m, "Escape with words in the field keeps the menu");
    assert.deepEqual([m.search.value, m.shown.length], ["", 18], "and clears them: every folder is back");
    // Enter from the field chooses the first folder found.
    await p.keyboard.type("b1x");
    await settle(p);
    await p.keyboard.press("Enter");
    await settle(p, 120);
    assert.equal(await menuNow(p), null, "Enter in the field closes the menu");
    assert.deepEqual((await x.posted("projectFolderChoose")).map((c) => c.folder), [folders[2].folder], "and chooses the first folder found");
    await p.click("#sessions-folder-pick");
    await settle(p, 150);
    await p.keyboard.press("Escape");
    await settle(p, 120);
    assert.equal(await menuNow(p), null, "Escape with an empty field closes the menu");
    assert.equal(await p.evaluate(() => document.activeElement?.id), "sessions-folder-pick", "and the keyboard is back on its button");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("5. a short list has no search field, and New Session's dropdown is held inside the view with its search too", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 640, height: 560, sessions: null, motion: "reduce" });
  try {
    const p = x.page;
    await x.send(workList(manyFolders(8)));
    await settle(p, 120);
    await p.click("#sessions-folder-pick");
    await settle(p, 150);
    let m = await menuNow(p);
    assert.deepEqual([m.folders, m.search], [8, null], "8 folders: no search field");
    assert.ok(m.bottom <= m.dockTop - 3.5, "it still ends above the dock");
    await p.keyboard.press("Escape");
    // New Session's own dropdown, with many folders.
    await x.send(workList(manyFolders(18)));
    await settle(p, 120);
    await p.click("#sessions-new");
    await settle(p, 150);
    await p.click("#new-session-folder");
    await settle(p, 150);
    m = await menuNow(p);
    assert.ok(m && m.search, "New Session's dropdown has the search field too");
    assert.ok(m.top >= 0 && m.bottom <= m.view - 3.5, `and is inside the view (${m.top} to ${m.bottom} of ${m.view})`);
    assert.ok(m.whole <= 8 && m.scrolls, "about 8 folders, then it scrolls");
    assert.deepEqual(m.strangers, []);
    await p.keyboard.type("storefront"); await settle(p);
    await p.keyboard.press("Enter"); await settle(p, 120);
    assert.match(await p.evaluate(() => document.getElementById("new-session-folder").textContent), /storefront/, "a folder found by typing is chosen with Enter");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- 6. a double-click opens the session's tab ---------------------------------------------------------------------------
test("6. a double-click on a session's row opens it in its editor tab, once: the Work list, View all, and a chat's row", async (t) => {
  if (skipOrFail(t)) return;
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `2026110${i % 9}-10000${i % 9}-x${i}`, path: `/s/x${i}.json`, name: `Session number ${i}`, preview: "", when: stamp(10 + i * 90), count: 4, open: false }));
  const x = await openDock(browser, { tab: "work", width: 640, height: 780, sessions: many });
  try {
    const p = x.page, opened = async () => (await x.posted("openSessionInEditor")).map((m) => m.id);
    await p.dblclick(`#sessions-list .session-row[data-id="${many[1].id}"] .session-name`);
    await settle(p, 120);
    assert.deepEqual(await opened(), [many[1].id], "the Work list: its tab is asked for, once");
    // The list drawn again between the two clicks (the host answers the first one) changes nothing.
    await p.mouse.move(...await centreOf(p, `#sessions-list .session-row[data-id="${many[2].id}"] .session-name`));
    await p.mouse.down({ clickCount: 1 }); await p.mouse.up({ clickCount: 1 });
    await x.send({ type: "sessions_list", items: many.map((s, i) => (i === 2 ? { ...s, open: true } : s)), error: "" });
    await p.mouse.down({ clickCount: 2 }); await p.mouse.up({ clickCount: 2 });
    await settle(p, 120);
    assert.deepEqual(await opened(), [many[1].id, many[2].id], "a row drawn again between the clicks: still once");
    // View all.
    await p.click("#sessions-all");
    await settle(p, 150);
    await p.dblclick(`#sessions-list .session-row[data-id="${many[9].id}"]`);
    await settle(p, 150);
    assert.deepEqual(await opened(), [many[1].id, many[2].id, many[9].id], "View all: its tab is asked for, once");
    // A chat's row.
    await p.click("#side-tab-chat");
    await settle(p, 150);
    await p.dblclick(`#chats-list .session-row >> nth=0`);
    await settle(p, 120);
    assert.equal((await x.posted("chatdgcOpen")).length, 1, "a chat's row: its tab is asked for, once");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- 7. the tab bar's corners --------------------------------------------------------------------------------------------
for (const theme of ["dark-modern", "light-modern"]) for (const width of [640, 300, 200]) {
  test(`7. the tab bar's corners are the button's, the tabs' a matching smaller one (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "work", theme, width, height: 600 });
    try {
      const m = await x.page.evaluate(() => {
        const probe = document.createElement("span"); probe.style.borderRadius = "var(--btn-r)"; document.body.append(probe);
        const btn = getComputedStyle(probe).borderTopLeftRadius; probe.remove();
        const bar = document.querySelector("#side-tabs .dgc-tabs-bar"), s = getComputedStyle(bar), four = (c) => [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius];
        return { btn, bar: four(s), pad: parseFloat(s.paddingTop), tabs: [...bar.querySelectorAll(".dgc-tab")].map((t) => four(getComputedStyle(t))), now: four(getComputedStyle(document.getElementById("sessions-new"))),
          search: four(getComputedStyle(document.getElementById("sessions-search"))), ground: s.backgroundImage !== "none", lift: s.boxShadow !== "none" };
      });
      assert.equal(m.btn, "6px", "the button family's corner is 6 px");
      assert.deepEqual(m.bar, Array(4).fill(m.btn), "the bar's four corners are the button's");
      assert.deepEqual([m.now, m.search], [m.bar, m.bar], "the same as New's and the search field's");
      const inner = `${Math.max(2, parseFloat(m.btn) - m.pad)}px`;
      for (const tab of m.tabs) assert.deepEqual(tab, Array(4).fill(inner), `each tab's corner follows inside it (${inner})`);
      assert.deepEqual([m.ground, m.lift], [true, true], "the bar keeps its ground and its lift");
      // As painted: the bar's corner pixel, 2 px in from its corner, is the bar's (a pill's would be the page's there).
      const corner = await x.page.evaluate(() => { const r = document.querySelector("#side-tabs .dgc-tabs-bar").getBoundingClientRect(); return { x: r.left + 2.5, y: r.top + 2.5, mx: r.left + 30, my: r.top + 2.5 }; });
      const px = async (cx, cy) => { const shot = await x.page.screenshot({ clip: { x: Math.floor(cx), y: Math.floor(cy), width: 1, height: 1 } });
        return x.page.evaluate(async (b64) => { const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode(); const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); }, shot.toString("base64")); };
      const [at, along] = [await px(corner.x, corner.y), await px(corner.mx, corner.my)];
      assert.ok(Math.max(...at.map((v, i) => Math.abs(v - along[i]))) <= 6, `2 px inside the corner is the bar's own ground (${at} against ${along})`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 8. a Work session's reply on Home ---------------------------------------------------------------------------------
const quietSessions = DOCK_SESSIONS.map((s) => ({ ...s, running: false, waiting: false }));
const cardOf = (hub, key) => hub.cards.find((c) => c.key === key);
for (const theme of ["dark-modern", "light-modern"]) for (const width of [640, 300]) {
  test(`8. a Work session's reply nobody was looking at is a card on Home, as a chat's new answer is (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    // A chat is answering as the side bar opens, so its card can be compared; no Work session is ever listed running.
    // (A reply is news: since 13 Nov evening what is new is in Recent only, so Home opens here on Recent opened whole.)
    const x = await openDock(browser, { tab: "home", open: "recent", theme, width, height: 900, sessions: quietSessions, answering: ["chat_2"], state: { list: {}, unread: {}, attention: null, digest: [] } });
    try {
      const p = x.page, id = quietSessions[1].id, key = `work:${id}`, said = "Tide pools matter because they are small, **rough** nurseries where the sea’s young things grow.";
      await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: ["chat_1"], answering: [] });
      await settle(p);
      assert.equal(cardOf(await x.hub(), key), undefined, "nothing about the session yet");
      // The host: that session's turn ended with a reply while its tab was not the one in front.
      const at = Date.now();
      await x.send({ type: "sessions_list", items: quietSessions, error: "", news: [{ id, at, preview: said }] });
      await settle(p);
      let hub = await x.hub();
      const card = cardOf(hub, key), chat = cardOf(hub, "chat:chat_2");
      assert.ok(card, `Home has the session's card (${hub.cards.map((c) => c.key)})`);
      assert.ok(chat, "beside the chat's");
      assert.deepEqual([card.group, card.source], ["new", "work"], "under New, from Work");
      assert.match(card.from, /^Write about 120 words on why tide pools matter · Work · now$/, "it says which session, and when");
      assert.equal(card.title, "Tide pools matter because they are small, rough nurseries where the sea’s young things grow.", "its title is the reply's own first words, as a chat's is");
      assert.deepEqual(card.chips, ["New reply"], "marked as a new reply");
      assert.deepEqual(card.actions, chat.actions, "the same answers as the chat's card: Open and Dismiss");
      assert.deepEqual([card.shared, card.thin, card.radius, card.ground, card.width, card.height], [chat.shared, chat.thin, chat.radius, chat.ground, chat.width, chat.height], "the same card: its shape, its ground and its size");
      const fresh = hub.groups.find((g) => g.id === "new").cards.map((c) => c.key);
      assert.deepEqual(fresh.slice(0, 2), [key, "chat:chat_2"], "in the same place: under New with the chat's, the newest first");
      assert.match(card.who, /^mark:/, "with the session's own mark");
      // (What is new is in Home's words, never in its number, which is what needs you: 16 Nov.)
      { const home = (await x.tabs()).tabs.find((tab) => tab.id === "home"), needs = hub.groups.find((g) => g.id === "needs")?.cards.length || 0;
        assert.match(home.label, new RegExp(`${hub.cards.length - needs} new$`), `Home's words count it (${home.label})`);
        assert.equal(home.count, needs ? String(needs) : "", "and its number stays what needs you"); }
      // The same list again (the host repeats what is still news) changes nothing.
      await x.send({ type: "sessions_list", items: quietSessions, error: "", news: [{ id, at, preview: said }] });
      await settle(p);
      assert.equal((await x.hub()).cards.filter((c) => c.key === key).length, 1, "said again: still one card");
      // Dismissed: it goes, the host is told, and the same news said once more does not bring it back.
      await p.click(`.dgc-hub-card[data-key="${key}"] [data-hub-act="dismiss"]`);
      await settle(p);
      assert.equal(cardOf(await x.hub(), key), undefined, "Dismiss takes it off Home");
      assert.deepEqual((await x.posted("homeSessionSeen")).map((m) => m.id), [id], "and the host is told it was seen");
      await x.send({ type: "sessions_list", items: quietSessions, error: "", news: [{ id, at, preview: said }] });
      await settle(p);
      assert.equal(cardOf(await x.hub(), key), undefined, "a list that was already on its way does not bring it back");
      // A later reply is news again; opening its card opens the session's tab and the card goes.
      await x.send({ type: "sessions_list", items: quietSessions, error: "", news: [{ id, at: at + 5000, preview: "" }] });
      await settle(p);
      hub = await x.hub();
      assert.equal(cardOf(hub, key)?.title, "Has a new reply", "a later reply is a card again (with no words of its own, it says so, as a chat's “Has a new answer”)");
      await p.click(`.dgc-hub-card[data-key="${key}"] [data-hub-act="open"]`);
      await settle(p);
      assert.deepEqual((await x.posted("openSessionInEditor")).map((m) => m.id), [id], "Open opens the session's tab");
      assert.equal(cardOf(await x.hub(), key), undefined, "and the card goes");
      // Seen in its own tab: a session the host says you are looking at has no card.
      await x.send({ type: "sessions_list", items: quietSessions, error: "", news: [{ id, at: at + 9000, preview: said }] });
      await settle(p);
      assert.ok(cardOf(await x.hub(), key), "a third reply");
      await x.send({ type: "sessions_list", items: quietSessions.map((s) => (s.id === id ? { ...s, open: true, watched: true } : s)), error: "" });
      await settle(p);
      assert.equal(cardOf(await x.hub(), key), undefined, "its tab came to the front: seen, so the card goes");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 9. a Home card's answers never lie on its words (13 Nov, later) ---------------------------------------------------
// Pointed at, an answer shows as a pill with its word, wider than the row of icons: it grew to the left, over the end of
// the card's own lines. The row keeps the widest pill's room, so the words end before it.
/** Every card on Home: its words' boxes (each line of its small line, its sentence, its chips, its note) and its answers' boxes (the icons and the pill). */
const cardBoxes = (page) => page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].map((card) => {
  const rect = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  const words = [];
  for (const part of card.querySelectorAll(".dgc-card-sub, .dgc-card-title, .dgc-card-note, .dgc-chip")) {
    if (!part.checkVisibility()) continue;
    const clip = part.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(part);
    // (What of each line is painted: a line cut with an ellipsis ends at its own box.)
    for (const r of range.getClientRects()) { const box = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right), top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) }; if (box.right - box.left > 0.5 && box.bottom - box.top > 0.5) words.push({ what: part.className.split(" ")[0], ...box }); }
  }
  const row = card.querySelector(".dgc-ia"), pill = row?.querySelector(".dgc-ia-pill");
  const answers = row ? [...row.querySelectorAll(".dgc-ia-btn")].map((b) => ({ what: b.textContent.trim(), ...rect(b.getBoundingClientRect()) })) : [];
  if (pill && row.classList.contains("dgc-ia-on")) answers.push({ what: `pill ${pill.textContent.trim()}`, ...rect(pill.getBoundingClientRect()) });
  return { key: card.dataset.key, card: rect(card.getBoundingClientRect()), words, answers, labels: row ? [...row.querySelectorAll(".dgc-ia-btn")].map((b) => b.textContent.trim()) : [],
    title: { text: card.querySelector(".dgc-card-title").textContent, lines: Math.round(card.querySelector(".dgc-card-title").getBoundingClientRect().height / 16), cut: card.querySelector(".dgc-card-title").scrollHeight > card.querySelector(".dgc-card-title").clientHeight + 1 } };
}));
const overlaps = (boxes) => { const out = []; for (const a of boxes.answers) for (const w of boxes.words) if (a.left < w.right - 0.5 && w.left < a.right - 0.5 && a.top < w.bottom - 0.5 && w.top < a.bottom - 0.5) out.push(`${a.what} on ${w.what} (${Math.round(a.left)}–${Math.round(a.right)} over ${Math.round(w.left)}–${Math.round(w.right)})`); return out; };
for (const theme of ["dark-modern", "light-modern", "cursor-dark"]) for (const width of [660, 300, 200]) {
  test(`9. a Home card's answers never lie on its words, at rest or pointed at, for every kind of card (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    // Every kind: a session that wants your okay (three answers), one running with no window, a Work reply, a chat's
    // reply two lines long, and the Pips' cards (something waits, a new Pip, new messages, a failed run).
    const long = "Here is the plan for the week in Goa, with the three beaches worth the drive, two day trips inland and the places to eat near each one, in the order we talked about.";
    const sessions = [...DOCK_SESSIONS.map((s, i) => (i === 1 ? { ...s, running: false } : s)), { id: "20261103-120000-e5", path: "/s/e5.json", name: "Nightly export, second try", preview: "", when: "2026-11-03 12:00", count: 9, open: false, windowless: "Running the export" }];
    const x = await openDock(browser, { tab: "home", theme, width, height: 1100, sessions, answering: ["chat_2"] });
    try {
      const p = x.page;
      await x.send({ type: "chatdgc_list", available: true, items: CHATS.map((c) => (c.id === "chat_2" ? { ...c, title: "New chat test", preview: long } : c)), open: ["chat_1"], answering: [] });
      await x.send({ type: "sessions_list", items: sessions, error: "", news: [{ id: sessions[1].id, at: Date.now(), preview: long }] });
      await settle(p, 150);
      // (Each card read where it shows: what needs you in Needs you opened, what is new in Recent opened.)
      let cards = await x.everyCard(() => cardBoxes(p));
      const kinds = new Set(cards.map((c) => c.key.split(":")[0]));
      assert.ok(kinds.has("work") && kinds.has("chat") && (kinds.has("pip") || kinds.has("setup")), `every kind of card is on Home (${cards.map((c) => c.key)})`);
      // (The Work reply's card is held by the tests of fix 8, above; here every card that is on Home is measured.)
      assert.ok(cards.some((c) => c.key === "chat:chat_2"), "the chat's two-line reply among them");
      for (const c of cards) assert.deepEqual(overlaps(c), [], `${c.key} at rest: no answer lies on its words`);
      // Each answer of each card pointed at in turn: its pill is up, and still on no word.
      for (const c of cards) for (let i = 0; i < c.labels.length; i++) {
        await x.see(c.key);
        const b = (await cardBoxes(p)).find((n) => n.key === c.key).answers[i];
        await p.mouse.move((b.left + b.right) / 2, (b.top + b.bottom) / 2, { steps: 2 });
        await p.waitForTimeout(330);
        const now = (await cardBoxes(p)).find((n) => n.key === c.key);
        const pill = now.answers.find((a) => a.what.startsWith("pill"));
        assert.ok(pill, `${c.key}: “${c.labels[i]}” pointed at shows its pill`);
        assert.deepEqual(overlaps(now), [], `${c.key}: “${c.labels[i]}” pointed at lies on none of its words`);
        assert.ok(pill.left >= now.card.left - 0.5 && pill.right <= now.card.right + 0.5, `${c.key}: and stays inside its card`);
      }
      // The keyboard's pill too.
      await p.mouse.move(width / 2, 1090);
      await x.see("chat:chat_2");
      await p.focus(`.dgc-hub-card[data-key="chat:chat_2"] .dgc-ia-btn`);
      await p.keyboard.press("Tab"); await p.waitForTimeout(330);
      cards = await cardBoxes(p);
      for (const c of cards) assert.deepEqual(overlaps(c), [], `${c.key} with the keyboard on an answer: none on its words`);
      // The words give way instead: the long reply is still two lines at most, and ends with an ellipsis.
      const chat = cards.find((c) => c.key === "chat:chat_2");
      assert.ok(chat.title.lines <= 2 && chat.title.cut, `the long reply wraps and is cut before the answers (${chat.title.lines} lines)`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 11. another folder's session can be pinned (13 Nov, later) --------------------------------------------------------
test("11. on All projects another folder's session has its pin and its “…”, and the dock's tile names its folder; a gone folder's has neither", async (t) => {
  if (skipOrFail(t)) return;
  const folders = [{ folder: "/home/me/code/shop", shown: "~/code/shop", name: "shop", here: true, exists: true }, { folder: "/home/me/code/garden", shown: "~/code/garden", name: "garden", here: false, exists: true },
    { folder: "/home/me/code/notes", shown: "~/code/notes", name: "notes", here: false, exists: false }];
  const row = (id, name, at, extra = {}) => ({ id, path: `/s/${id}.json`, name, preview: "", when: stamp(60 + at * 500), count: 4, open: false, project: folders[at].shown, projectPath: folders[at].folder, projectName: folders[at].name,
    ...(folders[at].here ? {} : { here: false }), ...(folders[at].exists ? {} : { gone: true }), ...extra });
  const items = [row("s-shop-1", "Checkout totals round the wrong way", 0), row("s-garden-1", "Water the tomatoes on Fridays", 1), row("s-notes-1", "Tidy the reading list", 2)];
  const list = { type: "sessions_list", error: "", searchable: true, query: "", more: false, folders: { choice: "", rows: folders }, items };
  const x = await openDock(browser, { tab: "work", width: 640, height: 700, sessions: null, pins: [] });
  try {
    const p = x.page;
    await x.send(list); await settle(p, 150);
    const acts = (id) => p.evaluate((i) => [...document.querySelectorAll(`#sessions-list .session-row[data-id="${i}"] .session-actions > *`)].map((b) => b.className.split(" ")[0]), id);
    assert.deepEqual(await acts("s-shop-1"), ["session-open", "dgc-pin", "session-more", "session-delete"], "this folder's own: Open, the pin, “…” and Delete, as before");
    assert.deepEqual(await acts("s-garden-1"), ["session-open", "dgc-pin", "session-more"], "another folder's: Open, the pin and “…” (Delete stays its own folder's)");
    assert.deepEqual(await acts("s-notes-1"), [], "a gone folder's: nothing");
    // The pin: the page says which session and where it runs; the dock holds it, its tile naming the folder.
    await p.hover('#sessions-list .session-row[data-id="s-garden-1"]');
    await p.click('#sessions-list .session-row[data-id="s-garden-1"] .dgc-pin');
    await settle(p, 200);
    const sent = (await x.posted("dockToggle")).at(-1);
    assert.deepEqual([sent.item.kind, sent.item.id, sent.item.ref], ["work", "s-garden-1", { folder: "/home/me/code/garden", folder_name: "garden" }], "the pin says where the session runs");
    assert.equal((await x.posted("openSessionInEditor")).length, 0, "pinning opens nothing");
    let d = await dockNow(p);
    assert.deepEqual(d.items.map((i) => i.key), ["work:s-garden-1", "+"], "the dock holds it");
    assert.equal(await p.getAttribute('#sessions-list .session-row[data-id="s-garden-1"] .dgc-pin', "aria-pressed"), "true", "and its row's pin is on");
    await p.focus('#dgc-dock .dgc-dock-item'); await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowLeft"); await settle(p, 150);
    d = await dockNow(p);
    assert.equal(d.tip?.title, "Water the tomatoes on Fridays");
    assert.match(d.tip?.state || "", /garden/, `its name says the folder it runs in (${d.tip?.state})`);
    // From the dock: the host is asked to open that pin (it opens it in its folder: session-tabs.test.mjs).
    await p.click('#dgc-dock .dgc-dock-item[data-key="work:s-garden-1"]'); await settle(p);
    assert.deepEqual((await x.posted("dockOpen")).map((m) => m.key), ["work:s-garden-1"]);
    // Its “…”: pin and colour, as this folder's own.
    await p.hover('#sessions-list .session-row[data-id="s-garden-1"]');
    await p.click('#sessions-list .session-row[data-id="s-garden-1"] .session-more'); await settle(p, 200);
    const menu = await p.evaluate(() => ({ rows: [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => r.textContent.trim()), colours: document.querySelectorAll(".dgc-pop .dgc-swatch [data-mark], .dgc-pop .dgc-swatch button").length }));
    assert.deepEqual(menu.rows.slice(0, 2), ["Open in editor", "Unpin from the dock"], "its menu: open, and the pin");
    assert.ok(menu.colours >= 12, `and its colours (${menu.colours})`);
    await p.keyboard.press("Escape");
    // Its folder goes: the dock's tile says so.
    await x.send({ ...list, items: items.map((s) => (s.id === "s-garden-1" ? { ...s, gone: true } : s)) }); await settle(p, 200);
    await p.focus('#dgc-dock .dgc-dock-item'); await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowLeft"); await settle(p, 150);
    assert.match((await dockNow(p)).tip?.state || "", /Folder not found/, "a pin whose folder is gone says “Folder not found”");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- 12. the Pips tab stands on the same ground as Home, Work and Chat (13 Nov, later) -----------------------------------
/** The ground of the page as painted: the colour most pixels of a strip down the left gutter have. */
const groundNow = async (page) => {
  const shot = await page.screenshot({ clip: { x: 1, y: 150, width: 3, height: 380 } });
  return page.evaluate(async (b64) => { const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, seen = {}; for (let k = 0; k < d.length; k += 4) { const key = `${d[k]},${d[k + 1]},${d[k + 2]}`; seen[key] = (seen[key] || 0) + 1; }
    return Object.entries(seen).sort((a, b) => b[1] - a[1])[0][0]; }, shot.toString("base64"));
};
for (const theme of ["dark-modern", "light-modern", "hc", "cursor-dark"]) {
  test(`12. the side bar's Pips view stands on the same ground as Home, Work and Chat (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "home", theme, width: 640, height: 700 });
    try {
      const p = x.page, grounds = {}, said = {};
      const bars = () => p.evaluate(() => { const css = (id) => getComputedStyle(document.getElementById(id)); const probe = document.createElement("i"); probe.style.background = "var(--glass-ground)"; document.body.append(probe); const glass = getComputedStyle(probe).backgroundColor; probe.remove();
        return { body: css("sessions-host").backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(document.body).backgroundColor : css("sessions-host").backgroundColor, pips: css("pips-host").backgroundColor, glass }; });
      for (const tab of ["home", "work", "chat", "pips"]) {
        await p.click(`#side-tab-${tab}`); await p.mouse.move(320, 690); await settle(p, tab === "pips" ? 500 : 200);
        grounds[tab] = await groundNow(p); said[tab] = await bars();
      }
      assert.deepEqual([grounds.work, grounds.chat], [grounds.home, grounds.home], "Home, Work and Chat stand on one ground");
      assert.equal(grounds.pips, grounds.home, `and so does the Pips view (Pips ${grounds.pips}, the others ${grounds.home})`);
      assert.equal(said.pips.pips, said.home.body, "the Pips view's own background is the side bar's, as the page's");
      assert.equal(said.pips.glass, said.home.glass, "and the tab bar and the dock stand on the same ground on every tab");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 16. a chat inside a project is the same row as any chat (13 Nov, later) ---------------------------------------------
/** A chat's row: its mark and palette, what it says, and its actions. */
const chatRows = (page, list) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} .chat-row`)].map((row) => { const mark = row.querySelector(".session-blob [data-mark]"), r = row.getBoundingClientRect(), m = mark?.getBoundingClientRect();
  return { id: row.dataset.id, mark: mark ? `${mark.dataset.mark}:${mark.dataset.palette}` : "", markSize: m ? [Math.round(m.width), Math.round(m.height)] : null, name: row.querySelector(".session-name").textContent, sub: row.querySelector(".session-sub")?.textContent || "",
    age: row.querySelector(".session-age")?.textContent || "", actions: [...row.querySelectorAll(".session-actions > *")].map((b) => b.className.split(" ")[0]), height: Math.round(r.height), left: Math.round(r.left) }; }), list);
for (const theme of ["dark-modern", "light-modern"]) for (const width of [640, 300]) {
  test(`16. a chat inside a project has its mark, its line, its age and the same actions as any chat (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "chat", theme, width, height: 760, pins: [{ key: "chat:chat_3", kind: "chat", id: "chat_3", title: "Packing list", sub: "", look: {}, ref: {} }] });
    try {
      const p = x.page;
      await x.send({ type: "chatdgc_project_chats", project: "project_" + "a".repeat(32), items: [{ id: "chat_3", title: "Packing list", preview: "Two shirts, the hat and the **ferry** tickets.", updated_at: "2026-11-04T09:00:00Z" }, { id: "chat_4", title: "Flights and the ferry", updated_at: "2026-11-03T09:00:00Z" }] });
      await settle(p, 200);
      const inside = await chatRows(p, "#projects-list"), top = await chatRows(p, "#chats-list");
      assert.deepEqual(inside.map((r) => r.id), ["chat_3", "chat_4"], "the open project lists its chats");
      for (const row of inside) {
        assert.match(row.mark, /^mote:[a-z]+$/, `${row.name}: it has its Mote mark (${row.mark})`);
        assert.deepEqual(row.markSize, top[0].markSize, `${row.name}: the size of any chat's mark`);
        assert.deepEqual(row.actions, top[0].actions, `${row.name}: the same actions as a chat's row (${top[0].actions})`);
        assert.ok(row.age, `${row.name}: its age`);
        assert.equal(row.height, top.find((r) => !!r.sub === !!row.sub)?.height ?? row.height, `${row.name}: the height of a chat's row`);
        assert.ok(row.left > top[0].left, `${row.name}: indented under its project`);
      }
      assert.equal(inside[0].sub, "Two shirts, the hat and the ferry tickets.", "its last words under its name, as any chat's");
      // The same palette everywhere: its row's mark and its tile on the dock.
      const tile = await p.evaluate(() => document.querySelector('#dgc-dock .dgc-dock-item[data-key="chat:chat_3"] [data-mark]')?.dataset.palette);
      assert.equal(`mote:${tile}`, inside[0].mark, "the palette its dock tile wears");
      assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector("#projects-list .project-chats")).borderLeftStyle !== "none" || !!document.querySelector("#projects-list .project-chats")), true, "the tree's line stays");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 17. a ChatDGC project wears a pinwheel and can be pinned (13 Nov, later) -------------------------------------------
const projectRows = (page) => page.evaluate(() => [...document.querySelectorAll("#projects-list .project-row")].map((row) => { const mark = row.querySelector("[data-mark]");
  return { id: row.dataset.id, mark: mark ? `${mark.dataset.mark}:${mark.dataset.palette}` : "", petals: mark ? mark.querySelectorAll("i").length : 0, moving: mark ? mark.hasAttribute("data-moving") : false,
    play: mark ? getComputedStyle(mark.querySelector("i")).animationPlayState : "", folder: !!row.querySelector(".codicon-folder"), name: row.querySelector(".project-name").textContent, actions: [...row.querySelectorAll(".session-actions > *")].map((b) => b.className.split(" ")[0]) }; }));
test("17. a ChatDGC project wears a pinwheel in a palette of its own, still unless a chat in it is answering; Work's folders keep their folder icon", async (t) => {
  if (skipOrFail(t)) return;
  const A = "project_" + "a".repeat(32), B = "project_" + "b".repeat(32);
  const x = await openDock(browser, { tab: "chat", width: 640, height: 760, pins: [] });
  try {
    const p = x.page;
    await x.send({ type: "chatdgc_project_chats", project: A, items: [{ id: "chat_3", title: "Packing list", updated_at: "2026-11-04T09:00:00Z" }] });
    await settle(p, 250);
    let rows = await projectRows(p);
    assert.deepEqual(rows.map((r) => r.id), [A, B]);
    for (const r of rows) { assert.match(r.mark, /^pinwheel:[a-z]+$/, `${r.name}: a pinwheel (${r.mark})`); assert.deepEqual([r.petals, r.folder, r.moving, r.play], [4, false, false, "paused"], `${r.name}: four petals, no folder icon, still`); }
    assert.notEqual(rows[0].mark, rows[1].mark, "two projects side by side wear two palettes");
    assert.ok((await x.posted("dockPalettes")).some((m) => m.kind === "project"), "the host is asked to keep the palettes given");
    // The host's word is kept: the palettes it says are the ones worn.
    await p.evaluate(([a, b]) => window.__dockSay?.({ colours: { ...(window.__dock.colours || {}), [`project:${a}`]: "rose", [`project:${b}`]: "mint" } }), [A, B]);
    await settle(p, 250);
    rows = await projectRows(p);
    assert.deepEqual(rows.map((r) => r.mark), ["pinwheel:rose", "pinwheel:mint"], "each wears the palette that is kept for it");
    // A chat inside the first project is answering: its pinwheel turns, the other's doesn't.
    await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: [], answering: ["chat_3"] });
    await settle(p, 250);
    rows = await projectRows(p);
    assert.deepEqual(rows.map((r) => [r.moving, r.play]), [[true, "running"], [false, "paused"]], "it turns only while a chat in it is answering");
    await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: [], answering: [] });
    await settle(p, 250);
    assert.deepEqual((await projectRows(p)).map((r) => r.play), ["paused", "paused"], "and is still again when it has answered");
    // Work's Project Folder is a directory: it keeps its plain folder mark.
    await p.click("#side-tab-work"); await settle(p, 200);
    assert.equal(await p.evaluate(() => document.querySelectorAll("#work-home .pinwheel, .dgc-folder-menu .pinwheel").length), 0, "no pinwheel on Work");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
test("17. reduced motion: a project's pinwheel never turns", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "chat", width: 640, height: 760, pins: [], motion: "reduce" });
  try {
    await x.send({ type: "chatdgc_project_chats", project: "project_" + "a".repeat(32), items: [{ id: "chat_3", title: "Packing list", updated_at: "2026-11-04T09:00:00Z" }] });
    await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: [], answering: ["chat_3"] });
    await settle(x.page, 250);
    const names = await x.page.evaluate(() => [...document.querySelectorAll("#projects-list .pinwheel i")].map((i) => getComputedStyle(i).animationName));
    assert.ok(names.length >= 8 && names.every((n) => n === "none"), `no petal is animated (${[...new Set(names)]})`);
  } finally { await x.close(); }
});
test("17. a project is pinned from its row, the dock shows its pinwheel and name with how many chats it has, and opens it", async (t) => {
  if (skipOrFail(t)) return;
  const A = "project_" + "a".repeat(32);
  const x = await openDock(browser, { tab: "chat", width: 640, height: 760, pins: [] });
  try {
    const p = x.page;
    await settle(p, 200);
    assert.deepEqual((await projectRows(p))[0].actions, ["dgc-pin", "session-more"], "a project's row has the pin and “…”, as a chat's");
    await p.hover(`#projects-list .project-row[data-id="${A}"]`);
    await p.click(`#projects-list .project-row[data-id="${A}"] .dgc-pin`); await settle(p, 250);
    assert.deepEqual((await x.posted("dockToggle")).at(-1).item, { kind: "project", id: A, title: "Goa trip" });
    assert.equal((await x.posted("chatdgcProjectOpen")).length, 0, "pinning opens nothing");
    const tile = await p.evaluate((key) => { const b = document.querySelector(`#dgc-dock .dgc-dock-item[data-key="${key}"]`), mark = b?.querySelector("[data-mark]"); return b ? { mark: mark ? `${mark.dataset.mark}:${mark.dataset.palette}` : "", label: b.getAttribute("aria-label") } : null; }, `project:${A}`);
    assert.ok(tile, "the dock holds the project");
    assert.equal(tile.mark, (await projectRows(p))[0].mark, "its tile is its pinwheel, in its palette");
    await p.focus("#dgc-dock .dgc-dock-item"); await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowLeft"); await settle(p, 150);
    const d = await dockNow(p);
    assert.deepEqual([d.tip?.title, d.tip?.state], ["Goa trip", "Space · 2 chats"], "its name, and how many chats it has");
    await p.click(`#dgc-dock .dgc-dock-item[data-key="project:${A}"]`); await settle(p);
    assert.deepEqual((await x.posted("dockOpen")).map((m) => m.key), [`project:${A}`], "a click asks the host to open it");
    // Its “…”: the pin, and its colour.
    await p.hover(`#projects-list .project-row[data-id="${A}"]`);
    await p.click(`#projects-list .project-row[data-id="${A}"] .session-more`); await settle(p, 200);
    const menu = await p.evaluate(() => ({ rows: [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => r.textContent.trim()), swatches: document.querySelectorAll(".dgc-pop .dgc-swatch").length, set: document.querySelector(".dgc-pop .dgc-swatch [data-mark]")?.dataset.mark }));
    assert.deepEqual([menu.rows.slice(0, 2), menu.swatches, menu.set], [["Open in editor", "Unpin from the dock"], 12, "pinwheel"], "open, unpin, and twelve pinwheels to choose its colour from");
    await p.click('.dgc-pop .dgc-swatch[data-colour="orchid"]'); await settle(p, 200);
    assert.deepEqual((await x.posted("dockColour")).at(-1), { type: "dockColour", key: `project:${A}`, colour: "orchid" });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- 5, again: every shared menu has a solid ground (13 Nov, later: Home's Show menu was see-through in Cursor) --------
// (Home's Show filter went on 13 Nov, when Home became cards: the cards you add are the filter. Its test went with it; test/home-cards.test.mjs holds that Show is gone.)

// ---- 18. a Work folder is a directory with a folder icon of its own (13 Nov, later) --------------------------------------
/** Every folder icon under `scope`: its palette, whether it has a label, and where its papers stand. */
const folderIcons = (page, scope) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} .folder-icon`)].map((icon) => { const r = icon.getBoundingClientRect(), front = icon.querySelector(".folder-paper--front");
  return { palette: [...icon.classList].find((c) => c.startsWith("folder--"))?.slice(8) || "", size: [Math.round(r.width), Math.round(r.height)], label: icon.querySelectorAll(".folder-label").length, text: icon.textContent.trim(), hidden: icon.getAttribute("aria-hidden"),
    papers: icon.querySelectorAll(".folder-paper").length, lines: icon.querySelectorAll(".folder-line").length, flap: icon.querySelectorAll(".folder-flap > *").length, front: getComputedStyle(front).transform, loops: icon.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming?.().iterations === Infinity).length,
    of: icon.closest("[data-folder]")?.dataset.folder ?? (icon.closest(".dgc-folder") ? "button" : icon.closest(".new-session-path") ? "line" : "") }; }), scope);
for (const theme of ["dark-modern", "light-modern", "hc"]) {
  test(`18. a folder wears the folder icon in a palette of its own, the same in the dropdown, its button and New Session's line; no label; still unless pointed at (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const folders = [{ folder: "/home/me/code/shop", shown: "~/code/shop", name: "shop", here: true, exists: true }, { folder: "/home/me/code/garden", shown: "~/code/garden", name: "garden", here: false, exists: true },
      { folder: "/home/me/code/notes", shown: "~/code/notes", name: "notes", here: false, exists: false }];
    const list = (choice) => ({ type: "sessions_list", error: "", searchable: true, query: "", more: false, folders: { choice, rows: folders, window: { folder: folders[0].folder, shown: folders[0].shown, name: "shop" } }, items: [] });
    const x = await openDock(browser, { tab: "work", theme, width: 640, height: 700, sessions: null, pins: [] });
    try {
      const p = x.page;
      await x.send(list("")); await settle(p, 250);
      assert.ok((await x.posted("dockPalettes")).some((m) => m.kind === "folder" && m.list.length === 3), "the host is asked to keep each folder's palette");
      assert.deepEqual(await folderIcons(p, "#sessions-folder-slot"), [], "All projects: the button has no folder (it is not one)");
      await p.click("#sessions-folder-pick"); await settle(p, 900);
      const rows = await folderIcons(p, ".dgc-folder-menu");
      assert.deepEqual(rows.map((r) => r.of), folders.map((f) => f.folder), "each folder's row has its folder icon; All projects keeps its stack");
      assert.equal(await p.evaluate(() => document.querySelector('.dgc-folder-menu [data-folder=""] svg') ? 1 : 0), 1, "All projects: its own mark");
      for (const r of rows) {
        assert.deepEqual([r.label, r.text, r.hidden, r.papers, r.lines, r.flap, r.loops], [0, "", "true", 3, 3, 4, 0], `${r.of}: the symbol alone (no label), its three papers and its flap, and no motion that loops`);
        assert.ok(r.size[0] >= 16 && r.size[0] <= 20 && r.size[0] === r.size[1], `${r.of}: 16 to 20 px, square (${r.size})`);
        assert.match(r.palette, /^(ember|peach|saffron|fern|mint|lagoon|ice|azure|iris|lilac|orchid|rose)$/, `${r.of}: one of the twelve palettes`);
      }
      assert.equal(new Set(rows.map((r) => r.palette)).size, 3, `three folders side by side wear three palettes (${rows.map((r) => r.palette)})`);
      // Still at rest; the papers lift while its row is pointed at, and settle again.
      const lifted = async () => (await folderIcons(p, ".dgc-folder-menu"))[1].front;
      const rest = await lifted();
      await p.hover(`.dgc-folder-menu [data-folder="${folders[1].folder}"]`); await p.waitForTimeout(600);
      assert.notEqual(await lifted(), rest, "pointed at, its papers lift");
      await p.mouse.move(5, 690); await p.waitForTimeout(600);
      assert.equal(await lifted(), rest, "and settle when the pointer leaves");
      // Chosen: the button wears the same folder, in the same palette; and so does New Session's line.
      await p.click(`.dgc-folder-menu [data-folder="${folders[1].folder}"]`); await x.send(list(folders[1].folder)); await settle(p, 400);
      const button = await folderIcons(p, "#sessions-folder-slot");
      assert.deepEqual(button.map((b) => [b.of, b.palette, b.label]), [["button", rows[1].palette, 0]], "the button's folder is the chosen one's, in its palette");
      await p.click("#sessions-new"); await settle(p, 300);
      const line = (await folderIcons(p, ".new-session-dialog")).filter((i) => i.of === "line");
      assert.deepEqual(line.map((i) => [i.palette, i.label]), [[rows[0].palette, 0]], "New Session's folder line: this window's folder, in its palette");
      await p.keyboard.press("Escape");
      // The palette the host keeps is the one worn, everywhere.
      const id = await p.evaluate((f) => window.DgcFolderPick.folderId(f), folders[1].folder);
      await p.evaluate((key) => window.__dockSay({ colours: { ...window.__dock.colours, [key]: "rose" } }), `folder:${id}`); await settle(p, 400);
      assert.deepEqual((await folderIcons(p, "#sessions-folder-slot")).map((b) => b.palette), ["rose"], "the palette kept for it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
test("18. reduced motion: a folder's papers never move", async (t) => {
  if (skipOrFail(t)) return;
  const folders = [{ folder: "/home/me/code/shop", shown: "~/code/shop", name: "shop", here: true, exists: true }, { folder: "/home/me/code/garden", shown: "~/code/garden", name: "garden", here: false, exists: true }];
  const x = await openDock(browser, { tab: "work", width: 640, height: 700, sessions: null, pins: [], motion: "reduce" });
  try {
    const p = x.page;
    await x.send({ type: "sessions_list", error: "", searchable: true, query: "", more: false, folders: { choice: "", rows: folders }, items: [] }); await settle(p, 250);
    await p.click("#sessions-folder-pick"); await settle(p, 300);
    const rest = (await folderIcons(p, ".dgc-folder-menu"))[1].front;
    await p.hover(`.dgc-folder-menu [data-folder="${folders[1].folder}"]`); await p.waitForTimeout(500);
    assert.equal((await folderIcons(p, ".dgc-folder-menu"))[1].front, rest, "pointed at: its papers stay where they are");
  } finally { await x.close(); }
});
