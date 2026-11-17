// The 16 Nov second pass's scenes (uir2b-*.test.mjs, render-uir2b.mjs): a Pip's chat that takes Work's @ outputs, the
// words on each surface, the Allow card, and the Home / Library / Work-list fixes from user-test round 1. Built on the
// scenes each surface already has. Not a *.test.mjs file.
import { openPip, openWork, launchArgs } from "./uir2a-scene.mjs";
import { PIP } from "./pip-chat-scene.mjs";
import { modelsMessage } from "./model-menu-scene.mjs";
import * as grid from "./home-grid-scene.mjs";
import { homeState } from "./home-scene.mjs";
import { PINS } from "./dock-scene.mjs";
export { launchArgs };

export const MISSING = "The model didn't make a page. Try again, or pick another model for this reply.";
/** A Pip's chat on a DGC that takes @ outputs (Pips API 100; `api: 99`: one that doesn't). `missed`: its last reply
    didn't make the page its message asked for. */
export async function openPipOutputs(browser, { width = 440, height = 760, theme = "dark-modern", api = 100, missed = false, ...opts } = {}) {
  const said = missed ? [{ role: "user", text: "Page the tide times for Baga this week", more: { display_mentions: [{ start: 0, kind: "artifact", label: "Page", identity: "page" }] } },
    { role: "assistant", text: "High tide at Baga is at 06:42 and 19:05 today, and about fifty minutes later each day this week.", more: { output_missing: MISSING } }]
    : [{ role: "user", text: "What can you make for me?" }, { role: "assistant", text: "A document, slides, a spreadsheet, a page or a dashboard: type @ and pick one." }];
  const x = await openPip(browser, { width, height, theme, said, api, convs: true, marks: true,
    stubs: { get_pip_goal: { pip_id: PIP, goal: null }, list_pip_project_changes: { pip_id: PIP, changes: [] }, list_pip_fixes: { pip_id: PIP, workspace_id: "ws_" + "e".repeat(32), fixes: [] }, list_project_folders: { folders: [] } }, ...opts });
  const sent = () => x.page.evaluate(() => window.__convs.sent);
  const box = () => x.page.evaluate(() => { const root = window.__pipsRoot || document, input = root.querySelector("#chatText");
    return { text: input.value ?? input.textContent, pills: [...input.querySelectorAll(".composer-pill")].map((p) => ({ kind: p.dataset.kind, label: p.textContent.trim(), svg: !!p.querySelector(".composer-artifact-mark svg") })) }; });
  const menu = () => x.page.evaluate(() => { const root = window.__pipsRoot || document, pop = root.querySelector("#chat-pop");
    return pop.hidden || !pop.children.length ? [] : [...pop.querySelectorAll(".pi")].map((r) => ({ label: r.querySelector(".pi-label").textContent.trim(), kind: r.querySelector(".pi-kind")?.textContent || "", detail: r.querySelector(".pd")?.textContent || "",
      svg: !!r.querySelector(".pi-output-mark svg"), w: Math.round(r.querySelector(".pi-output-mark svg")?.getBoundingClientRect().width || 0) })); });
  const type = async (text) => { await x.page.click("#chatText"); await x.page.keyboard.type(text); await x.page.waitForTimeout(120); };
  return { ...x, sent, box, menu, type };
}

// ---- the Allow card on an edit (W8) -------------------------------------------------------------------------------
export const ROOT = "/home/me/projects/lime_tiles";
const DIFF = "--- a/billing/totals.py\n+++ b/billing/totals.py\n@@ -1,3 +1,3 @@\n def total(rows):\n-    return sum(r.amount for r in rows)\n+    return round(sum(r.amount for r in rows), 2)\n";
/** A Work session in the project at `root` whose turn asks to edit a file: its Allow card. `path`: the file, as the
    model named it; `root: ""`: a DGC that doesn't say where the project is; `tool`: which edit tool asks. */
export async function openAllowCard(browser, { width = 440, height = 760, theme = "dark-modern", tool = "write_file", path = "billing/totals.py", root = ROOT, choices } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 0, ready: root ? { project_root: root } : {} });
  const id = await x.say("Round the totals to two places");
  await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "t1", prompt: "" });
  const shown = { write_file: "Write", edit_file: "Edit", multi_edit: "MultiEdit", apply_patch: "ApplyPatch" }[tool] || "Bash";
  const full = path.startsWith("/") ? path : `${root || ROOT}/${path}`;
  await x.event({ type: "permission_request", id: "req-1", call_id: "c1", name: tool, args: tool === "bash" ? { command: "npm test" } : { path, content: "…" },
    ...(tool === "bash" ? { command: "npm test" } : { diff: DIFF }), summary: tool === "bash" ? "npm test" : path,
    suggested_rule: tool === "bash" ? "Bash(npm test)" : `${shown}(${full})`, ...(choices ? { choices } : {}) });
  await x.page.waitForSelector('.card[data-request-id="req-1"]');
  const card = () => x.page.evaluate(() => { const c = document.querySelector('.card[data-request-id="req-1"]'), box = (n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
    const buttons = [...c.querySelectorAll(".btns button")].filter((b) => b.getClientRects().length);
    return { box: box(c), buttons: buttons.map((b) => ({ text: b.textContent.trim(), d: b.dataset.d || "", box: box(b), cut: b.scrollWidth > b.clientWidth + 1, radius: getComputedStyle(b).borderTopLeftRadius })),
      decision: c.querySelector(".decision")?.textContent.trim() || "", lines: [...document.querySelectorAll("#log .sys")].map((n) => n.textContent.trim()),
      says: (() => { const p = c.querySelector(".perm-always"); return p && p.getClientRects().length ? { text: p.textContent, box: box(p), size: getComputedStyle(p).fontSize } : null; })(),
      alwaysName: c.querySelector('button[data-d="always"]')?.getAttribute("aria-label") || "", alwaysTitle: c.querySelector('button[data-d="always"]')?.title || "" }; });
  return { ...x, card };
}
/** Work's Permission rules list, as /permissions opens it, over `items` ([{action, rule}]). */
export async function openRules(browser, items, { width = 440, height = 760, theme = "dark-modern", root = ROOT } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 0, ready: { project_root: root } });
  await x.send({ type: "surface_open", surface: "permissions" });
  await x.event({ type: "permissions", request_id: "p1", items, total: items.length });
  await x.page.waitForSelector("#surface .surface-card, #surface .surface-empty");
  const rows = () => x.page.evaluate(() => [...document.querySelectorAll("#surface .rule-row")].map((r) => ({ badge: r.querySelector(".surface-badge").textContent, words: r.querySelector(".rule-words").textContent,
    where: r.querySelector(".rule-where")?.textContent || "", raw: r.querySelector(".rule-raw")?.textContent || "", remove: r.querySelector("[data-rule-remove]").getAttribute("aria-label") })));
  return { ...x, rows };
}

// ---- plan mode (W29) ----------------------------------------------------------------------------------------------
export const PLAN = "## Goal\n\nMake `order_total` include tax, using **`billing/tax.py`**.\n\n## Steps\n\n1. **`billing/totals.py`**: call `tax_for(net)` and add it to the total.\n2. **`tests/test_totals.py`**: the two existing assertions now fail by design; update them.\n   - `test_order_total_without_discount`: 250 + 45.0 → `295.0`.\n3. **Verify**: `python -m pytest tests/ -q` from the project root.\n\n```python\ndef order_total(rows):\n    net = sum(r.amount for r in rows)\n    return net + tax_for(net)\n```\n\n## Risk\n\nLow. `order_total` has exactly one caller path.";
/** A Work session in plan mode whose turn proposed a plan: the page DGC serves for it (the preview's card), then the
    plan's own card. */
export async function openPlan(browser, { width = 440, height = 900, theme = "dark-modern", preview = true } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 0 });
  const id = await x.say("Plan how to add tax into order_total. Keep the plan short.");
  await x.event({ type: "prompt_accepted", request_id: id, state: "started" }); await x.event({ type: "turn_start", turn_id: "t1", prompt: "" });
  if (preview) await x.event({ type: "artifact_ready", id: "art-1", name: "Plan", url: "http://127.0.0.1:45001/?a=9f2c1b7e" });
  await x.event({ type: "plan_proposal", id: "plan-1", plan: PLAN });
  await x.page.waitForSelector('.card[data-request-id="plan-1"]');
  const facts = () => x.page.evaluate(() => { const c = document.querySelector('.card[data-request-id="plan-1"]'), body = c.querySelector(".plan-body, .plan-fold > pre"), a = document.querySelector("#log .artifact");
    const box = (n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
    return { card: box(c), raw: body.textContent, headings: [...body.querySelectorAll("h1, h2, h3")].map((h) => h.textContent), items: body.querySelectorAll("li").length, code: body.querySelectorAll("code").length, strong: body.querySelectorAll("strong").length,
      buttons: [...c.querySelectorAll(".btns button")].filter((b) => b.getClientRects().length).map((b) => ({ text: b.textContent.trim(), d: b.dataset.d, title: b.title, box: box(b), cut: b.scrollWidth > b.clientWidth + 1, radius: getComputedStyle(b).borderTopLeftRadius })),
      decision: c.querySelector(".decision")?.textContent.trim() || "", sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, says: c.querySelector(".plan-says")?.textContent || "",
      preview: a ? { head: a.querySelector(".anm").textContent, name: a.querySelector(".alabel").textContent, link: a.querySelector(".aurl").textContent, linkTitle: a.querySelector(".aurl").title, buttons: [...a.querySelectorAll(".abtns button")].map((b) => ({ text: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 1 })), words: a.textContent } : null }; });
  return { ...x, facts };
}

// ---- the thinking levels (W15) --------------------------------------------------------------------------------------
/** A Work session with its model picker open on the thinking levels. `state(think, ultra)`: DGC says its level, as the
    host passes it on. */
export async function openThinking(browser, { width = 440, height = 760, theme = "dark-modern", think = "low" } = {}) {
  const x = await openWork(browser, { width, height, theme, turns: 1 });
  const state = (level, ultra = false) => x.send({ type: "state", state: { model: "deepseek-v4-pro:cloud", think: level, ultra, mode: "default", goal: { text: "", status: "none" } } });
  await state(think);
  await x.page.click("#btn-model"); await x.send(modelsMessage()); await x.page.waitForSelector(".dgc-mp .dgc-mp-level"); await x.page.waitForTimeout(200);
  const now = () => x.page.evaluate(() => { const on = document.querySelector('.dgc-mp-level[aria-checked="true"]');
    return { button: document.getElementById("effortname").textContent, word: document.querySelector(".dgc-mp-think-now")?.textContent || "", value: on?.dataset.level || "", levels: [...document.querySelectorAll(".dgc-mp-level")].map((b) => b.dataset.level),
      menu: !!document.querySelector(".dgc-mp-layer"), lines: [...document.querySelectorAll("#log .sys")].map((n) => n.textContent.trim()) }; });
  return { ...x, state, now, sent: () => x.posted("setReasoningProfile") };
}

// ---- Home and the Library (H1, H2, H6, H7, H8, L2, L3) ---------------------------------------------------------------
export { grid, homeState, PINS };
const AR = (n) => "ar_" + String(n).padStart(16, "0");
/** Four things a Work session made, as the tester had them: a dashboard, a sheet changed, slides, a document changed. */
export const MADE = () => JSON.stringify([["dashboard", "Lime Tiles orders dashboard"], ["sheet", "Lime Tiles product line budget"], ["slides", "Lime Tiles billing - team pitch"], ["doc", "Billing in lime_tiles — one-page guide"]]
  .map(([type, title], k) => ({ id: AR(k + 1), type, title, version: k % 2 ? 2 : 1, op: k % 2 ? "changed" : "made", surface: "work", where: "", at: Date.now() - k * 60000 })));
/** Two folders with one name, as a copied project has them, and one that is alone with its name. */
export const TWINS = { choice: "", window: { folder: "/home/me/usertest/home/projects/lime_tiles", shown: "~/usertest/home/projects/lime_tiles", name: "lime_tiles" }, rows: [
  { folder: "/home/me/usertest/home/projects/lime_tiles", shown: "~/usertest/home/projects/lime_tiles", name: "lime_tiles", here: true, exists: true, sessions: 2, pips: 0, workspace_id: null },
  { folder: "/home/me/pipshot/home/projects/lime_tiles", shown: "~/pipshot/home/projects/lime_tiles", name: "lime_tiles", here: false, exists: true, sessions: 9, pips: 0, workspace_id: null },
  { folder: "/home/me/garden-notes", shown: "~/garden-notes", name: "garden-notes", here: false, exists: true, sessions: 6, pips: 0, workspace_id: null }] };
/** Home, as cards (the real side bar page), with what the tester's had: things made, a dock, the cards asked for. */
export async function openHomeCards(browser, { width = 300, height = 760, theme = "dark-modern", layout = grid.DEFAULT, quiet = false, made = true, pins = PINS.slice(0, 2), ...rest } = {}) {
  const x = await grid.openGrid(browser, { layout, width, height, theme, pins, state: homeState(quiet ? "quiet" : "busy"), ...(made ? { pages: MADE() } : {}), ...rest });
  const badge = () => x.page.evaluate(() => { const b = document.getElementById("side-tab-home-count"), s = getComputedStyle(b);
    return { text: b.hidden ? "" : b.textContent, label: document.getElementById("side-tab-home").getAttribute("aria-label"), newsOnly: b.hasAttribute("data-news-only"), title: b.title, ground: s.backgroundColor, ink: s.color }; });
  /** The quiet line over each card's sentence in Recent, opened: what it says, whether it is cut, what a pointer reads. */
  const lines = () => x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].filter((c) => c.getClientRects().length).map((c) => { const sub = c.querySelector(".dgc-card-sub");
    const range = document.createRange(); range.selectNodeContents(sub);
    return { key: c.dataset.key, text: sub.textContent, cut: range.getBoundingClientRect().width > sub.getBoundingClientRect().width + 0.25, title: sub.title, name: c.querySelector(".dgc-card-title").textContent }; }));
  /** The page scrolled to its end: where its last thing ends, and where the dock begins. */
  const end = () => x.page.evaluate(async () => { let sc = document.querySelector("#home-hub"); while (sc && sc.scrollHeight <= sc.clientHeight + 2) sc = sc.parentElement;
    if (sc) sc.scrollTop = sc.scrollHeight; await new Promise((r) => setTimeout(r, 150));
    const dock = document.getElementById("dgc-dock"), bar = dock?.querySelector(".dgc-dock-bar") || dock, things = [...document.querySelectorAll("#home-hub .hc-grid > .hc-card, #home-hub .hc-open .dgc-hub-card, #home-hub .hc-open .hc-rrow, #home-hub .hc-open li")].filter((n) => n.getClientRects().length);
    const last = things.map((n) => n.getBoundingClientRect().bottom).reduce((a, b) => Math.max(a, b), 0);
    return { scrolls: !!sc && sc.scrollHeight > sc.clientHeight + 2, last: Math.round(last), dockTop: bar ? Math.round(bar.getBoundingClientRect().top) : null }; });
  return { ...x, badge, lines, end };
}
