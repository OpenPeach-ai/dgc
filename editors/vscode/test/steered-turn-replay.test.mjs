// A turn the user steered while it ran must come back from a reload the way it was drawn live: one
// finished turn, with each steering message as its own bubble where the model read it. A restored
// chat used to close the steered turn at the interjection ("Stopped", no answer of its own), open a
// second turn for the interjection, and fold every steering message into one bubble.
// The REAL panel, the REAL `dgc serve` of this checkout and media/main.js in Chromium
// (test/support/panel-live.mjs). DGC_REQUIRE_CHROMIUM=1 turns a missing browser or Python into a failure.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { answer, launch, modelServer, panelSession, sleep, toolCalls, until } from "./support/panel-live.mjs";

let env, model;
before(async () => {
  env = await launch();
  // One command that runs for a few seconds (time to steer), then an answer naming what it read.
  model = await modelServer(({ messages, lastUser }) => {
    if (!messages.some((m) => m.role === "tool")) return toolCalls([["call_sleep", "bash", { command: "sleep 3; echo slept" }]]);
    return answer(`Handled: ${lastUser.includes("keep the public API") ? "both messages" : "the prompt"}`);
  });
});
after(async () => {
  model?.close();
  await env?.browser?.close();
});

// Every DGC turn block, and what it holds in order.
const turns = (page) => page.evaluate(() => [...document.querySelectorAll("#log .msg.dgc")].map((block) => ({
  status: (block.querySelector(".thinking")?.textContent || "").trim().replace(/ for \d+s$/, ""),
  parts: [...block.children].filter((node) => !node.matches(".role, .thinking")).map((node) => node.matches(".msg.user")
    ? `${node.querySelector(".role")?.textContent}: ${node.querySelector(".bubble")?.textContent}`
    : node.matches(".tool-group") ? "tools" : node.matches(".answer") ? `answer: ${node.textContent.trim()}` : node.className),
})));

test("a steered turn replays as the one finished turn it was live, one bubble per steering message", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await panelSession({ ...env, model, name: "steer" });
  try {
    await s.openWebview();
    await s.ready();
    await s.typePrompt("Refactor the parser");
    await until(() => s.events.some((e) => e.type === "tool_call"), "the command to start");
    await s.typePrompt("also update the docs");                  // Enter steers the running turn
    await until(() => s.events.filter((e) => e.type === "prompt_accepted" && e.state === "steered").length === 1, "the first steer");
    await s.typePrompt("and keep the public API");
    await until(() => s.events.filter((e) => e.type === "prompt_accepted" && e.state === "steered").length === 2, "the second steer");
    const ended = await until(() => s.events.find((e) => e.type === "turn_end"), "the turn to end", 30_000);
    assert.equal(ended.reason, "completed");
    await sleep(300);
    const live = await turns(s.page);
    assert.deepEqual(live, [{ status: "Worked", parts: ["tools", "you · steering: also update the docs",
      "you · steering: and keep the public API", "answer: Handled: both messages"] }], JSON.stringify(live));

    await s.reloadWebview();
    await s.ready();
    const replayed = await until(async () => {
      const now = await turns(s.page);
      return now.length && now.at(-1).parts.some((part) => part.startsWith("answer")) ? now : null;
    }, "the replayed turn", 10_000).catch(async () => turns(s.page));
    assert.deepEqual(replayed, live, "the reload draws the turn the live one drew");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
