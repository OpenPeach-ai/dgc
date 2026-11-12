// Every word and mark on a page, measured where it is drawn: its colour laid over the grounds under it (through shadow
// roots too), and its contrast with that ground. For the muted grey's tests and pictures (muted-grey.test.mjs): what
// counts is the colour that reaches the eye, never the token a rule names. Not a *.test.mjs file.

/** [{ what, text, kind: "words" | "mark" | "placeholder", color: [r,g,b], ground: [r,g,b], ratio, size }] for the page. */
export const inks = (page) => page.evaluate(() => {
  const parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0];
    return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const up = (n) => n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const ground = (e) => { const layers = [];
    for (let n = e; n; n = up(n)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  // An element's own opacity, and its parents', thin its ink too.
  const seen = (e) => { let a = 1; for (let n = e; n; n = up(n)) a *= Number(getComputedStyle(n).opacity); return a; };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const measure = (ink, e) => { const g = ground(e), raw = parse(ink), c = over([raw[0], raw[1], raw[2], raw[3] * seen(e)], g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p);
    return { ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100, color: c.slice(0, 3).map(Math.round), ground: g.slice(0, 3).map(Math.round) }; };
  const name = (e) => { const one = (n) => `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${n.classList.length ? "." + [...n.classList].join(".") : ""}`; const p = up(e); return p && p !== document.body ? `${one(p)} > ${one(e)}` : one(e); };
  const out = [];
  const visit = (root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const e = t.parentElement;
      if (!e || !t.textContent.trim() || ["STYLE", "SCRIPT", "TITLE", "OPTION"].includes(e.tagName) || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      const style = getComputedStyle(e), fill = style.webkitTextFillColor;
      out.push({ what: name(e), text: t.textContent.trim().replace(/\s+/g, " ").slice(0, 48), kind: "words", size: parseFloat(style.fontSize), ...measure(fill && fill !== style.color ? fill : style.color, e) });
    }
    for (const e of root.querySelectorAll(".codicon, svg")) {
      if (e.closest(".dgc-plush, [data-mark], .dgc-sheet") || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      out.push({ what: name(e), text: "", kind: "mark", size: Math.round(r.height), ...measure(getComputedStyle(e).color, e) });
    }
    for (const e of root.querySelectorAll("textarea[placeholder], input[placeholder], [contenteditable][data-placeholder]")) {
      if (!e.checkVisibility() || (e.value ?? e.textContent)) continue;
      const pseudo = e.matches("[contenteditable]") ? "::before" : "::placeholder";
      out.push({ what: `${name(e)}${pseudo}`, text: (e.placeholder || e.dataset.placeholder || "").slice(0, 48), kind: "placeholder", size: parseFloat(getComputedStyle(e).fontSize), ...measure(getComputedStyle(e, pseudo).color, e) });
    }
    for (const n of root.querySelectorAll("*")) if (n.shadowRoot) visit(n.shadowRoot);
  };
  visit(document.body);
  return out;
});

/** The page's body text colour and main ground, as [r,g,b]. */
export const groundAndText = (page) => page.evaluate(() => { const probe = document.createElement("i"); document.body.append(probe);
  const read = (v) => { probe.style.color = `var(${v})`; return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number); };
  const out = { text: read("--text"), bg: read("--bg"), surface: read("--surface") }; probe.remove(); return out; });
