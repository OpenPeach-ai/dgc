// User test round 2, W21: a session that was running and waiting for an okay said both in its row of the Work list:
// "Wants your okay" under its name and the purple Running dot at its end. One state: the one that needs the person.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const short = (theme) => theme.split("-")[0];

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`W21: a running session that wants an okay says only that; one only running keeps its dot (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const sessions = [{ ...DOCK_SESSIONS[0], name: "Add tax to order_total", running: true, waiting: true }, { ...DOCK_SESSIONS[1], name: "Tidy the invoices", running: true, waiting: false }, { ...DOCK_SESSIONS[2] }];
    const x = await openDock(C.state.browser, { width, height: 600, theme, sessions, pins: [] });
    try {
      await x.page.waitForSelector("#sessions-host .session-row, #sessions-host [data-session]");
      await x.page.waitForTimeout(200);
      const rows = await x.page.evaluate(() => [...document.querySelectorAll("#sessions-host .session-name")].map((name) => { const row = name.closest("[data-session], .session-row, li, button") || name.parentElement.parentElement;
        const dots = [...row.querySelectorAll(".live-dot, .session-live, [data-live]")].filter((n) => n.checkVisibility()), sub = row.querySelector(".session-sub"), age = row.querySelector(".session-age");
        return { name: name.textContent, sub: sub?.textContent || "", waiting: !!sub?.classList.contains("session-waiting"), dots: dots.map((d) => d.getAttribute("aria-label") || d.title || d.textContent || "dot"), age: age && !age.hidden ? age.textContent : "",
          said: row.textContent }; }));
      await shot(x.page, `w21-work-list-${short(theme)}-${width}`);
      const both = rows.find((r) => r.name === "Add tax to order_total"), only = rows.find((r) => r.name === "Tidy the invoices");
      assert.ok(both && only, `premise: both rows are listed (${rows.map((r) => r.name)})`);
      assert.equal(both.sub, "Wants your okay");
      assert.deepEqual(both.dots, [], "no Running dot beside it: one state, the one that needs you");
      assert.doesNotMatch(both.said, /Running/);
      assert.match(only.sub, /^Running/, "a session that is only running says so");
      assert.equal(only.dots.length, 1, "and keeps its dot");
      assert.deepEqual(x.errors || [], []);
    } finally { await x.page.close(); }
  });
}
