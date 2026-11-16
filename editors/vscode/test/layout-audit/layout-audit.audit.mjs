// The layout audit (0.52; the maintainer's go, 16 Nov): "specific places where something is off: a pop-up drawn
// Run on its own, not in `npm test` (about 10 minutes, and paced for a quiet machine): `npm run test:layout`, before a
// build and after a UI pass. Its report: test/layout-audit/report.md.
// off-screen, a dropdown not lined up with its button, a field cut at narrow widths, mismatched heights", and
// "everything must be tested in all ways for the UI/UX".
//
// In real Chromium, on the real pages (the scenes the tests already use: Home, Work's list and a Work session, the Chat
// list and ChatDGC, the Pips list, a Pip's chat, page and computer tab, the Library in the side bar and in its tab,
// Settings, Notes, the dock), the walk
//   - opens every pop-up, dropdown, menu, popover, dialog and hover label each page has (every control that says it
//     opens one, every <details> menu, every "…" a row shows to a resting pointer, a right-click where a control's menu
//     is on Shift+F10, a typed "@" or "/" in a prompt box), by the pointer and again by the keyboard, and measures each:
//     inside the window, lined up with its control, under nothing and over nothing it shouldn't be, its rows one
//     height, its words whole, closed by Escape with the focus back on its control;
//   - reads the page at rest at 300, 360, 440, 700 and 1000 px, dark and light, a short and a tall window, the
//     editor's font at 12 and 18 px, forced colours and high contrast, and a screen with no hover;
//   - sweeps each page from 260 to 1200 px (and the side bar's minimum, 170): an action a row, a bar or a card offers
//     at the widest must be reachable at every narrower width, and a row's height does not change with the width;
//   - compares one kind of control across the surfaces, and reads the one-action-one-icon walk.
// Each check is a test below; a finding fails it. What is found is written to test/layout-audit/report.md (ranked:
// off-screen, covering, unreachable first), report.json and pictures/ (the control dashed blue, the layer red).
// allow.mjs is the list of findings left on purpose, each with its reason.
//
//   DGC_LAYOUT_AUDIT_ONLY=<pattern>   only the scenes whose name matches (a part of the audit, while working on one page)
//   DGC_LAYOUT_SWEEP=full             the 20 px sweep on every state (by default a page's first state is swept every
//                                     20 px and its other states at ten sampled widths)
//   DGC_LAYOUT_AUDIT_POOL=<n>         pages walked at once (half the processors, ten at the most)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "../support/look-probe.mjs";
import { cleanup as cleanupNotes } from "../support/notes-host.mjs";
import { cleanup as cleanupBundle } from "../support/panel-bundle.mjs";
import { runAudit } from "./run.mjs";
import { CHECKS, writeReport, allowedBy } from "./harness.mjs";
import { ALLOW } from "./allow.mjs";

const chromium = await chromiumOrNull();
const ONLY = process.env.DGC_LAYOUT_AUDIT_ONLY || "";
let browser, audit, report;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; return; }
  audit = await runAudit(browser, { only: ONLY, part: ONLY ? "part" : "all" });
  audit.save();
  report = writeReport(ALLOW);
});
after(async () => { await browser?.close(); cleanupNotes(); cleanupBundle(); });

test("premise: every state the plan names was on screen, and layers were opened and measured", async (t) => {
  if (skipOrFail(t)) return;
  t.diagnostic(`${audit.stats.layers} layers (${audit.stats.menus} menus, ${audit.stats.dialogs} dialogs, ${audit.stats.tooltips} hover labels), ${audit.stats.states} states at rest, ${audit.stats.widths} widths swept, ${audit.stats.jobs} passes, ${audit.stats.seconds} s`);
  assert.deepEqual(audit.missing, [], "a state the plan names was never on screen: the plan (surfaces.mjs) is out of date");
  assert.deepEqual(audit.stats.notes.filter((n) => /the scene stopped|the icon walk stopped/.test(n)), [], "a scene stopped before its end");
  if (ONLY) return;
  assert.ok(audit.stats.menus >= 300, `menus and popovers opened: ${audit.stats.menus}`);
  assert.ok(audit.stats.dialogs >= 10, `dialogs measured: ${audit.stats.dialogs}`);
  assert.ok(audit.stats.tooltips >= 40, `hover labels measured: ${audit.stats.tooltips}`);
  assert.ok(audit.stats.widths >= 600, `widths swept: ${audit.stats.widths}`);
  assert.ok(audit.stats.glyphs >= 100, `controls read by the icon walk: ${audit.stats.glyphs}`);
});

for (const [id, title, what] of CHECKS) {
  test(`${title}: nothing found`, async (t) => {
    if (skipOrFail(t)) return;
    const mine = report.findings.filter((f) => f.part === audit.part && f.check === id);
    const open = mine.filter((f) => !f.allowed);
    t.diagnostic(`${what} ${open.length} open, ${mine.length - open.length} left on purpose.`);
    assert.deepEqual(open.map((f) => `${f.surface}: ${f.says} [${f.at.slice(0, 3).join("; ")}${f.at.length > 3 ? `; +${f.at.length - 3}` : ""}]${f.picture ? ` (test/layout-audit/${f.picture})` : ""}`), [], `see test/layout-audit/report.md`);
  });
}

test("the allow-list: every entry says why, and still names a finding", async (t) => {
  if (skipOrFail(t)) return;
  for (const a of ALLOW) assert.ok(a.check && a.surface && a.what && String(a.reason || "").length >= 20, `an entry without its reason: ${JSON.stringify(a)}`);
  if (ONLY) return;
  const mine = report.findings.filter((f) => f.part === audit.part);
  assert.deepEqual(ALLOW.filter((a) => !mine.some((f) => allowedBy(f, [a]) === a)).map((a) => `${a.check} | ${a.surface} | ${a.what}`), [], "an entry that matches no finding: take it out");
});
