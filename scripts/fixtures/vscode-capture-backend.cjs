#!/usr/bin/env node
"use strict";

/*
 * Deterministic protocol-v5 backend used only to record the real DGC extension surface.
 * It does not impersonate a model: it drives a deterministic, reviewable protocol fixture. The edit
 * and test below are executed against the disposable workspace, and their exact outputs are
 * emitted to the extension.  Public site copy must preserve that distinction.
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const workspace = process.cwd();
const statusPath = process.env.DGC_CAPTURE_STATUS || "";
const target = path.join(workspace, "clamp.py");
let seq = 0;
let turnActive = false;
let planOpen = false;
let currentMode = "plan";
let timers = [];

const send = (event) => process.stdout.write(JSON.stringify({ seq: seq++, ...event }) + "\n");
const later = (delay, callback) => {
  const timer = setTimeout(() => {
    timers = timers.filter((item) => item !== timer);
    callback();
  }, delay);
  timers.push(timer);
};
const writeStatus = (value) => {
  if (!statusPath) return;
  const temporary = statusPath + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n");
  fs.renameSync(temporary, statusPath);
};
const goal = (status = "active") => ({
  text: "Ship a verified bounds fix",
  status,
  elapsed_seconds: status === "active" ? 97 : 109,
});
const sendConfig = (requestId) => send({
  type: "config",
  ...(requestId ? { request_id: requestId } : {}),
  model: "deterministic protocol fixture",
  mode: "plan",
  think: "off",
  base_url: "fixture://deterministic",
  project_root: workspace,
  goal: goal(),
  context_size: 32768,
  show_reasoning: true,
  preserve_thinking: false,
  code_action: false,
  suggest: false,
  subscription_engine: "",
  subscription_model: "",
  subscription_effort: "",
  subscription_engines: [],
});

send({
  type: "ready",
  version: "capture-fixture",
  protocol_version: 5,
  capabilities: { correlated_state_requests: true },
  model: "deterministic protocol fixture",
  mode: "plan",
  think: "off",
  base_url: "fixture://deterministic",
  project_root: workspace,
  workspace_trusted: true,
  commands: [],
  custom_commands: [],
  goal: goal(),
  context_size: 32768,
});

function beginTrace(command) {
  if (turnActive) return;
  turnActive = true;
  const prompt = String(command.text || "");
  send({ type: "turn_start", turn_id: "capture-turn", prompt });
  later(350, () => send({ type: "text_delta", text: "I’ll inspect the failing helper and its tests, then propose the smallest safe change." }));
  later(850, () => send({ type: "stream_end" }));
  later(1150, () => send({
    type: "tool_call", call_id: "read-clamp", name: "read_file",
    args: { path: "clamp.py" }, summary: "clamp.py",
  }));
  later(1950, () => send({
    type: "tool_result", call_id: "read-clamp", name: "read_file",
    output: fs.readFileSync(target, "utf8"), is_error: false, is_diff: false,
  }));
  later(2400, () => send({
    type: "text_delta",
    text: "The implementation applies the bounds in reverse. I can correct that one expression and verify all three cases.",
  }));
  later(3000, () => send({ type: "stream_end" }));
  later(3500, () => {
    planOpen = true;
    send({
      type: "plan_proposal", id: "capture-plan",
      plan: "1. Correct the reversed clamp expression in `clamp.py`.\n2. Run `python3 -m unittest -v`.\n3. Report the exact verified result.",
      choices: ["auto", "acceptEdits", "default", "reject"],
    });
  });
}

function applyApprovedTrace() {
  const oldText = fs.readFileSync(target, "utf8");
  const bad = "    return min(lower, max(upper, value))\n";
  const good = "    return max(lower, min(upper, value))\n";
  if (!oldText.includes(bad)) {
    send({ type: "error", message: "capture project no longer matches the deterministic fixture" });
    send({ type: "turn_end", turn_id: "capture-turn", reason: "error", token_estimate: 0 });
    writeStatus({ state: "failed", reason: "fixture mismatch" });
    turnActive = false;
    return;
  }
  const newText = oldText.replace(bad, good);
  const diff = [
    "--- a/clamp.py",
    "+++ b/clamp.py",
    "@@ -1,3 +1,3 @@",
    " def clamp(value, lower, upper):",
    "     \"\"\"Keep value inside the inclusive lower/upper bounds.\"\"\"",
    "-    return min(lower, max(upper, value))",
    "+    return max(lower, min(upper, value))",
  ].join("\n");

  send({ type: "mode_changed", mode: "acceptEdits", workspace_trusted: true });
  later(300, () => send({ type: "text_delta", text: "Plan approved. Applying the focused edit now." }));
  later(750, () => send({ type: "stream_end" }));
  later(1050, () => send({
    type: "tool_call", call_id: "edit-clamp", name: "edit_file",
    args: { path: "clamp.py", old_string: bad.trim(), new_string: good.trim() },
    summary: "clamp.py",
  }));
  later(1800, () => {
    fs.writeFileSync(target, newText);
    send({
      type: "tool_result", call_id: "edit-clamp", name: "edit_file",
      output: "edited clamp.py", is_error: false, is_diff: true, diff,
    });
  });
  later(2250, () => send({ type: "text_delta", text: "The diff is limited to the reversed expression. Running the regression suite." }));
  later(2750, () => send({ type: "stream_end" }));
  later(3050, () => send({
    type: "tool_call", call_id: "test-clamp", name: "bash",
    args: { command: "python3 -m unittest -v" }, summary: "python3 -m unittest -v",
  }));
  later(4150, () => {
    const result = spawnSync("python3", ["-m", "unittest", "-v"], {
      cwd: workspace,
      encoding: "utf8",
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeout: 15000,
    });
    const output = String(result.stdout || "") + String(result.stderr || "");
    const passed = result.status === 0 && /Ran 3 tests/.test(output) && /\bOK\b/.test(output);
    send({
      type: "tool_result", call_id: "test-clamp", name: "bash",
      output: output.slice(0, 4000), is_error: !passed, is_diff: false,
    });
    if (!passed) {
      send({ type: "turn_end", turn_id: "capture-turn", reason: "error", token_estimate: 0 });
      writeStatus({ state: "failed", reason: "tests failed", output: output.slice(-2000) });
      turnActive = false;
      return;
    }
    later(500, () => send({
      type: "text_delta",
      text: "Implemented the one-line bounds fix in `clamp.py`.\n\nVerification: `python3 -m unittest -v` passed all 3 tests.",
    }));
    later(1150, () => {
      send({ type: "stream_end" });
      send({ type: "goal_changed", goal: goal("completed").text, status: "completed", elapsed_seconds: 109 });
      send({ type: "turn_end", turn_id: "capture-turn", reason: "completed", token_estimate: 84 });
      writeStatus({ state: "passed", tests: 3, changed_file: "clamp.py" });
      turnActive = false;
    });
  });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let command;
  try { command = JSON.parse(line); }
  catch { return; }
  if (command.type === "set_workspace_roots") {
    send({
      type: "workspace_roots", roots: command.roots,
      ...(command.request_id ? { request_id: command.request_id } : {}),
    });
  } else if (command.type === "get_config") {
    sendConfig(command.request_id);
  } else if (command.type === "status") {
    send({
      type: "status", request_id: command.request_id,
      model: "deterministic protocol fixture", mode: currentMode, think: "off",
      base_url: "fixture://deterministic", context_used: 0, context_size: 32768,
      goal: goal(),
    });
  } else if (command.type === "get_goal") {
    send({ type: "goal_changed", request_id: command.request_id, goal: goal().text,
      status: "active", elapsed_seconds: 97 });
  } else if (command.type === "prompt") {
    beginTrace(command);
  } else if (command.type === "plan_response" && command.id === "capture-plan" && planOpen) {
    planOpen = false;
    if (command.decision === "acceptEdits") {
      currentMode = "acceptEdits";
      applyApprovedTrace();
    }
    else {
      send({ type: "turn_end", turn_id: "capture-turn", reason: "cancelled", token_estimate: 0 });
      writeStatus({ state: "failed", reason: "plan was not approved with acceptEdits" });
      turnActive = false;
    }
  } else if (command.type === "cancel" || command.type === "interrupt") {
    timers.forEach(clearTimeout);
    timers = [];
    send({ type: "turn_end", turn_id: "capture-turn", reason: "cancelled", token_estimate: 0 });
    writeStatus({ state: "failed", reason: "capture cancelled" });
    turnActive = false;
  } else if (command.type === "shutdown") {
    process.exit(0);
  }
});
