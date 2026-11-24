// The side bar's Pips area never scrolls itself: its page scrolls inside it. With `overflow: hidden` a focus or a
// scrollIntoView on something below the fold scrolled the area by code (hidden still scrolls that way), and the Pip's top
// bar slid up under DGC's logo line, cut in half, and stayed so (seen 24 Nov on a Pip's Settings page, a wide side bar).
// Real Chromium, the shipped main.css, the side bar's own grid.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { mainCss } from "./support/webview-dom.mjs";

const chromium = await chromiumOrNull();
let browser;
before(async () => { if (chromium) { try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; } } });
after(async () => { await browser?.close(); });

test("the Pips area stays put when something far down its page takes focus", async (t) => {
  if (!browser) { if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: Chromium could not start"); t.skip("no Chromium"); return; }
  const page = await browser.newPage({ viewport: { width: 770, height: 600 } });
  try {
    await page.setContent(`<!doctype html><html data-chat-place="home"><head><style>${mainCss}</style></head>
      <body class="pips-active inside-pip" style="height:100vh;margin:0"><div id="phead"><span class="pm">DGC</span></div>
      <div id="pips-host"><div class="root" style="flex:1;display:flex;flex-direction:column;padding-top:44px">
        <header id="bar" style="height:50px;flex:none">‹ Test · Settings</header><div style="height:1800px"><input id="far" style="margin-top:1500px"></div></div></div></body></html>`);
    await page.evaluate(() => { document.getElementById("far").focus(); document.getElementById("far").scrollIntoView({ block: "center" }); });
    const at = await page.evaluate(() => ({ host: document.getElementById("pips-host").scrollTop, head: document.getElementById("phead").getBoundingClientRect().bottom, bar: document.getElementById("bar").getBoundingClientRect().top }));
    assert.equal(at.host, 0, "the area was not scrolled");
    assert.ok(at.bar >= at.head, `the top bar is below the logo line: ${JSON.stringify(at)}`);
  } finally { await page.close(); }
});
