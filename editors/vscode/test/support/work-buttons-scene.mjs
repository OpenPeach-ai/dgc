// Work's chat with one of each thing that carries a button: a command to allow, a question with options, a plan to
// approve, the listing cards (monitors, artifacts), a Pip's report with its fix done, a tool row with its links. For
// buttons-work.test.mjs and its pictures. Not a *.test.mjs file.
import { openAgentLines, sendEvents, settle, sid } from "./agent-lines-scene.mjs";

const now = () => Date.now() / 1000, RUN = "run_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), FIX = "fix_" + "c".repeat(32);
export const READY = { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { agents: true, agent_control: true, history_snapshot: true, pip_reports: 1, pip_fix: 1, open_asks: true, ask_options: true },
  model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" };
const REPORT = { run_id: RUN, pip_id: PIP, name: "Billing review", pip_type: "rook", kind: "audit", outcome: "findings", finished_at: new Date(Date.now() - 5 * 60000).toISOString(), earlier: 0, total: 2, counts: { high: 1, medium: 1 },
  findings: [{ title: "A discount is accepted but never subtracted", severity: "high", path: "billing/totals.py", line: 88 }, { title: "Rounding drops cents on credit notes", severity: "medium", path: "billing/notes.py", line: 17 }] };
const REPORT_2 = { ...REPORT, run_id: "run_" + "d".repeat(32), pip_id: "pip_" + "e".repeat(32), name: "Docs check", findings: [{ title: "The README names a flag that is gone", severity: "medium", path: "README.md", line: 40 }], total: 1, counts: { medium: 1 } };
/** Which parts to draw: "cards" (the listing cards and a Pip's report, one with its fix done), "asks" (a command, a question, a plan). */
export const EVENTS = {
  cards: [READY,
    { type: "monitors", request_id: "monitors-list-1-1", wake_paused: false, pending_events: 0, items: [{ id: "mon1", description: "ticker", command: "./tick.sh 4", state: "running", events: 75 }] },
    { type: "artifacts", items: [{ id: "a1", name: "preview", url: "http://127.0.0.1:5173/" }] },
    { type: "pip_report", report: REPORT_2 }, { type: "info", message: "between" }, { type: "pip_report", report: REPORT },
    { type: "pip_fix", fix: { fix_id: FIX, run_id: RUN, pip_id: PIP, name: "Billing review", pip_type: "rook", agent_id: sid(7), created_at: now() - 90, state: "applied", started_at: now() - 72, ended_at: now(),
      files: [{ path: "billing/totals.py", kind: "edited", additions: 4, deletions: 1 }], tests: { state: "passed", command: "pytest -q" }, undo: { state: "available" } } }],
  asks: [READY, { type: "turn_start", turn_id: "t1", prompt: "Set it up and deploy" },
    { type: "permission_request", id: "p1", call_id: "c1", name: "bash", args: { command: "npm ci --no-audit" }, command: "npm ci --no-audit", suggested_rule: "Bash(npm ci *)", choices: [] },
    { type: "plan_proposal", id: "plan1", plan: "1. Change the totals\n2. Run the tests", choices: [] },
    { type: "ask_request", ask_id: "a1", question: "Where should this run?", options: [{ label: "Local", description: "on this machine", recommended: true }, { label: "Cloud", description: "on a rented box" }] }],
};
export async function openWork(browser, { part = "cards", width = 460, height = 900, theme = "dark-modern", forcedColors = false, reducedMotion = false, deviceScaleFactor = 1 } = {}) {
  const page = await openAgentLines(browser, { width, height, theme, events: EVENTS[part], forcedColors, reducedMotion, deviceScaleFactor });
  await settle(page);
  return page;
}
export { sendEvents, settle };
