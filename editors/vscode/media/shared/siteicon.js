// A site's own icon beside its tab or its link: Your Browser's tabs (src/yourBrowserTab.js) and Home's Browser card
// (media/shared/homecards.js). One check for both: what may be drawn (a small data: picture DGC downloaded, never an
// address the page would fetch), and, on a dark editor, an icon that is dark and of one colour (black, near-black,
// grey) is drawn light, as the site's own dark-mode icon would be; coloured icons stay as they are.
//
//   DgcSiteIcon.ok(src)                       -> src when it may be drawn, else ""
//   DgcSiteIcon.lift(images, "class-name")    -> each image wears the class where it needs lifting (after it loads)
(function (root) {
  "use strict";
  const PICTURE = /^data:image\/(png|x-icon|svg\+xml|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  const tones = new Map();

  const ok = (src, most = 140000) => (typeof src === "string" && src.length < most && PICTURE.test(src) ? src : "");

  /** Whether the editor around the page is dark (its own background, as drawn). */
  function darkEditor(doc = root.document) {
    const m = root.getComputedStyle(doc.body).backgroundColor.match(/[\d.]+/g);
    if (!m || m.length < 3) return false;
    const [r, g, b] = m.slice(0, 3).map((v) => Number(v) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
  }

  /** A dark icon of one colour, by its own pixels (read once per picture). */
  function darkOneColour(img) {
    const key = img.currentSrc || img.src;
    if (tones.has(key)) return tones.get(key);
    let tone = false;
    try {
      const c = img.ownerDocument.createElement("canvas"); c.width = c.height = 16;
      const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      let n = 0, lum = 0, spread = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255;
        lum += 0.2126 * r + 0.7152 * gr + 0.0722 * b; spread += Math.max(r, gr, b) - Math.min(r, gr, b); n += 1;
      }
      tone = n > 8 && lum / n < 0.22 && spread / n < 0.15;
    } catch { tone = false; }
    if (tones.size > 300) tones.clear();
    tones.set(key, tone);
    return tone;
  }

  function lift(images, cls, doc = root.document) {
    const dark = darkEditor(doc);
    for (const img of images) {
      const apply = () => img.classList.toggle(cls, dark && darkOneColour(img));
      if (img.complete && img.naturalWidth) apply(); else img.addEventListener("load", apply, { once: true });
    }
    return dark;
  }

  root.DgcSiteIcon = { ok, darkEditor, darkOneColour, lift };
})(typeof window !== "undefined" ? window : globalThis);
