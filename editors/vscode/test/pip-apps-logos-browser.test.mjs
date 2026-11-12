// A logo beside each app in a Pip's "Apps it can use" (asked 12 Nov: "each app should show its logo as well next to the
// name"). In real Chromium with the real Pips bundle (test/support/pip-chat-scene.mjs, its "logos" Pip at Pips API 88:
// Airtable and Stripe, plugins, Stripe switched off; Gmail and Google Calendar; Todoist, which DGC ships no logo for;
// Notion, switched off), the stub host answering a logo request as the editor does. Each row has its mark left of the
// name, one size and one column in dark and light, at 700 px (a tab) and 300 px (the side bar); an app with no logo has
// its letter in the same square; an app that is off reads muted; the switch stays beside the name; nothing is cut.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
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

// The logos as the host sends them: the files DGC ships, as data: URIs.
const png = (name) => `data:image/png;base64,${readFileSync(new URL(`../media/plugin-logos/${name}.png`, import.meta.url)).toString("base64")}`;
const LOGOS = { plugins: { airtable: png("airtable"), stripe: png("stripe") }, apps: { gmail: png("gmail"), googlecalendar: png("calendar"), notion: png("notion") } };
const ORDER = ["airtable", "stripe", "gmail", "googlecalendar", "todoist", "notion"], WITH_LOGO = ["airtable", "stripe", "gmail", "googlecalendar", "notion"];
const click = (p, sel) => p.evaluate((s) => (window.__pipsRoot || document).querySelector(s).click(), sel);
async function openPage(t, theme, width, opts = {}) {
  const x = await openChat(browser, { width, height: 1000, theme, where: width > 400 ? "tab" : "side", api: 88, settings: true, apps: "logos", convs: true, logos: LOGOS, ...opts });
  t.after(x.close);
  await click(x.p, '[data-tab="job"]'); await x.p.waitForSelector(".pip-page #pipLevel"); await x.p.waitForSelector(".pip-apps [data-pip-app]");
  return x;
}
const drawn = (p, n) => p.waitForFunction((n) => { const imgs = [...(window.__pipsRoot || document).querySelectorAll(".pip-apps .pip-app-mark img")]; return imgs.length === n && imgs.every((i) => i.complete && i.naturalWidth > 0); }, n);
/** The section's rows as they are drawn, read in the page. */
const rows = () => {
  const root = window.__pipsRoot || document, sec = root.querySelector(".pip-apps"), box = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  return { section: box(sec), sideways: Math.max(sec.scrollWidth - sec.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    marks: sec.querySelectorAll(".pip-app-mark").length, inAddresses: sec.querySelectorAll(".pip-app-addresses .pip-app-mark").length,
    apps: [...sec.querySelectorAll("[data-pip-app]")].map((li) => { const row = li.querySelector(":scope > .pip-page-row"), mark = row.querySelector(".pip-app-mark"), img = mark.querySelector("img"), s = getComputedStyle(mark), words = row.querySelector(".row-words"), sw = row.querySelector("label.switch");
      return { id: li.dataset.pipApp, off: li.classList.contains("is-off"), row: box(row), mark: box(mark), img: img && { ...box(img), loaded: img.complete && img.naturalWidth > 0, src: img.getAttribute("src").slice(0, 22) }, letter: img ? "" : mark.textContent,
        first: row.firstElementChild === mark, hidden: mark.getAttribute("aria-hidden"), words: box(words), name: box(row.querySelector("strong")), nameText: row.querySelector("strong").textContent, switch: box(sw),
        tile: s.backgroundColor, ink: s.color, radius: s.borderTopLeftRadius, opacity: s.opacity, filter: s.filter, cls: [...mark.classList].filter((c) => /^logo-on|^has-logo/.test(c)).sort().join(" "),
        cut: [row.querySelector("strong"), row.querySelector("small")].some((n) => n.scrollWidth > n.clientWidth + 1) }; }) };
};
const chroma = (rgb) => { const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number); return Math.max(...c) - Math.min(...c); };
const alpha = (rgb) => { const c = rgb.match(/[\d.]+/g).map(Number); return c.length > 3 ? c[3] : 1; };

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`each app has its logo left of its name, one size and one column (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPage(t, theme, width);
    await drawn(x.p, WITH_LOGO.length);
    const v = await x.p.evaluate(rows);
    assert.deepEqual(v.apps.map((a) => a.id), ORDER);
    assert.equal(v.marks, ORDER.length, "one mark an app"); assert.equal(v.inAddresses, 0, "an address has none of its own");
    assert.ok(v.sideways <= 0, "nothing runs off the side");
    for (const a of v.apps) {
      assert.ok(a.first && a.hidden === "true", `${a.id}: its mark is first in the row, and the name says the app`);
      assert.ok(Math.abs(a.mark.width - 22) < 0.5 && Math.abs(a.mark.height - 22) < 0.5, `${a.id}: the mark a plugin's card has in the Pip's chat, 22 px (${a.mark.width} by ${a.mark.height})`);
      assert.equal(a.radius, "7px");
      assert.ok(a.mark.right + 8 <= a.name.left, `${a.id}: left of the name, with a gap (${a.name.left - a.mark.right}px)`);
      assert.ok(a.mark.left >= a.row.left + 8 && a.mark.top >= a.row.top && a.mark.bottom <= a.row.bottom, `${a.id}: inside its row`);
      assert.ok(Math.abs((a.mark.top + a.mark.bottom) / 2 - (a.words.top + a.words.bottom) / 2) <= 1.5, `${a.id}: level with its words`);
      assert.equal(a.cut, false, `${a.id}: its words are not cut`);
      // The switch is beside the name still, at the row's right, clear of the words.
      assert.ok((a.switch.top + a.switch.bottom) / 2 > a.words.top - 1 && (a.switch.top + a.switch.bottom) / 2 < a.words.bottom + 1, `${a.id}: the switch stays beside the name`);
      assert.ok(a.words.right <= a.switch.left + 0.5 && a.switch.right <= a.row.right, `${a.id}: the words stop before the switch`);
    }
    assert.ok(v.apps.every((a) => Math.abs(a.mark.left - v.apps[0].mark.left) < 0.5), "the marks are one column");
    assert.ok(v.apps.every((a) => Math.abs(a.name.left - v.apps[0].name.left) < 0.5), "and the names stay in line, with a logo or without");
    for (const a of v.apps.filter((a) => WITH_LOGO.includes(a.id))) {
      assert.ok(a.img?.loaded, `${a.id}: its logo is drawn`); assert.equal(a.img.src, "data:image/png;base64,", `${a.id}: a picture the host sent, never an address`);
      assert.ok(Math.abs(a.img.width - 16) < 0.5 && Math.abs(a.img.height - 16) < 0.5, `${a.id}: a 16 px logo`);
      assert.ok(a.img.left >= a.mark.left && a.img.right <= a.mark.right && a.img.top >= a.mark.top && a.img.bottom <= a.mark.bottom, `${a.id}: inside its square`);
      assert.match(a.cls, /has-logo/);
    }
    // No logo: the app's first letter in a quiet square of the same size: grey, never the accent, never a gap.
    const todoist = v.apps.find((a) => a.id === "todoist");
    assert.equal(todoist.img, null); assert.equal(todoist.letter, "T");
    assert.ok(alpha(todoist.tile) > 0 && alpha(todoist.tile) < 0.3 && chroma(todoist.tile) <= 12, `a quiet grey square (${todoist.tile})`);
    assert.ok(chroma(todoist.ink) <= 12, "its letter in the text's own grey");
    // Off: the mark reads muted with the row; on, it is whole.
    for (const a of v.apps) {
      assert.equal(a.off, ["stripe", "notion"].includes(a.id));
      if (a.off) { assert.equal(a.opacity, "0.5", `${a.id} is off: its mark is faint`); assert.match(a.filter, /grayscale\(1\)/, "and grey"); }
      else { assert.equal(a.opacity, "1", `${a.id} is on`); assert.equal(a.filter, "none"); }
    }
    assert.deepEqual(x.errors, []);
  });
}

test("the page asks the host once, by the app's kind, and a redraw keeps the logos; the same square in dark and light", async (t) => {
  if (skipOrFail(t)) return;
  const asked = (p) => p.evaluate(() => (window.__posted || []).filter((m) => /^pips(Plugin|App)Logos$/.test(m.type)).map((m) => [m.type, [...(m.plugins || m.apps)]]));
  const dark = await openPage(t, "dark", 300); await drawn(dark.p, 5);
  const asks = await asked(dark.p);
  assert.deepEqual(asks.filter(([type]) => type === "pipsAppLogos"), [["pipsAppLogos", ["gmail", "googlecalendar", "todoist", "notion"]]], "the apps through Composio, by toolkit, in one ask");
  assert.deepEqual(asks.filter(([type]) => type === "pipsPluginLogos").flatMap(([, ids]) => ids).filter((id) => ["airtable", "stripe"].includes(id)).sort(), ["airtable", "stripe"], "the plugins through the lookup the page already has");
  assert.ok(asks.every(([, ids]) => ids.every((id) => /^[a-z0-9][a-z0-9_-]*$/.test(id))), "an app is named, never a file or an address");
  // A switch redraws the section: the logos are there with the markup, and nothing is asked again (Todoist, with none, included).
  await click(dark.p, '[data-pip-app-switch="gmail"]');
  await dark.p.waitForFunction(() => (window.__pipsRoot || document).querySelector('[data-pip-app="gmail"]').classList.contains("is-off"));
  await drawn(dark.p, 5);
  let v = await dark.p.evaluate(rows);
  assert.equal(v.apps.find((a) => a.id === "gmail").opacity, "0.5", "switched off: its logo is muted at once");
  assert.equal(v.apps.find((a) => a.id === "todoist").letter, "T");
  assert.deepEqual(await asked(dark.p), asks, "asked once");
  // Dark and light: the same square behind the same logo.
  const light = await openPage(t, "light", 300); await drawn(light.p, 5);
  const w = await light.p.evaluate(rows);
  for (const id of ["airtable", "googlecalendar", "notion"]) { const a = v.apps.find((r) => r.id === id), b = w.apps.find((r) => r.id === id);
    assert.equal(a.cls, b.cls, `${id}: the same backdrop in both`); assert.equal(a.tile, b.tile); assert.deepEqual([a.mark.width, a.img.width], [b.mark.width, b.img.width]); }
});

test("a host that sends no logo, or something that is not a picture: every app keeps its letter, in line", async (t) => {
  if (skipOrFail(t)) return;
  const quiet = await openPage(t, "dark", 300, { logos: undefined });
  await quiet.p.waitForTimeout(200);
  let v = await quiet.p.evaluate(rows);
  assert.deepEqual(v.apps.map((a) => a.letter), ["A", "S", "G", "G", "T", "N"], "the first letter of each, never a gap");
  assert.ok(v.apps.every((a) => Math.abs(a.mark.width - 22) < 0.5 && Math.abs(a.name.left - v.apps[0].name.left) < 0.5));
  const bad = await openPage(t, "dark", 300, { logos: { plugins: { airtable: "javascript:alert(1)" }, apps: { gmail: "https://logos.example/gmail.png", googlecalendar: "data:text/html;base64,PGI+", notion: png("notion") } } });
  await drawn(bad.p, 1);
  v = await bad.p.evaluate(rows);
  assert.deepEqual(v.apps.map((a) => a.letter), ["A", "S", "G", "G", "T", ""], "only a picture's data: URI is drawn");
  assert.deepEqual([...quiet.errors, ...bad.errors], []);
});
