// One kind of Pip on screen (0.52): in real Chromium, on the stand-in DGC of test/support/one-pips-scene.mjs, a Pip with
// a folder has what a Pip without one has, wherever DGC already allows it: Reply on a message; /learn and /goal in the
// "/" menu; the context meter; its page's Links, Media and Files; "Apps it can use" and its skills' switches; its
// computers (how many, Add another, Rename, the menu under the header's icon, which computer a new conversation uses);
// a model change that applies at once; its chosen character; its saved logins; its working notes and daily log. And
// what DGC does not allow it yet is not asked for (its app links, its plugins, its keys, how it sees).
// Words: a row and a page say where a Pip works ("Personal", or its folder), never what kind it is.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, MORNINGS, openOnePips } from "./support/one-pips-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const hex = (c) => c.repeat(32);
const now = new Date().toISOString();
const SAID = "msg_" + hex("2");
const CHAT = { [GST]: { messages: [{ id: "msg_" + hex("1"), role: "user", text: "How did tonight's check go?", run_id: "run_" + hex("8"), status: "succeeded" },
  { id: SAID, role: "assistant", text: "All green tonight. Nothing new in the GST code.", run_id: "run_" + hex("8"), status: "succeeded" }] } };
const WHOLE = { fix: "none", posts: false, waiting: false, attention: false, computers: 2, convs: true, context: 2048, chat: CHAT,
  models: [{ id: "m", name: "m" }, { id: "qwen3-coder:480b", name: "qwen3-coder:480b" }],
  shared: { links: [{ from: "pip", at: now, message_id: SAID, url: "https://example.com/gst-rules", host: "example.com" }], media: [], files: [] },
  apps: [{ id: "gmail", name: "Gmail", kind: "app", on: true, accounts: ["me@example.com"] },
         { id: "github", name: "GitHub", kind: "plugin", on: false, accounts: [] }],
  skills: [{ name: "tidy-notes", description: "Tidy a page of notes", source: "yours", on: true }],
  logins: [{ id: "login_" + hex("1"), site: "portal.example.com", hosts: ["portal.example.com"], username: "me", has_code: false, pips: "all", source: "page", created_at: now, last_used_at: null, usable: true }] };
const open = async (scene = {}, more = {}) => { const x = await openOnePips(browser, { width: 700, api: 97, ...more, scene: { ...WHOLE, ...scene } }); return x; };
const toPage = async (x) => { await x.inPips((root) => [...root.querySelectorAll(".pip-topbar .pip-menu [data-tab]")].find((b) => b.dataset.tab === "job").click()); await x.waitIn(".pip-page"); await x.page.waitForTimeout(300); };
const type = async (x, words) => { await x.inPips((root) => root.querySelector("#chatText").focus()); await x.page.keyboard.type(words); await x.page.waitForTimeout(200); };
const asked = async (x, kind) => (await x.requests(kind)).filter((r) => r.pip_id === GST);
const settled = (x) => x.page.waitForTimeout(350);

test("a Pip with a folder: Reply on its message quotes it, and the quote goes with what is sent", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST); await x.waitIn(".conversation-log .message, .conversation-log [data-message-id]");
    await x.waitIn('[data-chat-action="reply"]', 4000).catch(() => {});
    assert.equal(await x.inPips((root) => root.querySelectorAll('[data-chat-action="reply"]').length), 1, "Reply is on the Pip's message");
    await x.click('[data-chat-action="reply"]'); await x.waitIn(".chat-reply-text");
    assert.match(await x.inPips((root) => root.querySelector(".chat-reply-text").textContent), /All green tonight/);
    await type(x, "and the round-off?"); await x.page.keyboard.press("Enter"); await settled(x);
    const sent = (await asked(x, "send_pip_message")).at(-1);
    assert.equal(sent?.text, "and the round-off?"); assert.equal(sent.reply_to, SAID, "the quote goes with the message");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("a Pip with a folder: the \"/\" menu lists /learn and /goal, and /learn drafts a skill", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST);
    await type(x, "/");
    await x.waitIn("#chat-pop [role=option]", 4000).catch(() => {});
    const rows = await x.inPips((root) => [...root.querySelectorAll("#chat-pop [role=option]")].map((r) => r.textContent));
    assert.ok(rows.some((r) => /^\/?learn/.test(r)), `/learn is listed (${rows.join(" | ")})`);
    assert.ok(rows.some((r) => /^\/?goal/.test(r)), "/goal is listed");
    assert.ok(!rows.some((r) => /^\/?setup/.test(r)), "/setup is not: DGC's side of it is a Pip without a folder's still");
    await x.page.keyboard.press("Escape"); await x.page.keyboard.type("learn how I like the evening report"); await x.page.keyboard.press("Enter"); await settled(x);
    const learn = (await x.requests("learn_skill")).at(-1);
    assert.equal(learn?.pip_id, GST); assert.equal(learn.request, "how I like the evening report");
    assert.equal((await asked(x, "send_pip_message")).length, 0, "/learn is never a message to the Pip");
  } finally { await x.close(); }
  // A Pip without a folder keeps its three.
  const y = await open();
  try {
    await y.openPip(MORNINGS); await type(y, "/"); await y.waitIn("#chat-pop [role=option]");
    const rows = await y.inPips((root) => [...root.querySelectorAll("#chat-pop [role=option]")].map((r) => r.textContent));
    for (const name of ["setup", "learn", "goal"]) assert.ok(rows.some((r) => r.replace(/^\//, "").startsWith(name)), `/${name} for a Pip with no folder`);
  } finally { await y.close(); }
});

test("a Pip with a folder: its context meter shows how full its window is", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST);
    await x.waitIn(".composer-ctx-pct", 4000).catch(() => {});
    assert.equal(await x.inPips((root) => root.querySelector(".composer-ctx-pct")?.textContent), "25%");
    assert.equal((await asked(x, "get_pip_chat_context")).at(-1).context_size, 8192);
  } finally { await x.close(); }
});

test("a Pip with a folder: its page's Links, Media and Files load", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST); await toPage(x);
    for (const [tab, has] of [["links", /example\.com/], ["media", /./], ["files", /gst-report\.csv/]]) {
      await x.click(`[data-pip-page-tab="${tab}"]`); await x.page.waitForTimeout(400);
      const body = await x.inPips((root) => root.querySelector(".pip-page-body").textContent.trim());
      assert.doesNotMatch(body, /^Loading/, `${tab} is not left loading`); assert.match(body, has);
      assert.equal((await asked(x, "list_pip_shared")).at(-1)?.kind, tab);
    }
  } finally { await x.close(); }
});

test("a Pip with a folder: \"Apps it can use\" and its skills, each with its switch; what DGC keeps closed is not asked for", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST); await toPage(x);
    await x.waitIn('[data-pip-app-switch="gmail"]', 4000).catch(() => {});
    assert.equal(await x.inPips((root) => root.querySelector('[data-pip-app-switch="gmail"]')?.checked), true);
    assert.equal(await x.inPips((root) => root.querySelector('[data-pip-skill-switch="tidy-notes"]')?.checked), true);
    await x.click('[data-pip-app-switch="gmail"]'); await settled(x);
    assert.deepEqual((await asked(x, "set_pip_app")).map((r) => [r.app, r.on]), [["gmail", false]]);
    await x.click('[data-pip-skill-switch="tidy-notes"]'); await settled(x);
    assert.deepEqual((await asked(x, "set_pip_skill")).map((r) => [r.skill, r.on]), [["tidy-notes", false]]);
    // Kept as they are until DGC opens them for every Pip: its app links, plugins, keys, how it sees, borrowing Chrome.
    for (const kind of ["list_pip_app_links", "list_pip_plugins", "list_pip_keys", "get_pip_eyes", "list_pip_borrows", "add_pip_app_account"])
      assert.equal((await asked(x, kind)).length, 0, `${kind} is not asked for a Pip with a folder`);
    assert.equal(await x.inPips((root) => root.querySelectorAll("[data-pip-app-add]").length), 0, "no \"another address\": connecting an app is not open to it yet");
    // Plugins aren't open to a Pip with a folder yet (the backend refuses one): no switch that does nothing.
    assert.equal(await x.inPips((root) => !!root.querySelector('[data-pip-app-switch="github"]')), false, "no plugin switch");
    // A folder only groups the Personal list: a Pip that works in a folder has no "Folder: No folder" beside "Works in".
    assert.equal(await x.inPips((root) => !!root.querySelector("#pip-folder-btn")), false, "no Personal-list folder for it");
    assert.equal(await x.inPips((root) => root.querySelector(".pip-page .error, .pip-page [role=alert]")?.textContent || ""), "", "nothing on its page failed");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // With no app at all, it is not told to ask for one in its chat: DGC does not connect an app for it yet.
  const y = await open({ apps: [] });
  try {
    await y.openPip(GST); await toPage(y); await y.waitIn('[aria-label="Apps it can use"] .pip-page-empty');
    assert.equal(await y.inPips((root) => root.querySelector('[aria-label="Apps it can use"] .pip-page-empty').textContent), "None yet.",
      "not told to turn on a plugin it can't use yet");
  } finally { await y.close(); }
});

test("a Pip with a folder: its computers on its page (how many, Add another, Rename), and its saved logins", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST); await toPage(x);
    await x.waitIn("[data-computers]", 4000).catch(() => {});
    assert.equal(await x.inPips((root) => root.querySelector("[data-computers]")?.dataset.computers), "2");
    assert.equal(await x.inPips((root) => root.querySelectorAll("[data-computer-name-rename]").length), 2, "each computer has Rename");
    assert.equal(await x.inPips((root) => root.querySelectorAll('[aria-label="Computer"] #remove-computer, [aria-label="Computer"] #give-computer').length), 0, "its computer came with its folder: never removed here");
    assert.ok(await x.inPips((root) => !!root.querySelector('[aria-label="Computer"] [data-flow-watch]')), "Open stays");
    await x.click("#add-computer"); await settled(x);
    assert.equal((await asked(x, "add_pip_computer")).length, 1);
    assert.equal(await x.inPips((root) => root.querySelector("[data-computers]")?.dataset.computers), "3");
    // Its logins: the site, and whose it is.
    assert.match(await x.inPips((root) => root.querySelector('[aria-label="Logins"]')?.textContent || ""), /portal\.example\.com/);
    // Working notes and the daily log, as every Pip has them.
    assert.ok(await x.inPips((root) => !!root.querySelector('[aria-label="Working notes"]') && !!root.querySelector('[aria-label="Daily log"]')));
  } finally { await x.close(); }
});

test("a Pip with a folder: the header's computer icon opens its one computer, or asks which of several", async (t) => {
  if (skipOrFail(t)) return;
  let x = await open();
  try {
    await x.openPip(GST); await x.page.waitForTimeout(400);
    assert.equal(await x.inPips((root) => root.querySelector("#pip-computer-open").getAttribute("aria-haspopup")), "menu", "with two, it is a menu's button");
    await x.click("#pip-computer-open"); await x.waitIn("#computer-menu", 4000).catch(() => {});
    assert.equal(await x.inPips((root) => root.querySelectorAll("#computer-menu [data-computer]").length), 2, "each computer by name");
    await x.inPips((root) => root.querySelector('#computer-menu [data-computer="2"]').click()); await settled(x);
    assert.deepEqual((await x.posted("pipsOpenComputer")).map((m) => [m.pip.id, m.number]), [[GST, 2]]);
  } finally { await x.close(); }
  x = await open({ computers: 1 });
  try {
    await x.openPip(GST); await x.page.waitForTimeout(400);
    await x.click("#pip-computer-open"); await settled(x);
    assert.deepEqual((await x.posted("pipsOpenComputer")).map((m) => m.pip.id), [GST], "one computer: the icon opens it");
  } finally { await x.close(); }
});

test("a Pip with a folder: a new conversation asks which computer its work uses", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST); await x.page.waitForTimeout(400);
    await x.waitIn("#pip-convs"); await x.click("#pip-convs"); await x.waitIn("#conv-menu [data-conv-new]"); await x.click("#conv-menu [data-conv-new]");
    await x.waitIn("input[name=convComputer]", 4000).catch(() => {});
    assert.equal(await x.inPips((root) => root.querySelectorAll("#conv-menu input[name=convComputer]").length), 2, "use one it has, or add another");
  } finally { await x.close(); }
});

test("a Pip with a folder: a model chosen in its box applies at once, as any Pip's", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    await x.openPip(GST); await x.page.waitForTimeout(300);
    await x.click("#chat-model"); await x.waitIn("#chat-model-summary, .composer-model-menu"); 
    if (await x.inPips((root) => !root.querySelector("[data-chat-model]"))) { await x.click("#chat-model-summary"); await x.waitIn("[data-chat-model]"); }
    assert.equal(await x.inPips((root) => /confirm a new model/.test(root.querySelector(".composer-model-menu")?.textContent || "")), false, "no \"you'll confirm\" line");
    await x.inPips((root) => [...root.querySelectorAll("[data-chat-model]")].find((b) => b.dataset.chatModel.includes("qwen3-coder:480b")).click()); await x.page.waitForTimeout(500);
    assert.equal(await x.inPips((root) => !!root.querySelector("#review-root .dialog")), false, "no review card");
    assert.deepEqual((await asked(x, "propose_pip_update")).map((r) => r.changes), [{ model_choice: { mode: "model", model: "qwen3-coder:480b" } }]);
    assert.equal((await asked(x, "accept_pip_update")).length, 1, "accepted as it is chosen");
  } finally { await x.close(); }
});

test("a Pip with a folder wears the character chosen for it: in the list, its chat's header and its page", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ look: { [GST]: "quill" } });
  try {
    assert.equal(await x.inPips((root, id) => root.querySelector(`.pips-one-list [data-job="${id}"] .dgc-plush`).dataset.character, GST), "quill", "its row");
    await x.openPip(GST);
    assert.equal(await x.inPips((root) => root.querySelector(".pip-topbar .pip-pill .dgc-plush").dataset.character), "quill", "its chat's header");
    // Open in editor: its tab is asked for with its chosen character, so it opens wearing that face.
    await x.click("#pip-open-editor");
    assert.deepEqual((await x.posted("pipsOpenChat")).map((m) => [m.pip.id, m.pip.pip_type, m.pip.body]), [[GST, "rook", "quill"]]);
    await toPage(x);
    assert.equal(await x.inPips((root) => root.querySelector(".pip-page .dgc-plush").dataset.character), "quill", "its page");
  } finally { await x.close(); }
});

test("words: where a Pip works, never a kind of Pip", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const kinds = /\b(Personal|Project) Pips?\b/i;
    assert.doesNotMatch(await x.inPips((root) => root.querySelector(".pips-one").textContent), kinds, "the list");
    assert.equal(await x.inPips((root, id) => root.querySelector(`.pips-one-list [data-job="${id}"] .pip-row-place`).textContent.trim(), MORNINGS), "Personal");
    await x.click("#simple-new"); await x.waitIn("#review-root .dialog");
    const dialog = await x.inPips((root) => { const d = root.querySelector("#review-root .dialog"); return d.textContent + " " + [...d.querySelectorAll("[title]")].map((n) => n.title).join(" "); });
    assert.doesNotMatch(dialog, kinds, "New Pip says nothing of kinds"); assert.match(dialog, /No folder: it is listed under Personal\./, "with no folder, it says where it will be");
    await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(200);
    // In a Pip's chat, the @ list says where each other Pip works.
    await x.openPip(GST); await type(x, "@"); await x.waitIn("#chat-pop [role=option]"); await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(300);
    const row = await x.inPips((root) => [...root.querySelectorAll("#chat-pop [role=option]")].find((r) => r.textContent.includes("ERP daily audit"))?.textContent || "");
    assert.match(row, /lime_tiles · v3/, "its folder"); assert.doesNotMatch(row, /Project|Personal/);
    await x.page.keyboard.press("Escape"); await x.inPips((root) => { const b = root.querySelector("#chatText"); b.textContent = ""; b.dispatchEvent(new Event("input", { bubbles: true })); });
    await toPage(x);
    assert.doesNotMatch(await x.inPips((root) => root.querySelector(".pip-page").textContent), kinds, "its page");
    assert.match(await x.inPips((root) => root.querySelector(".pip-folder-where").textContent), /lime_tiles/, "its page says where it works");
  } finally { await x.close(); }
  // A Pip with no folder: its page says so in the same row.
  const y = await open();
  try {
    await y.openPip(MORNINGS); await toPage(y);
    assert.match(await y.inPips((root) => root.querySelector(".pip-folder-where")?.textContent || ""), /^Personal/, "\"Works in: Personal\"");
  } finally { await y.close(); }
});
