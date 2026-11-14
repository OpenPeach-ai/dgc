// The scene of the Pip page batch of 14 Nov (0.52): a Pip that pays by itself with a limit, a count and two sites, what
// its computer sent to the web (one blocked, one long name), and a note. Shared by the Chromium test and the pictures
// (test/pip-page-batch-browser.test.mjs, test/render-pip-page-batch.mjs). Not a *.test.mjs file.
const today = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
export const SENT = [
  { host: "api.shop.example", times: 3, sent_bytes: 12288, received_bytes: 348160, blocked: 0, first_at: today(9, 5), last_at: today(10, 42) },
  { host: "paste.example", times: 0, sent_bytes: 0, received_bytes: 0, blocked: 1, first_at: today(10, 30), last_at: today(10, 30) },
  { host: "a-very-long-subdomain-name.storage.eu-central.files.example", times: 14, sent_bytes: 300, received_bytes: 2600000, blocked: 2, first_at: "2026-11-02T08:00:00Z", last_at: "2026-11-02T08:15:00Z" }];
export const PAYING = { level: "full", paying: "allow", limits: { usd_per_day: 50, max_count: 5, sites: ["books.example", "shop.example"] }, spent: 12.5, sent: SENT,
  notes: [{ id: "pipnote_" + "a".repeat(32), text: "Likes the brief short: five bullets.", source: "chat", run_id: null, created_at: "2026-11-10T09:00:00Z" }] };
/** A Pip's page, from its chat's menu. */
export async function openPage(x, id) {
  await x.openPip(id);
  await x.click('.pip-topbar .pip-menu [data-tab="job"]');
  await x.waitIn(".pip-page #pipLevel");
  await x.page.waitForTimeout(250);
}
