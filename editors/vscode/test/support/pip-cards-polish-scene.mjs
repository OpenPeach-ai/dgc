// The Pip report cards of a Work chat as he saw them in a real project (13 Nov: "the Pips cards that come in work
// sessions needs UI polish"): two Pips, each posting a card with findings and Ask DGC to fix. What
// pip-report-polish-browser.test.mjs measures and `node test/render-pip-cards.mjs <folder>` pictures. Not a *.test.mjs file.
import { readFileSync } from "node:fs";
import { openAgentLines, sendEvents, settle, sid } from "./agent-lines-scene.mjs";

const pip = (c) => "pip_" + c.repeat(32), run = (c) => "run_" + c.repeat(32);
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const base = (c, name, type = "lens") => ({ pip_id: pip(c), name, pip_type: type, kind: "audit", earlier: 0 });
export const ERP = "ERP daily audit — data & Tally integrity", GST = "GST watchdog — e-invoice & e-way";
const SEVEN = [
  { title: "Tally voucher totals differ from the ERP ledger for 14 invoices in October", severity: "critical", path: "erp/integrations/tally/voucher_sync.py", line: 212 },
  { title: "Stock goes negative when two dispatches post in the same second", severity: "high", path: "erp/stock/dispatch.py", line: 88 },
  { title: "Credit notes are rounded before tax, so the GST on them is a paisa short", severity: "high", path: "erp/billing/credit_notes.py", line: 41 },
  { title: "Customer opening balances are imported twice after a failed sync", severity: "medium", path: "erp/integrations/tally/ledgers.py", line: 130 },
  { title: "The nightly backup check passes when the dump file is empty", severity: "medium", path: "ops/backup_check.sh", line: 17 },
  { title: "A deleted item still shows in the price list export", severity: "medium", path: "erp/catalogue/export.py", line: 59 },
  { title: "Two reports use the server's time zone instead of the company's", severity: "low", path: "erp/reports/daybook.py", line: 23 },
];
/** One finding: the smallest card with something to fix. */
export const one = (c = "1", name = GST) => ({ ...base(c, name, "scout"), run_id: run(c), outcome: "findings", finished_at: ago(12), total: 1, counts: { high: 1 },
  findings: [{ title: "E-way bills are raised for consignments under the ₹50,000 limit", severity: "high", path: "erp/gst/eway.py", line: 64 }] });
/** Seven findings. `carried`: how many of them the card is given (the backend sends the first three today). */
export const seven = (c = "2", name = ERP, carried = 7) => ({ ...base(c, name), run_id: run(c), outcome: "findings", finished_at: ago(9), total: 7,
  counts: { critical: 1, high: 2, medium: 3, low: 1 }, findings: SEVEN.slice(0, carried) });
export const failed = (c = "3") => ({ ...base(c, "Bank feed check", "pulse"), run_id: run(c), outcome: "failed", finished_at: ago(8),
  reason: "The project is too big for it to copy for review.", detail: "snapshot_limit: 2.4 GB of 2 GB" });
export const clear = (c = "4") => ({ ...base(c, "Docs links", "quill"), run_id: run(c), outcome: "clear", finished_at: ago(7), total: 0, counts: {}, findings: [] });
/** A clean run after one that found something: "fixed · nothing found". */
export const broke = (c = "5") => ({ ...base(c, "Stock sync", "rook"), run_id: run(c), outcome: "findings", finished_at: ago(40), total: 1, counts: { high: 1 },
  findings: [{ title: "Stock went negative", severity: "high", path: "erp/stock/sync.py", line: 4 }] });
export const mended = (c = "5") => ({ ...base(c, "Stock sync", "rook"), run_id: run("6"), outcome: "clear", finished_at: ago(5), total: 0, counts: {}, findings: [] });
export const ready = (fix = true) => ({ type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { agents: true, agent_control: true, history_snapshot: true, pip_reports: 1, ...(fix ? { pip_fix: 1 } : {}) },
  model: "qwen3.8:27b", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
const report = (r) => ({ type: "pip_report", report: r });
const line = (message) => ({ type: "info", message });
const turn = (id, prompt, answer) => [{ type: "turn_start", turn_id: id, prompt, kind: "prompt" }, { type: "text_delta", text: answer }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];
const now = () => Date.now() / 1000;
export const FIXER = sid(7);
export const fixOf = (r, fields) => ({ fix_id: "fix_" + r.run_id.slice(4), run_id: r.run_id, pip_id: r.pip_id, name: r.name, pip_type: r.pip_type, agent_id: FIXER, created_at: now() - 90, ...fields });
export const APPLIED = { state: "applied", started_at: now() - 84, ended_at: now() - 4, summary: "E-way bills are raised only from ₹50,000.",
  files: [{ path: "erp/gst/eway.py", kind: "edited", additions: 3, deletions: 1 }, { path: "tests/test_eway.py", kind: "added", additions: 14, deletions: 0 }], tests: { state: "passed", command: "pytest -q erp/gst" }, undo: { state: "available" } };

export const WHERE = ["Fixed in your files · not committed", "Already fixed in your files"];
/** The sheets that are pictured, each a chat's events and what to click once they are drawn. */
export const SHEETS = {
  // Each card on its own (a line of the chat between them): one finding, seven, a failure, a clean run, a fixed one.
  cards: { events: () => [ready(), ...turn("t1", "Tidy the October invoices", "Done: 14 invoices renumbered."), report(one()), line("A line of the chat"), report(seven()), line("A line of the chat"),
    report(failed()), line("A line of the chat"), report(clear()), line("A line of the chat"), report(broke()), report(mended())] },
  // The same, each opened.
  opened: { events: () => SHEETS.cards.events(), open: "all" },
  // As he had them: two Pips' cards one after the other.
  two: { events: () => [ready(), ...turn("t1", "Tidy the October invoices", "Done: 14 invoices renumbered."), report(seven("2", ERP, 3)), report({ ...one("1"), total: 4, counts: { high: 1, medium: 3 } })] },
  "two-opened": { events: () => SHEETS.two.events(), open: "group" },
  "two-opened-card": { events: () => SHEETS.two.events(), open: "group+first" },
  // Answered: asked in the chat (a DGC without background fixes), and a background fix that changed two files.
  asked: { events: () => [ready(false), report(seven("2", ERP, 3)), line("A line of the chat"), report(one())], open: "ask" },
  fixed: { events: () => [ready(), report(one()), { type: "pip_fix", fix: fixOf(one(), APPLIED) }, line("A line of the chat"), report(broke()), report(mended())] },
  // The words a fix's line will say once DGC tells it where a fix went (13 Nov, from a real project: "Fixed · 4 files
  // changed" was applied and never committed, and the Pip reported the same findings the next day). The states are not
  // sent yet, so the two lines are written into a finished fix's row: what is held is that they fit.
  "fixed-where": { events: () => [ready(), report(one()), { type: "pip_fix", fix: fixOf(one(), APPLIED) }, line("A line of the chat"),
    report(seven("2", ERP, 3)), { type: "pip_fix", fix: fixOf(seven("2", ERP, 3), { ...APPLIED, agent_id: sid(8), files: [], undo: { state: "none" }, state: "unchanged" }) }], words: WHERE },
};

// The Pips' faces are the shipped ones (media/pips/plush.js and its two pictures), there before the first card is drawn,
// as in the panel. The script is told where it was loaded from, a made-up origin this page serves its pictures from.
const FACES = "https://pip-faces.test";
const MSGTIME = readFileSync(new URL("../../media/msgtime.js", import.meta.url), "utf8");
const PLUSH = readFileSync(new URL("../../media/pips/plush.js", import.meta.url), "utf8")
  .replace("globalThis.document?.currentScript?.src", JSON.stringify(`${FACES}/media/pips/plush.js`));
/** Work's page with a sheet drawn and opened as it says. */
export async function openSheet(browser, name, { width, theme, forcedColors = false, deviceScaleFactor = 1, height = 1600 }) {
  const sheet = SHEETS[name];
  const page = await openAgentLines(browser, { width, height, theme, forcedColors, deviceScaleFactor });
  await page.route(`${FACES}/**`, (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    if (!["plush-bodies.webp", "plush-body-mask.png"].includes(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: file.endsWith(".png") ? "image/png" : "image/webp", body: readFileSync(new URL(`../../media/pips/${file}`, import.meta.url)) });
  });
  // (and the real clock, media/msgtime.js, as the panel loads it: a card's first line carries its time)
  await page.evaluate(([faces, clock]) => { (0, eval)(faces); (0, eval)(clock); }, [PLUSH, MSGTIME]);
  await sendEvents(page, sheet.events()); await settle(page);
  const click = async (selector) => { for (const n of await page.locator(selector).all()) await n.click({ position: { x: 30, y: 6 } }); await settle(page); };
  if (sheet.open === "all") await click("#log .pip-report .pip-report-line1");
  if (sheet.open?.startsWith("group")) await click("#log .pip-report-group-head");
  if (sheet.open === "group+first") await page.locator("#log .pip-report .pip-report-line1").first().click({ position: { x: 30, y: 6 } });
  if (sheet.open === "ask") await page.locator("#log .pip-report .pip-report-fix-slim").first().click();
  if (sheet.words) await page.evaluate((words) => { [...document.querySelectorAll("#log .pip-fix-text")].forEach((n, i) => { if (words[i]) n.textContent = words[i]; }); }, sheet.words);
  await page.mouse.move(2, 2); await settle(page);
  await page.evaluate(() => Promise.all([...document.querySelectorAll("#log .pip-report-face image")].map((i) => i.decode?.().catch(() => {}))));
  return page;
}
