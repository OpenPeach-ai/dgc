// What test/render-ui-batch-r1.mjs pictures, item by item. Not a *.test.mjs file.
import { openGrid, LISBON } from "./home-grid-scene.mjs";
import { sample } from "./notes-sample.mjs";

const CARD = '.hc-grid .hc-card[data-card="note"]', OPEN = ".hc-open .hc-card";
const THEMES = ["dark", "light"];
const type = async (x, digits, rest = 400) => { for (const d of digits) await x.page.keyboard.press(d); await x.rest(rest); };

export const PICTURES = {
  // 1. Notes on Home: only a field, the new-note icon and Open Notes; the lock at once, open now, locked again.
  notes: async ({ browser, touch, shot, boxOf }) => {
    for (const theme of THEMES) for (const width of [170, 220, 300, 440, 700]) for (const finger of width === 440 ? [false, true] : [false]) {
      const x = await openGrid(finger ? touch : browser, { width, theme: `${theme}-modern`, layout: ["note", "clock", "weather"], seed: sample(), notesOptions: { iterations: 1500 }, settings: { weather: { place: LISBON } }, scale: 2, touch: finger });
      try { await x.rest(400); await shot(x.page, `1-notes-card-${width}-${theme}${finger ? "-touch" : ""}`, { x: 0, y: 0, width, height: Math.min(900, 620) });
        if (!finger && (width === 300 || width === 700)) { await x.page.click(`${CARD} .hc-note-new`); await x.rest(300); await shot(x.page, `1-notes-card-fresh-${width}-${theme}`, await boxOf(x.page, CARD));
          await x.page.keyboard.type("Buy string for the beans"); await x.page.keyboard.press("Enter"); await x.page.keyboard.type("- two balls, green"); await x.rest(700); await shot(x.page, `1-notes-card-typed-${width}-${theme}`, await boxOf(x.page, CARD)); }
      } finally { await x.close(); }
    }
    for (const theme of THEMES) for (const width of [300, 700]) {
      const x = await openGrid(browser, { width: 300, theme: `${theme}-modern`, layout: ["note", "clock"], seed: sample(), notesOptions: { iterations: 1500 }, scale: 2 });
      try { await x.rest(200); await x.page.click(`${CARD} .nt-openapp`); await x.rest(350); if (width !== 300) await x.resize(width, 900);
        await x.page.click(`${OPEN} .hc-note-row[data-note="wifi01"]`); await x.rest(350); await shot(x.page, `1-notes-app-note-${width}-${theme}`);
        await x.page.click(`${OPEN} .nt-lock`); await x.rest(250); await type(x, "4821", 150); await type(x, "4821", 800); await x.page.mouse.move(2, 880);
        await shot(x.page, `1-notes-locked-at-once-${width}-${theme}`);
        await x.page.click(`${OPEN} .nt-pad`); await type(x, "4821", 700); await x.page.mouse.move(2, 880); await shot(x.page, `1-notes-open-now-${width}-${theme}`);
        await x.page.click(`${OPEN} .nt-more`); await x.rest(300); await shot(x.page, `1-notes-more-remove-lock-${width}-${theme}`); await x.page.keyboard.press("Escape"); await x.rest(200);
        if (width === 300) { await x.page.click(`${OPEN} .hc-note-all`); await x.rest(300); await shot(x.page, `1-notes-list-open-now-${width}-${theme}`); }
      } finally { await x.close(); }
    }
  },
};

// 2. The model menu: the tabs under the model row and the main slider; the Sub-agents tab and its dropdowns.
import { openMapScene } from "./agent-map-scene.mjs";
import { modelsMessage } from "./model-menu-scene.mjs";
PICTURES.menu = async ({ browser, shot }) => {
  for (const theme of THEMES) for (const [width, height] of [[170, 700], [220, 700], [300, 900], [440, 760], [700, 760]]) {
    const s = await openMapScene(browser, { width, height, theme: `${theme}-modern`, open: false, capabilities: { agents_model: 1, model_fallback: 1 } }), { page, post } = s;
    try {
      await page.click("#btn-model"); await post(modelsMessage({ thinking: "medium" })); await page.waitForSelector(".dgc-mp .dgc-mp-row"); await page.waitForTimeout(250);
      await page.locator(".dgc-mp .dgc-menu-item", { hasText: "gpt-oss:120b-32k" }).hover(); await page.waitForTimeout(250);
      await shot(page, `2-menu-main-${width}-${theme}`);
      await page.click('.dgc-mp-tab[data-tab="agents"]'); await page.waitForTimeout(250); await page.mouse.move(2, 2); await shot(page, `2-menu-sub-agents-${width}-${theme}`);
      // (Their thinking is the picker's own Thinking row and their window its one field: nothing more to open.)
      await page.click(`.dgc-mp-conn[data-rail="provider_${"c".repeat(32)}"]`); await post({ type: "providerModels", id: `provider_${"c".repeat(32)}`, ids: ["gpt-oss:120b", "own-coder", "qwen3-coder:30b", "glm-5.3:cloud", "deepseek-v4.1-flash:cloud", "codellama:13b", "qwen2.5:14b", "a-model-with-a-very-long-name-that-goes-on:120b-instruct-q8_0"] });
      await page.waitForSelector(".dgc-mp .dgc-mp-row"); await page.waitForTimeout(250); await shot(page, `2-menu-sub-agents-models-${width}-${theme}`);
    } finally { await page.close(); }
  }
};

// 4. The Work and Chat tabs' header row, beside the Pips tab's. 6. One corner shape. 7, 8. The cards' words. 10, 11.
import { openDock } from "./dock-scene.mjs";
import { openRunningTurn, openChatDgc } from "./dgc-look-scene.mjs";
import { openChat as openPipChat } from "./pip-chat-scene.mjs";
PICTURES.headers = async ({ browser, shot }) => {
  // (The Pips tab's own header row, to set beside these, is in the sweep below: 9-pips-list-list-*.)
  for (const theme of THEMES) for (const width of [170, 220, 300, 440, 700]) for (const tab of ["work", "chat"]) {
    const x = await openDock(browser, { tab, width, height: 520, theme: `${theme}-modern` });
    try { await x.settle(); await x.page.waitForTimeout(500); await shot(x.page, `4-header-${tab}-${width}-${theme}`);
      if (tab !== "pips" && width === 300) { await x.page.click(tab === "work" ? "#work-more" : "#chats-more-menu"); await x.page.waitForTimeout(400); await shot(x.page, `4-header-${tab}-menu-${width}-${theme}`); }
    } finally { await x.close(); }
  }
};
PICTURES.corners = async ({ browser, shot }) => {
  for (const theme of THEMES) for (const width of [300, 700]) {
    let x = await openRunningTurn(browser, { width, height: 560, theme: `${theme}-modern`, approval: false });
    try { await shot(x.page, `6-corner-work-${width}-${theme}`, { x: 0, y: 300, width, height: 260 }); } finally { await x.page.close(); }
    x = await openChatDgc(browser, { width, height: 560, theme: `${theme}-modern` });
    try { await shot(x.page, `6-corner-chat-${width}-${theme}`, { x: 0, y: 300, width, height: 260 }); } finally { await x.page.close(); }
    const p = await openPipChat(browser, { width, height: 560, theme, where: width > 400 ? "tab" : "side", project: true, running: true, api: 97, doing: "Waiting for its computer: it's finishing 'Book the 9 am train'", fixing: true });
    try { await p.p.waitForTimeout(500); await shot(p.p, `6-11-corner-pip-tray-${width}-${theme}`, { x: 0, y: 300, width, height: 260 }); } finally { await p.close(); }
  }
};
PICTURES.cards = async ({ browser, shot }) => {
  for (const theme of THEMES) for (const width of [300, 440]) {
    const asks = [["7-sub-agent-card", "task", { description: "Read billing/totals.py", prompt: "Read it and say what order_total returns.", model: "glm-5.3:cloud" }],
      ["8-settings-card", "dgc_settings", { action: "setting", key: "pips_parallel_runs", value: 8, reason: "You asked for more Pips at once.", setting_label: "Pip runs at once (all Pips)", before: 4 }],
      ["8-settings-card-rule", "dgc_settings", { action: "rule", rule: "Bash(npm test:*)", rule_action: "allow", reason: "So the tests run without asking each time." }]];
    for (const [name, tool, args] of asks) {
      const s = await openMapScene(browser, { width, height: 620, theme: `${theme}-modern`, open: false, capabilities: { settings_undo: 1 } });
      try { await s.post({ type: "event", event: { type: "permission_request", id: "p1", call_id: "c1", name: tool, args, choices: ["once", "always", "deny"], suggested_rule: tool } }); await s.page.waitForTimeout(400);
        await s.page.locator(".card .q").last().scrollIntoViewIfNeeded(); await shot(s.page, `${name}-${width}-${theme}`); } finally { await s.page.close(); }
    }
  }
};

// 5. A Pip's chat header: back, face and name at the left; the thread selector in the middle; the switch, its computer
// and the menu at the right. With a short thread name and with a very long one: nothing else moves.
PICTURES.pipheader = async ({ browser, touch, shot }) => {
  const LONG = "Everything we still have to book for the week in Goa in March, with the trains", MA = `conv_${"d".repeat(32)}`;
  for (const theme of THEMES) for (const finger of [false, true]) for (const [where, width] of [["side", 170], ["side", 220], ["side", 300], ["side", 440], ["tab", 700], ["tab", 1100]]) {
    const x = await openPipChat(finger ? touch : browser, { where, width, height: 420, theme, api: 97, convs: true, switches: true, touch: finger });
    try { await x.p.waitForSelector("#pip-convs"); await x.p.waitForTimeout(500);
      const tag = `${width}-${theme}${finger ? "-touch" : ""}`;
      await shot(x.p, `5-pip-header-${tag}`, { x: 0, y: 0, width, height: 130 });
      await x.p.evaluate(([id, t]) => { window.__convs.list.find((c) => c.id === id).title = t; }, [MA, LONG]);
      const column = await x.p.evaluate(() => !!(window.__pipsRoot || document).querySelector("#conv-column .conv-row")?.checkVisibility());
      if (column) await x.p.click(`#conv-column [data-conv="${MA}"]`); else { await x.p.click("#pip-convs"); await x.p.waitForTimeout(250); if (!finger && width === 300) await shot(x.p, `5-pip-header-threads-open-${tag}`, { x: 0, y: 0, width, height: 420 }); await x.p.click(`#conv-menu [data-conv="${MA}"]`); }
      await x.p.waitForTimeout(500); await shot(x.p, `5-pip-header-long-name-${tag}`, { x: 0, y: 0, width, height: 130 });
    } finally { await x.close(); }
  }
};

// 9 (and 2, 3, 10 on their pages). The narrowest widths, every page: each state of each scene the polish pass walks, at
// VS Code's narrowest side bar (170), 300, 440 and 700 px, dark and light, with a mouse and on a touch screen.
import { SCENES } from "./polish-scenes.mjs";
export const SWEEP = { "home-grid": ["top"], "home-notes": ["card", "a-note", "choose-a-pin"], "home-library": ["library"], "work-list": ["list", "row-menu", "folder-menu", "many-long", "new-session"], "chat-list": ["list"],
  "work-chat": ["running-queue", "approval"], "work-model-menu": ["menu", "sub-agents", "agent-map"], "chatdgc": ["a-chat"], "pips-list": ["list", "new-pip", "many"],
  "pips-chat": ["chat-ask", "pip-chat", "page", "model-menu", "model-menu-sub-agents"], "settings": ["general", "mcp", "models"], "notes-tab": ["a-note"] };
PICTURES.sweep = async ({ browser, touch, out }) => {
  const only = (process.env.SWEEP_SCENES || "").split(",").filter(Boolean), widths = (process.env.SWEEP_WIDTHS || "170,300,440,700").split(",").map(Number);
  for (const [scene, states] of Object.entries(SWEEP)) { if (only.length && !only.includes(scene)) continue;
    for (const theme of THEMES) for (const width of widths) for (const finger of [false, true]) {
      const DONE = new Error("done"), left = new Set(states);
      try { await SCENES[scene](finger ? touch : browser, { width, theme, touch: finger }, async (state, page) => {
        if (!left.has(state)) return;
        if (!finger) await page.mouse.move(1, 1);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${out}/9-${scene}-${state}-${width}-${theme}${finger ? "-touch" : ""}.png` });
        left.delete(state); if (!left.size) throw DONE;
      }); } catch (error) { if (error !== DONE) console.log(`! ${scene} ${width} ${theme}${finger ? " touch" : ""}: ${String(error).slice(0, 160)}`); }
      if (left.size) console.log(`! ${scene} ${width} ${theme}${finger ? " touch" : ""}: not pictured: ${[...left].join(", ")}`);
    }
    console.log(`9-${scene}`);
  }
};
