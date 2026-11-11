// What the fix's helper row is drawn from in pip-fix-row-browser.test.mjs and its pictures: Work's page with a helper of
// the chat's own at work (a real helper row to compare with) and a Pip's report; then the events of a fix that starts,
// works and ends. Not a *.test.mjs file.
import { sid } from "./agent-lines-scene.mjs";

const RUN = "run_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), FIX = "fix_" + "c".repeat(32), FIXER = sid(7), HELPER = sid(1);
export const REPORT = { run_id: RUN, pip_id: PIP, name: "Billing review", pip_type: "rook", kind: "audit", outcome: "findings", finished_at: new Date(Date.now() - 5 * 60000).toISOString(), earlier: 0,
  total: 2, counts: { high: 1, medium: 1 }, findings: [{ title: "A discount is accepted but never subtracted", severity: "high", path: "billing/totals.py", line: 88 },
    { title: "Rounding drops cents on credit notes", severity: "medium", path: "billing/notes.py", line: 17 }] };
const now = () => Date.now() / 1000;
export const fix = (fields) => ({ fix_id: FIX, run_id: RUN, pip_id: PIP, name: "Billing review", pip_type: "rook", agent_id: FIXER, created_at: now() - 30, ...fields });
export const READY = { type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { agents: true, agent_control: true, history_snapshot: true, pip_reports: 1, pip_fix: 1 }, model: "qwen3.8:27b", mode: "auto", think: "off",
  base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" };
/** A helper of the chat's own at work (its row is what the fix's row is compared with), then a Pip's report. */
export const SCENE = [READY, { type: "agent_started", id: HELPER, parent_id: null, call_id: null, description: "Check the GST rounding", depth: 1, state: "running", started_at: now() - 12, isolated: false, parallel: false, background: true },
  { type: "pip_report", report: REPORT }];
export const FIXING = [{ type: "pip_fix", fix: fix({ state: "queued" }) },
  { type: "agent_started", id: FIXER, parent_id: null, call_id: null, description: "Fix what Billing review found", depth: 1, state: "running", started_at: now() - 5, isolated: true, parallel: false, background: true },
  { type: "pip_fix", fix: fix({ state: "running", started_at: now() - 5 }) },
  { type: "tool_call", call_id: `${FIXER}:c1`, name: "bash", args: { command: "pytest -q billing" }, summary: "pytest -q billing" }];
export const FIXED = [{ type: "agent_finished", id: FIXER, state: "finished" }, { type: "pip_fix", fix: fix({ state: "applied", started_at: now() - 72, ended_at: now(), summary: "The discount is subtracted before tax, and credit notes round half up.",
  files: [{ path: "billing/totals.py", kind: "edited", additions: 4, deletions: 1 }, { path: "billing/notes.py", kind: "edited", additions: 2, deletions: 2 }, { path: "tests/test_totals.py", kind: "added", additions: 18, deletions: 0 }],
  tests: { state: "passed", command: "pytest -q billing" }, undo: { state: "available" } }) }];
