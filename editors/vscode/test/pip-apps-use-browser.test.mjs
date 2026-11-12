// pips-09, the editor half, in real Chromium with the real Pips bundle (test/support/pip-chat-scene.mjs, its "apps"
// Pip at Pips API 88: Airtable on, Stripe switched off, Gmail with two addresses, Google Calendar).
// A Pip's page has "Apps it can use": one row an app with a switch that DGC is told about, an app that is off reads
// muted, an address has Disconnect (it asks first), and "Add another address" raises its Connect card in the chat.
// Below API 88 the page keeps "Linked apps". An Allow card for a Pip with two addresses has a small menu, in the
// card, with none picked: Send waits for a pick and goes from the one picked. Nothing is cut off or pokes out, dark
// and light, in a tab (700 px) and in the side bar (300 px). DGC_APPS_PICTURES=<folder> keeps a picture of each.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromiumOrNull, isPurple } from "./support/look-probe.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
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

const PICTURES = process.env.DGC_APPS_PICTURES || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });
const picture = async (p, name, selector) => { if (!PICTURES) return; if (selector) await p.locator(selector).first().scrollIntoViewIfNeeded(); await p.waitForTimeout(150); await p.screenshot({ path: `${PICTURES}/${name}.png` }); };
const click = (p, sel) => p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);
const sent = (p, type) => p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t).map(({ type: _t, ...rest }) => rest), type);
const open = (theme, width, opts = {}) => openChat(browser, { width, height: 1000, theme, where: width > 400 ? "tab" : "side", api: 88, settings: true, apps: true, convs: true, ...opts });
async function openPage(theme, width, opts = {}) {
  const x = await open(theme, width, opts);
  await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-page #pipLevel");
  if ((opts.api || 88) >= 88) await x.p.waitForSelector(".pip-apps [data-pip-app]");
  await x.p.waitForTimeout(250);
  return x;
}

/** The section, read in the page: each app's row, and what the eye would catch (a control outside its card or past its
    row's edge, words cut by their box, two things on top of each other, the page scrolling sideways, a filled or purple button). */
const section = () => {
  const root = window.__pipsRoot || document, sec = root.querySelector(".pip-apps"), box = (n) => n.getBoundingClientRect(), seen = (n) => n.checkVisibility() && box(n).width > 1;
  const card = box(sec), ink = (n) => getComputedStyle(n).color;
  const apps = [...sec.querySelectorAll("[data-pip-app]")].map((li) => { const row = li.querySelector(":scope > .pip-page-row"), sw = row.querySelector("label.switch"), s = getComputedStyle(row);
    return { id: li.dataset.pipApp, name: row.querySelector("strong").textContent, says: row.querySelector("small").textContent, on: row.querySelector("input").checked, off: li.classList.contains("is-off"),
      nameInk: ink(row.querySelector("strong")), switchAtEdge: Math.abs(box(sw).right - (box(row).right - parseFloat(s.paddingRight))) <= 1.5,
      switchBesideName: (box(sw).top + box(sw).bottom) / 2 > box(row.querySelector(".row-words")).top - 1 && (box(sw).top + box(sw).bottom) / 2 < box(row.querySelector(".row-words")).bottom + 1,
      addresses: [...li.querySelectorAll(".pip-app-address")].map((a) => ({ text: a.querySelector(".row-words > span").textContent, ink: ink(a.querySelector(".row-words > span")), buttons: [...a.querySelectorAll("button")].map((b) => b.textContent) })),
      add: li.querySelector("[data-pip-app-add]")?.textContent || "" }; });
  const controls = [...sec.querySelectorAll("button, label.switch")].filter(seen);
  const poking = controls.filter((c) => box(c).right > card.right - 8 || box(c).left < card.left + 8 || box(c).bottom > card.bottom + 0.5).map((c) => c.textContent.trim() || c.className);
  const cut = [...sec.querySelectorAll("button, strong, small, .row-words > span")].filter(seen).filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).display !== "inline").map((n) => n.textContent.trim().slice(0, 30));
  const over = []; for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) { const a = box(controls[i]), b = box(controls[j]);
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) over.push(`${controls[i].textContent.trim()} / ${controls[j].textContent.trim()}`); }
  const fills = [...sec.querySelectorAll("button")].filter(seen).map((b) => ({ text: b.textContent.trim() || b.getAttribute("aria-label"), fill: getComputedStyle(b).backgroundColor }));
  return { label: sec.querySelector(".pip-page-label").firstChild.textContent.trim(), apps, poking, cut, over, fills, error: sec.querySelector("[role=alert]")?.textContent || "",
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
};
function checkLayout(m, solid) {
  assert.deepEqual(m.poking, [], "no control pokes out of its card");
  assert.deepEqual(m.cut, [], "no words are cut by their box");
  assert.deepEqual(m.over, [], "no two controls lie on each other");
  assert.deepEqual(m.fills.filter((b) => b.fill === solid || isPurple(b.fill)).map((b) => b.text), [], "no filled or purple button");
  assert.equal(m.sideways, false, "nothing scrolls sideways");
  assert.deepEqual(m.apps.filter((a) => !a.switchAtEdge || !a.switchBesideName).map((a) => a.name), [], "every app's switch is beside its name, at the row's right edge");
}

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const solid = theme === "dark" ? "rgb(0, 120, 212)" : "rgb(0, 95, 184)";
  test(`Apps it can use: a row an app with its switch, off reads muted, addresses with Disconnect and Add another address (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(theme, width);
    try {
      const m = await x.p.evaluate(section);
      assert.equal(m.label, "Apps it can use");
      assert.deepEqual(m.apps.map((a) => [a.id, a.name, a.says, a.on]), [["airtable", "Airtable", "A plugin from Settings", true], ["stripe", "Stripe", "A plugin from Settings · Off for Mornings", false],
        ["gmail", "Gmail", "An app through Composio · 2 addresses", true], ["googlecalendar", "Google Calendar", "An app through Composio", true]]);
      const [airtable, stripe, gmail, calendar] = m.apps;
      assert.notEqual(stripe.nameInk, airtable.nameInk, "an app that is off reads muted");
      assert.deepEqual(gmail.addresses.map((a) => [a.text, a.buttons]), [["pitch@studio.example", ["Disconnect"]], ["dev@studio.example", ["Disconnect"]]]);
      assert.equal(gmail.add, "Add another address"); assert.equal(calendar.add, "Add another address"); assert.equal(airtable.add, "", "a plugin has no addresses to add");
      checkLayout(m, solid);
      assert.equal(await x.p.evaluate(() => !!(window.__pipsRoot || document).querySelector('[aria-label="Linked apps"]')), false, "the one section, not Linked apps beside it");
      await picture(x.p, `apps-${theme}-${width}`, ".pip-apps");

      // A switch tells DGC, and the row reads muted from then on (and after the page reads its apps again).
      await x.p.locator('[data-pip-app-switch="airtable"]').click({ force: true });
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector('[data-pip-app="airtable"]')?.classList.contains("is-off") && (window.__sent || []).filter((r) => r.type === "get_pip_apps").length >= 2);
      assert.deepEqual(await sent(x.p, "set_pip_app"), [{ pip_id: await x.p.evaluate(() => window.__sent.find((r) => r.type === "get_pip_apps").pip_id), app: "airtable", on: false }]);
      await x.p.waitForTimeout(150);
      let now = await x.p.evaluate(section);
      assert.deepEqual([now.apps[0].on, now.apps[0].off, now.apps[0].says], [false, true, "A plugin from Settings · Off for Mornings"]);
      assert.equal(now.apps[0].nameInk, stripe.nameInk);
      // Switching Gmail off keeps its addresses (the link stays), muted, and takes away "Add another address".
      await x.p.locator('[data-pip-app-switch="gmail"]').click({ force: true });
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector('[data-pip-app="gmail"]')?.classList.contains("is-off") && !(window.__pipsRoot || document).querySelector('[data-pip-app-switch="gmail"]').disabled);
      now = await x.p.evaluate(section);
      assert.deepEqual(now.apps[2].addresses.map((a) => a.text), ["pitch@studio.example", "dev@studio.example"]); assert.equal(now.apps[2].add, "");
      assert.equal(now.apps[2].addresses[0].ink, stripe.nameInk, "its addresses read muted too");
      checkLayout(now, solid);
      await x.p.locator('[data-pip-app-switch="gmail"]').click({ force: true });
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector('[data-pip-app="gmail"]')?.dataset.on === "true" && !(window.__pipsRoot || document).querySelector('[data-pip-app-switch="gmail"]').disabled);
      assert.deepEqual((await sent(x.p, "set_pip_app")).map((r) => [r.app, r.on]), [["airtable", false], ["gmail", false], ["gmail", true]]);

      // Disconnect asks first, on the address's own row; Keep it changes nothing; Disconnect then tells DGC, by that card's id.
      const first = "applink_" + "1".repeat(32);
      await click(x.p, `[data-pip-app-ask-disconnect="${first}"]`); await x.p.waitForSelector(`[data-pip-app-disconnect="${first}"]`);
      assert.deepEqual(await sent(x.p, "disconnect_pip_app_link"), [], "nothing yet");
      const asking = await x.p.evaluate(section);
      assert.deepEqual(asking.apps[2].addresses[0].buttons, ["Disconnect", "Keep it"]); checkLayout(asking, solid);
      await picture(x.p, `apps-disconnect-asks-${theme}-${width}`, `[data-pip-app-address="${first}"]`);
      await click(x.p, "[data-pip-app-keep]"); await x.p.waitForSelector(`[data-pip-app-ask-disconnect="${first}"]`);
      assert.deepEqual(await sent(x.p, "disconnect_pip_app_link"), []);
      await click(x.p, `[data-pip-app-ask-disconnect="${first}"]`); await click(x.p, `[data-pip-app-disconnect="${first}"]`);
      await x.p.waitForFunction((id) => !(window.__pipsRoot || document).querySelector(`[data-pip-app-address="${id}"]`), first);
      assert.deepEqual((await sent(x.p, "disconnect_pip_app_link")).map((r) => r.link_id), [first]);
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector('[data-pip-app="gmail"] small')?.textContent === "An app through Composio");
      assert.deepEqual((await x.p.evaluate(section)).apps[2].addresses.map((a) => a.text), ["dev@studio.example"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Add another address raises its Connect card in the chat, and the address chosen there joins the app's list (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(theme, width);
    try {
      await click(x.p, '[data-pip-app-add="gmail"]');
      const card = x.p.locator('.app-link[data-state="requested"]');
      await card.waitFor();
      assert.deepEqual((await sent(x.p, "add_pip_app_account")).map((r) => r.app), ["gmail"]);
      assert.ok(await x.p.locator("#chat-form").isVisible(), "the chat, where Connect cards show");
      assert.match(await card.innerText(), /Add another Gmail address to Mornings\s+One more Gmail address for this Pip\./);
      await picture(x.p, `apps-add-card-${theme}-${width}`);
      await card.locator("[data-app-link-start]").click();
      await x.p.locator('[data-app-link-account="ca_hello0000"]').click();
      await x.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector(".app-link[data-app-link]") && (window.__sent || []).filter((r) => r.type === "start_pip_app_link").length === 2);
      assert.deepEqual((await sent(x.p, "start_pip_app_link")).map((r) => r.account || ""), ["", "ca_hello0000"]);
      await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-apps [data-pip-app]");
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelectorAll('[data-pip-app="gmail"] .pip-app-address').length === 3);
      const m = await x.p.evaluate(section);
      assert.deepEqual(m.apps[2].addresses.map((a) => a.text).sort(), ["dev@studio.example", "hello@studio.example", "pitch@studio.example"]);
      assert.equal(m.apps[2].says, "An app through Composio · 3 addresses");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`an Allow card with two addresses: a small menu in the card, none picked, Send waits and goes from the one picked (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width, { allow: "event" });
    try {
      const mail = "maildraft_" + "3".repeat(32), meet = "caldraft_" + "4".repeat(32);
      await x.p.waitForSelector(`[data-allow-card="${mail}"] [data-allow-from]`); await x.p.waitForSelector(`[data-allow-card="${meet}"] [data-allow-from]`);
      /** A card, read in the page: its From button and menu against the card's box, and what is cut or covered. */
      const read = (id) => x.p.evaluate((draft) => {
        const root = window.__pipsRoot || document, card = root.querySelector(`[data-allow-card="${draft}"]`), box = (n) => n.getBoundingClientRect(), c = box(card);
        const from = card.querySelector("[data-allow-from]"), menu = card.querySelector(".allow-from-menu"), inside = (n) => { const r = box(n); return r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5; };
        const rows = menu ? [...menu.querySelectorAll(".dgc-menu-row")] : [];
        // (What is in sight at a row's middle is that row: nothing lies over the open menu, and no ancestor clips it.)
        const hit = (n) => { const r = box(n), top = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && (top === n || n.contains(top)); };
        return { says: card.querySelector(".dgc-card-words small").textContent, label: card.querySelector(".allow-from-label").textContent, value: from.textContent.trim(), expanded: from.getAttribute("aria-expanded"),
          fromInside: inside(from), fromCut: from.querySelector(".allow-from-value").scrollWidth > from.querySelector(".allow-from-value").clientWidth + 1,
          menu: menu ? { inside: inside(menu), shared: menu.classList.contains("dgc-menu"), rows: rows.map((r) => ({ text: r.textContent.trim(), checked: r.getAttribute("aria-checked"), cut: r.querySelector(".dgc-menu-label").scrollWidth > r.querySelector(".dgc-menu-label").clientWidth + 1, hit: hit(r) })),
            underButton: box(menu).top >= box(from).bottom - 0.5, aboveActions: box(menu).bottom <= box(card.querySelector(".dgc-card-actions")).top + 0.5, fill: getComputedStyle(menu).backgroundColor } : null,
          disabled: [...card.querySelectorAll(".dgc-card-actions button")].map((b) => [b.textContent.trim().replace(/…$/, ""), b.disabled]), fromFill: getComputedStyle(from).backgroundColor,
          sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      }, id);
      let m = await read(mail);
      assert.equal(m.says, "Mornings has 2 Gmail addresses. Choose which one sends this.");
      assert.deepEqual([m.label, m.value, m.expanded, m.menu], ["From", "Choose an address", "false", null], "no address is chosen for you");
      assert.deepEqual(m.disabled.map(([, off]) => off), [true, true, false, false], "Send and Always allow wait; Edit and Don't send don't");
      assert.ok(m.fromInside && !m.fromCut && !m.sideways); assert.equal(isPurple(m.fromFill), false);
      await x.p.locator(`[data-allow-send="${mail}"]`).click({ force: true }); await x.p.waitForTimeout(100);
      assert.deepEqual(await sent(x.p, "prepare_pip_message_draft"), [], "a click on a waiting Send sends nothing");

      await x.p.locator(`[data-allow-from="${mail}"]`).click(); await x.p.waitForSelector(".allow-from-menu");
      await x.p.waitForTimeout(250);   // (the menu's arrival)
      m = await read(mail);
      assert.equal(m.expanded, "true"); assert.ok(m.menu.shared, "the shared menu");
      assert.deepEqual(m.menu.rows.map((r) => [r.text, r.checked]), [["pitch@studio.example", "false"], ["dev@studio.example", "false"]]);
      assert.ok(m.menu.inside && m.menu.underButton && m.menu.aboveActions, "the menu is in the card, under From and above the answers");
      assert.deepEqual(m.menu.rows.filter((r) => r.cut || !r.hit).map((r) => r.text), [], "every address is whole and in sight");
      assert.equal(isPurple(m.menu.fill), false); assert.equal(m.sideways, false);
      assert.equal(await x.p.evaluate(() => { const root = window.__pipsRoot || document; return root.activeElement?.classList.contains("dgc-menu-row"); }), true, "the keyboard is in the menu");
      await picture(x.p, `allow-menu-${theme}-${width}`, `[data-allow-card="${mail}"]`);
      // The keys of every DGC menu: Down moves, Escape closes and goes back to the button, picking nothing.
      await x.p.keyboard.press("ArrowDown");
      assert.equal(await x.p.evaluate(() => (window.__pipsRoot || document).activeElement?.textContent.trim()), "dev@studio.example");
      await x.p.keyboard.press("Escape");
      m = await read(mail);
      assert.deepEqual([m.menu, m.value], [null, "Choose an address"]);
      assert.equal(await x.p.evaluate((id) => (window.__pipsRoot || document).activeElement?.dataset.allowFrom === id, mail), true, "focus is back on From");

      await x.p.locator(`[data-allow-from="${mail}"]`).click(); await x.p.locator('.allow-from-menu [data-allow-from-pick="ca_dev00000"]').click();
      m = await read(mail);
      assert.deepEqual([m.value, m.menu, m.says], ["dev@studio.example", null, "Sends from the address you chose."]);
      assert.deepEqual(m.disabled.map(([, off]) => off), [false, false, false, false]); assert.ok(m.fromInside && !m.fromCut);
      // The other card is still its own: nothing was picked for it.
      const other = await read(meet);
      assert.deepEqual([other.label, other.value, other.disabled[0][1]], ["To", "Choose a calendar", true]);
      await picture(x.p, `allow-picked-${theme}-${width}`, `[data-allow-card="${mail}"]`);
      await x.p.locator(`[data-allow-send="${mail}"]`).click();
      await x.p.waitForFunction(() => (window.__sent || []).some((r) => r.type === "accept_pip_app_action"));
      assert.deepEqual((await sent(x.p, "prepare_pip_message_draft")).map((r) => r.account), ["ca_dev00000"], "it sends from the address picked, not the first");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("one address: the Allow card reads as before, with no menu; and a refused switch goes back and says why", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("dark", 300, { apps: "one", allow: true });
  try {
    const card = x.p.locator(".allow-card"); await card.waitFor();
    assert.match(await card.innerText(), /From pitch@studio\.example/);
    assert.equal(await card.locator("[data-allow-from]").count(), 0); assert.equal(await card.locator("[data-allow-send]").isDisabled(), false);
  } finally { await x.close(); }
  const y = await openPage("light", 700, { apps: "refuse" });
  try {
    await y.p.locator('[data-pip-app-switch="airtable"]').click({ force: true });
    await y.p.waitForSelector(".pip-apps [role=alert]");
    await y.p.waitForFunction(() => !(window.__pipsRoot || document).querySelector('[data-pip-app-switch="airtable"]').disabled);
    const m = await y.p.evaluate(section);
    assert.match(m.error, /Only you can choose a Pip's apps/);
    assert.deepEqual([m.apps[0].on, m.apps[0].off], [true, false], "the switch is back where DGC has it");
  } finally { await y.close(); }
});

test("below Pips API 88 the page keeps Linked apps, and DGC is never asked for a Pip's apps", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPage("dark", 700, { api: 87 });
  try {
    await x.p.waitForSelector('[aria-label="Linked apps"] [data-linked-app]');
    assert.equal(await x.p.evaluate(() => !!(window.__pipsRoot || document).querySelector(".pip-apps")), false);
    assert.equal(await x.p.locator("[data-linked-app]").count(), 3, "every linked address, as before");
    assert.deepEqual(await sent(x.p, "get_pip_apps"), []);
  } finally { await x.close(); }
});
