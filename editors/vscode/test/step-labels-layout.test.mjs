// Plain-words step labels as Chromium draws them, dark and light, at an editor tab's width and a narrow side bar's:
// the label is one line in the quiet grey (the same ink as the line that counts the steps), a long one ends in an
// ellipsis without widening the panel, a labelled row is as tall as one without a label, the opened row shows the exact
// command in a chip that wraps inside the row, and the approval card shows the command and never the label.
// jsdom checks the DOM in step-labels.test.mjs. DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openLabelledTurn } from "./render-step-labels.mjs";
import { STEPS, MISLEADING } from "./support/step-labels-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const MEASURE = `(() => {
  const log = document.getElementById("log");
  const probe = document.createElement("span"); probe.style.color = "var(--muted)"; log.appendChild(probe);
  const muted = getComputedStyle(probe).color; probe.remove();
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
  const rows = [...log.querySelectorAll(".tool")].map((row) => {
    const arg = row.querySelector(".arg"), chip = row.querySelector(".step-command"), style = getComputedStyle(arg);
    return { id: row.dataset.callId, open: row.classList.contains("open"), labelled: arg.classList.contains("step-label"),
      text: arg.textContent, title: arg.title, color: style.color, overflow: style.textOverflow, wrap: style.whiteSpace,
      clipped: arg.scrollWidth > arg.clientWidth + 1, arg: box(arg), head: box(row.querySelector(".head")), row: box(row),
      chip: chip ? { text: chip.textContent, visible: chip.checkVisibility(), box: box(chip), ink: getComputedStyle(chip.querySelector("code") || chip).color,
        font: getComputedStyle(chip.querySelector("code") || chip).fontFamily, pre: box(row.querySelector(".body pre")) } : null };
  });
  const card = document.querySelector(".card[data-request-id]");
  return { muted, rows, text: getComputedStyle(document.body).color, groupLabel: getComputedStyle(log.querySelector(".tg-label-text") || log.querySelector(".tool-group-label")).color,
    sideways: Math.max(log.scrollWidth - log.clientWidth, document.documentElement.scrollWidth - innerWidth, 0),
    card: card && { pre: card.querySelector("pre")?.textContent, text: card.textContent, html: card.innerHTML } };
})()`;

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`${theme}, ${width}px: labels are one quiet grey line, the opened row shows its command, the card shows the command only`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openLabelledTurn(browser, { width, theme, expand: 2 });
    try {
      const m = await page.evaluate(MEASURE);
      assert.equal(m.sideways, 0, "nothing pushes the panel sideways");
      const byId = Object.fromEntries(m.rows.map((r) => [r.id, r]));
      const plain = byId.s4;
      assert.equal(plain.labelled, false);
      assert.equal(plain.text, STEPS[3].command, "the step without a label is as it was");
      for (const step of STEPS.slice(0, 3)) {
        const r = byId[step.id];
        assert.equal(r.labelled, true, `${step.id} is labelled`);
        assert.equal(r.text, step.label);
        assert.equal(r.title, step.label);
        assert.equal(r.color, m.muted, "in the quiet grey");
        assert.equal(r.color, m.groupLabel, "the same ink as the line that counts the steps");
        assert.notEqual(r.color, m.text, "duller than the text");
        assert.equal(r.wrap, "nowrap"); assert.equal(r.overflow, "ellipsis");
        assert.ok(Math.abs(r.head.height - plain.head.height) <= 0.5, `a labelled row is as tall as a plain one (${r.head.height} vs ${plain.head.height})`);
        assert.ok(r.arg.right <= r.head.right + 0.5, "the label stays inside its row");
      }
      if (width === 300) assert.equal(byId.s3.clipped, true, "a long label ends in an ellipsis in a narrow side bar");
      if (width === 700) assert.equal(byId.s1.clipped, false, "a short label is whole at an editor tab's width");
      // The opened row: the exact command first, in a chip, then what came back.
      const opened = byId.s3;
      assert.equal(opened.open, true);
      assert.equal(opened.chip.text, `$ ${STEPS[2].command}`);
      assert.equal(opened.chip.visible, true);
      assert.match(opened.chip.font, /mono/i, "in the code face");
      assert.ok(opened.chip.box.bottom <= opened.chip.pre.top + 0.5, "above the output");
      assert.ok(opened.chip.box.left >= opened.row.left && opened.chip.box.right <= opened.row.right + 0.5, "inside the row, wrapped if it is long");
      assert.equal(byId.s1.chip.visible, false, "a folded row keeps its command behind the click");
      // The approval card goes by the command.
      assert.equal(m.card.pre, `$ ${MISLEADING.command}`);
      assert.equal(m.card.text.includes(MISLEADING.label), false, "the label is not on the approval card");
      assert.equal(m.card.html.includes(MISLEADING.label), false);
    } finally { await page.close(); }
  });
}
