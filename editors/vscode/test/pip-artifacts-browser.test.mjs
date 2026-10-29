// A Pip's reports and the dashboards it refreshes (Pips API 67), in real Chromium: a reviewing Pip's Settings tab has
// Reports (In its chat / Also as a document / Also as a spreadsheet, and Open once one is made) and "Dashboards it
// refreshes" (the person's own, Add, Open, Remove, at most 8); a Personal Pip's page has the dashboards only; an older
// CLI is never asked; and at 360px nothing runs off the edge, in either theme.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { DASH, DASHBOARDS, openPipSettings } from "./support/pip-artifacts-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const sets = (s) => s.posted("set_pip_artifacts").then((all) => all.map((m) => { const { type: _t, pip_id: _p, ...rest } = m.request; return rest; }));
const names = (s) => s.page.locator(".pip-dashboard .pip-dashboard-name").allTextContents();
const settled = (s) => s.page.waitForFunction(() => !document.querySelector(".pip-artifacts-section select:disabled, .pip-artifacts select:disabled"));

test("a reviewing Pip: where its reports go, said in one line, and Open once its document is made", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPipSettings(browser, { kind: "scout", dashboards: DASHBOARDS });
  try {
    await s.page.waitForSelector("#pipReportAs");
    assert.equal(await s.page.locator("#pipReportAs").inputValue(), "chat");
    assert.deepEqual(await s.page.locator("#pipReportAs option").allTextContents(), ["In its chat", "Also as a document", "Also as a spreadsheet"]);
    assert.equal(await s.page.locator("#pipReportSays").textContent(), "Each review’s findings come as a card in its chat.");
    assert.equal(await s.page.locator("[data-artifact-type=doc], [data-artifact-type=sheet]").count(), 0, "nothing to open yet");
    await s.page.selectOption("#pipReportAs", "doc");
    await settled(s);
    assert.deepEqual(await sets(s), [{ report_as: "doc" }]);
    assert.equal(await s.page.locator("#pipReportSays").textContent(),
      "The card still comes, and each review is also the newest version of its own document. It’s made after its next review.");
    assert.match(await s.page.locator(".notice").first().textContent(), /Each review from Scout is also kept as its own document\./);
    // Its first review made the document: Open opens it in the editor's artifact panel.
    await s.page.evaluate((id) => { window.__artifacts.report_doc = id; }, DASH("d"));
    await s.page.selectOption("#pipReportAs", "sheet");
    await settled(s);
    await s.page.selectOption("#pipReportAs", "doc");
    await settled(s);
    assert.equal(await s.page.locator("#pipReportSays").textContent(), "The card still comes, and each review is also the newest version of its own document.");
    await s.page.click('[data-artifact-type="doc"]');
    assert.deepEqual((await s.posted("pipsOpenArtifact")).map(({ id, artifactType }) => ({ id, artifactType })), [{ id: DASH("d"), artifactType: "doc" }]);
    // A runtime that says the document's title and version: which one it is and how many reviews it holds, not only Open.
    await s.page.evaluate(() => { Object.assign(window.__artifacts, { report_doc_title: "Scout: findings", report_doc_version: 3 }); });
    await s.page.selectOption("#pipReportAs", "sheet");
    await settled(s);
    await s.page.selectOption("#pipReportAs", "doc");
    await settled(s);
    assert.equal(await s.page.locator("#pipReportSays").textContent(),
      "The card still comes, and each review is also the newest version of its own document, “Scout: findings”, which holds 3 reviews.");
    assert.equal(await s.page.locator('[data-artifact-type="doc"]').getAttribute("aria-label"), "Open “Scout: findings”, Scout’s document, version 3");
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test("dashboards it refreshes: the person's own to add, each with Open and Remove, one gone shown as gone, at most 8", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPipSettings(browser, { kind: "pulse", name: "Pulse", dashboards: DASHBOARDS, artifacts: { dashboards: [DASH("e")] } });
  try {
    await s.page.waitForSelector("#pipDashboardsLabel");
    assert.equal(await s.page.locator("#pipReportAs").count(), 0, "a Pulse makes no review to keep: no Reports");
    assert.match(await s.page.locator(".pip-artifacts-section").textContent(), /Pulse refreshes these after every run it finishes, so they stay current\./);
    assert.deepEqual(await names(s), ["A dashboard that was removed"]);
    assert.equal(await s.page.locator(`[data-dashboard="${DASH("e")}"] [data-artifact-open]`).count(), 0, "nothing to open");
    assert.deepEqual(await s.page.locator("#pipDashboardAdd option").allTextContents(), ["Add a dashboard…", "Store sales", "Error budget this week", "Signups by country"]);
    // The backend refuses a list that names a dashboard that's gone: adding one leaves the gone one out, and says so.
    await s.page.selectOption("#pipDashboardAdd", DASH("a"));
    await settled(s);
    assert.deepEqual(await sets(s), [{ dashboards: [DASH("a")] }]);
    assert.equal(await s.page.locator(".pip-artifacts-section .error").count(), 0);
    assert.match(await s.page.locator(".notice").first().textContent(), /Pulse refreshes “Store sales” after every run it finishes\. It stopped refreshing one that’s gone\./);
    await s.page.selectOption("#pipDashboardAdd", DASH("b"));
    await settled(s);
    assert.deepEqual(await names(s), ["Store sales", "Error budget this week"]);
    assert.match(await s.page.locator(".notice").first().textContent(), /Pulse refreshes “Error budget this week” after every run it finishes\./);
    assert.equal(await s.page.locator(".pip-dashboard").first().locator("small").textContent(), "Dashboard · version 4");
    await s.page.click(`[data-dashboard="${DASH("a")}"] [data-artifact-open]`);
    assert.deepEqual((await s.posted("pipsOpenArtifact")).map(({ id, artifactType }) => ({ id, artifactType })), [{ id: DASH("a"), artifactType: "dashboard" }]);
    await s.page.click(`[data-dashboard-remove="${DASH("a")}"]`);
    await settled(s);
    assert.deepEqual(await names(s), ["Error budget this week"]);
    assert.match(await s.page.locator(".notice").first().textContent(), /Pulse no longer refreshes “Store sales”\./);
    // A refusal is said where it happened, in the section.
    await s.page.evaluate(() => { window.__dashboards = window.__dashboards.filter((d) => d.title !== "Signups by country"); });
    await s.page.selectOption("#pipDashboardAdd", DASH("c"));
    await settled(s);
    assert.match(await s.page.locator(".pip-artifacts-section .error").textContent(), /isn't a dashboard in your artifacts/);
    assert.equal(await s.page.locator('[aria-label="Stop refreshing Error budget this week"]').count(), 1, "each Remove says what it stops");
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test("no dashboards yet says how to make one; all of them chosen, or the most, says so; a failed list says why", async (t) => {
  if (skipOrFail(t)) return;
  const none = await openPipSettings(browser, { kind: "scout", dashboards: [] });
  try {
    await none.page.waitForSelector("#pipDashboardsLabel");
    assert.match(await none.page.locator(".pip-artifacts-section").last().textContent(), /You have no dashboards yet\. Ask for one in a chat: choose Output, then Dashboard\./);
    assert.equal(await none.page.locator("#pipDashboardAdd").count(), 0);
  } finally { await none.close(); }
  const eight = Array.from({ length: 9 }, (_, i) => ({ id: DASH(String(i)), title: `Board ${i}`, version: 1 }));
  const full = await openPipSettings(browser, { kind: "scout", dashboards: eight, artifacts: { dashboards: eight.slice(0, 8).map((d) => d.id) } });
  try {
    await full.page.waitForSelector(".pip-dashboard");
    assert.equal((await names(full)).length, 8);
    assert.match(await full.page.locator(".pip-artifacts-section").last().textContent(), /That’s the most a Pip refreshes: 8\. Remove one to add another\./);
    assert.equal(await full.page.locator("#pipDashboardAdd").count(), 0);
  } finally { await full.close(); }
  const failed = await openPipSettings(browser, { kind: "scout", dashboards: DASHBOARDS, artifacts: { dashboards: [DASH("a")] },
                                                  dashboardsFail: "This DGC keeps no dashboards yet. Run “DGC: Update CLI”, then reconnect." });
  try {
    await failed.page.waitForSelector(".pip-dashboard");
    assert.match(await failed.page.locator(".pip-artifacts-section").last().textContent(), /This DGC keeps no dashboards yet\. Run “DGC: Update CLI”, then reconnect\./);
    assert.deepEqual(await names(failed), ["Dashboard"], "what it refreshes still shows, and can be removed");
    assert.equal(await failed.page.locator("#pipDashboardAdd").count(), 0);
  } finally { await failed.close(); }
});

test("a Personal Pip's page: its dashboards in a group of rows, no Reports; an older CLI is never asked", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPipSettings(browser, { kind: "personal", dashboards: DASHBOARDS, artifacts: { dashboards: [DASH("c")] } });
  try {
    await s.page.waitForSelector(".pip-artifacts .pip-dashboard");
    assert.equal(await s.page.locator(".pip-artifacts").getAttribute("aria-label"), "Dashboards");
    assert.equal(await s.page.locator("#pipReportAs").count(), 0);
    assert.deepEqual(await names(s), ["Signups by country"]);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
  const old = await openPipSettings(browser, { kind: "scout", dashboards: DASHBOARDS, apiVersion: 66 });
  try {
    await old.page.waitForSelector("#model-form");
    await old.page.waitForTimeout(150);
    assert.deepEqual(await old.posted("get_pip_artifacts"), []);
    assert.deepEqual(await old.posted("list_artifact_dashboards"), []);
    assert.equal(await old.page.locator("#pipDashboardsLabel, #pipReportAs").count(), 0);
  } finally { await old.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  for (const kind of ["scout", "personal"]) {
    test(`at 360px (${theme}, ${kind}) nothing in Reports and dashboards runs off the edge`, async (t) => {
      if (skipOrFail(t)) return;
      const long = [...DASHBOARDS, { id: DASH("f"), title: "Weekly revenue by region and channel, with refunds taken out", version: 30 }];
      const s = await openPipSettings(browser, { width: 360, theme, kind, dashboards: long,
        artifacts: { report_as: "sheet", report_sheet: DASH("9"), dashboards: [DASH("f"), DASH("a")] } });
      try {
        await s.page.waitForSelector(".pip-dashboard");
        const off = await s.page.evaluate(() => [...document.querySelectorAll(".pip-artifacts-section *, .pip-artifacts *")]
          .filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > window.innerWidth + 0.5).map((n) => n.id || n.className || n.tagName));
        assert.deepEqual(off, [], "every row, choice and button within reach");
        const tall = await s.page.locator(".pip-dashboard-name").first().evaluate((n) => n.getClientRects().length);
        assert.ok(tall >= 1);
        const buttons = await s.page.locator(".pip-dashboard button").evaluateAll((all) => all.map((b) => Math.round(b.getBoundingClientRect().width)));
        assert.ok(buttons.every((w) => w >= 40), `Open and Remove keep their size (${buttons})`);
        assert.deepEqual(s.errors, []);
      } finally { await s.close(); }
    });
  }
}
