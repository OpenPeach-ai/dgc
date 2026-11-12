// The dialog a Work session's delete or archive opens when it owns Project Pips (0.52), on the side bar's own page
// (home-scene.mjs): the question the host sends, how a test or a picture opens it, and what is measured of it.
// Shared by session-pips-dialog-browser.test.mjs and render-owners.mjs. Not a *.test.mjs file.
const hex = (c) => c.repeat(32);
export const SESSION_PIPS_ASK = { type: "sessionPipsAsk", requestId: "f".repeat(32), mode: "delete", title: "Invoice totals round the wrong way",
  pips: [{ id: "pip_" + hex("a"), name: "Billing audit", pip_type: "rook" }, { id: "pip_" + hex("b"), name: "Docs writer", pip_type: "quill" },
    { id: "pip_" + hex("c"), name: "Fixer", pip_type: "patch" }, { id: "pip_" + hex("d"), name: "Test runner for the checkout flow", pip_type: "pulse" }],
  sessions: [{ id: "20261106-091200-b2", title: "Visits page alignment" }, { id: "20261105-221000-c3", title: "In one short sentence: what does nextWatering in src/app.js return?" }] };

/** Sends the host's question to the page and waits for its dialog to be drawn. */
export async function askSessionPips(page, ask = SESSION_PIPS_ASK) {
  await page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), ask);
  await page.waitForSelector(".session-pips-dialog", { timeout: 4000 });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 260)))));
}

/** The dialog as drawn: its box, each Pip's row, its buttons, the session picker, parts that overlap, and every
    word's contrast against what is painted under it. */
export const measureSessionPips = (page) => page.evaluate(() => {
  const dialog = document.querySelector(".session-pips-dialog"), d = dialog.getBoundingClientRect();
  const box = (r) => ({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) });
  const inside = (r) => r.left >= d.left - 0.5 && r.right <= d.right + 0.5 && r.top >= d.top - 0.5 && r.bottom <= d.bottom + 0.5;
  const pips = [...dialog.querySelectorAll(".session-pips-list li")].map((li) => { const name = li.querySelector(".session-pips-name"), face = li.querySelector(".session-pips-face .dgc-plush, .session-pips-face svg");
    const r = li.getBoundingClientRect(), n = name.getBoundingClientRect(), f = face?.getBoundingClientRect();
    return { name: name.textContent, face: !!face && f.width >= 12 && f.height >= 12, faceRight: f ? f.right : 0, nameLeft: n.left, top: r.top, bottom: r.bottom, inside: inside(r) && inside(n),
      cut: name.scrollWidth > name.clientWidth + 1 && getComputedStyle(name).whiteSpace === "nowrap" && !name.title }; });
  const buttons = [...dialog.querySelectorAll(".session-pips-buttons button")].map((b) => { const r = b.getBoundingClientRect();
    return { word: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 1, inside: inside(r), width: Math.round(r.width), height: Math.round(r.height) }; });
  const select = dialog.querySelector(".session-pips-to"), s = select?.getBoundingClientRect();
  const parts = [...dialog.querySelectorAll("h2, .session-pips-intro, .session-pips-list, .session-pips-choices label, .session-pips-to, .session-pips-buttons")].filter((e) => e.checkVisibility())
    .map((e) => ({ what: e.className || e.tagName, r: e.getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) { const a = parts[i].r, b = parts[j].r;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${parts[i].what} over ${parts[j].what}`); }
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const words = [];
  const walk = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) { const e = t.parentElement;
    if (!t.textContent.trim() || !e.checkVisibility({ visibilityProperty: true }) || e.closest("option, :disabled, .session-pips-face")) continue;
    const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p);
    words.push({ text: t.textContent.trim().slice(0, 40), ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100 }); }
  return { box: box(d), pips, buttons, select: s ? { inside: inside(s), width: Math.round(s.width) } : { inside: false, width: 0 }, overlaps, words };
});
