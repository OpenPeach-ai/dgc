// Screenshots of the user's mods in the editor (Work, ChatDGC and Settings -> Plugins -> Mods), light and dark, at
// 360 and 1200 px: the strip above the prompt box with a command's answer, a notice and the question about a mod DGC
// wrote; a mod's panel in its drawer; /mods; the slash menu; the Mods section and a plugin's install review.
//   node test/render-mods.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { MODS, openChatMods, openSettings, openWork, workTranscript, OFFER, RESULT } from "./support/mods-scene.mjs";

const out = process.argv[2] || "mods-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const shot = async (page, name) => { await page.screenshot({ path: `${out}/${name}.png` }); console.log(`${out}/${name}.png`); };
const THEMES = [["dark", "dark-modern"], ["light", "light-modern"]];
const WIDTHS = [360, 1200];

for (const [label, theme] of THEMES) {
  for (const width of WIDTHS) {
    const height = width < 600 ? 780 : 760;
    // Work
    let scene = await openWork(browser, { width, height, theme });
    await workTranscript(scene);
    await shot(scene.page, `work-${label}-${width}-strip-and-cards`);
    await scene.page.click(".mod-status-item[data-mod=tally]");
    await scene.settle();
    await shot(scene.page, `work-${label}-${width}-pane`);
    await scene.page.keyboard.press("Escape");
    await scene.page.evaluate(() => {
      const input = document.getElementById("input");
      input.textContent = "/t"; input.focus();
      const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await scene.settle();
    await shot(scene.page, `work-${label}-${width}-slash-menu`);
    await scene.page.evaluate(() => { document.getElementById("input").textContent = ""; document.getElementById("pop").style.display = "none"; });
    await scene.page.evaluate(() => {
      const input = document.getElementById("input");
      input.textContent = "/mods"; input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("pop").style.display = "none";
      document.getElementById("send").click();
    });
    await scene.event({ type: "mods", mods: MODS, on: true });
    await scene.settle();
    await shot(scene.page, `work-${label}-${width}-mods-list`);
    if (scene.errors.length) console.error("work errors", scene.errors);
    await scene.page.close();

    // ChatDGC
    const chat = await openChatMods(browser, { width, height, theme });
    await chat.send({ type: "opened", conversation: { id: `chat_${"a".repeat(32)}`, title: "Release planning", model: null, thinking: null, pinned: false, archived: false, temporary: false },
                      messages: [{ id: `msg_${"1".repeat(32)}`, role: "user", text: "What changed this week?", created_at: Date.now() - 60000 },
                                 { id: `msg_${"2".repeat(32)}`, role: "assistant", text: "Three pull requests landed: the importer, the retry fix and the docs.", created_at: Date.now() - 50000 }] });
    await chat.send({ type: "modsEvent", event: { type: "mod_toast", name: "tally", mod: "Tally", text: "counting from zero again", surface: "chat" } });
    await chat.page.fill("#cd-input", "/tally");
    await chat.page.keyboard.press("End");
    await chat.page.evaluate(() => document.getElementById("cd-input").dispatchEvent(new Event("input", { bubbles: true })));
    await chat.settle();
    await shot(chat.page, `chat-${label}-${width}-slash-menu`);
    await chat.page.press("#cd-input", "Escape");
    await chat.page.fill("#cd-input", "/tally by tool");
    await chat.page.evaluate(() => document.getElementById("cd-input").dispatchEvent(new Event("input", { bubbles: true })));
    await chat.page.press("#cd-input", "Enter");
    const id = (await chat.modsPosted("command")).at(-1)?.request_id;
    await chat.send({ type: "modsEvent", event: { type: "mod_result", request_id: id, name: "tally", mod: "Tally", tree: RESULT } });
    await chat.send({ type: "modsEvent", event: { ...OFFER, surface: "chat" } });
    await chat.settle();
    await chat.page.evaluate(() => { const s = document.getElementById("cd-scroll"); s.scrollTop = s.scrollHeight; });
    await shot(chat.page, `chat-${label}-${width}-strip-and-cards`);
    await chat.page.click(".mod-status-item[data-mod=tally]");
    await chat.settle();
    await shot(chat.page, `chat-${label}-${width}-pane`);
    await chat.page.keyboard.press("Escape");
    await chat.page.fill("#cd-input", "/mods");
    await chat.page.evaluate(() => document.getElementById("cd-input").dispatchEvent(new Event("input", { bubbles: true })));
    await chat.page.press("#cd-input", "Enter");
    await chat.send({ type: "modsEvent", event: { type: "mods", mods: MODS, on: true, surface: "chat" } });
    await chat.settle();
    await shot(chat.page, `chat-${label}-${width}-mods-list`);
    if (chat.errors.length) console.error("chat errors", chat.errors);
    await chat.page.close();
  }
}

// Settings -> Plugins -> Mods, and a plugin's install review with its mods.
for (const [label] of THEMES) {
  for (const width of [360, 1200]) {
    const { page } = await openSettings(browser, { width, theme: label, mods: MODS });
    await page.click("[data-lane=mods]");
    await page.waitForTimeout(80);
    await shot(page, `settings-${label}-${width}-mods`);
    await page.click("[data-lane=plugins]");
    await page.waitForTimeout(40);
    await page.click("#browse-directory").catch(() => {});
    await page.evaluate(() => { window.postMessage({ type: "plugins", items: [{ name: "shipkit", display_name: "Ship Kit", summary: "Release notes and a changelog check.", installed: false, license: "MIT", marketplace: "personal", skills: [] }] }, "*"); });
    await page.waitForTimeout(60);
    const install = await page.$("[data-install='shipkit']");
    if (install) { await install.click(); await page.waitForTimeout(120); }
    await shot(page, `settings-${label}-${width}-install-review`);
    await page.close();
  }
}
await browser.close();
