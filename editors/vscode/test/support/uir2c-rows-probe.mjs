// Reads a list's rows as drawn: each row's height, its buttons (by their label) and which of them can be seen and
// pressed without pointing at the row, and again while it is pointed at. For uir2c-rows.test.mjs. Not a *.test.mjs file.
export const DEEP = "const all = (root, s, out = []) => { out.push(...root.querySelectorAll(s)); for (const n of root.querySelectorAll('*')) if (n.shadowRoot) all(n.shadowRoot, s, out); return out; };";
/** rows: [{ h, top, name, cut, tip, buttons: [{ label, seen, tab, w }] }] for every row `sel` matches (through shadow roots). */
export const readRows = (page, sel) => page.evaluate(([sel, deep]) => { const all = new Function(`${deep} return all;`)();
  const seen = (n) => { if (!n.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false; const r = n.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    for (let p = n; p; p = p.parentElement || p.getRootNode().host) { const s = getComputedStyle(p); if (Number(s.opacity) < 0.05 || s.visibility === "hidden") return false; if (p.matches?.(sel)) break; } return true; };
  return all(document, sel).filter((r) => r.getClientRects().length).map((row) => { const box = row.getBoundingClientRect();
    return { h: Math.round(box.height * 10) / 10, top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right), key: row.dataset.key || row.dataset.id || row.dataset.session || row.dataset.pip || "",
      buttons: [...row.querySelectorAll("button, [role=button], [role=switch]")].map((b) => ({ label: (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60), cls: String(b.className || "").slice(0, 40), seen: seen(b), tab: b.tabIndex >= 0 && !b.disabled, w: Math.round(b.getBoundingClientRect().width) })) }; }); }, [sel, DEEP]);
