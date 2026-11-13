// Pictures for the 12 Nov night notes, dark and light, at 700 and 300 px: a Project Pip's "Reports to" picker with
// same-titled sessions (each says when it is from), the delete dialog's "Move them to another session" list, New Pip
// with a folder chosen in the Project tab's dropdown, and the Project tab on one folder ("Project Pips").
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-queue6.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openOwnerPicker } from "./support/pip-chat-scene.mjs";
import { GARDEN, openPips } from "./support/project-folder-pips-scene.mjs";

const out = process.argv[2] || "queue6-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 250)))));
const pad = (n) => String(n).padStart(2, "0");
const ago = (minutes) => { const d = new Date(Date.now() - minutes * 60000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const SESSIONS = [5, 150, 26 * 60, 6 * 1440 + 90, 8 * 1440, 22 * 1440].map((m, i) => ({ id: `2026110${i + 1}-091200-b${i}`, title: "Say hello in three words.", when: ago(m) }));
const problems = [];
for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const said = (name, errors) => { console.log(`${out}/${name}-${theme}-${width}.png`); if (errors.length) problems.push(`${name} ${theme} ${width}: ${errors.join("; ")}`); };
  // 1. The owner picker, six sessions with one title.
  const x = await openOwnerPicker(browser, { width, theme });
  await x.p.screenshot({ path: `${out}/owner-picker-${theme}-${width}.png` });
  said("owner-picker", x.errors);
  await x.close();
  // (2. was the delete dialog's Move list: deleting a session no longer asks about Pips, 14 Nov.)
  // 3. The Project tab on one folder, then 4. New Pip from it.
  const p = await openPips(browser, { theme: `${theme}-modern`, width, height: 760, choice: GARDEN });
  await settle(p.page);
  await p.page.screenshot({ path: `${out}/project-tab-one-folder-${theme}-${width}.png` });
  await p.inPips((root) => root.querySelector("#simple-new").click());
  await p.page.waitForFunction(() => document.getElementById("pips-host").shadowRoot.querySelector("#new-pip-folder"));
  await settle(p.page);
  await p.page.screenshot({ path: `${out}/new-pip-folder-chosen-${theme}-${width}.png` });
  said("project-tab-one-folder / new-pip-folder-chosen", p.errors);
  await p.close();
}
await browser.close();
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
