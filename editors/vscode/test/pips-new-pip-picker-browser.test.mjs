// New Pip's big face and dropdown (reported 24 Oct: "a big face with a dropdown beside it") in real Chromium, drawn
// by the real client and its CSS at a narrow 300 px side bar, 460 px and a wide 900 px editor tab, dark and light: the Project and
// Personal dialogs closed and with their list open, and a Personal Pip's face on its page. Nothing sticks out of the page
// or is cut off by a box it sits in, there is no sideways scroll, the face sits beside the dropdown, and the open list
// lies wholly inside the dialog's visible part and the page: it drops down, or flips up when the picker sits low. Real
// keys pick a job (Enter opens it, End, Home and type-ahead move, Space picks and the list stays shut when the key comes
// up, Esc and Tab close it), a click outside closes it, and with reduced motion the faces are still. jsdom can't see any
// of that. SHOTS=<dir> also saves what each view painted.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { THEMES } from "./support/options-scene.mjs";

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

const ext = new URL("..", import.meta.url).pathname;
const bundled = await build({ entryPoints: [ext + "src/pipsClient.js"], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const PLANNER = "pip_" + "f".repeat(32), AUDIT = "pip_" + "a".repeat(32);

// Personal (a Lens called Planner) and a project ("shop", a Rook), with the catalog's own words for each character.
const host = `(${function (PLANNER, AUDIT) {
  const P = "ws_" + "e".repeat(32), W = "ws_" + "d".repeat(32), NOW = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const words = { scout: ["Repository exploration", "Reads the code to map out a project before a review. It doesn’t run commands."], lens: ["Repository research", "Answers a question from the project’s code. It doesn’t search the web."],
    patch: ["File fixes", "Edits only the files you approve, in a private copy. You approve each fix in a handoff."], rook: ["Code review", "Reviews the code for bugs and for code that will be hard to maintain."],
    pulse: ["Test execution", "Runs the exact test commands you approve, from a handoff or its own command plan."], lock: ["Security review", "Reviews the code for possible security problems. It never runs attacks."],
    quill: ["Documentation drafts", "Writes a private documentation draft from the code for you to review. It never changes project files."], core: ["Main chat", "The main chat."] };
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
    role: words[id][0], description: words[id][1], available: id !== "core", unavailable_reason: id === "core" ? "Core is the main chat." : null,
    default_name: id[0].toUpperCase() + id.slice(1), default_goal: "Review the committed code.", engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const base = { source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const audit = { ...base, workspace_id: W, id: AUDIT, pip_type: "rook", name: "Billing audit", goal: "Look for bugs in billing.py.", source_policy: { mode: "committed_only" } };
  const planner = { ...base, workspace_id: P, id: PLANNER, pip_type: "lens", name: "Planner", goal: "Plan my week.", source_policy: { mode: "personal" }, profile: { title: "", body: null, color: null, notify: true } };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576, effective_context_size: 8192,
    context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const pips = { [P]: [planner], [W]: [audit] }, byId = { [AUDIT]: audit, [PLANNER]: planner };
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: P, name: "Personal", kind: "personal" }, { id: W, name: "shop", kind: "git" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: (r) => ({ pips: pips[r.workspace_id] || [], total: (pips[r.workspace_id] || []).length, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: (r) => ({ context: { workspace_id: r.workspace_id, revision: 1, entries: [] } }),
    list_pip_models: () => ({ default_model: "deepseek-v4.1-flash:cloud", models: [{ id: "deepseek-v4.1-flash:cloud", name: "deepseek-v4.1-flash:cloud" }], connection: "configured" }),
    list_pip_messages: (r) => ({ pip_id: r.pip_id, workspace_id: byId[r.pip_id].workspace_id, messages: [], next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: (r) => ({ pip_id: r.pip_id, workspace_id: byId[r.pip_id].workspace_id, posts: [], next_before_id: null }),
    list_pip_run_fixes: (r) => ({ pip_id: r.pip_id, workspace_id: byId[r.pip_id].workspace_id, fixes: [] }),
    list_pip_reply_stats: (r) => ({ pip_id: r.pip_id, stats: [] }),
    get_pip: (r) => ({ pip: byId[r.pip_id] }), list_pip_runs: () => ({ runs: [] }),
    list_pip_routines: (r) => ({ pip_id: r.pip_id, routines: [] }),
    list_pip_attention: () => ({ as_of: iso(NOW), total: 0, counts: {}, by_pip: {}, items: [], truncated: false }),
    get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000, count: 1 }),
    list_pip_approvals: () => ({ approvals: [], next_cursor: null }), list_pip_checkpoints: () => ({ checkpoints: [], next_cursor: null }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make(m.request) }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 65, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PLANNER)}, ${JSON.stringify(AUDIT)});`;
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

// What sticks out of the page or is cut off by a box it sits in (one that hides what overflows, not one that scrolls).
const MEASURE = () => {
  const vw = document.documentElement.clientWidth, out = [];
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : ""} “${(e.textContent || "").trim().slice(0, 30)}”`;
  for (const e of document.querySelectorAll("#app *, #review-root *")) {
    if (!shown(e) || e.closest(".avatar, svg") || e.closest(".sr-only")) continue;
    const r = e.getBoundingClientRect();
    let clip = null;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== "visible") { clip = a; break; } }
    if (!clip) { if (r.right > vw + 1 || r.left < -1) out.push(`${name(e)} sticks out of the page (${Math.round(r.left)}–${Math.round(r.right)} of ${vw})`); continue; }
    const c = clip.getBoundingClientRect(), s = getComputedStyle(clip);
    if (["auto", "scroll"].includes(s.overflowX)) continue;
    if (r.right > c.right + 1 || r.left < c.left - 1) out.push(`${name(e)} is cut off by ${name(clip)}`);
  }
  return { out, scroll: document.documentElement.scrollWidth - vw };
};
// The picker: its face beside its button, and the open list against what may clip it: every box between it and the page
// that hides or scrolls what overflows (the dialog), and the page itself.
const PICKER = (scope) => {
  const root = document.querySelector(scope), picker = root?.querySelector(".pip-picker");
  if (!picker) return null;
  const rect = (e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  const list = picker.querySelector(".pip-picker-list"), button = picker.querySelector(".pip-picker-button"), open = !list.hidden;
  let top = 0, bottom = innerHeight, left = 0, right = document.documentElement.clientWidth;
  for (let a = list.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowY === "visible" && s.overflowX === "visible") continue; const r = a.getBoundingClientRect(); top = Math.max(top, r.top + a.clientTop); bottom = Math.min(bottom, r.top + a.clientTop + a.clientHeight); left = Math.max(left, r.left); right = Math.min(right, r.right); }
  const rig = picker.querySelector(".pip-picker-face .dgc-plush-rig");
  return { grid: !!root.querySelector(".character-grid"), face: rect(picker.querySelector(".pip-picker-face")), faceCharacter: picker.querySelector(".pip-picker-face .avatar")?.dataset.character,
    button: rect(button), value: button.textContent.trim(), expanded: button.getAttribute("aria-expanded"), visible: { top, bottom, left, right },
    list: open ? rect(list) : null, up: list.classList.contains("up"), scrolls: open ? list.scrollHeight - list.clientHeight : 0,
    rows: open ? [...list.querySelectorAll("[role=option]")].map((o) => ({ text: o.textContent.trim(), whole: o.scrollWidth <= o.clientWidth + 1 })) : [],
    still: rig ? getComputedStyle(rig).animationName === "none" : null };
};
const inside = (v, label) => {
  const { list, visible } = v;
  assert.ok(list, `${label}: the list is open`);
  assert.ok(list.top >= visible.top - 1 && list.bottom <= visible.bottom + 1 && list.left >= visible.left - 1 && list.right <= visible.right + 1,
    `${label}: the list is wholly inside the dialog's visible part and the page (${JSON.stringify(list)} in ${JSON.stringify(visible)})`);
  assert.ok(list.left >= v.face.left - 1 && list.right <= v.button.right + 1 && list.right >= v.button.right - 1, `${label}: the list sits under the picker, its right edge the button's`);
  for (const row of v.rows) assert.ok(row.whole, `${label}: “${row.text}” is whole`);
};

async function scene({ width, theme, height = 820, reducedMotion = "reduce" }) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.route("https://pips.test/**", (r) => {
    const m = new URL(r.request().url()).pathname.match(/^\/media\/(pips\/[\w.-]+\.webp)$/);
    if (m) return r.fulfill({ body: readFileSync(ext + "media/" + m[1]), contentType: "image/webp" });
    return r.fulfill({ body: page, contentType: "text/html" });
  });
  await p.goto("https://pips.test/view");
  await p.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} } body { background: var(--vscode-sideBar-background); }` });
  await p.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await p.waitForSelector("[data-pips-tab=project]");
  return { p, context, errors };
}
const shot = async (p, name) => { if (process.env.SHOTS) { await p.waitForTimeout(300); await p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); } };
const kind = (p) => p.evaluate(() => document.querySelector(".dialog .new-pip-kind .type-role")?.textContent || "");
const focused = (p) => p.evaluate(() => document.activeElement?.id || document.activeElement?.className || "");

for (const width of [300, 460, 900]) {
  for (const theme of ["dark-modern", "light-modern"]) {
    test(`New Pip at ${width} px, ${theme}: a big face beside a dropdown; open, its list is whole inside the dialog`, async (t) => {
      if (skipOrFail(t)) return;
      const { p, context, errors } = await scene({ width, theme });
      const tag = `${width}-${theme}`;
      // A Project Pip: what it should do.
      await p.click("[data-pips-tab=project]"); await p.waitForSelector(`[data-job="${AUDIT}"]`);
      await p.click("#simple-new"); await p.waitForSelector(".dialog #new-pip-kind");
      let v = await p.evaluate(PICKER, ".dialog"), m = await p.evaluate(MEASURE);
      assert.equal(v.grid, false, "no grid of tiles");
      assert.ok(v.face.width >= 64 && v.face.width <= 76 && v.face.height >= 64 && v.face.height <= 76, `the big face is 64–76 px (${v.face.width}×${v.face.height})`);
      assert.ok(v.face.right <= v.button.left && v.face.top <= v.button.bottom && v.face.bottom >= v.button.top, "the face is beside the dropdown");
      assert.equal(v.value, "Map out the project"); assert.equal(v.faceCharacter, "scout"); assert.equal(v.expanded, "false");
      assert.equal(v.still, true, "reduced motion: the big face is still");
      assert.deepEqual(m.out, [], "closed: nothing sticks out or is cut off"); assert.ok(m.scroll <= 0, `closed: no sideways scroll (${m.scroll}px)`);
      await shot(p, `${tag}-project-closed`);
      await p.click("#new-pip-kind");
      v = await p.evaluate(PICKER, ".dialog"); m = await p.evaluate(MEASURE);
      assert.equal(v.expanded, "true");
      inside(v, "Project, open");
      assert.ok(v.scrolls <= 0, `all seven jobs show without scrolling the list (${v.scrolls}px more)`);
      assert.deepEqual(v.rows.map((r) => r.text), ["Map out the projectScout", "Answer a question about the codeLens", "Fix files you approvePatch", "Review the code for bugsRook",
        "Run tests you approvePulse", "Look for security problemsLock", "Draft documentationQuill"], "the jobs, each with its character's name");
      assert.deepEqual(m.out, [], "open: nothing sticks out or is cut off"); assert.ok(m.scroll <= 0, `open: no sideways scroll (${m.scroll}px)`);
      await shot(p, `${tag}-project-open`);
      // A click outside closes it; then Lock, by a click in the list.
      await p.click(".dialog h2");
      assert.equal((await p.evaluate(PICKER, ".dialog")).expanded, "false", "a click outside closes it");
      await p.click("#new-pip-kind"); await p.click("#new-pip-kind-list [data-pick=lock]");
      v = await p.evaluate(PICKER, ".dialog");
      assert.deepEqual([v.expanded, v.value, v.faceCharacter], ["false", "Look for security problems", "lock"], "Lock: the face follows");
      assert.match(await kind(p), /^Lock · Security review/, "and the description");
      await shot(p, `${tag}-project-lock`);
      await p.click("#new-pip-kind"); await shot(p, `${tag}-project-lock-open`);
      inside(await p.evaluate(PICKER, ".dialog"), "Project, open on Lock");
      await p.keyboard.press("Escape");
      // A Personal Pip: a face and a name.
      await p.click("#review-cancel");
      await p.click("[data-pips-tab=personal]"); await p.waitForSelector(`[data-job="${PLANNER}"]`);
      await p.click("#simple-new"); await p.waitForSelector(".dialog #new-pip-character");
      v = await p.evaluate(PICKER, ".dialog"); m = await p.evaluate(MEASURE);
      assert.equal(v.grid, false); assert.ok(v.face.right <= v.button.left, "the face is beside the dropdown");
      assert.equal(v.value, "Scout");
      assert.deepEqual(m.out, [], "Personal, closed: nothing sticks out or is cut off"); assert.ok(m.scroll <= 0);
      await shot(p, `${tag}-personal-closed`);
      await p.click("#new-pip-character");
      v = await p.evaluate(PICKER, ".dialog"); m = await p.evaluate(MEASURE);
      inside(v, "Personal, open");
      assert.ok(v.scrolls <= 0, `the short dialog makes room: all seven names show without scrolling the list (${v.scrolls}px more)`);
      assert.deepEqual(v.rows.map((r) => r.text), ["Scout", "Lens", "Patch", "Rook", "Pulse", "Lock", "Quill"], "the names");
      assert.deepEqual(m.out, [], "Personal, open: nothing sticks out or is cut off"); assert.ok(m.scroll <= 0);
      await shot(p, `${tag}-personal-open`);
      await p.click("#new-pip-character-list [data-pick=quill]");
      assert.equal((await p.evaluate(PICKER, ".dialog")).faceCharacter, "quill");
      await p.click("#review-cancel");
      // A Personal Pip's face, on its page: the same control, a bigger face.
      await p.click(`[data-job="${PLANNER}"]`); await p.waitForSelector(".pip-topbar");
      await p.click(".pip-topbar .pip-menu > summary"); await p.click('.pip-topbar .pip-menu [data-tab="job"]');
      await p.click('[data-pip-page="character"]'); await p.waitForSelector("#pip-face");
      v = await p.evaluate(PICKER, "#app"); m = await p.evaluate(MEASURE);
      assert.ok(v.face.right <= v.button.left, "its page: the face is beside the dropdown"); assert.equal(v.value, "Lens");
      assert.deepEqual(m.out, [], "its page: nothing sticks out or is cut off"); assert.ok(m.scroll <= 0);
      await p.click("#pip-face");
      v = await p.evaluate(PICKER, "#app");
      assert.ok(v.list && v.list.bottom <= v.visible.bottom + 1 && v.list.top >= v.visible.top - 1, `its page: the list is inside the page (${JSON.stringify(v.list)})`);
      assert.deepEqual(v.rows.map((r) => r.text), ["Core", "Scout", "Lens", "Patch", "Rook", "Pulse", "Lock", "Quill"]);
      await shot(p, `${tag}-face-page-open`);
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
}

test("real keys pick a job: Enter opens it, End, Home and type-ahead move, Space picks, Esc and Tab close it", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context, errors } = await scene({ width: 460, theme: "dark-modern" });
  await p.click("[data-pips-tab=project]"); await p.waitForSelector(`[data-job="${AUDIT}"]`);
  await p.click("#simple-new"); await p.waitForSelector(".dialog #new-pip-kind");
  const active = () => p.evaluate(() => { const l = document.getElementById("new-pip-kind-list"); return l.hidden ? "" : l.getAttribute("aria-activedescendant"); });
  await p.focus("#new-pip-kind");
  await p.keyboard.press("Enter");
  assert.equal(await active(), "new-pip-kind-scout", "Enter opens it on the chosen job");
  assert.equal(await focused(p), "new-pip-kind-list", "and the list has the focus");
  await p.keyboard.press("End"); assert.equal(await active(), "new-pip-kind-quill");
  await p.keyboard.press("Home"); assert.equal(await active(), "new-pip-kind-scout");
  await p.keyboard.press("ArrowDown"); assert.equal(await active(), "new-pip-kind-lens");
  await p.keyboard.type("lo"); assert.equal(await active(), "new-pip-kind-lock", "“lo”: Look for security problems");
  await p.keyboard.press("Space");
  await p.waitForTimeout(150);
  const v = await p.evaluate(PICKER, ".dialog");
  assert.deepEqual([v.expanded, v.value, v.faceCharacter], ["false", "Look for security problems", "lock"], "Space picks Lock, and the list stays shut when the key comes up");
  assert.match(await kind(p), /^Lock/);
  assert.equal(await focused(p), "new-pip-kind", "the button has the focus back");
  await p.keyboard.press("ArrowDown"); assert.equal(await active(), "new-pip-kind-lock", "the Down arrow opens it on Lock");
  await p.keyboard.press("ArrowUp"); await p.keyboard.press("Escape");
  assert.equal(await active(), "", "Esc closes it");
  assert.ok(await p.$(".dialog"), "and only the list: the dialog stays");
  assert.equal(await focused(p), "new-pip-kind");
  assert.equal((await p.evaluate(PICKER, ".dialog")).faceCharacter, "lock", "Esc picks nothing");
  await p.keyboard.press("Enter"); await p.keyboard.press("Tab");
  assert.equal(await active(), "", "Tab closes it");
  assert.equal(await focused(p), "name", "and moves on, to the next field");
  await p.focus("#new-pip-kind"); await p.keyboard.press("Enter"); await p.keyboard.press("ArrowUp"); await p.keyboard.press("Enter");
  assert.equal((await p.evaluate(PICKER, ".dialog")).faceCharacter, "pulse", "Enter picks too");
  assert.deepEqual(errors, []);
  await context.close();
});

test("the list flips up when its picker sits low in the dialog, and scrolls inside when neither way has room for it all", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await scene({ width: 460, theme: "dark-modern" });
  await p.click("[data-pips-tab=project]"); await p.waitForSelector(`[data-job="${AUDIT}"]`);
  await p.click("#simple-new"); await p.waitForSelector(".dialog #new-pip-kind");
  // Lower the picker in the dialog (as a taller lead would) and scroll it near the dialog's bottom edge.
  await p.evaluate(() => { const d = document.querySelector(".dialog"), spacer = document.createElement("div"); spacer.style.height = "900px"; d.querySelector(".pip-picker").before(spacer);
    const b = document.getElementById("new-pip-kind").getBoundingClientRect(), r = d.getBoundingClientRect(); d.scrollTop += b.bottom - (r.bottom - 24); });
  await p.click("#new-pip-kind");
  let v = await p.evaluate(PICKER, ".dialog");
  assert.equal(v.up, true, "it flips up");
  inside(v, "flipped up");
  assert.ok(v.list.bottom <= v.button.top, "above its button");
  await shot(p, "flip-up");
  await p.keyboard.press("Escape"); await context.close();
  // A short window: the dialog scrolls the picker up to make room, and what still doesn't fit scrolls inside the list.
  const short = await scene({ width: 460, theme: "dark-modern", height: 300 });
  await short.p.click("[data-pips-tab=project]"); await short.p.waitForSelector(`[data-job="${AUDIT}"]`);
  await short.p.click("#simple-new"); await short.p.waitForSelector(".dialog #new-pip-kind");
  await short.p.click("#new-pip-kind");
  v = await short.p.evaluate(PICKER, ".dialog");
  inside(v, "a short window");
  assert.ok(v.scrolls > 0, "the list scrolls inside");
  await short.p.keyboard.press("End");
  await short.p.waitForTimeout(300);
  assert.equal(await short.p.evaluate(() => document.getElementById("new-pip-kind-list").getAttribute("aria-activedescendant")), "new-pip-kind-quill",
    "End is on the last job, though the list moved under the still pointer");
  const last = await short.p.evaluate(() => { const l = document.getElementById("new-pip-kind-list"), o = document.getElementById("new-pip-kind-quill").getBoundingClientRect(), r = l.getBoundingClientRect(); return o.top >= r.top - 1 && o.bottom <= r.bottom + 1; });
  assert.ok(last, "End scrolls the last job into sight");
  await shot(short.p, "short-window");
  const box = await short.p.evaluate(() => { const r = document.getElementById("new-pip-kind-patch").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
  await short.p.mouse.move(box.x, box.y);
  assert.equal(await short.p.evaluate(() => document.getElementById("new-pip-kind-list").getAttribute("aria-activedescendant")), "new-pip-kind-patch", "moving the pointer onto a row goes to it");
  await short.context.close();
});

test("with motion allowed the faces move; with reduced motion they are still", async (t) => {
  if (skipOrFail(t)) return;
  for (const [reducedMotion, still] of [["no-preference", false], ["reduce", true]]) {
    const { p, context } = await scene({ width: 460, theme: "dark-modern", reducedMotion });
    await p.click("[data-pips-tab=project]"); await p.waitForSelector(`[data-job="${AUDIT}"]`);
    await p.click("#simple-new"); await p.waitForSelector(".dialog #new-pip-kind"); await p.click("#new-pip-kind");
    const faces = await p.evaluate(() => [...document.querySelectorAll(".dialog .pip-picker .dgc-plush-rig")].map((r) => getComputedStyle(r).animationName === "none"));
    assert.equal(faces.length, 8, "the big face and the seven small ones");
    assert.deepEqual(faces, faces.map(() => still), `${reducedMotion}: ${still ? "still" : "moving"}`);
    await context.close();
  }
});

// Reported 24 Oct: "remove the outline cube around the main Pip face". The big face stands on its own, in both
// themes, in New Pip and on a Pip's Face page: no border, no filled box behind it.
test("the big face has no box around it: no border and no fill, in both themes", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) {
    const { p, context } = await scene({ width: 460, theme });
    await p.click("[data-pips-tab=project]"); await p.waitForSelector(`[data-job="${AUDIT}"]`);
    await p.click("#simple-new"); await p.waitForSelector(".dialog #new-pip-kind");
    const box = await p.evaluate(() => {
      const s = getComputedStyle(document.querySelector(".dialog .pip-picker-face"));
      return { border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth], fill: s.backgroundColor, image: s.backgroundImage, shadow: s.boxShadow };
    });
    assert.deepEqual(box.border, ["0px", "0px", "0px", "0px"], `${theme}: no border`);
    assert.ok(["rgba(0, 0, 0, 0)", "transparent"].includes(box.fill), `${theme}: no fill (${box.fill})`);
    assert.equal(box.image, "none", `${theme}: no background image`);
    assert.equal(box.shadow, "none", `${theme}: no shadow`);
    await context.close();
  }
});
