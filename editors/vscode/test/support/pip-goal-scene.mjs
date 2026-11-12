// A Personal Pip's chat with a goal (pips-15, Pips API 92), in the side bar: the goal card above the prompt box in each
// of the states the pictures show. Shared by pip-goal-browser.test.mjs and render-pip-goal.mjs. Not a *.test.mjs file.
import { openChat } from "./pip-chat-scene.mjs";

const OBJECTIVE = "Plan my week: list my three priorities, block time for each on the calendar, and draft the plan as a short note I can send to the team on Monday morning.";
/** state -> what the scene's DGC says the goal is (opts.goal of pip-chat-scene.mjs), and what the card should then say. */
export const GOAL_STATES = {
  working: { goal: { status: "active", turns: 2 }, turn: "Turn 3 of 20", status: "Working on it", buttons: ["Stop"] },
  waiting: { goal: { status: "needs_you", turns: 3, reason: "Waiting for your answer in the chat." }, turn: "Turn 3 of 20", status: "Waits for your answer", buttons: ["Stop"] },
  done: { goal: { status: "done", turns: 5, reason: "The plan is drafted and every priority has its time.",
    evidence: ["Three priorities are listed in the chat: the launch notes, the hiring loop, the budget review", "Each has a block on the calendar draft, Tuesday to Thursday", "The note for the team is in the chat, ready to send"] },
    details: true, turn: "Turn 5 of 20", status: "Done", buttons: ["Details", "Dismiss"], evidence: 3 },
  blocked: { goal: { status: "blocked", turns: 20, reason: "Stopped after 20 turns without finishing. Look at where it got to, then set it again." },
    turn: "Turn 20 of 20", status: "Blocked: Stopped after 20 turns without finishing. Look at where it got to, then set it again.", buttons: ["Details", "Dismiss"] },
};

/** The chat with its goal in `state`; a state with `details` has them open. */
export async function openGoal(browser, { width = 300, height = 760, theme = "dark", state = "working" } = {}) {
  const spec = GOAL_STATES[state];
  const x = await openChat(browser, { width, height, theme, api: 92, goal: { objective: OBJECTIVE, ...spec.goal } });
  await x.p.waitForSelector(".pip-goal-card", { timeout: 4000 });
  if (spec.details) { await x.p.click(".pip-goal-card [data-goal-details]"); await x.p.waitForSelector(".pip-goal-card .pip-goal-details"); }
  await x.p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200)))));
  return x;
}

/** The card as drawn (pass the page): its box against the prompt box's, its parts, and each word's contrast. */
export const measureGoal = (page) => page.evaluate(() => {
  const root = window.__pipsRoot || document, card = root.querySelector(".pip-goal-card"), form = root.querySelector("#chat-form");
  if (!card) return { card: null };
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const c = box(card), inside = (e) => { const b = box(e); return b.left >= c.left - 0.5 && b.right <= c.right + 0.5 && b.top >= c.top - 0.5 && b.bottom <= c.bottom + 0.5; };
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const chain = (node) => { const list = []; for (let n = node; n; n = n.parentElement || n.getRootNode()?.host) list.unshift(n); return list; };
  const pixel = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  const lum = (p) => { const v = p.map((q) => q / 255).map((q) => (q <= 0.04045 ? q / 12.92 : ((q + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (node) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1, 1);
    for (const n of chain(node)) { ctx.fillStyle = getComputedStyle(n).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
    const under = pixel(); ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1); const over = pixel();
    const [a, b] = [lum(over), lum(under)].sort((m, n) => n - m); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
  const objective = card.querySelector(".pip-goal-objective"), turn = card.querySelector(".pip-goal-turn"), status = card.querySelector(".pip-goal-status");
  const words = [];
  const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) { const e = t.parentElement; if (!t.textContent.trim() || !e.checkVisibility({ visibilityProperty: true })) continue;
    words.push({ text: t.textContent.trim().slice(0, 40), ratio: ratio(e) }); }
  const parts = [...card.querySelectorAll(".pip-goal-objective, .pip-goal-turn, .pip-goal-status, .pip-goal-acts button, [data-goal-more], .pip-goal-reason, .pip-goal-evidence li")].filter((e) => e.checkVisibility())
    .map((e) => ({ what: e.className || e.textContent.trim(), r: e.getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) { const a = parts[i].r, b = parts[j].r;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${parts[i].what} over ${parts[j].what}`); }
  return { card: c, form: box(form), sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    objective: { lines: Math.round(box(objective).height / parseFloat(getComputedStyle(objective).lineHeight)) },
    turn: { text: turn.textContent.trim(), cut: turn.scrollWidth > turn.clientWidth + 1 }, status: { text: status.textContent.replace(/\s+/g, " ").trim() },
    buttons: [...card.querySelectorAll("button")].filter((b) => b.checkVisibility()).map((b) => ({ word: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 1, inside: inside(b) })),
    evidence: [...card.querySelectorAll(".pip-goal-evidence li")].map((li) => ({ inside: inside(li) })), overlaps, words };
});
