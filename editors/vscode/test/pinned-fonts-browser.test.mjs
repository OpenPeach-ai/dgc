// The browser tests measure words in pixels, so they all draw them in one known font (test/support/pin-fonts.mjs, via
// `npm test`): Noto Sans for the panel's words and DejaVu Sans Mono for code, from test/fonts and nothing else. On
// 27 Nov a GitHub runner drew them in DejaVu Sans, this machine in Noto Sans, and 80 layout tests failed only there.
// Chromium is asked which font files it really used (not which family the CSS asked for).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor } from "./support/ut2b-common.mjs";
import * as S from "./support/uir2a-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const linux = process.platform === "linux";
const wide = process.env.DGC_TEST_FONTS === "wide";

test("npm test pins the fonts: FONTCONFIG_FILE is test/fonts' own", { skip: !linux && "fontconfig is Linux's" }, () => {
  assert.match(process.env.FONTCONFIG_FILE || "", /\/test\/fonts\/(fonts|wide)\.conf$/, "run through npm test (it loads test/support/pin-fonts.mjs)");
});

test("the panel's words are drawn in the pinned face, and code in DejaVu Sans Mono", { skip: !linux && "fontconfig is Linux's" }, async (t) => {
  if (C.skipOrFail(t)) return;
  if (!/\/test\/fonts\//.test(process.env.FONTCONFIG_FILE || "")) { t.skip("not run through npm test"); return; }
  const x = await S.openWork(C.state.browser, { width: 440, theme: "dark-modern", turns: 1 });
  try {
    await x.event({ type: "turn_start", turn_id: "t2", prompt: "" });
    await x.event({ type: "text_delta", text: "Read `src/upload.py` and **then** the plan's *own* limit." });
    await x.event({ type: "stream_end", message_id: "t2:1", phase: "final" });
    await x.event({ type: "turn_end", turn_id: "t2", status: "completed", usage: {} });
    await x.page.waitForTimeout(150);
    const cdp = await x.page.context().newCDPSession(x.page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const fontsOf = async (selector) => {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
      assert.ok(nodeId, `${selector} is on the page`);
      return (await cdp.send("CSS.getPlatformFontsForNode", { nodeId })).fonts.map((f) => f.familyName);
    };
    const face = wide ? "DejaVu Sans" : "Noto Sans";
    assert.deepEqual(await fontsOf("#log .msg.user .prompt-text"), [face], "a prompt's words");
    assert.deepEqual(await fontsOf("#log .msg.dgc .text p strong"), [face], "bold words");
    assert.deepEqual(await fontsOf("#log .msg.dgc .text p em"), [face], "italic words");
    assert.deepEqual(await fontsOf("#log .msg.dgc .text p code"), ["DejaVu Sans Mono"], "code");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
