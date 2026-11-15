// Pictures of editor tabs wearing a Pip's face (0.52), beside a Work session's tab, a ChatDGC chat's and a Pip's
// computer's: the icons are the ones the extension gives VS Code (src/pipTabFace.ts, src/dock.ts, src/tabIcon.ts read
// the same files), drawn 16 px wide as a tab draws them, in VS Code's own tab colours, dark and light; and each face
// four times as large under it, to see what the 16 px one is made of. Not a test.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-pip-tab-faces.mjs <folder to write into>
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { CHARACTERS, faceFile } from "../scripts/render-pip-tab-faces.mjs";

const out = process.argv[2];
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const root = new URL("..", import.meta.url).pathname;
const png = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
const svg = (file) => `data:image/svg+xml;base64,${readFileSync(file).toString("base64")}`;
const THEME = { dark: { bar: "#181818", tab: "#181818", active: "#1f1f1f", text: "#9d9d9d", on: "#ffffff", line: "#2b2b2b", top: "#0078d4" },
  light: { bar: "#f8f8f8", tab: "#f8f8f8", active: "#ffffff", text: "#3b3b3b", on: "#3b3b3b", line: "#e5e5e5", top: "#005fb8" } };
const NAMES = { core: "Core", scout: "Tile helper", lens: "Inbox reader", patch: "Fixer", rook: "GST watchdog", pulse: "Nightly tests", lock: "Key keeper", quill: "Mornings" };
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const theme of ["dark", "light"]) for (const scale of [1, 2]) {
  const t = THEME[theme];
  const tabs = [
    { icon: png(`${root}media/session-icons/voxel-iris.png`), label: "Fix the e-way bill total" },
    { icon: png(`${root}media/session-icons/mote-azure.png`), label: "Plan the launch week" },
    ...CHARACTERS.slice(0, 4).map((c) => ({ icon: png(faceFile(c)), label: `${NAMES[c]} · Chat`, face: c })),
    { icon: png(`${root}media/session-icons/portal-iris.png`), label: "Core · Computer" },
    { icon: svg(`${root}media/dgc-tab-${theme}.svg`), label: "New session" }];
  const more = CHARACTERS.slice(4).map((c) => ({ icon: png(faceFile(c)), label: `${NAMES[c]} · Chat`, face: c }));
  const strip = (list, active) => `<div class="strip">${list.map((x, i) => `<div class="tab${i === active ? " on" : ""}"><span class="icon" style="background-image:url(${x.icon})"></span><span class="label">${x.label}</span><span class="x">×</span></div>`).join("")}</div>`;
  const page = await (await browser.newContext({ viewport: { width: 1180, height: 250 }, deviceScaleFactor: scale })).newPage();
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;background:${t.bar};font:13px system-ui,sans-serif;color:${t.text}}
    .strip{display:flex;border-bottom:1px solid ${t.line};background:${t.bar}}
    .tab{display:flex;align-items:center;height:35px;padding:0 10px;gap:6px;border-right:1px solid ${t.line};background:${t.tab};white-space:nowrap}
    .tab.on{background:${t.active};color:${t.on};box-shadow:inset 0 1px 0 ${t.top}}
    .icon{width:16px;height:16px;background-size:16px;background-repeat:no-repeat;background-position:center;flex:none}
    .x{opacity:.55;font-size:15px;padding-left:4px}
    .big{display:flex;gap:18px;padding:16px 12px;align-items:end}.big figure{margin:0;text-align:center;font-size:11px}
    .big .i64{display:block;width:64px;height:64px;background-size:64px;margin:0 auto 4px}.big .i16{display:inline-block;width:16px;height:16px;background-size:16px;vertical-align:middle;margin-right:4px}
  </style></head><body>${strip(tabs, 2)}${strip(more, 1)}
  <div class="big">${CHARACTERS.map((c) => `<figure><span class="i64" style="background-image:url(${png(faceFile(c))})"></span><span class="i16" style="background-image:url(${png(faceFile(c))})"></span>${c}</figure>`).join("")}</div></body></html>`);
  await page.screenshot({ path: `${out}/tab-faces-${theme}${scale === 2 ? "-2x" : ""}.png` });
  console.log(`tab-faces-${theme}${scale === 2 ? "-2x" : ""}`);
  await page.context().close();
}
await browser.close();
