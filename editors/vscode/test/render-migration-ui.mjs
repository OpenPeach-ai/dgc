// Pictures of 0.52's migration screens, in real Chromium, dark and light at 300 and 700 px. Not a test.
//   1. "Your Pips moved into one list" over the Pips tab (and with many Pips, and as "How Pips work now" opens it for
//      someone with nothing moved), and the line in Pips settings that opens it again.
//   2. The quiet note above a Work session that used to get Pip cards.
//   3. Report cards in a Work chat at Pips API 96 (closed and opened), with API 95's beside them.
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-migration-ui.mjs <folder to write into> [only: a name's start]
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { openOnePips } from "./support/one-pips-scene.mjs";
import { openAgentLines, sendEvents, settle } from "./support/agent-lines-scene.mjs";
import { one, seven, failed, clear, fixOf, APPLIED, ERP, GST } from "./support/pip-cards-polish-scene.mjs";

const out = process.argv[2], only = process.argv[3] || "";
if (!out) throw new Error("say where the pictures go");
mkdirSync(out, { recursive: true });
const want = (name) => !only || name.startsWith(only);
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const pid = (c) => "pip_" + c.repeat(32);
const WELCOME = { had_pips: true, folders: [{ folder: "toni_fabrics", pips: [{ id: pid("c"), name: "GST watchdog" }, { id: pid("d"), name: "ERP daily audit" }] }],
  personal: [{ id: pid("b"), name: "Mornings" }, { id: pid("e"), name: "Garden notes" }], do_it_all: [{ id: pid("b"), name: "Mornings" }] };
const MANY = { had_pips: true, folders: [
  { folder: "toni_fabrics", pips: ["GST watchdog", "ERP daily audit", "Night tests", "Docs check", "Lock review", "Stock count"].map((name, i) => ({ id: pid(String(i)), name })) },
  { folder: "garden", pips: [{ id: pid("7"), name: "Bed planner" }] }, { folder: "shop-frontend-and-checkout", pips: [{ id: pid("8"), name: "Checkout smoke tests, every night at two" }, { id: pid("9"), name: "Price list export" }] }],
  personal: [{ id: pid("b"), name: "Mornings" }, { id: pid("e"), name: "Garden notes" }, { id: pid("f"), name: "Reading list" }], do_it_all: [{ id: pid("b"), name: "Mornings" }, { id: pid("e"), name: "Garden notes" }] };

// The Pips' faces on the cards are the shipped ones, as in the panel (see pip-cards-polish-scene.mjs).
const FACES = "https://pip-faces.test";
const PLUSH = read("../media/pips/plush.js").replace("globalThis.document?.currentScript?.src", JSON.stringify(`${FACES}/media/pips/plush.js`));
const turn = (id, prompt, answer) => [{ type: "turn_start", turn_id: id, prompt, kind: "prompt" }, { type: "text_delta", text: answer }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];
const ready = (api) => ({ type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { agents: true, agent_control: true, history_snapshot: true, pip_reports: 1, pip_fix: 1, pips_supported: true, pips_enabled: true, pips_api_version: api },
  model: "qwen3.8:27b", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "20261112-101500-a1", session_name: "ERP fixes" });
/** A Work chat whose history has `reports` as cards (and `fixes` of them), at Pips API `api`; `note`: the editor says its note is due. */
async function openWork({ width, theme, api = 96, reports, fixes = [], note = false, height = 1500 }) {
  const page = await openAgentLines(browser, { width, height, theme, deviceScaleFactor: 2 });
  await page.route(`${FACES}/**`, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    if (!["plush-bodies.webp", "plush-body-mask.png"].includes(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: file.endsWith(".png") ? "image/png" : "image/webp", body: readFileSync(new URL(`../media/pips/${file}`, import.meta.url)) });
  });
  await page.evaluate(([faces, clock, welcome]) => { (0, eval)(faces); (0, eval)(clock); (0, eval)(welcome); }, [PLUSH, read("../media/msgtime.js"), read("../media/shared/pipswelcome.js")]);
  await sendEvents(page, [ready(api), { type: "history", items: [...turn("h1", "Set up the daily audit of the billing code", "Done: ERP daily audit runs every evening at 18:30, and GST watchdog at 20:00."),
    ...reports.map((report) => ({ role: "pip_report", report: fixes.some((f) => f.run_id === report.run_id) ? { ...report, fix: fixes.find((f) => f.run_id === report.run_id) } : report }))] }]);
  if (note) await page.evaluate(() => window.__post({ type: "pipSessionNote", session: "20261112-101500-a1", show: true }));
  await settle(page);
  await page.evaluate(() => Promise.all([...document.querySelectorAll("#log .pip-report-face image")].map((i) => i.decode?.().catch(() => {}))));
  await page.mouse.move(2, 2); await settle(page);
  return page;
}
/** The chat from its header to its last block, not the empty page under it. */
async function chatShot(page, name) {
  const clip = await page.evaluate(() => { const bottom = Math.max(0, ...[...document.querySelectorAll("#log .msg, #log .pip-report, #log .sys, #log .pip-report-group")].map((n) => n.getBoundingClientRect().bottom));
    return { x: 0, y: 0, width: innerWidth, height: Math.min(innerHeight, Math.ceil(bottom) + 16) }; });
  await page.screenshot({ path: `${out}/${name}.png`, clip }); console.log(name);
  await page.close();
}

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const tag = `${theme}-${width}`, look = { theme: `${theme}-modern`, width };
  if (want("1")) {
    for (const [name, welcome, auto] of [["1-welcome", WELCOME, true], ["1-welcome-many", MANY, true], ["1-welcome-how-pips-work-new-user", { had_pips: false, folders: [], personal: [], do_it_all: [] }, false]]) {
      const x = await openOnePips(browser, { ...look, height: 760, scale: 2 });
      await x.send({ type: "pipsWelcome", auto, welcome });
      await x.page.waitForSelector("#pips-welcome:not([hidden])"); await x.page.waitForTimeout(350);
      await x.page.screenshot({ path: `${out}/${name}-${tag}.png` }); console.log(`${name}-${tag}`);
      await x.close?.(); await x.page.context().close().catch(() => {});
    }
    const x = await openOnePips(browser, { ...look, height: 760, scale: 2 });
    await x.click("#pips-settings-open"); await x.waitIn("#pips-how"); await x.page.waitForTimeout(350);
    await x.page.screenshot({ path: `${out}/1-pips-settings-line-${tag}.png` }); console.log(`1-pips-settings-line-${tag}`);
    await x.page.context().close().catch(() => {});
  }
  const gst = one("1", "GST watchdog"), erp = seven("2", "ERP daily audit", 3);
  if (want("2")) {
    await chatShot(await openWork({ ...look, reports: [gst, erp], fixes: [fixOf(erp, APPLIED)], note: true }), `2-session-note-${tag}`);
    await chatShot(await openWork({ ...look, reports: [gst], note: true }), `2-session-note-one-pip-${tag}`);
    await chatShot(await openWork({ ...look, reports: [gst, erp, failed(), clear(), one("5", "Stock sync, every hour on the hour")], note: true }), `2-session-note-five-pips-${tag}`);
  }
  if (want("3")) {
    for (const api of [96, 95]) {
      const reports = [one("1", GST), seven("2", ERP, 3), failed(), clear()];
      // Each card on its own (cards that arrive together fold into one line): a line of the chat between them.
      const open = async (opened) => {
        const page = await openAgentLines(browser, { ...look, height: 1700, deviceScaleFactor: 2 });
        await page.route(`${FACES}/**`, (route) => { const file = new URL(route.request().url()).pathname.split("/").pop();
          return route.fulfill({ status: 200, contentType: file.endsWith(".png") ? "image/png" : "image/webp", body: readFileSync(new URL(`../media/pips/${file}`, import.meta.url)) }); });
        await page.evaluate(([faces, clock]) => { (0, eval)(faces); (0, eval)(clock); }, [PLUSH, read("../media/msgtime.js")]);
        await sendEvents(page, [ready(api), ...turn("t1", "Tidy the October invoices", "Done: 14 invoices renumbered."), ...reports.flatMap((report) => [{ type: "pip_report", report }, { type: "info", message: "A line of the chat" }]),
          { type: "pip_report", report: one("7", "Billing review") }, { type: "pip_fix", fix: fixOf(one("7", "Billing review"), APPLIED) }]);
        await settle(page);
        if (opened) { for (const n of await page.locator("#log .pip-report:not(.is-fix-row) .pip-report-line1").all()) await n.click({ position: { x: 30, y: 6 } }); await settle(page); }
        await page.evaluate(() => Promise.all([...document.querySelectorAll("#log .pip-report-face image")].map((i) => i.decode?.().catch(() => {}))));
        await page.mouse.move(2, 2); await settle(page);
        return page;
      };
      await chatShot(await open(false), `3-cards-api${api}-${tag}`);
      await chatShot(await open(true), `3-cards-opened-api${api}-${tag}`);
    }
  }
}
await browser.close();
