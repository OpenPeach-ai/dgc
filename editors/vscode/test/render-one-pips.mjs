// Pictures of the One Pips screens (0.52; Pips API 94 to 96), in real Chromium on the stand-in DGC of
// test/support/one-pips-scene.mjs: the side bar's real page at 700 and 300 px, dark and light. Not a test.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-one-pips.mjs <folder to write into> [only: a name's start]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { GST, MORNINGS, RIVERSIDE_DIR, openOnePips } from "./support/one-pips-scene.mjs";

const out = process.argv[2], only = process.argv[3] || "";
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const shot = async (x, name, full = false) => {
  await x.page.mouse.move(2, 2); await settle(x.page);
  // (A chat taller than the view is pictured whole: the view is made as tall as its log.)
  if (full) {
    const scroller = (root) => { for (let e = root.querySelector(".conversation-log") || root.querySelector(".pip-page") || root.querySelector(".simple-content"); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return e; return null; };
    const need = await x.inPips((root, find) => { const e = (0, eval)(`(${find})`)(root); return e ? Math.ceil(e.scrollHeight - e.clientHeight) : 0; }, scroller.toString());
    if (need > 0) { const size = x.page.viewportSize(); await x.page.setViewportSize({ width: size.width, height: Math.min(2600, size.height + need + 8) }); await settle(x.page);
      await x.inPips((root, find) => { const e = (0, eval)(`(${find})`)(root); if (e) e.scrollTop = 0; }, scroller.toString()); await settle(x.page); }
  }
  await x.page.screenshot({ path: `${out}/${name}.png` }); console.log(name);
};
const menuOpen = (x) => x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot.querySelector(".dgc-folder-menu")).then(() => x.page.waitForTimeout(450));
const choose = async (x, value) => { await x.click("#pips-filter"); await menuOpen(x); await x.inPips((root, v) => [...root.querySelectorAll('.dgc-folder-menu [role="menuitemradio"]')].find((r) => r.dataset.folder === v).click(), value); await x.page.waitForTimeout(350); };
const want = (name) => !only || name.startsWith(only);

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const tag = `${theme}-${width}`, opts = { theme: `${theme}-modern`, width, height: 760, scale: 2 };
  let x;
  if (want("list")) {
    // The one list: All Pips with Needs attention, the filter's menu, Personal, one folder, a folder with no Pips.
    x = await openOnePips(browser, { ...opts, scene: { fix: "ask", unread: { [GST]: { id: "msg_" + "7".repeat(32), latest: "Tonight's check found 3 things. Two are new, and one is back from Tuesday." } } } });
    await shot(x, `list-all-${tag}`);
    await x.click("#pips-filter"); await menuOpen(x); await shot(x, `list-filter-menu-${tag}`);
    await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(300);
    await choose(x, ":personal"); await shot(x, `list-personal-${tag}`);
    await choose(x, RIVERSIDE_DIR); await shot(x, `list-folder-${tag}`);
    // New Pip with the folder pre-filled from the filter line.
    await x.click("#simple-new"); await x.waitIn("#review-root .dialog"); await x.inPips((root) => { const i = root.querySelector("#newPipName"); i.value = "Invoice checker"; i.dispatchEvent(new Event("input", { bubbles: true, composed: true })); });
    await shot(x, `new-pip-folder-${tag}`);
    await x.click("#new-pip-folder"); await menuOpen(x); await shot(x, `new-pip-folder-menu-${tag}`);
    await x.close();
    // New Pip on All Pips: "+ Give it a folder".
    x = await openOnePips(browser, { ...opts, scene: { attention: false } });
    await x.click("#simple-new"); await x.waitIn("#review-root .dialog"); await shot(x, `new-pip-none-${tag}`);
    await x.close();
  }
  if (want("chat")) {
    // A Pip's chat at each step of the flow.
    for (const [fix, name] of [["ask", "chat-1-finding-ask"], ["running", "chat-2-fixing"], ["ready", "chat-3-ready-apply"], ["applied", "chat-4-do-it-all"]]) {
      x = await openOnePips(browser, { ...opts, scene: { fix, level: fix === "applied" ? "full" : "ask" } });
      await x.openPip(GST);
      await x.waitIn(fix === "ask" ? ".pip-found-ask" : fix === "running" ? ".pip-found-fixing" : "[data-project-change]");
      if (fix === "applied") { await x.click("#pip-waiting-toggle"); await x.waitIn(".pip-found-waiting"); }
      await shot(x, `${name}-${tag}`, true);
      if (fix === "ask") { await x.click("[data-flow-menu]"); await x.waitIn(".pip-found-menu"); await shot(x, `chat-1-allow-menu-${tag}`, true); }
      if (fix === "ready") { await x.click("[data-project-review]"); await x.waitIn(".pip-project-file.open pre:not(.pip-project-wait)"); await shot(x, `chat-3-review-open-${tag}`, true); }
      await x.close();
    }
    // Its own change line with Undo, and the level menu with the Do it all warning.
    x = await openOnePips(browser, { ...opts, scene: { own: true, fix: "none", posts: false } });
    await x.openPip(GST); await x.waitIn(".own-change"); await shot(x, `chat-own-change-${tag}`);
    await x.click("#chat-level"); await x.waitIn(".composer-level-menu"); await shot(x, `chat-level-menu-${tag}`);
    await x.inPips((root) => [...root.querySelectorAll(".composer-level-menu [data-pip-level-pick]")][2].click()); await x.waitIn("#review-root .dialog"); await shot(x, `level-warning-${tag}`);
    await x.close();
  }
  if (want("page")) {
    // Its settings page, and its reports as a table.
    x = await openOnePips(browser, { ...opts, scene: { fix: "ask" } });
    await x.openPip(GST);
    await x.inPips((root) => root.querySelector(".pip-topbar .pip-menu summary").click()); await x.page.waitForTimeout(150); await shot(x, `pip-menu-${tag}`);
    await x.inPips((root) => [...root.querySelectorAll(".pip-topbar .pip-menu [data-tab]")].find((b) => b.dataset.tab === "job").click()); await x.waitIn(".pip-folder-parts"); await x.page.waitForTimeout(200);
    await shot(x, `settings-page-${tag}`, true);
    await x.inPips((root) => root.querySelector('.pip-folder-parts [data-tab="runs"]').click()); await x.waitIn("table.pip-reports"); await shot(x, `reports-table-${tag}`);
    await x.close();
    // A Personal Pip's chat, for the same header and box.
    x = await openOnePips(browser, { ...opts, scene: { attention: false } });
    await x.openPip(MORNINGS); await shot(x, `chat-personal-${tag}`);
    await x.close();
  }
}
await browser.close();
