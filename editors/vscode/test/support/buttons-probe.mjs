// DGC's one button (media/shared/tokens.css, "The button"), measured where it is drawn. `probe` runs in the page
// (pass it to page.evaluate with {root, buttons, cards}): every text button under `root` matching `buttons`, as
// {word, kind: "filled" | "outline" | "link" | "other", height, radius, label (contrast), ...}, grouped by the card or
// view it stands in (`cards`: the selector of what holds one main action); and the shared tokens as the page resolves
// them, so a test compares a surface's buttons with the definition itself, never with numbers of its own.
// Not a *.test.mjs file.
export const probe = ({ root = "body", buttons = "button", cards = "", shadow = "" }) => {
  const doc = shadow ? document.querySelector(shadow).shadowRoot : document, host = shadow ? doc.querySelector(root === "body" ? ".pip-app-root" : root) : document.querySelector(root);
  const parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const ground = (e) => { const layers = []; for (let n = e; n; n = up(n)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (ink, g) => { const c = over(parse(ink), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const rgb = (c) => parse(c).slice(0, 3).map(Math.round).join(",");
  // The tokens, as this page resolves them (a probe wearing each).
  const scope = host || document.body, p = document.createElement("i"); p.style.cssText = "position:absolute;visibility:hidden;border:1px solid;"; scope.append(p);
  const token = (name, property) => { p.style[property] = `var(${name})`; const v = getComputedStyle(p)[property]; p.style[property] = ""; return v; };
  const tokens = { r: token("--btn-r", "borderTopLeftRadius"), h: Math.round(parseFloat(token("--btn-h", "height"))), hSm: Math.round(parseFloat(token("--btn-h-sm", "height"))), fill: rgb(token("--btn-fill", "backgroundColor")), onFill: rgb(token("--btn-on-fill", "color")),
    line: token("--btn-line", "borderTopColor"), text: rgb(token("--btn-text", "color")), pad: token("--btn-pad", "paddingLeft"), padSm: token("--btn-pad-sm", "paddingLeft"),
    w: Math.round(parseFloat(token("--btn-w", "width"))), wSm: Math.round(parseFloat(token("--btn-w-sm", "width"))), wWide: Math.round(parseFloat(token("--btn-w-wide", "width"))) };
  p.remove();
  const seen = (n) => n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 1;
  const list = [...(host || doc).querySelectorAll(buttons)].filter(seen).map((b) => { const s = getComputedStyle(b), r = b.getBoundingClientRect(), fill = parse(s.backgroundColor), line = parse(s.borderTopColor), under = ground(up(b));
    const filled = fill[3] > 0.9, kind = filled && rgb(s.backgroundColor) === tokens.fill ? "filled" : fill[3] === 0 && parseFloat(s.borderTopWidth) === 1 && line[3] > 0 ? "outline" : fill[3] === 0 && (parseFloat(s.borderTopWidth) === 0 || line[3] === 0) ? "link" : "other";
    const card = cards ? b.closest(cards) : null;
    return { word: (b.textContent || b.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40), cls: String(b.className).slice(0, 60), kind, off: b.disabled === true, height: Math.round(r.height * 10) / 10, radius: s.borderTopLeftRadius,
      width: Math.round(r.width * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top), cut: b.scrollWidth > b.clientWidth + 1, lines: Math.round(r.height) > Math.round(parseFloat(s.height)) + 1 || s.whiteSpace !== "nowrap" ? 2 : 1,
      padding: [s.paddingLeft, s.paddingRight], fill: s.backgroundColor, line: s.borderTopColor, ink: rgb(s.color), label: ratio(s.color, filled ? over(fill, under) : under), edge: kind === "outline" ? ratio(s.borderTopColor, under) : null,
      moves: s.transitionProperty.includes("transform") || s.transitionProperty === "all", card: card ? (card.id || card.dataset.key || card.getAttribute("aria-label") || String(card.className)).slice(0, 60) + "#" + [...(host || doc).querySelectorAll(cards)].indexOf(card) : "" }; });
  return { tokens, buttons: list };
};

/** What a button does when pointed at and pressed, read in the page: its step, its fill, how long it takes. (`locator`: Playwright's.) */
export async function answers(page, locator) {
  const read = () => locator.evaluate((b) => { const c = getComputedStyle(b), m = new DOMMatrixReadOnly(c.transform === "none" ? "" : c.transform); return { y: Math.round(m.f * 100) / 100, scale: Math.round(m.a * 1000) / 1000, fill: c.backgroundColor, line: c.borderTopColor, ms: c.transitionDuration.split(",")[0].trim() }; });
  const wait = () => page.waitForTimeout(260);
  await page.mouse.move(1, 1); await wait();
  const rest = await read();
  await locator.hover(); await wait();
  const pointed = await read();
  await page.mouse.down(); await wait();
  const pressed = await read();
  await page.mouse.move(1, 1); await page.mouse.up(); await wait();
  return { rest, pointed, pressed, after: await read() };
}

/** The usual checks on a surface's buttons against the shared definition. `sizes`: which of the two heights it may use. */
export function check(assert, found, { where, sizes = ["h", "hSm"], oneFilled = true, min = 1, free = null }) {
  const { tokens, buttons } = found, boxed = buttons.filter((b) => b.kind === "filled" || b.kind === "outline");
  assert.ok(buttons.length >= min, `${where}: its buttons are on screen (${buttons.length})`);
  assert.deepEqual(buttons.filter((b) => b.kind === "other").map((b) => `${b.word} [${b.cls}] ${b.fill} ${b.line}`), [], `${where}: every button is filled, an outline or a link, never a fourth kind`);
  assert.deepEqual(boxed.filter((b) => b.radius !== tokens.r).map((b) => `${b.word} ${b.radius}`), [], `${where}: one corner, the shared ${tokens.r}`);
  const heights = sizes.map((k) => tokens[k]);
  assert.deepEqual(boxed.filter((b) => !heights.includes(Math.round(b.height))).map((b) => `${b.word} ${b.height}`), [], `${where}: the shared height (${heights.join(" or ")} px)`);
  assert.deepEqual(buttons.filter((b) => b.kind === "filled" && b.ink !== tokens.onFill).map((b) => `${b.word} ${b.ink}`), [], `${where}: a filled button's words are the shared colour`);
  assert.deepEqual(buttons.filter((b) => b.kind === "outline" && b.line !== tokens.line).map((b) => `${b.word} ${b.line}`), [], `${where}: an outline is the shared hairline`);
  assert.deepEqual(buttons.filter((b) => !b.off && b.label < 4.5).map((b) => `${b.word} ${b.label}`), [], `${where}: every label reads at 4.5:1`);
  assert.deepEqual(boxed.filter((b) => !b.moves).map((b) => b.word), [], `${where}: every button is ready to step`);
  // One box a size, whatever its words: the shared width (or the one wide width); or, in a row too narrow for them,
  // the row shared equally. `free`: the buttons whose words are a name or a sentence (a tool row's), at their own width.
  const small = (b) => Math.round(b.height) === tokens.hSm, fixed = boxed.filter((b) => !(free && free.test(b.cls)));
  const odd = fixed.filter((b) => ![small(b) ? tokens.wSm : tokens.w, tokens.wWide].includes(Math.round(b.width)));
  const shared = new Map(); for (const b of odd) shared.set(b.card + "@" + b.top, [...(shared.get(b.card + "@" + b.top) || []), b]);
  const uneven = [...shared.values()].filter((row) => row.length < 2 || new Set(row.map((b) => Math.round(b.width))).size > 1 || row.some((b) => b.width > (small(b) ? tokens.wSm : tokens.w))).flat();
  assert.deepEqual(uneven.map((b) => `${b.word} ${b.width}`), [], `${where}: every button is the one box of its size (${tokens.w} or ${tokens.wSm} px wide; ${tokens.wWide} wide), or shares a narrow row equally`);
  assert.deepEqual(boxed.filter((b) => b.cut || b.lines > 1).map((b) => b.word), [], `${where}: no label is cut or wrapped`);
  // Columns line up on both edges: buttons one over another in a card share their left and right.
  const cols = new Map(); for (const b of fixed) cols.set(b.card, [...(cols.get(b.card) || []), b]);
  const crooked = [...cols.entries()].filter(([card, list]) => card && list.length > 1 && new Set(list.map((b) => b.top)).size === list.length && (new Set(list.map((b) => b.left)).size > 1 || new Set(list.map((b) => b.right)).size > 1)).map(([card]) => card);
  assert.deepEqual(crooked, [], `${where}: a column of buttons lines up on both edges`);
  if (oneFilled) { const by = new Map(); for (const b of buttons) if (b.kind === "filled") by.set(b.card, [...(by.get(b.card) || []), b.word]);
    assert.deepEqual([...by].filter(([, words]) => words.length > 1).map(([card, words]) => `${card}: ${words.join(" + ")}`), [], `${where}: one filled button a card or view`); }
}
