// The marks in a message you sent a Pip (a project, a file, a Pip named in it) read on that bubble in both themes: at
// least 4.5:1 against the bubble's own ground. Live, 12 Nov: in the light theme a sent project's name was pale grey on
// the bubble's light grey, kept light by a rule written when a Pip's bubble was deep purple in either theme.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";

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

const SAID = "garden add one line to README.md in your copy";
const MARKS = [{ start: 0, kind: "project", label: "garden", identity: "ws_" + "5".repeat(32), wired: true }];

// In its own tab (the document) and in the side bar (a shadow root, which :root and body rules don't reach).
for (const [width, where] of [[700, "tab"], [300, "side"]]) for (const theme of ["light", "dark"]) {
  test(`${theme}, ${where}: a project named in a message you sent reads on its bubble`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openChat(browser, { width, where, theme, api: 91, projects: true, reply: "Done.", replyTo: SAID, replyMarks: MARKS });
    try {
      await s.p.waitForFunction(() => !!(window.__pipsRoot || document).querySelector(".pip-message.user .bubble .sent-mention"), null, { timeout: 5000 });
      const seen = await s.p.evaluate(() => {
        const root = window.__pipsRoot || document;
        // rgb(…) in 0-255, or color(srgb …) in 0-1 (a colour-mix comes back that way), alpha last.
        const rgb = (v) => { const n = (v.match(/[\d.]+/g) || []).map(Number);
          return /^color\(srgb/.test(v) ? [...n.slice(0, 3).map((c) => c * 255), ...n.slice(3)] : n; };
        const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
        const ground = (n) => { for (let x = n; x; x = x.parentElement) { const c = rgb(getComputedStyle(x).backgroundColor); if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c; } return [255, 255, 255]; };
        return [...root.querySelectorAll(".pip-message.user .bubble .sent-mention")].map((mark) => {
          const name = mark.querySelector(".composer-project-name") || mark;
          const style = getComputedStyle(name), fill = style.webkitTextFillColor && !/rgba\(0, 0, 0, 0\)/.test(style.webkitTextFillColor) ? style.webkitTextFillColor : style.color;
          const a = lum(rgb(fill)), b = lum(ground(mark));
          return { text: mark.textContent.trim(), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fill, ground: ground(mark).join(",") };
        });
      });
      assert.ok(seen.length >= 1, "the sent message shows its mark");
      for (const mark of seen) assert.ok(mark.ratio >= 4.5, `${theme}: “${mark.text}” ${mark.fill} on ${mark.ground} is ${mark.ratio.toFixed(2)}:1`);
    } finally { await s.close(); }
  });
}
