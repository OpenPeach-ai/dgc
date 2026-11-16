// What a page's tokens compute to, and one element's look: shared by the 0.52 look's tests (dgc-look-*.test.mjs).
// Runs in the page. Not a *.test.mjs file.

/** {name: computed colour} for custom properties, read on `where` (a selector; the body by default) as a colour or a fill. */
export const tokenColours = (page, names, where = "body") => page.evaluate(([list, sel]) => {
  const find = (root, s) => { const hit = root.querySelector(s); if (hit) return hit; for (const n of root.querySelectorAll("*")) { const inner = n.shadowRoot && find(n.shadowRoot, s); if (inner) return inner; } return null; };
  const host = find(document, sel) || document.body, probe = document.createElement("i"); host.append(probe);
  const out = {}; for (const name of list) { probe.style.backgroundColor = `var(${name})`; out[name] = getComputedStyle(probe).backgroundColor; probe.style.backgroundColor = ""; }
  probe.remove(); return out;
}, [names, where]);

/** The first element matching `selector`, in the page or any shadow root: its fill, words, line, corner, size and shadow. */
export const look = (page, selector) => page.evaluate((sel) => {
  const find = (root, s) => { const hit = root.querySelector(s); if (hit) return hit; for (const n of root.querySelectorAll("*")) { const inner = n.shadowRoot && find(n.shadowRoot, s); if (inner) return inner; } return null; };
  const n = find(document, sel); if (!n) return null;
  const s = getComputedStyle(n), r = n.getBoundingClientRect();
  return { fill: s.backgroundColor, image: s.backgroundImage, words: s.color, line: s.borderTopColor, lineWidth: s.borderTopWidth, corner: s.borderTopLeftRadius, shadow: s.boxShadow,
    size: s.fontSize, weight: s.fontWeight, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10,
    textFill: s.webkitTextFillColor, grain: getComputedStyle(n, "::before").content, display: s.display, opacity: s.opacity };
}, selector);

/** True when a computed colour is in DGC's purple family (hue 235 to 290, with some chroma and some alpha). */
export function isPurple(colour) {
  const m = String(colour).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number); if (!m) return false;
  const [r, g, b, a = 1] = String(colour).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3]] : m;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (a < 0.04 || mx - mn < 18) return false;
  const h = mx === b ? 240 + 60 * (r - g) / (mx - mn) : mx === r ? (360 + 60 * (g - b) / (mx - mn)) % 360 : 120 + 60 * (b - r) / (mx - mn);
  return h > 235 && h < 290;
}

export async function chromiumOrNull() { try { return (await import("@playwright/test")).chromium; } catch { return null; } }
