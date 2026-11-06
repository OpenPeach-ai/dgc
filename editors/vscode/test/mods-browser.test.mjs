// The user's mods in real Chromium (media/mods.js with the real Work panel and the real ChatDGC screen and their
// stylesheets): the status line is one line however long a mod's status is, cut with its whole text on hover; the
// strip sits above the prompt box and nothing scrolls sideways at 320 px; a mod's panel docks beside the chat when
// wide (the Send button stays in view) and covers the page when narrow; every tone a mod's words take clears 4.5:1 in
// the dark, light and high contrast themes. In ChatDGC, which has no slash menu of its own: "/" lists /mods and each
// running mod's commands, choosing one or sending "/name args" runs it at once (never sent as a message), the answer
// is a card under the mod's name, a notice is the page's notice, and the question about a mod DGC wrote is answered
// from the keyboard. jsdom has no layout, cascade or real keyboard focus, so mods-work.test.mjs can't say these.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { LONG, OFFER, RESULT, openChatMods, openSettings, openWork } from "./support/mods-scene.mjs";
import { openChat } from "./support/chat-scene.mjs";

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

// Contrast of each tone's words against the ground they are drawn on, as the browser resolved both.
async function toneContrast(page, scope) {
  return page.evaluate((root) => {
    const rgb = (css) => {
      const probe = document.createElement("canvas").getContext("2d");
      probe.fillStyle = "#000"; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const ground = (node) => { for (let n = node; n; n = n.parentElement) { const bg = getComputedStyle(n).backgroundColor; if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg; } return "#fff"; };
    const out = {};
    for (const node of document.querySelectorAll(`${root} .mod-text[data-tone]`)) {
      out[node.dataset.tone] = Math.round(ratio(rgb(getComputedStyle(node).color), rgb(ground(node))) * 100) / 100;
    }
    return out;
  }, scope);
}

for (const theme of ["dark-modern", "light-modern", "hc"]) {
  for (const width of [320, 1200]) {
    test(`Work at ${width}px, ${theme}: one status line, the strip above the box, a docked or covering panel, readable tones`, async (t) => {
      if (skipOrFail(t)) return;
      const scene = await openWork(browser, { width, theme });
      const { page } = scene;
      try {
        const got = await page.evaluate(() => {
          const r = (n) => n.getBoundingClientRect();
          const line = document.querySelector("#mod-strip .mod-status");
          const items = [...line.querySelectorAll(".mod-status-item")];
          return { line: r(line).height, items: items.map((i) => [r(i).height, Math.round(r(i).top)]),
                   cut: items[0].querySelector(".mod-status-body").scrollWidth > items[0].querySelector(".mod-status-body").clientWidth,
                   title: items[0].title, strip: r(document.getElementById("mod-strip")).bottom, box: r(document.getElementById("cbox")).top,
                   scroll: document.documentElement.scrollWidth, view: innerWidth };
        });
        assert.ok(got.line <= 24, `one line: ${got.line}px`);
        assert.equal(new Set(got.items.map(([, top]) => top)).size, 1, "every item on that one line");
        assert.ok(got.items.every(([h]) => h <= 24));
        if (width === 320) assert.ok(got.cut, "a long status is cut at 320px");
        assert.ok(got.title.includes(LONG), "the whole of it on hover");
        assert.ok(got.strip <= got.box + 0.5, "above the prompt box");
        assert.ok(got.scroll <= got.view, `nothing scrolls sideways (${got.scroll} > ${got.view})`);

        await page.click(".mod-status-item[data-mod=tally]");
        await scene.settle();
        const drawn = await page.evaluate(() => {
          const r = (n) => n.getBoundingClientRect();
          const drawer = document.querySelector(".mod-drawer");
          return { drawer: { left: r(drawer).left, width: r(drawer).width }, send: r(document.getElementById("send")).right,
                   scroll: document.documentElement.scrollWidth, view: innerWidth,
                   wide: drawer.querySelector(".mod-table-wrap").scrollWidth > drawer.querySelector(".mod-table-wrap").clientWidth };
        });
        if (width >= 760) {
          assert.equal(Math.round(drawn.drawer.width), 380);
          assert.ok(drawn.send <= drawn.drawer.left + 0.5, "docked beside the chat: Send stays in view");
        } else {
          assert.equal(Math.round(drawn.drawer.width), width, "narrow: it covers the page");
        }
        assert.ok(drawn.scroll <= drawn.view, "the drawer scrolls nothing sideways");
        const tones = await toneContrast(page, ".mod-drawer");
        for (const tone of ["muted", "strong", "accent", "ok", "warn", "bad"]) {
          assert.ok(tones[tone] >= 4.5, `${tone} is ${tones[tone]}:1 in ${theme}`);
        }
        await page.keyboard.press("Escape");
        assert.equal(await page.evaluate(() => document.activeElement?.dataset?.mod), "tally", "Esc puts the focus back on its status");
        assert.deepEqual(scene.errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [320, 1200]) {
    test(`ChatDGC at ${width}px, ${theme}: the strip above the box, one status line, no sideways scroll`, async (t) => {
      if (skipOrFail(t)) return;
      const scene = await openChatMods(browser, { width, theme });
      const { page } = scene;
      try {
        const got = await page.evaluate(() => {
          const r = (n) => n.getBoundingClientRect();
          const strip = document.getElementById("cd-mod-strip");
          return { line: r(strip.querySelector(".mod-status")).height, strip: r(strip).bottom, box: r(document.getElementById("cd-box")).top,
                   band: !!strip.querySelector(".mod-band"), scroll: document.documentElement.scrollWidth, view: innerWidth };
        });
        assert.ok(got.line <= 24);
        assert.ok(got.band);
        assert.ok(got.strip <= got.box + 0.5);
        assert.ok(got.scroll <= got.view);
        await page.click(".mod-status-item[data-mod=tally]");
        const drawer = await page.evaluate(() => { const r = document.querySelector(".mod-drawer").getBoundingClientRect(); return [r.width, document.querySelector(".mod-drawer-title").textContent]; });
        assert.equal(drawer[1], "From Tally");
        assert.equal(Math.round(drawer[0]), width >= 760 ? 380 : width);
        const tones = await toneContrast(page, ".mod-drawer");
        for (const tone of ["muted", "strong", "accent", "ok", "warn", "bad"]) assert.ok(tones[tone] >= 4.5, `${tone} ${tones[tone]}`);
        assert.deepEqual(scene.errors, []);
      } finally { await page.close(); }
    });
  }
}

test("ChatDGC: \"/\" lists /mods and the running mods' commands, and a chosen or sent one runs at once, never as a message", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await openChatMods(browser, { width: 900 });
  const { page, posted, modsPosted, send } = scene;
  try {
    assert.equal((await modsPosted("list")).length, 1);
    assert.match((await modsPosted("list"))[0].request_id, /^chatdgc-mods-/);
    assert.equal((await modsPosted("watch")).length, 1);
    await page.click("#cd-input");
    await page.keyboard.type("/");
    const rows = await page.$$eval(".mod-slash-row", (r) => r.map((n) => [n.querySelector(".mod-slash-name").textContent,
                                                                             n.querySelector(".mod-slash-desc").textContent]));
    assert.deepEqual(rows.map(([name]) => name), ["/mods", "/tally", "/window"]);
    assert.equal(rows[1][1], "Steps this session, by tool · from Tally");
    assert.equal(await page.getAttribute("#cd-input", "aria-expanded"), "true");
    await page.keyboard.type("ta");
    await page.keyboard.press("Enter");
    const [run] = await modsPosted("command");
    assert.deepEqual({ name: run.name, surface: run.surface }, { name: "tally", surface: "chat" });
    assert.match(run.request_id, /^chatdgc-mods-/);
    assert.equal(await page.evaluate(() => document.getElementById("cd-input").value), "", "chosen, it ran: the box is empty again");
    await send({ type: "modsEvent", event: { type: "mod_result", request_id: run.request_id, name: "tally", mod: "Tally", tree: RESULT } });
    const card = await page.$eval("#cd-log .mod-result", (n) => [n.querySelector(".mod-result-from").textContent, n.dataset.state, n.querySelector(".mod-table td")?.textContent]);
    assert.deepEqual(card, ["From Tally", "done", "read_file"]);
    // Typed with its arguments and sent: the same, and still no message.
    await page.fill("#cd-input", "/tally by tool");
    await page.keyboard.press("Escape").catch(() => {});
    await page.press("#cd-input", "Enter");
    const second = (await modsPosted("command")).at(-1);
    assert.equal(second.args, "by tool");
    assert.deepEqual((await posted()).filter((m) => m.type === "send" || m.type === "chatdgc_send"), [], "nothing went to the model");
    await send({ type: "modsEvent", event: { type: "command_rejected", command: "mod_command", request_id: second.request_id, message: "Tally isn't running." } });
    assert.equal(await page.$eval("#cd-log .mod-result:last-of-type .mod-result-error", (n) => n.textContent), "Tally isn't running.");
    // /mods opens the list.
    await page.fill("#cd-input", "/mods");
    await page.press("#cd-input", "Enter");
    assert.equal(await page.$eval(".mod-drawer", (n) => n.hidden), false);
    assert.equal(await page.$eval(".mod-drawer-title", (n) => n.textContent), "Mods");
    assert.deepEqual(scene.errors, []);
  } finally { await page.close(); }
});

test("ChatDGC: a notice under the mod's title, and the question about a written mod answered from the keyboard", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await openChatMods(browser, { width: 900, theme: "light-modern" });
  const { page, send, modsPosted } = scene;
  try {
    await send({ type: "modsEvent", event: { type: "mod_toast", name: "tally", mod: "Tally", text: "counting from zero", surface: "chat" } });
    assert.deepEqual(await page.$eval("#cd-notice", (n) => [n.hidden, n.textContent, n.dataset.kind]), [false, "Tally: counting from zero", "info"]);
    await send({ type: "modsEvent", event: { ...OFFER, surface: "chat" } });
    assert.equal(await page.$eval("#cd-log .card.mod-offer .q", (n) => n.textContent), "Turn on the mods DGC writes in this session?");
    await page.focus("#cd-log .card.mod-offer .btns button");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Allow");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Not now");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    const [answer] = await modsPosted("offer");
    assert.deepEqual({ id: answer.id, allow: answer.allow, surface: answer.surface }, { id: OFFER.id, allow: true, surface: "chat" });
    assert.match(await page.$eval("#cd-log .card.mod-offer .decision", (n) => n.textContent), /Allowed: Counter runs for this session/);
    assert.deepEqual(scene.errors, []);
  } finally { await page.close(); }
});

test("ChatDGC without the capability: no strip, no slash menu, and \"/tally\" is an ordinary message", async (t) => {
  if (skipOrFail(t)) return;
  const scene = await openChat(browser, { width: 900 });
  const { page, send, posted } = scene;
  try {
    await send({ type: "modsReady", capabilities: {} });
    await send({ type: "modsEvent", event: { type: "mods", mods: [{ name: "tally", title: "Tally", state: "running", commands: [{ name: "tally" }], draws: [] }], on: true, surface: "chat" } });
    assert.equal(await page.$eval("#cd-mod-strip", (n) => n.hidden), true);
    await page.click("#cd-input");
    await page.keyboard.type("/");
    assert.equal(await page.$eval(".mod-slash", (n) => n.hidden), true);
    assert.deepEqual((await posted()).filter((m) => m.type === "mods"), []);
  } finally { await page.close(); }
});

test("Settings -> Plugins -> Mods: the same list, the same words and actions, safe mode and how to make one, at 300px too", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, theme] of [[1200, "dark"], [300, "light"]]) {
    const { page, posted, errors } = await openSettings(browser, { width, theme });
    try {
      await page.click("[data-lane=mods]");
      await page.waitForSelector(".mod-item");
      assert.equal((await posted("modsList")).length, 1);
      const items = await page.$$eval(".mod-item", (n) => n.map((i) => [i.querySelector(".mod-item-title").textContent,
        i.querySelector(".mod-state").textContent, i.querySelector(".mod-item-where").textContent,
        [...i.querySelectorAll(".mod-item-actions button")].map((b) => b.textContent)]));
      assert.deepEqual(items, [["Tally", "On", "DGC's own", ["Reload", "Turn off"]], ["Context", "On", "DGC's own", ["Reload", "Turn off"]],
        ["Guard", "Needs your Allow", "DGC's own", ["Allow"]], ["Release notes", "Off", "From the plugin Ship Kit", ["Turn on"]]]);
      assert.ok((await page.$$eval('.mod-item[data-mod="guard"] .mod-asks li', (n) => n.map((li) => li.textContent)))
        .includes("It can see each step DGC is about to take, and stop it or ask you first."), "what it asks, before its Allow");
      const about = await page.$eval(".mod-about", (n) => n.textContent);
      assert.match(about, /dgc --safe-mode runs no mods at all/);
      assert.match(about, /\$mod-author.*dgc mods dev FOLDER/);
      await page.click('.mod-item[data-mod="guard"] [data-op=allow]');
      assert.deepEqual((await posted("modSet")).map((m) => [m.name, m.op]), [["guard", "allow"]]);
      assert.equal((await posted("modSet"))[0].review, "a".repeat(64));
      const fit = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, document.getElementById("main").scrollWidth, document.getElementById("main").clientWidth]);
      assert.ok(fit[0] <= fit[1] && fit[2] <= fit[3], `nothing scrolls sideways at ${width}px: ${fit}`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  const { page } = await openSettings(browser, { unsupported: true });
  try {
    await page.click("[data-lane=mods]");
    await page.getByText("This DGC has no mods yet").waitFor();
    assert.match(await page.$eval("#mods-list", (n) => n.textContent), /This DGC has no mods yet/);
  } finally { await page.close(); }
});

test("Settings: a plugin's install review lists each mod and what it asks, and says when an update asks for more", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openSettings(browser, { width: 900, theme: "light" });
  try {
    await page.click("#browse-directory");
    await page.evaluate(() => window.postMessage({ type: "plugins", items: [{ name: "shipkit", display_name: "Ship Kit", summary: "s", installed: false, license: "MIT", marketplace: "personal", skills: [] }] }, "*"));
    await page.waitForSelector("[data-install='shipkit']");
    await page.click("[data-install='shipkit']");
    await page.waitForSelector("#review-mods .review-mod");
    const mods = await page.$$eval("#review-mods .review-mod", (n) => n.map((m) => [m.querySelector("strong").textContent,
      m.querySelector(".note").textContent, m.querySelectorAll("li").length]));
    assert.deepEqual(mods, [["Release notes", "This version asks for more than you allowed before. Installing it allows all of this:", 5],
                            ["Changelog check", "Installing it allows exactly this:", 4]]);
    assert.equal(await page.$eval("#confirm-plugin", (b) => b.textContent), "Install and allow its mods");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
