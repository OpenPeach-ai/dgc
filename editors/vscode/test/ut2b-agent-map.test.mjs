// User test round 2, W18, the Agent map. A helper that had finished wore its face in full colour, and one of the faces
// is a coral triangle: it read as a red warning on a row that said Finished (red is for errors only). A finished
// helper's face is drawn quiet, without colour; one still working, or one that failed, keeps its own. And the main
// row's line was cut mid-word ("55.3k t…"): it gives way a whole part at a time, the model always whole.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { openMapScene, sid } from "./support/agent-map-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const short = (theme) => theme.split("-")[0];
const rows = (page) => page.evaluate(() => [...document.querySelectorAll("#agent-map .am-row")].map((row) => { const face = row.querySelector(".am-face"), meta = row.querySelector(".am-meta"), cs = face ? getComputedStyle(face) : null;
  const shownParts = [...meta.querySelectorAll(".am-meta-part, .am-meta-where")].filter((n) => !n.hidden && n.checkVisibility());
  return { key: row.dataset.amKey, state: row.querySelector(".agent-dot").dataset.state, face: !!face, filter: cs ? cs.filter : "", meta: meta.textContent, shown: shownParts.map((n) => n.textContent).join(""),
    cut: [...meta.querySelectorAll(".am-meta-where"), ...(meta.classList.contains("am-meta-split") ? [] : [meta])].some((n) => n.scrollWidth > n.clientWidth + 1),
    where: meta.querySelector(".am-meta-where")?.textContent || "", whereCut: (() => { const n = meta.querySelector(".am-meta-where"); return n ? n.scrollWidth > n.clientWidth + 1 : false; })() }; }));

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`W18: a finished helper's face is quiet, a failed or working one keeps its colour; the main row is never cut mid-word (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const s = await openMapScene(C.state.browser, { width, theme, faces: true });
    try {
      await s.send({ type: "context", used: 55300, size: 131072 });
      await s.page.waitForTimeout(250);
      const m = await rows(s.page);
      await shot(s.page, `w18-agent-map-${short(theme)}-${width}`);
      const done = m.find((r) => r.key === `agent:${sid(4)}`), failed = m.find((r) => r.key === `agent:${sid(3)}`), working = m.find((r) => r.key === `agent:${sid(1)}`), root = m.find((r) => r.key === "root");
      assert.deepEqual([done.state, failed.state, working.state], ["finished", "failed", "running"], "premise: one finished, one failed, one working");
      assert.match(done.filter, /grayscale\(1\)/, `the finished helper's face has no colour (${done.filter})`);
      assert.doesNotMatch(failed.filter, /grayscale/, "the failed one keeps its own: its red dot says failed");
      assert.doesNotMatch(working.filter, /grayscale/, "and so does one still working");
      // The main row: what is in context, then its model; whatever shows is whole.
      assert.match(root.meta, /^55\.3k tokens in context · /);
      assert.ok(root.where && root.meta.endsWith(root.where), "its model is the line's last part");
      assert.ok(root.shown === root.meta.replace(" · ", "") || root.shown === root.where, `it shows whole, or its model alone, never a part cut short (“${root.shown}”)`);
      if (width >= 700) assert.equal(root.whereCut, false, "the model is whole");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}
