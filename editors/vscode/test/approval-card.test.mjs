// A permission card the user has answered says what they decided, and the "If you deny: a note for
// the model" box goes away with the buttons. It used to keep the box (disabled, still asking for a
// note) and say nothing about the decision, so a card answered "Allow once" read like one still open.
// media/main.js in Chromium with a scripted event stream (setContent only; no port is opened).
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure instead of a skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  if (browser) return false;
  const reason = chromium ? "Chromium could not start" : "playwright is not installed (npm ci at the repository root)";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

async function scene(theme, capabilities = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), event);
  await send({ type: "ready", version: "0.40.0", protocol_version: 14, capabilities, model: "m", mode: "default", think: "off",
    base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
  await send({ type: "turn_start", turn_id: "t1", prompt: "Run the tests" });
  for (const id of ["once", "deny", "always", "backend"]) {
    await send({ type: "permission_request", id: `req-${id}`, name: "bash", args: { command: `npm test -- ${id}` },
      command: `npm test -- ${id}`, summary: `npm test -- ${id}`, suggested_rule: "Bash(npm test:*)" });
  }
  const card = (id) => page.locator(`.card[data-request-id="req-${id}"]`);
  const facts = (id) => card(id).evaluate((node) => {
    const decision = node.querySelector(".decision");
    let opacity = 1;
    for (let el = decision; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
    const rgb = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    let ground = node;
    while (ground && rgb(getComputedStyle(ground).backgroundColor).length < 3
      || (ground && getComputedStyle(ground).backgroundColor === "rgba(0, 0, 0, 0)")) ground = ground.parentElement;
    const fg = decision ? lum(rgb(getComputedStyle(decision).color)) : 0, bg = lum(rgb(getComputedStyle(ground || document.body).backgroundColor));
    const feedback = node.querySelector(".feedback");
    return {
      decision: decision ? decision.textContent.trim() : "",
      decisionRole: decision?.getAttribute("role") || "",
      opacity, contrast: decision ? (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) : 0,
      feedbackShown: !!feedback && feedback.getClientRects().length > 0,
      buttonsShown: [...node.querySelectorAll("button")].filter((b) => b.getClientRects().length > 0).length,
    };
  });
  return { page, errors, send, card, facts };
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`an answered approval card shows the decision and drops the deny note (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await scene(theme);
    try {
      const open = await s.facts("once");
      assert.equal(open.feedbackShown, true, "an open card asks for the optional deny note");
      assert.equal(open.buttonsShown, 3);
      assert.equal(open.decision, "");

      await s.card("once").locator('button[data-d="once"]').click();
      await s.card("deny").locator(".feedback").fill("Use the fixture database instead");
      await s.card("deny").locator('button[data-d="deny"]').click();
      await s.card("always").locator('button[data-d="always"]').click();
      // Answered elsewhere (the backend resolved it): the card still says how.
      await s.send({ type: "permission_resolved", id: "req-backend", decision: "no", message: "Denied by a rule" });

      const posted = await s.page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response"));
      assert.deepEqual(posted.map((m) => [m.id, m.decision, m.reason ?? null]), [["req-once", "once", null],
        ["req-deny", "deny", "Use the fixture database instead"], ["req-always", "always", null]]);
      const expected = {
        once: "Allowed once",
        deny: "Denied · note for the model: Use the fixture database instead",
        always: "Always allowed · Bash(npm test:*)",
        backend: "Denied by a rule",
      };
      for (const [id, words] of Object.entries(expected)) {
        const f = await s.facts(id);
        assert.equal(f.decision, words, id);
        assert.equal(f.feedbackShown, false, `${id}: the deny-note box is gone`);
        assert.equal(f.buttonsShown, 0, id);
        assert.equal(f.opacity, 1, `${id}: the decision is not faded with the rest of the card`);
        assert.ok(f.contrast >= 4.5, `${id}: decision contrast ${f.contrast.toFixed(2)}`);
      }
      assert.deepEqual(s.errors, []);
    } finally {
      await s.page.close();
    }
  });

  // The plan review and the MCP cards settle the same way: they used to keep only their question
  // (and the plan card its disabled "Optional feedback" box), saying nothing about what was decided.
  test(`an answered plan or MCP card shows the decision too (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await scene(theme);
    try {
      const cards = [];
      for (const [id, d] of [["plan-approve", "acceptEdits"], ["plan-auto", "auto"], ["plan-keep", "reject"], ["plan-keep-bare", "reject"]]) {
        await s.send({ type: "plan_proposal", id: `req-${id}`, plan: "1. Change it\n2. Verify it",
          choices: ["auto", "acceptEdits", "default", "reject"] });
        cards.push([id, d]);
      }
      await s.card("plan-keep").locator(".feedback").fill("Cover the migration first");
      await s.card("plan-approve").locator(".feedback").fill("typed, then approved");
      for (const [id, d] of cards) await s.card(id).locator(`button[data-d="${d}"]`).click();
      await s.page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "planAutoDecision", id: "req-plan-auto", approved: true, mode: "auto",
      } })));
      await s.send({ type: "mcp_input_request", id: "req-sampling", server: "fixture", kind: "sampling_request", payload: { messages: [] } });
      await s.send({ type: "mcp_input_request", id: "req-url", server: "fixture", kind: "elicitation",
        payload: { mode: "url", message: "Sign in", url: "https://example.com/login", host: "example.com" } });
      await s.send({ type: "mcp_input_request", id: "req-form", server: "fixture", kind: "elicitation",
        payload: { message: "Your name", requestedSchema: { type: "object", properties: { name: { type: "string" } } } } });
      await s.send({ type: "mcp_input_request", id: "req-cancel", server: "fixture", kind: "sampling_response", payload: {} });
      await s.card("sampling").locator('button[data-a="accept"]').click();
      await s.card("url").locator('button[data-a="decline"]').click();
      await s.card("form").locator("input").fill("Ada");
      await s.card("form").locator('button[type="submit"]').click();
      await s.card("cancel").locator('button[data-a="cancel"]').click();

      const plans = await s.page.evaluate(() => window.__posted.filter((m) => m.type === "plan_response").map((m) => [m.id, m.decision]));
      assert.deepEqual(plans, cards.map(([id, d]) => [`req-${id}`, d]));
      const expected = {
        "plan-approve": "Approved · acceptEdits mode",
        "plan-auto": "Approved · auto mode",
        "plan-keep": "Kept planning · feedback: Cover the migration first",
        "plan-keep-bare": "Kept planning",
        sampling: "Approved once",
        url: "Declined",
        form: "Submitted",
        cancel: "Cancelled",
      };
      for (const [id, words] of Object.entries(expected)) {
        const f = await s.facts(id);
        assert.equal(f.decision, words, id);
        assert.equal(f.feedbackShown, false, `${id}: no feedback box is left on a settled card`);
        assert.equal(f.buttonsShown, 0, id);
        assert.equal(f.opacity, 1, `${id}: the decision is not faded with the rest of the card`);
        assert.ok(f.contrast >= 4.5, `${id}: decision contrast ${f.contrast.toFixed(2)}`);
      }
      assert.deepEqual(s.errors, []);
    } finally {
      await s.page.close();
    }
  });
}

// The user's own Chrome, signed in as them (dgc/browser_user.py): the card names the site and says what it means,
// instead of "Run browser" and the tool's arguments; Allow once is that call, Always saves that site and nothing else.
test("a signed-in Chrome card names the site and what it can do there", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene("dark-modern");
  try {
    await s.send({ type: "permission_request", id: "req-chrome", name: "browser",
      args: { operation: "open", url: "https://mail.google.com/mail/u/0/#inbox", signed_in: true },
      summary: "open https://mail.google.com/mail/u/0/#inbox", suggested_rule: "Browser(signed-in:https://mail.google.com)" });
    await s.send({ type: "permission_request", id: "req-evil", name: "browser",
      args: { operation: "open", url: "https://<b>x</b>.example/", signed_in: true }, suggested_rule: "Browser(signed-in:https://x.example)" });
    const card = s.card("chrome");
    assert.equal((await card.locator(".q").innerText()).trim(), "Use your signed-in Chrome on mail.google.com?");
    assert.match(await card.innerText(), /DGC wants to open mail\.google\.com in a window of its own in your Chrome, where you're signed in\. It can read and act on that site as you\./);
    assert.deepEqual(await card.locator("button").allInnerTexts(), ["Allow once", "Always allow mail.google.com", "Deny"]);
    assert.equal(await card.locator("pre").innerText(), "https://mail.google.com/mail/u/0/#inbox");
    assert.equal(await s.card("evil").locator("b b, .q b b").count(), 0, "a name is text, never markup");
    await card.locator('button[data-d="always"]').click();
    // The answer is posted after the click's handler runs: wait for it (under a loaded test run it lands a moment later).
    await s.page.waitForFunction(() => window.__posted.some((m) => m.type === "permission_response" && m.id === "req-chrome"),
      null, { timeout: 5000 });
    const posted = await s.page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response" && m.id === "req-chrome"));
    assert.deepEqual(posted.map((m) => [m.decision, m.rule]), [["always", "Browser(signed-in:https://mail.google.com)"]]);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.page.close();
  }
});

// A paid picture's card (generate_image), in plain words as ChatDGC's card is: what it makes, with which generator, how
// many at what size, the price and this month's spend, and the prompt as written; never "Run generate_image" and the
// tool's JSON. Edit asks again with a changed prompt (the model calls again, so its new card shows that prompt).
for (const theme of ["dark-modern", "light-modern"]) {
  test(`a paid picture's card says what it makes and what it costs, with Make it, Edit, Always allow and Don't (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await scene(theme);
    try {
      const args = { prompt: "A small round sticker of a smiling tomato, flat colours", generator: "fal.ai FLUX Schnell", provider: "fal.ai",
        model: "fal-ai/flux/schnell", size: "512x512", count: 1, price: "about $0.003", this_month: "$0.003 so far" };
      await s.send({ type: "permission_request", id: "req-img", call_id: "g1", name: "generate_image", args,
        summary: "fal.ai FLUX Schnell · 1 × 512x512 · about $0.003", suggested_rule: "GenerateImage", choices: ["once", "always", "deny"] });
      const card = s.card("img");
      assert.equal((await card.locator(".q").innerText()).trim(), "Make this image with fal.ai FLUX Schnell?");
      assert.equal((await card.locator(".perm-facts").innerText()).trim(), "1 × 512×512 · about $0.003 · this month $0.003 so far");
      assert.equal((await card.locator(".perm-prompt").innerText()).trim(), args.prompt);
      const text = await card.innerText();
      assert.doesNotMatch(text, /Run generate_image|\{|"provider"|If you deny/);
      assert.deepEqual(await card.locator(".btns button").allInnerTexts(), ["Make it · about $0.003", "Edit", "Always allow", "Don't"]);
      if (process.env.DGC_SHOTS) await card.screenshot({ path: `${process.env.DGC_SHOTS}/image-card-${theme}.png` });
      await card.locator("[data-edit-prompt]").click();
      await card.locator(".perm-edit textarea").fill("A small round sticker of a smiling lemon");
      await card.locator("[data-edited]").click();
      const posted = await s.page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response" && m.id === "req-img"));
      assert.deepEqual(posted.map((m) => m.decision), ["deny"]);
      assert.equal(posted[0].reason, "Changed the prompt to: A small round sticker of a smiling lemon — make it with this prompt instead (same generator, size and count).");
      assert.match(await card.innerText(), /Asked again with your prompt/);
      // Two pictures with a monthly limit: the total price on the button, the note the backend gave.
      await s.send({ type: "permission_request", id: "req-two", call_id: "g2", name: "generate_image",
        args: { ...args, count: 2, price: "about $0.006 (about $0.003 each)", this_month: "$4.99 of your $5.00 limit", note: "This would pass this month's limit." },
        suggested_rule: "GenerateImage", choices: ["once", "always", "deny"] });
      const two = s.card("two");
      assert.equal((await two.locator(".q").innerText()).trim(), "Make these 2 images with fal.ai FLUX Schnell?");
      assert.equal(await two.locator(".btns button").first().innerText(), "Make it · about $0.006");
      assert.match(await two.locator(".perm-note").innerText(), /pass this month's limit/);
      await two.locator('button[data-d="always"]').click();
      const always = await s.page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response" && m.id === "req-two"));
      assert.deepEqual(always.map((m) => m.decision), ["always"]);
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

// Seen in testing: a helpers batch's card read "Run task 3 helpers · … {"tasks":[…]}" and a plugin's tool's card
// "Run mcp__example__get-time {}". Both are in plain words now, as a paid picture's card is: who does what (and where,
// when the model said), each helper's brief one click away; a plugin's tool and the plugin by name, its inputs as a
// short list or "No inputs", the inputs as sent one click away. The note for the model stays.
for (const theme of ["dark-modern", "light-modern"]) {
  test(`a helpers batch and a plugin's tool ask in plain words, never raw names or JSON (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await scene(theme);
    try {
      const tasks = [
        { description: "Describe plants.py", prompt: "Read plants.py and say in one line what it is for.", agent: "explorer", system: "Workstation", model: "glm-5.3:cloud" },
        { description: "Describe rota.py", prompt: "Read rota.py and say in one line what it is for.", size: "small" },
        { description: "Describe notes.md", prompt: "Read notes.md and say in one line what it is for.", effort: "low" }];
      await s.send({ type: "permission_request", id: "req-batch", call_id: "t1", name: "task", args: { tasks },
        summary: "3 helpers · Describe plants.py, Describe rota.py, Describe notes.md", suggested_rule: "Task", choices: ["once", "always", "deny"] });
      const batch = s.card("batch");
      assert.equal((await batch.locator(".q").innerText()).trim(), "Start 3 helpers?");
      assert.deepEqual((await batch.locator(".perm-helpers > li > b").allInnerTexts()), ["Describe plants.py", "Describe rota.py", "Describe notes.md"]);
      const words = await batch.innerText();
      assert.match(words, /explorer agent · on Workstation · glm-5\.3:cloud/);
      assert.match(words, /a small model/);
      assert.match(words, /thinking low/);
      assert.doesNotMatch(words, /Run task|\{|"tasks"|\[/);
      assert.equal(await batch.locator(".perm-brief p").first().isVisible(), false, "each brief is one click away");
      await batch.locator(".perm-brief summary").first().click();
      assert.equal((await batch.locator(".perm-brief p").first().innerText()).trim(), tasks[0].prompt);
      assert.deepEqual(await batch.locator(".btns button").allInnerTexts(), ["Start them", "Always allow", "Deny"]);
      assert.equal(await batch.locator(".deny-note").count(), 1, "a note for the model if you deny");
      if (process.env.DGC_SHOTS) await batch.screenshot({ path: `${process.env.DGC_SHOTS}/helpers-card-${theme}.png` });
      await s.send({ type: "permission_request", id: "req-one", call_id: "t2", name: "task",
        args: { description: "Map the auth module", prompt: "List every auth entry point.", background: true }, summary: "", suggested_rule: "Task" });
      const one = s.card("one");
      assert.equal((await one.locator(".q").innerText()).trim(), "Start a helper?");
      assert.match(await one.innerText(), /Map the auth module[\s\S]*In the background/);
      assert.equal(await one.locator(".btns button").first().innerText(), "Start it");

      await s.send({ type: "permission_request", id: "req-mcp", call_id: "m1", name: "mcp__example__get-time", args: {},
        summary: "", suggested_rule: "mcp__example__get-time", choices: ["once", "always", "deny"] });
      const mcp = s.card("mcp");
      assert.equal((await mcp.locator(".q").innerText()).trim(), "Use Get time from Example?");
      assert.equal((await mcp.locator(".perm-facts").innerText()).trim(), "No inputs.");
      assert.doesNotMatch(await mcp.innerText(), /mcp__|\{\}|Run /);
      await s.send({ type: "permission_request", id: "req-mcp2", call_id: "m2", name: "mcp__example__convert_time",
        args: { time: "16:30", source_timezone: "Europe/London", target_timezone: "Asia/Tokyo" }, summary: "", suggested_rule: "mcp__example__convert_time" });
      const two = s.card("mcp2");
      assert.equal((await two.locator(".q").innerText()).trim(), "Use Convert time from Example?");
      assert.deepEqual(await two.locator(".perm-inputs dt").allInnerTexts(), ["time", "source timezone", "target timezone"]);
      assert.deepEqual(await two.locator(".perm-inputs dd").allInnerTexts(), ["16:30", "Europe/London", "Asia/Tokyo"]);
      assert.equal(await two.locator(".perm-brief pre").isVisible(), false, "the inputs as sent are one click away");
      if (process.env.DGC_SHOTS) await two.screenshot({ path: `${process.env.DGC_SHOTS}/plugin-tool-card-${theme}.png` });
      await two.locator('button[data-d="once"]').click();
      assert.match(await two.innerText(), /Convert time · Example · Allowed once/);
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

// A plugin's tool's Allow card named the plugin by its server ("Use Get time from Example?") while its own card said "MCP
// Apps example": the editor had the plugins' names only once Settings had loaded the plugin list. DGC now sends them
// with the handshake (ready.capabilities.plugin_names), so both say the plugin's name, and so does the step's line.
test("a plugin's tool's Allow card names the plugin as its card does", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene("dark-modern", { plugin_names: { example: "MCP Apps example", "bad name": "x", notes: 7 } });
  try {
    await s.send({ type: "permission_request", id: "req-named", call_id: "n1", name: "mcp__example__get-time", args: {},
      summary: "", suggested_rule: "mcp__example__get-time", choices: ["once", "deny"] });
    const card = s.card("named");
    assert.equal((await card.locator(".q").innerText()).trim(), "Use Get time from MCP Apps example?");
    assert.deepEqual(await card.locator(".btns button").allInnerTexts(), ["Allow once", "Deny"]);
    await card.locator('button[data-d="once"]').click();
    assert.match(await card.innerText(), /Get time · MCP Apps example · Allowed once/);
    await s.send({ type: "permission_request", id: "req-other", call_id: "n2", name: "mcp__notes__save_note", args: {},
      summary: "", suggested_rule: "mcp__notes__save_note" });
    assert.equal((await s.card("other").locator(".q").innerText()).trim(), "Use Save note from Notes?",
      "a name that isn't text is left out: the server's own name, as before");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
