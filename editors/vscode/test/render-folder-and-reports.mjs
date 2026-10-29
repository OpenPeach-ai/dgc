// Captures the screens for a ChatDGC chat's folder and Continue in Work, and for a Pip's reports and the dashboards it
// refreshes (Pips API 67): light and dark, at a narrow (360px) and a normal width, from the real webview pages with a
// stub host. Not a test: run it with
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-folder-and-reports.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { CHAT, M, OFFER, conversation, openChat } from "./support/chat-scene.mjs";
import { DASH, DASHBOARDS, openPipSettings } from "./support/pip-artifacts-scene.mjs";
import { BRIEF, openWorkTab } from "./support/work-tab-scene.mjs";

const out = process.argv[2] || join(tmpdir(), "dgc-folder-and-reports-screens");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const TONES = [["dark", "dark-modern"], ["light", "light-modern"]];
const WIDTHS = [["narrow", 360], ["normal", 1200]];
const FOLDER = "/home/me/projects/uploads-service";
const shots = [];
const problems = [];
async function shoot(page, name, errors = []) {
  const path = join(out, `${name}.png`);
  await page.waitForTimeout(120);
  await page.screenshot({ path });
  shots.push(path);
  // What a person would see as broken: anything past the right edge, or a script error.
  // (Inside an SVG, its own viewBox clips: the Pip avatar's rig draws wider than it shows.)
  const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((n) => !n.ownerSVGElement && n.getClientRects().length
    && n.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(n).position !== "fixed").map((n) => `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}.${n.getAttribute("class") || ""} in ${n.closest("section,[class]")?.getAttribute("class") || ""}`).slice(0, 5));
  if (wide.length) problems.push(`${name}: past the right edge: ${wide.join(", ")}`);
  if (errors.length) problems.push(`${name}: ${errors.join("; ")}`);
}

const SAID = [
  { id: M(1), role: "user", text: "Where is the upload limit set, and can each plan have its own?", created_at: "2026-10-28T08:39:00Z" },
  { id: M(2), role: "assistant", finish: "stop", created_at: "2026-10-28T08:40:00Z",
    text: "It's set in `src/upload.py`, line 2: `limit = 20`, a minute, the same for everyone.\n\nTo give each plan its own, move it into "
      + "`settings.py` as a table by plan, keep 20 as the default, and read it in `upload()` from the caller's plan. Three files change: "
      + "`settings.py`, `src/upload.py` and its test." },
];

// ---- ChatDGC: the Folder chip, its menu, Continue in Work
for (const [tone, theme] of TONES) {
  for (const [label, width] of WIDTHS) {
    const open = async (messages = SAID) => {
      const s = await openChat(browser, { width, height: 760, theme });
      await s.send({ type: "artifacts", offered: OFFER });
      await s.send({ type: "folderOffered", on: true });
      await s.send({ type: "opened", conversation: conversation({ title: "Upload limits" }), messages, earlier: 0, busy: false });
      await s.send({ type: "models", ids: ["glm-5.3:cloud"], current: "glm-5.3:cloud" });
      return s;
    };
    let s = await open();
    await shoot(s.page, `chat-folder-none-${label}-${tone}`, s.errors);
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER, mine: true });
    await shoot(s.page, `chat-folder-set-${label}-${tone}`, s.errors);
    await s.page.click("#cd-folder");
    await shoot(s.page, `chat-folder-menu-${label}-${tone}`, s.errors);
    await s.page.keyboard.press("Escape");
    await s.page.click("#cd-work");
    await s.send({ type: "briefing", on: true });
    await shoot(s.page, `chat-folder-briefing-${label}-${tone}`, s.errors);
    await s.send({ type: "briefing", on: false });
    await s.send({ type: "workOpened", folder: FOLDER, opened: true });
    await shoot(s.page, `chat-folder-work-opened-${label}-${tone}`, s.errors);
    await s.send({ type: "folderError", message: "Choose a project's folder, not the whole disk or your home folder." });
    await shoot(s.page, `chat-folder-refused-${label}-${tone}`, s.errors);
    await s.page.close();
    // A new chat, not yet sent: it can have a folder; Continue in Work waits for a message.
    s = await open([]);
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    await s.page.click("#cd-folder");
    await shoot(s.page, `chat-folder-new-chat-menu-${label}-${tone}`, s.errors);
    await s.page.close();
    // Narrow, with Output chosen too: the folder's chip gives way to its icon.
    s = await open();
    await s.send({ type: "folder", conversation: CHAT, folder: FOLDER });
    await s.page.click("#cd-output");
    await s.page.click('#cd-output-menu [data-output="spreadsheet"]');
    await shoot(s.page, `chat-folder-and-output-${label}-${tone}`, s.errors);
    await s.page.close();
  }
}

// ---- Work: the session Continue in Work opened, its brief in the prompt box, unsent
for (const [tone, theme] of TONES) {
  for (const [label, width] of WIDTHS) {
    const s = await openWorkTab(browser, { width, height: 760, theme, cwd: FOLDER });
    await s.send({ type: "composer_text", text: BRIEF });
    await s.send({ type: "session_ready", sessionId: "20261028-101500-ab" });
    await shoot(s.page, `work-brief-in-box-${label}-${tone}`, s.errors);
    await s.page.close();
  }
}

// ---- Pips: a reviewing Pip's Reports and dashboards (its Settings tab), a Personal Pip's page
async function pip(name, label, tone, theme, width, opts, section) {
  const s = await openPipSettings(browser, { width, height: 900, theme, ...opts });
  await s.page.waitForSelector(section);
  await s.page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent?.includes("Loading your dashboards"));
  await s.page.evaluate((sel) => { const n = document.querySelector(sel); n.scrollIntoView({ block: "start" }); window.scrollBy(0, -16); }, section);
  return s;
}
for (const [tone, theme] of TONES) {
  for (const [label, width] of WIDTHS) {
    let s = await pip("reports", label, tone, theme, width, { kind: "scout", dashboards: DASHBOARDS,
      artifacts: { report_as: "doc", report_doc: DASH("d"), dashboards: [DASH("a"), DASH("e")] } }, ".pip-artifacts-section");
    await shoot(s.page, `pip-reports-and-dashboards-${label}-${tone}`, s.errors);
    await s.page.selectOption("#pipDashboardAdd", DASH("b"));
    await s.page.waitForFunction(() => document.querySelectorAll(".pip-dashboard").length === 2 && !document.querySelector("#pipDashboardAdd:disabled"));   // the gone one left out
    await shoot(s.page, `pip-dashboard-added-${label}-${tone}`, s.errors);
    await s.close();
    s = await pip("first", label, tone, theme, width, { kind: "scout", dashboards: [] }, ".pip-artifacts-section");
    await s.page.selectOption("#pipReportAs", "sheet");
    await s.page.waitForFunction(() => !document.querySelector("#pipReportAs:disabled"));
    await shoot(s.page, `pip-reports-sheet-no-dashboards-${label}-${tone}`, s.errors);
    await s.close();
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: DASH(String(i)), title: ["Store sales", "Error budget", "Signups by country", "Refunds",
      "Weekly revenue by region and channel", "Support queue", "Deploys", "Latency p95"][i], version: i + 1 }));
    s = await pip("most", label, tone, theme, width, { kind: "pulse", name: "Pulse", dashboards: eight, artifacts: { dashboards: eight.map((d) => d.id) } }, ".pip-artifacts-section");
    await shoot(s.page, `pip-pulse-eight-dashboards-${label}-${tone}`, s.errors);
    await s.close();
    s = await pip("personal", label, tone, theme, width, { kind: "personal", dashboards: DASHBOARDS, artifacts: { dashboards: [DASH("c")] } }, ".pip-artifacts");
    await shoot(s.page, `pip-personal-dashboards-${label}-${tone}`, s.errors);
    await s.close();
  }
}

await browser.close();
console.log(`${shots.length} screens in ${out}`);
if (problems.length) { console.log(problems.join("\n")); process.exitCode = 1; }
