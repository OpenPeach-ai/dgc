// User test W8, his call of 15 Nov: "Always allow" on an edit means edits in this project, said in plain words on the
// Allow card (a line of the card, and the button's own name: the button stays the family's box), the rule it made
// shown in words where rules are listed, removable in Settings. In real Chromium on the
// real pages (media/main.js, src/settingsClient.js), and the host's side with the real src/panel.ts.
// "Edits in this project" is four of DGC's rules, one per edit tool, over the project's folder (media/shared/rulewords.js).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openAllowCard, openRules, ROOT } from "./support/uir2b-scene.mjs";
import { openSettings } from "./support/settings-scene.mjs";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });

const FOUR = ["Write", "Edit", "MultiEdit", "ApplyPatch"].map((tool) => `${tool}(${ROOT}/*)`);
const answers = (x) => x.page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response"));

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`W8: the Allow card on an edit says, in a line of plain words, that Always allow means edits in this project (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openAllowCard(browser, { theme, width });
    try {
      const c = await x.card(), always = c.buttons.find((b) => b.d === "always");
      assert.ok(c.says, "the card says what Always allow covers");
      assert.equal(c.says.text, "Always allow means edits in this project: DGC stops asking before it edits a file here.");
      assert.ok(c.says.box.left >= c.box.left && c.says.box.right <= c.box.right && c.says.box.bottom <= c.box.bottom && c.says.box.height >= 14, `the line is whole, inside the card (${JSON.stringify(c.says.box)})`);
      assert.equal(c.alwaysName, "Always allow edits in this project", "and the button's own name says it");
      assert.match(c.alwaysTitle, /^Always allow edits in this project: .*Settings → Security/);
      // The answers are the button family's own boxes (one design language): never a button as wide as a sentence.
      assert.deepEqual(c.buttons.map((b) => [b.text, b.box.width, b.box.height, b.radius, b.cut]), [["Always allow", 104, 28, "6px", false], ["Deny", 104, 28, "6px", false], ["Allow once", 104, 28, "6px", false]]);
      for (const b of c.buttons) assert.ok(b.box.left >= c.box.left && b.box.right <= c.box.right && b.box.bottom <= c.box.bottom, `${b.text} is inside its card (${JSON.stringify(b.box)})`);
      for (const [i, a] of c.buttons.entries()) for (const b of c.buttons.slice(i + 1)) {
        assert.ok(a.box.right <= b.box.left || b.box.right <= a.box.left || a.box.bottom <= b.box.top || b.box.bottom <= a.box.top, `${a.text} and ${b.text} don't overlap`);
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("W8: Always allow on an edit answers with the project's rule, and its receipt and the rule's line are in words", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openAllowCard(browser, { tool: "edit_file" });
  try {
    await x.page.click('.card[data-request-id="req-1"] button[data-d="always"]');
    const [sent] = await answers(x);
    assert.equal(sent.decision, "always");
    assert.equal(sent.rule, `Edit(${ROOT}/*)`, "the rule for the tool that asked, over the whole project");
    assert.deepEqual([...sent.projectRules].sort(), FOUR.filter((r) => !r.startsWith("Edit(")).sort(), "and the other edit tools' rules for the host to add");
    assert.equal((await x.card()).decision, "Always allowed · edits in this project");
    await x.event({ type: "rule_added", rule: sent.rule });
    assert.ok((await x.card()).lines.includes("Rule added: always allow edits in this project"), "the line a new rule leaves is in words");
    assert.equal(JSON.stringify(await x.page.evaluate(() => document.getElementById("log").textContent)).includes("Edit(/home"), false, "the session never shows the rule as written");
  } finally { await x.page.close(); }
});

test("W8: a reopened session's settled card says the rule in words too", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openAllowCard(browser);
  try {
    // As DGC replays a settled decision (its own label, with the rule as written).
    await x.event({ type: "permission_decision", call_id: "c9", name: "write_file", args: { path: "billing/tax.py" }, decision: "always", message: `Always allowed · Write(${ROOT}/*)` });
    await x.event({ type: "permission_decision", call_id: "c10", name: "bash", args: { command: "npm test" }, decision: "once", message: "Allowed once" });
    const said = await x.page.evaluate(() => [...document.querySelectorAll('.card[data-history-approval="true"] .decision, .permission-receipt')].map((n) => n.textContent.trim()).join(" | "));
    assert.match(said, /Always allowed · edits in this project/); assert.match(said, /Allowed once/);
    assert.doesNotMatch(said, /Write\(/, "never the rule as written");
  } finally { await x.page.close(); }
});

test("W8: Allow once and Deny are as before; a command, a file outside the project, and a DGC that names no project keep their own rule", async (t) => {
  if (skipOrFail(t)) return;
  const once = await openAllowCard(browser);
  try { await once.page.click('.card[data-request-id="req-1"] button[data-d="once"]'); const [sent] = await answers(once);
    assert.equal(sent.decision, "once"); assert.equal(sent.rule, undefined); assert.equal(sent.projectRules, undefined); } finally { await once.page.close(); }
  for (const [opts, rule, receipt] of [[{ tool: "bash" }, "Bash(npm test)", "Always allowed · the command npm test"],
    [{ path: "/tmp/notes/totals.py" }, "Write(/tmp/notes/totals.py)", "Always allowed · edits to totals.py"],
    [{ root: "" }, `Write(${ROOT}/billing/totals.py)`, "Always allowed · edits to totals.py"]]) {
    const x = await openAllowCard(browser, opts);
    try {
      const open = await x.card();
      assert.equal(open.buttons[0].text, "Always allow", JSON.stringify(opts)); assert.equal(open.says, null, `no project to speak of: no line (${JSON.stringify(opts)})`); assert.equal(open.alwaysName, "");
      await x.page.click('.card[data-request-id="req-1"] button[data-d="always"]');
      const [sent] = await answers(x);
      assert.equal(sent.rule, rule); assert.equal(sent.projectRules, undefined);
      assert.equal((await x.card()).decision, receipt);
    } finally { await x.page.close(); }
  }
});

test("W8: the rules list shows each rule in words; a project's four edit rules are one row, and its Remove takes all four", async (t) => {
  if (skipOrFail(t)) return;
  const items = [...FOUR.map((rule) => ({ action: "allow", rule })), { action: "allow", rule: "Bash(npm test:*)" }, { action: "deny", rule: "Bash(rm -rf:*)" }, { action: "allow", rule: "Write(/home/me/projects/garden/*)" }];
  const x = await openRules(browser, items);
  try {
    assert.deepEqual(await x.rows(), [
      { badge: "allow", words: "Always allow edits in this project", where: ROOT, raw: "", remove: "Remove rule: Always allow edits in this project" },
      { badge: "allow", words: "Always allow commands that start with npm test", where: "", raw: "Bash(npm test:*)", remove: "Remove rule: Always allow commands that start with npm test" },
      { badge: "deny", words: "Never allow commands that start with rm -rf", where: "", raw: "Bash(rm -rf:*)", remove: "Remove rule: Never allow commands that start with rm -rf" },
      { badge: "allow", words: "Always allow edits in garden", where: "/home/me/projects/garden", raw: "", remove: "Remove rule: Always allow edits in garden" }]);
    await x.page.click("#surface .rule-row [data-rule-remove]");
    assert.deepEqual((await x.posted("permissionRemove")).map((m) => [m.action, m.rule]), FOUR.map((rule) => ["allow", rule]));
  } finally { await x.page.close(); }
});

for (const theme of ["dark", "light"]) for (const width of [300, 440, 700]) {
  test(`W8: Settings → Security lists what is always allowed, in words, each with Remove (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openSettings(browser, { section: "security", theme, width, height: 900 });
    try {
      await x.page.waitForSelector("#security-rules");
      assert.ok((await x.page.evaluate(() => window.__posted.map((m) => m.type))).includes("permissionsList"), "the page asks DGC for its rules");
      await x.page.evaluate(([four]) => window.postMessage({ type: "event", event: { type: "permissions", project_root: "/home/me/projects/lime_tiles",
        items: [...four.map((rule) => ({ action: "allow", rule })), { action: "allow", rule: "Bash(npm test:*)" }, { action: "deny", rule: "Bash(rm -rf:*)" }] } }, "*"), [FOUR]);
      await x.page.waitForSelector("#security-rules [data-rule-remove]");
      const f = await x.page.evaluate(() => { const group = document.getElementById("security-rules"), box = (n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
        return { title: group.querySelector("h3").textContent, rows: [...group.querySelectorAll(".rule-line")].map((r) => ({ words: r.querySelector(".name").textContent, detail: r.querySelector(".rule-detail")?.textContent || "",
          remove: r.querySelector("button").textContent, label: r.querySelector("button").getAttribute("aria-label"), button: box(r.querySelector("button")), row: box(r), radius: getComputedStyle(r.querySelector("button")).borderTopLeftRadius })),
          sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
      assert.equal(f.title, "Always allowed");
      // (Only what is always allowed: a deny is not something Always allow made.)
      assert.deepEqual(f.rows.map((r) => [r.words, r.detail, r.remove, r.label]), [["Always allow edits in this project", ROOT, "Remove", "Remove: Always allow edits in this project"],
        ["Always allow commands that start with npm test", "Bash(npm test:*)", "Remove", "Remove: Always allow commands that start with npm test"]]);
      for (const r of f.rows) { assert.ok(r.button.right <= r.row.right + 1 && r.button.left >= r.row.left, "Remove is inside its row"); assert.notEqual(r.radius, "999px"); }
      assert.ok(f.sideways <= 0, "the page doesn't scroll sideways");
      await x.page.click("#security-rules [data-rule-remove]");
      const removed = (await x.page.evaluate(() => window.__posted.filter((m) => m.type === "permissionsRemove"))).at(-1);
      assert.deepEqual([removed.action, removed.rules], ["allow", FOUR]);
    } finally { await x.page.close(); }
  });
}

test("W8 host: Always allow edits in this project adds the other edit tools' rules beside the card's answer, and only for this project", async () => {
  const send = async (message, project_root = ROOT) => { const { provider, backend } = makeProvider(); provider.lastReadyEvent = { ...provider.lastReadyEvent, project_root };
    await provider.onMessage({ type: "permission_response", id: "req-1", ...message }); return backend.sent; };
  const [first, ...rest] = FOUR;
  const sent = await send({ decision: "always", rule: first, projectRules: rest });
  assert.deepEqual(sent.filter((c) => c.type === "permission_response").map((c) => [c.decision, c.rule]), [["always", first]]);
  assert.deepEqual(sent.filter((c) => c.type === "add_permission_rule").map((c) => [c.action, c.rule]), rest.map((rule) => ["allow", rule]));
  const added = (sentNow) => sentNow.filter((c) => c.type === "add_permission_rule").map((c) => c.rule);
  assert.deepEqual(added(await send({ decision: "once", rule: first, projectRules: rest })), [], "Allow once adds nothing");
  assert.deepEqual(added(await send({ decision: "always", rule: first, projectRules: rest }, "/home/me/projects/garden")), [], "another project's folder adds nothing");
  assert.deepEqual(added(await send({ decision: "always", rule: first, projectRules: ["Bash(*)", "Write(/etc/*)", `Read(${ROOT}/*)`, first] })), [], "nor a rule that isn't an edit tool's over the same folder");
  assert.deepEqual(added(await send({ decision: "always", rule: "Bash(npm test)", projectRules: rest })), [], "nor beside an answer that isn't the project's edit rule");
});

test("W8 host: the other sessions open on the project hear a new rule, and every open session hears a rule removed", async () => {
  const a = makeProvider(), b = makeProvider(), elsewhere = makeProvider();
  for (const x of [a, b]) x.provider.lastReadyEvent = { ...x.provider.lastReadyEvent, project_root: ROOT };
  elsewhere.provider.lastReadyEvent = { ...elsewhere.provider.lastReadyEvent, project_root: "/home/me/projects/garden" };
  a.provider.tabProviders.add(b.provider); a.provider.tabProviders.add(elsewhere.provider);
  const [first, ...rest] = FOUR;
  await a.provider.onMessage({ type: "permission_response", id: "req-1", decision: "always", rule: first, projectRules: rest });
  assert.deepEqual(b.backend.sent.filter((c) => c.type === "add_permission_rule").map((c) => c.rule), FOUR, "the same project's other session is given all four");
  assert.deepEqual(elsewhere.backend.sent.filter((c) => c.type === "add_permission_rule"), [], "a session on another project is given none");
  await a.provider.onSettingsMessage({ type: "permissionsRemove", action: "allow", rules: FOUR });
  for (const x of [a, b, elsewhere]) assert.deepEqual(x.backend.sent.filter((c) => c.type === "remove_permission_rule").map((c) => c.rule), FOUR, "every open session is told the rule is gone");
});

test("W8 host: Settings asks DGC for its rules and removes the ones a row stands for", async () => {
  const { provider, backend } = makeProvider();
  await provider.onSettingsMessage({ type: "permissionsList" });
  assert.equal(backend.sent.filter((c) => c.type === "list_permissions").length, 1);
  await provider.onSettingsMessage({ type: "permissionsRemove", action: "allow", rules: FOUR });
  assert.deepEqual(backend.sent.filter((c) => c.type === "remove_permission_rule").map((c) => [c.action, c.rule]), FOUR.map((rule) => ["allow", rule]));
  await provider.onSettingsMessage({ type: "permissionsRemove", action: "everything", rules: FOUR });
  assert.equal(backend.sent.filter((c) => c.type === "remove_permission_rule").length, 4, "an action DGC doesn't have removes nothing");
});
