// Home with every kind of card on it, for the tests and pictures of the cards' answers (home-card-buttons.test.mjs):
// what is answered on its card (a command, a Pip's change, a site to visit, a new Pip), what only opens, Pips with news,
// a failed run and things made. Not a *.test.mjs file.
import { openDock, DOCK_SESSIONS } from "./dock-scene.mjs";
import { homeState, pipId, P } from "./home-scene.mjs";

const AR = (n) => "ar_" + String(n).padStart(16, "0");
/** Things made, as the host keeps them: a page from a Work session, a document from a chat. */
export const made = () => JSON.stringify([["page", "Login redirect map", "work", DOCK_SESSIONS[0].id, 0], ["doc", "Rent or buy, in one page, with every number the bank sent and the two that it did not", "chat", "chat_2", 4]]
  .map(([type, title, surface, where, min], k) => ({ id: AR(k + 1), type, title, version: 1, op: "made", surface, where, at: Date.now() - min * 60000 })));
export const SETUP = "setup_" + "7".repeat(32), PROPOSAL = "proposal-" + "3".repeat(12), VISIT = "compact_" + "5".repeat(32), MAIL = "maildraft_" + "1".repeat(32);
/** Everything that is answered on its card, and one that only opens. */
export function waiting() {
  const state = homeState("quiet");
  const pip = (c, name, type) => ({ id: pipId(c), name, pip_type: type, workspace_id: P, status: "active", pending_review_count: 0, version: 1, current_version: 4 });
  state.list[P] = [pip("a", "Core", "core"), pip("b", "Mail watch", "scout"), pip("c", "Morning brief", "quill"), pip("d", "Garden notes", "lens")];
  const waits = (kind, card, c, name, type, title, detail, more = {}) => ({ id: `${kind}:${card}`, kind, card, pip_id: c ? pipId(c) : null, pip_name: name, pip_type: type, workspace_id: P, title, detail,
    created_at: "2026-11-03T09:00:00.000Z", expires_at: null, ...more });
  state.attention = { as_of: "2026-11-03T12:00:00.000Z", total: 4, truncated: false, counts: { setup: 1, computer_action: 1, email: 1 }, by_pip: { [pipId("b")]: 1, [pipId("c")]: 1, [pipId("d")]: 1 }, projects: {},
    items: [waits("setup", SETUP, null, "Receipts", "rook", "Create the Pip “Receipts”?", "File each receipt from my mail."),
      waits("computer_action", VISIT, "d", "Garden notes", "lens", "Visit seeds.example?", "https://seeds.example/tomatoes"), waits("email", MAIL, "b", "Mail watch", "scout", "A reply to send", "To: someone new")],
    reviews: [waits("approval", PROPOSAL, "c", "Morning brief", "quill", "Change Morning brief?", "Run at 7:00 instead of 9:00", { review: "schedule_update" })] };
  state.setups = { [SETUP]: { id: SETUP, digest: "a".repeat(64), workspace_id: P, project_root: "/private/pips", pip_id: null, name: "Receipts", goal: "File each receipt from my mail.", pip_type: "rook", work_kind: "personal_task",
    source_ref: "HEAD", schedule: null, run_now: false, next_run_at: null, status: "pending", created_at: "2099-10-02T04:00:00Z", expires_at: "2099-10-02T06:00:00Z", receipt: null, reason: "You asked.", expected_version: null,
    expected_lifecycle_revision: null, permissions: "read_only", source_policy: "personal", runner_notice: "Runs only while Pips are on.", scope_notice: "Reads only what you share.", run_now_policy: null } };
  state.computers = { [pipId("d")]: { pip_id: pipId("d"), granted: true, available: true, reason: "", pending: 1, actions: [{ id: VISIT, pip_id: pipId("d"), workspace_id: P, run_id: "run_" + "b".repeat(32),
    summary: { method: "GET", host: "seeds.example", path: "/tomatoes", page: "", fields: [], more_fields: 0, body_bytes: 0, kind: "site", site: "seeds.example", shown: "seeds.example" }, digest: "d".repeat(64), frame: null, status: "pending",
    created_at: "2026-11-03T09:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", resolved_at: null, resolved_by: null, continuation_run_id: null }] } };
  return state;
}
export const RUN = { ...DOCK_SESSIONS[2], name: "Plan the 0.52 release notes", waiting: true, running: true, ask: { id: "perm-1", command: "npm test -- --run" } };
export const EDIT = { ...DOCK_SESSIONS[1], name: "Rename the watering helpers", waiting: true, running: true };
export const K = { setup: `setup:${SETUP}`, change: `pip:${pipId("c")}`, visit: `pip:${pipId("d")}`, mail: `pip:${pipId("b")}`, run: `work:${RUN.id}`, edit: `work:${EDIT.id}` };

/** One Home with them all: the cards answered where they are, and the news (Open / Mark read, Open / Dismiss). */
export function everyCard() { const s = waiting(), busy = homeState("busy"); s.list = busy.list; s.unread = busy.unread; s.digest = busy.digest; return s; }
export async function openCards(browser, options = {}) {
  const done = { ...DOCK_SESSIONS[0] };
  const x = await openDock(browser, { tab: "home", state: everyCard(), sessions: [RUN, EDIT, done], height: 1500, pages: made(), ...options });
  await x.send({ type: "sessions_list", items: [RUN, EDIT, { ...done, running: false }], error: "" });
  await x.settle();
  for (const more of await x.page.locator("#home-hub .dgc-hub-rest").all()) { await more.click().catch(() => {}); await x.settle(); }
  await x.page.mouse.move(2, 2);
  return x;
}
