// Messages queued behind a running turn belong to the user until their own turn starts. A backend
// restarted from the editor, a window reload, and a webview reload each used to lose them: the panel
// cleared the transcript and nothing gave them back. The REAL panel (src/panel.ts), the REAL
// `dgc serve` of this checkout and media/main.js in Chromium, through test/support/panel-live.mjs.
//
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser or Python into a failure instead of a skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { answer, launch, modelServer, panelSession, sleep, toolCalls, transcript, until } from "./support/panel-live.mjs";

let env, model;
before(async () => {
  env = await launch();
  // SLOW: one command that takes a few seconds, so messages can be queued behind it; any other
  // prompt is answered at once, naming what it answers.
  model = await modelServer(({ messages, lastUser }) => {
    const tail = messages.slice(messages.findLastIndex((m) => m.role === "user"));
    if (/^SLOW/.test(lastUser) && !tail.some((m) => m.role === "tool")) {
      return toolCalls([["call_sleep", "bash", { command: "sleep 4; echo slept" }]]);
    }
    return answer(`Answered: ${lastUser.slice(0, 40)}`);
  });
});
after(async () => {
  model?.close();
  await env?.browser?.close();
});

async function queuedBehindARunningTurn(name) {
  const s = await panelSession({ ...env, model, name });
  await s.openWebview();
  await s.ready();
  await s.typePrompt("SLOW run the long command");
  await until(() => s.events.some((e) => e.type === "tool_call"), "the long command to start");
  await s.typePrompt("second message", { queue: true });
  await s.typePrompt("third message", { queue: true });
  await until(() => s.events.filter((e) => e.type === "prompt_accepted" && e.state === "queued").length === 2,
    "both messages to be queued");
  assert.deepEqual((await transcript(s.page)).slice(-2), ["you · queued: second message", "you · queued: third message"]);
  return s;
}

const notSent = (lines) => lines.filter((line) => line.startsWith("you · not sent"));
const settled = async (s) => {
  await s.ready();
  return until(async () => {
    const lines = await transcript(s.page);
    return notSent(lines).length === 2 ? lines : null;
  }, "the queued messages to come back as not sent", 20_000).catch(async () => transcript(s.page));
};

test("DGC: Restart Backend during a turn gives the queued messages back as not sent", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await queuedBehindARunningTurn("restart");
  try {
    s.provider.restart();
    const lines = await settled(s);
    assert.deepEqual(notSent(lines), ["you · not sent: second message [Restore unsent message]",
      "you · not sent: third message [Restore unsent message]"], lines.join("\n"));
    assert.equal(await s.page.locator("#input").inputValue(), "second message", "the first is back in the empty composer");
    assert.equal(await s.page.locator("#queued").textContent(), "");
    // The second one restores once the composer is free.
    await s.page.locator("#input").fill("");
    await s.page.locator(".msg.user", { hasText: "third message" }).locator("button", { hasText: "Restore unsent message" }).click();
    assert.equal(await s.page.locator("#input").inputValue(), "third message");
    await sleep(500);
    assert.equal(notSent(await transcript(s.page)).length, 2, "the reconnect's history leaves them in place");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test("Developer: Reload Window during a turn gives the queued messages back as not sent", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await queuedBehindARunningTurn("window");
  try {
    await s.reloadWindow();
    const lines = await settled(s);
    assert.deepEqual(notSent(lines), ["you · not sent: second message [Restore unsent message]",
      "you · not sent: third message [Restore unsent message]"], lines.join("\n"));
    assert.equal(await s.page.locator("#input").inputValue(), "second message");
    // They are handed back once: another reload of the window does not bring them back again.
    await s.page.locator("#input").fill("");
    await sleep(300);
    await s.reloadWindow();
    await s.ready();
    await sleep(1500);
    assert.deepEqual(notSent(await transcript(s.page)), []);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test("a backend that dies on its own gives the queued messages back once, under the reconnect's replay", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await queuedBehindARunningTurn("exit");
  try {
    const child = s.provider.backend.proc;
    process.kill(child.pid, "SIGKILL");
    await until(() => s.posted.some((m) => m.type === "backend_exit"), "the exit to reach the webview");
    await until(() => s.posted.some((m) => m.type === "session_ready") && s.provider.sessionReady
      && s.provider.backend?.proc !== child, "the reconnect", 30_000);
    const lines = await settled(s);
    await sleep(800);                                   // the extension's own give-back lands after session_ready
    const final = await transcript(s.page);
    assert.deepEqual(notSent(final), ["you · not sent: second message [Restore unsent message]",
      "you · not sent: third message [Restore unsent message]"], final.join("\n"));
    assert.ok(final.indexOf(notSent(final)[0]) > final.findIndex((line) => line.startsWith("DGC:")), "below the replayed turn");
    assert.equal(lines.filter((line) => /second message/.test(line)).length, 1);
    assert.equal(await s.page.locator("#input").inputValue(), "second message");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test("a webview reloaded with messages queued still shows them, and Stop gives them back as not sent", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await queuedBehindARunningTurn("webview-stop");
  try {
    await s.reloadWebview();
    await s.ready();
    const shown = await until(async () => {
      const lines = await transcript(s.page);
      return lines.filter((line) => line.startsWith("you · queued")).length === 2 ? lines : null;
    }, "the queued messages after the reload", 10_000).catch(async () => transcript(s.page));
    assert.deepEqual(shown.slice(-2), ["you · queued: second message", "you · queued: third message"], shown.join("\n"));
    await s.page.locator("#send").click();                      // Stop
    const lines = await until(async () => {
      const now = await transcript(s.page);
      return notSent(now).length === 2 ? now : null;
    }, "Stop to hand the queued messages back", 15_000).catch(async () => transcript(s.page));
    assert.deepEqual(notSent(lines), ["you · not sent: second message [Restore unsent message]",
      "you · not sent: third message [Restore unsent message]"], lines.join("\n"));
    assert.equal(await s.page.locator("#input").inputValue(), "second message");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});

test("a webview reloaded with messages queued lets them run in order, each prompt shown once", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await queuedBehindARunningTurn("webview-run");
  try {
    await s.reloadWebview();
    await s.ready();
    await until(() => s.events.filter((e) => e.type === "turn_end").length === 3, "all three turns", 30_000);
    const lines = await until(async () => {
      const now = await transcript(s.page);
      return now.filter((line) => /^DGC: Worked/.test(line)).length === 3 ? now : null;
    }, "three settled turns", 10_000).catch(async () => transcript(s.page));
    assert.deepEqual(lines.map((line) => line.replace(/Worked for \d+s/, "Worked")), [
      "you: SLOW run the long command", "DGC: Worked",
      "you: second message", "DGC: Worked",
      "you: third message", "DGC: Worked"], lines.join("\n"));
    assert.equal(await s.page.locator("#queued").textContent(), "");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
