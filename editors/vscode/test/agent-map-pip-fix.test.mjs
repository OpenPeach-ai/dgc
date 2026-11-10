import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openMapScene, sid } from "./support/agent-map-scene.mjs";

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch {}
before(async () => { if (chromium) browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); });
after(async () => { await browser?.close(); });

const faceScript = readFileSync(fileURLToPath(new URL("../media/pips/plush.js", import.meta.url)), "utf8")
  .replace(/const asset=[^\n]+;/, `const asset='data:image/webp;base64,${readFileSync(
    fileURLToPath(new URL("../media/pips/plush-bodies.webp", import.meta.url))).toString("base64")}';`);
const run = (c) => `run_${c.repeat(32)}`;
const fix = (c, agent, name, state) => ({ fix_id: `fix_${c.repeat(32)}`, run_id: run(c),
  pip_id: `pip_${c.repeat(32)}`, name, pip_type: "scout", agent_id: agent,
  created_at: Date.now() / 1000, state });

for (const width of [300, 460, 900]) {
  test(`Pip fix face stays outside its agent row at ${width}px and follows the agent's state`, async (t) => {
    if (!browser) { t.skip("Chromium unavailable"); return; }
    const { page, send, errors } = await openMapScene(browser, { width, faces: true, reducedMotion: false });
    try {
      await page.evaluate((script) => {
        eval(script);
        const style = document.createElement("style"); style.textContent = window.PipConcepts.plush.styles;
        document.head.append(style);
        window.PipConcepts.plush.mount(document.getElementById("agent-map"));
      }, faceScript);
      await send({ type: "pip_fix", fix: fix("a", sid(1), "ERP audit", "running") });
      await send({ type: "pip_fix", fix: fix("b", sid(4), "Invoice Pip", "applied") });
      const measure = () => page.evaluate((ids) => {
        const map = document.getElementById("agent-map-box").getBoundingClientRect();
        return ids.map((id) => {
          const row = document.querySelector(`.am-row[data-agent-id="${id}"]`);
          const face = row.querySelector(".am-pip-float"), shell = face.getBoundingClientRect();
          const box = row.getBoundingClientRect();
          return { gap: shell.left - box.right, right: shell.right, viewport: innerWidth,
            mapRight: map.right, pose: face.querySelector(".dgc-plush")?.dataset.state,
            specialist: !!row.querySelector(".am-face"), label: row.getAttribute("aria-label"), hidden: face.hidden };
        });
      }, [sid(1), sid(4)]);
      const [working, finished] = await measure();
      for (const face of [working, finished]) {
        assert.equal(face.hidden, false);
        assert.ok(face.gap >= 5, `face clears the card border by ${face.gap}px`);
        assert.ok(face.right <= face.viewport, "the face stays inside the editor viewport");
        assert.equal(face.specialist, true, "the specialist icon remains in its row");
        assert.match(face.label, /Pip fix for/);
      }
      assert.equal(working.pose, "working");
      assert.equal(finished.pose, "idle");
      await send({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 267000 });
      assert.equal((await measure())[0].pose, "idle", "finishing the specialist settles the Pip face");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

// Pointing at the Pip's face beside a helper names the Pip (the user, 11 Nov): the face takes the pointer, says its
// name on hover, and a screen reader hears it too.
test("pointing at a Pip's face in the Agent Map shows its name", async (t) => {
  if (!browser) { t.skip("Chromium unavailable"); return; }
  const { page, send, errors } = await openMapScene(browser, { width: 460, faces: true, reducedMotion: true });
  try {
    await page.evaluate((script) => {
      eval(script);
      const style = document.createElement("style"); style.textContent = window.PipConcepts.plush.styles;
      document.head.append(style);
    }, faceScript);
    await send({ type: "pip_fix", fix: fix("c", sid(1), "Invoice Pip", "running") });
    const face = await page.evaluate((id) => {
      const el = document.querySelector(`.am-row[data-agent-id="${id}"] .am-pip-float`), r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { title: el.title, label: el.getAttribute("aria-label"), role: el.getAttribute("role"), hidden: el.getAttribute("aria-hidden"),
        takesPointer: !!hit && (hit === el || el.contains(hit)) };
    }, sid(1));
    assert.equal(face.takesPointer, true, "the face takes the pointer");
    assert.equal(face.title, "Invoice Pip", "its name on hover");
    assert.equal(face.label, "Invoice Pip", "and to a screen reader");
    assert.equal(face.role, "img");
    assert.equal(face.hidden, null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
