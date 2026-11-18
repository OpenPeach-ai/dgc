// Work's real page in Chromium with a plan: a turn running, its plan card in the transcript, the Tasks pill on the bar
// above the box, and the step DGC is running now. Shared by agent-todos-layout.test.mjs (assertions) and
// agent-todos-pictures.mjs. setContent only; no port is opened. Not a *.test.mjs file.
import { openRailScene } from "./rail-scene.mjs";

export const PLAN = [
  { content: "Read the settings store", status: "done" },
  { content: "Write the v2 to v3 migration", status: "in_progress" },
  { content: "Tests for both directions", status: "pending" },
  { content: "Update the changelog", status: "pending" },
  { content: "Publish to the marketplace", status: "pending" },
];

// `kinds`: what else shows on the bar beside the plan (rail-scene's kinds). `running`: a step running now (its words go
// under the step in progress). `blocked`: one step blocked.
export async function openTodosScene(browser, { width = 440, height = 760, theme = "dark-modern", kinds = [], reducedMotion = false,
  scale = 1, plan = PLAN, running = true } = {}) {
  const x = await openRailScene(browser, { width, height, theme, kinds, reducedMotion, scale });
  let n = 0;
  // One plan update as the backend sends it: the call, the list it took, the call's result.
  const update = async (todos) => {
    const id = `td${++n}`;
    await x.send({ type: "tool_call", call_id: id, name: "todo", args: { todos }, summary: "" });
    await x.send({ type: "todos", todos });
    await x.send({ type: "tool_result", call_id: id, name: "todo", output: "todo list updated", is_error: false, is_diff: false });
  };
  await update(plan);
  if (running) {
    await x.send({ type: "tool_call", call_id: "r1", name: "read_file", args: { path: "src/settings/store.ts" }, summary: "src/settings/store.ts" });
  }
  await x.page.waitForTimeout(150);
  const openPill = async () => {
    await x.page.click('#rail-chips .rail-chip[data-kind="tasks"]');
    await x.page.waitForTimeout(450);
  };
  return { ...x, update, openPill };
}
