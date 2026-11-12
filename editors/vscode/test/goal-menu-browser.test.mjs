// A goal starts only when Goal is chosen from the "/" menu (decided 12 Nov, as Codex in VS Code), in real Chromium
// with real keys and the panel's own page (test/support/options-scene.mjs): the whole token "/goal" typed lists Goal
// and pins nothing; a click, Enter or Tab on Goal pins it to the draft, inside the prompt box, on nothing else; and
// "/goal some text" typed and sent goes as plain text. Dark and light, at 700 px and in the side bar (300 px).
// DGC_GOAL_MENU_PICTURES=<folder> keeps a picture of the menu with Goal in it and of the box with Goal chosen.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

const chromium = await chromiumOrNull();
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

const MENU_CSS = readFileSync(new URL("../media/mentions.css", import.meta.url), "utf8");
const PICTURES = process.env.DGC_GOAL_MENU_PICTURES || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });

async function open(theme, width) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 640 }, reducedMotion: "reduce" });
  const errors = []; page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: MENU_CSS });   // the menu's own rows, which the panel loads beside main.css
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
  }, [mainJs, markdownJs]);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: {}, model: "qwen3.8:27b",
    mode: "default", think: "off", base_url: "http://localhost:11434/v1", workspace_trusted: true, custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" } } })));
  await page.click("#input");
  const sent = () => page.evaluate(() => ({ goals: window.__posted.filter((m) => m.type === "startGoal").map((m) => m.text), prompts: window.__posted.filter((m) => m.type === "prompt").map((m) => m.text),
    commands: window.__posted.filter((m) => m.type === "slashText").map((m) => m.text) }));
  const value = () => page.evaluate(() => document.getElementById("input").value);
  const picture = async (name) => { if (PICTURES) { await page.waitForTimeout(200); await page.screenshot({ path: `${PICTURES}/${name}.png` }); } };
  return { page, errors, sent, value, picture, pinned: () => page.locator("#btn-goal").isVisible(), menuOpen: () => page.locator("#pop").evaluate((n) => getComputedStyle(n).display === "block") };
}
/** The menu and the prompt box, read in the page: what the eye would catch. */
const seen = () => {
  const box = (n) => n.getBoundingClientRect(), shown = (n) => n.checkVisibility({ visibilityProperty: true }) && box(n).width > 1;
  const pop = document.getElementById("pop"), goal = document.getElementById("btn-goal"), form = document.getElementById("input").closest(".composer, form, #composer") || document.getElementById("input").parentElement.parentElement;
  const rows = shown(pop) ? [...pop.querySelectorAll(".pi")].map((r) => ({ text: r.querySelector(".pi-label")?.textContent.trim() || r.textContent.trim(), chosen: r.getAttribute("aria-selected") === "true",
    inside: box(r).left >= box(pop).left - 0.5 && box(r).right <= box(pop).right + 0.5, cut: [...r.querySelectorAll(".pi-label")].some((n) => n.scrollWidth > n.clientWidth + 1) })) : null;
  const controls = [...form.querySelectorAll("button")].filter(shown), f = box(form);
  const over = []; for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) { const a = box(controls[i]), b = box(controls[j]);
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) over.push(`${controls[i].id} / ${controls[j].id}`); }
  return { rows, popInView: !shown(pop) || (box(pop).left >= -0.5 && box(pop).right <= innerWidth + 0.5 && box(pop).top >= -0.5), over,
    goal: shown(goal) ? { text: goal.textContent.trim(), state: goal.dataset.state, inBox: box(goal).left >= f.left - 0.5 && box(goal).right <= f.right + 0.5 && box(goal).top >= f.top - 0.5 && box(goal).bottom <= f.bottom + 0.5,
      cut: goal.scrollWidth > goal.clientWidth + 1, icon: !!goal.querySelector(".codicon-target") } : null,
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
};

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  const tag = `${theme.split("-")[0]}-${width}`;
  test(`"/goal" typed lists Goal and pins nothing; a click on Goal pins it in the box, and the next message is the goal (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(theme, width);
    try {
      await x.page.keyboard.type("/goal");
      assert.equal(await x.pinned(), false, "the whole token typed pins nothing");
      assert.equal(await x.value(), "/goal", "and stays as typed");
      let m = await x.page.evaluate(seen);
      assert.equal(m.rows?.[0]?.text.toLowerCase(), "goal", "the menu is open, Goal first"); assert.equal(m.rows[0].chosen, true);
      assert.deepEqual(m.rows.filter((r) => !r.inside || r.cut).map((r) => r.text), [], "no row is cut or pokes out of the menu");
      assert.equal(m.popInView, true); assert.equal(m.sideways, false);
      await x.picture(`goal-menu-${tag}`);
      await x.page.locator("#pop .pi").first().click();
      assert.equal(await x.pinned(), true, "a click on Goal pins it to this draft");
      assert.equal(await x.value(), "", "the slash token leaves the text"); assert.equal(await x.menuOpen(), false);
      assert.deepEqual((await x.sent()).goals, [], "choosing it starts nothing");
      await x.page.keyboard.type("Ship the release");
      m = await x.page.evaluate(seen);
      assert.deepEqual(m.goal, { text: "Goal", state: "draft", inBox: true, cut: false, icon: true }, "Goal sits in the prompt box, whole");
      assert.deepEqual(m.over, [], "on nothing else in the box"); assert.equal(m.sideways, false);
      await x.picture(`goal-chosen-${tag}`);
      await x.page.keyboard.press("Enter");
      assert.deepEqual(await x.sent(), { goals: ["Ship the release"], prompts: [], commands: [] });
      assert.equal(await x.pinned(), false, "the choice leaves with the message");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("Enter and Tab on Goal choose it too; typed and sent without the menu, /goal text is plain text and the managing words are commands", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open("dark-modern", 460);
  try {
    for (const key of ["Enter", "Tab"]) {
      await x.page.keyboard.type("tidy the docs /go");
      assert.equal(await x.pinned(), false);
      await x.page.keyboard.press(key);
      assert.equal(await x.pinned(), true, `${key} on Goal pins it`); assert.equal(await x.value(), "tidy the docs ");
      await x.page.locator("#btn-goal").click();   // taken off again
      assert.equal(await x.pinned(), false);
      await x.page.evaluate(() => document.getElementById("input").replaceChildren()); await x.page.click("#input");
    }
    assert.deepEqual(await x.sent(), { goals: [], prompts: [], commands: [] });
    // Typed whole and sent: the menu closed at the space, and Enter sends the words as they are.
    await x.page.keyboard.type("/goal fix the build");
    assert.equal(await x.menuOpen(), false); assert.equal(await x.pinned(), false);
    await x.page.keyboard.press("Enter");
    assert.deepEqual(await x.sent(), { goals: [], prompts: ["/goal fix the build"], commands: [] });
    // Ending in " /goal": the menu lists Goal; Escape leaves it, and Enter sends the words as they are.
    await x.page.click("#input"); await x.page.keyboard.type("fix the build /goal");
    assert.equal(await x.menuOpen(), true); assert.equal(await x.pinned(), false);
    await x.page.keyboard.press("Escape"); await x.page.keyboard.press("Enter");
    assert.deepEqual(await x.sent(), { goals: [], prompts: ["/goal fix the build", "fix the build /goal"], commands: [] });
    await x.page.click("#input"); await x.page.keyboard.type("/goal pause"); await x.page.keyboard.press("Enter");
    assert.deepEqual((await x.sent()).commands, ["/goal pause"]);
    assert.deepEqual((await x.sent()).goals, []);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
