// What test/render-library-build.mjs pictures (0.52, 15 Nov: the Library everywhere, Always allow on every Pip card,
// deep research's row, the site card at the narrowest side bar), item by item. Not a *.test.mjs file.
import { openLibraryTab, LIB_ARTIFACTS } from "./library-scene.mjs";
import { openGrid } from "./home-grid-scene.mjs";
import { openCard, HOLDS } from "./pip-cards-scene.mjs";
import { openChat as openPipChat } from "./pip-chat-scene.mjs";
import { openResearch } from "./deep-research-scene.mjs";

const THEMES = ["dark", "light"], WIDTHS = [170, 300, 440, 700];
const LONG = "A page with a name so long that it cannot fit on one line of a narrow side bar";
const tag = (width, theme, finger) => `${width}-${theme}${finger ? "-touch" : ""}`;

export const PICTURES = {
  // 1 + 2. The Library tab: the five tabs, the page, each filter's menu, a filter chosen, many long names, nothing yet.
  library: async ({ browser, touch, shot }) => {
    for (const theme of THEMES) for (const width of WIDTHS) for (const finger of [false, true]) {
      const b = finger ? touch : browser, t = tag(width, theme, finger);
      let x = await openLibraryTab(b, { width, theme: `${theme}-modern`, touch: finger });
      try { await shot(x.page, `2-library-${t}`);
        if (!finger) { await x.page.hover("#library-list .lib-row:nth-child(2) .lib-row-maker"); await x.page.waitForTimeout(250); await shot(x.page, `2-library-row-hover-${t}`); await x.page.mouse.move(1, 1); }
        await x.menu("type"); await shot(x.page, `2-library-type-menu-${t}`); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(200);
        await x.menu("maker"); await shot(x.page, `2-library-maker-menu-${t}`);
        await x.pick("maker", "Rent or buy: the numbers"); await x.pick("type", "Widgets"); await shot(x.page, `2-library-widgets-of-one-chat-${t}`);
        await x.pick("type", "Dashboards"); await shot(x.page, `2-library-nothing-found-${t}`);
        await x.pick("type", "All"); await x.pick("maker", "Anyone");
        await x.page.click("#library-more"); await x.page.waitForTimeout(350); await shot(x.page, `2-library-more-menu-${t}`);
      } finally { await x.close(); }
      if (finger) continue;
      const many = Array.from({ length: 40 }, (_, k) => ({ ...LIB_ARTIFACTS[k % LIB_ARTIFACTS.length], id: "ar_" + String(k).padStart(16, "a"), title: k % 2 ? `${LONG} (${k})` : `Item ${k}`,
        ...(k % 3 ? {} : { made_by: { kind: "pip", id: "pip_" + "9".repeat(32), name: "Checkout smoke tests, every night at two" } }) }));
      x = await openLibraryTab(b, { width, theme: `${theme}-modern`, artifacts: many });
      try { await shot(x.page, `2-library-many-long-${t}`); } finally { await x.close(); }
      x = await openLibraryTab(b, { width, theme: `${theme}-modern`, artifacts: [], files: [], images: [] });
      try { await shot(x.page, `2-library-empty-${t}`); } finally { await x.close(); }
    }
  },
  // 1. Home's top row: Library beside Cards (and beside Home's back arrow while a card is open); the five tabs over it.
  home: async ({ browser, touch, shot }) => {
    for (const theme of THEMES) for (const width of WIDTHS) for (const finger of [false, true]) {
      const x = await openGrid(finger ? touch : browser, { width, theme: `${theme}-modern`, layout: ["needs", "recent", "clock", "running"], height: 520, touch: finger });
      try { await x.rest(400); await shot(x.page, `1-home-library-button-${tag(width, theme, finger)}`, { x: 0, y: 0, width, height: 300 });
        if (!finger) { await x.page.hover("#home-hub .hc-library-btn"); await x.rest(250); await shot(x.page, `1-home-library-button-hover-${tag(width, theme, finger)}`, { x: 0, y: 0, width, height: 140 });
          await x.page.click('.hc-grid .hc-card[data-card="clock"]', { position: { x: 12, y: 8 } }).catch(() => {}); await x.rest(400); await shot(x.page, `1-home-card-open-${tag(width, theme, finger)}`, { x: 0, y: 0, width, height: 200 }); }
      } finally { await x.close(); }
    }
  },
  // 3 + 5. A Pip's held-step cards: Always allow on each (and "Inside its daily limit" on a payment's), the site card.
  cards: async ({ browser, touch, shot }) => {
    for (const theme of THEMES) for (const width of WIDTHS) for (const finger of [false, true]) for (const kind of Object.keys(HOLDS)) {
      const x = await openCard(finger ? touch : browser, kind, { width, theme, where: width >= 600 ? "tab" : "side", touch: finger });
      try { await x.p.waitForTimeout(250);
        const box = await x.p.evaluate(() => { const c = (window.__pipsRoot || document).querySelector("[data-computer-card]"), r = c.getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 12), width: innerWidth, height: Math.min(innerHeight - Math.max(0, r.top - 12), r.height + 24) }; });
        await shot(x.p, `3-card-${kind}-${tag(width, theme, finger)}`, box);
      } finally { await x.close(); }
    }
    // The Pip's page: what is allowed without asking, the 15 Nov grants by their labels.
    for (const theme of THEMES) for (const width of WIDTHS) {
      const p = await openPipChat(browser, { settings: true, grants: "every", width, height: 900, where: width >= 600 ? "tab" : "side", theme, api: 96 });
      try { await p.p.waitForTimeout(300);
        await p.p.evaluate(() => { const root = window.__pipsRoot || document; (root.querySelector('.pip-topbar .pip-menu [data-tab="job"]') || root.querySelector('[data-tab="job"]')).click(); }); await p.p.waitForTimeout(600);
        const box = await p.p.evaluate(() => { const g = (window.__pipsRoot || document).querySelector('[aria-label="Allowed without asking"]'); if (!g) return null; g.scrollIntoView({ block: "center" }); const r = g.getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top - 12), width: innerWidth, height: Math.min(innerHeight - Math.max(0, r.top - 12), r.height + 24) }; });
        await p.p.waitForTimeout(200);
        if (box) await shot(p.p, `3-allowed-without-asking-${tag(width, theme, false)}`, box); else console.log(`! no Allowed without asking at ${width} ${theme}`);
      } finally { await p.close(); }
    }
  },
  // 4. Deep research's row in a Work chat, while it runs (each kind of progress line) and done.
  research: async ({ browser, shot }) => {
    for (const theme of THEMES) for (const width of WIDTHS) {
      for (const [name, o] of [["round", { step: 2, depth: "standard" }], ["page-title", { step: 3, depth: "quick" }], ["writing", { step: 4, depth: "thorough" }], ["done", { step: 5, done: true }]]) {
        const page = await openResearch(browser, { width, height: o.done ? 460 : 260, theme: `${theme}-modern`, ...o });
        try { if (o.done) { await page.evaluate(() => document.querySelectorAll("#log .msg.dgc.work-folded > .work-toggle").forEach((row) => row.click())); await page.waitForTimeout(200);
            await page.evaluate(() => { const log = document.getElementById("log"); log.scrollTop = log.scrollHeight; }); await page.waitForTimeout(250); }
          await shot(page, `4-deep-research-${name}-${tag(width, theme, false)}`); } finally { await page.close(); }
      }
    }
  },
};
