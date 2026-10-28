/**
 * Where a chat another window holds is open, and what runs there: the line beside Open here.
 *
 *   Open in Cursor · ~/shop-api · idle 6 min. 2 monitors and 1 background helper run there. Open here moves them
 *   to this window.
 *
 * Built only from what the holding DGC said (session_holder, chatdgc_holder: dgc/holder_note.py, which says the same in
 * the terminal). A part it didn't say is left out, never guessed; when it can't say where (an older CLI, a window that
 * hasn't named its editor), the bar keeps its plain sentence.
 */

export interface HolderFacts {
  found: boolean;
  editor?: string;
  windowless?: boolean;
  folder?: string;
  working?: boolean;
  idle_s?: number;
  monitors?: number;
  helpers?: number;
  commands?: number;
  queued?: number;
  waiting?: number;
}

/** The bar's words: `head` in bold (where, and working or idle), then `detail` (what runs and waits there). */
export interface HolderLine { head: string; detail: string }

const MAX_EDITOR = 40;
const COUNTS = ["monitors", "helpers", "commands", "queued", "waiting"] as const;
const RUNNING: Array<[typeof COUNTS[number], string, string]> = [
  ["monitors", "monitor", "monitors"],
  ["helpers", "background helper", "background helpers"],
  ["commands", "background command", "background commands"],
];

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** The editor's name as people say it: VS Code, Cursor, Windsurf... (vscode.env.appName). */
export function editorName(appName: unknown): string {
  const name = clean(appName, 80);
  const code = /^Visual Studio Code(?:\s*-\s*(.+))?$/i.exec(name);
  if (code) return code[1] ? clean(`VS Code ${code[1]}`, MAX_EDITOR) : "VS Code";
  return clean(name, MAX_EDITOR);
}

/** A folder as the CLI gave it ("~/shop-api", or only a folder's own name): never a full path, whatever arrives. */
function folderShown(value: unknown): string {
  const folder = clean(value, 200);
  if (!folder || folder === "~" || folder.startsWith("~/")) return folder;
  if (/^(?:[A-Za-z]:)?[\\/]/.test(folder)) return folder.split(/[\\/]/).filter(Boolean).pop() || "";
  return folder;
}

const count = (value: unknown): number => (Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0);

/** The facts in a session_holder or chatdgc_holder event, typed and bounded. */
export function holderFacts(ev: any): HolderFacts {
  if (!ev || ev.found !== true) return { found: false };
  const facts: HolderFacts = {
    found: true, editor: clean(ev.editor, MAX_EDITOR), windowless: ev.windowless === true,
    folder: folderShown(ev.folder), working: ev.working === true,
  };
  if (!facts.working && Number.isSafeInteger(ev.idle_s) && ev.idle_s >= 0) facts.idle_s = ev.idle_s;
  for (const key of COUNTS) { const n = count(ev[key]); if (n) facts[key] = n; }
  return facts;
}

export function idleWords(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return "idle under a minute";
  if (minutes < 60) return `idle ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `idle ${hours} h` : `idle ${Math.floor(hours / 24)} days`;
}

const phrase = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const join = (parts: string[]): string => (parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** "2 monitors and 1 background helper run there." -- "" when nothing does. */
export function runningSentence(facts: HolderFacts): string {
  const named = RUNNING.filter(([key]) => count(facts[key])).map(([key, one, many]) => phrase(count(facts[key]), one, many));
  if (!named.length) return "";
  const single = named.length === 1 && RUNNING.reduce((sum, [key]) => sum + count(facts[key]), 0) === 1;
  return `${join(named)} ${single ? "runs" : "run"} there.`;
}

/** "1 queued prompt waits there.", "2 questions wait for an answer there." -- "" when nothing waits. */
export function waitingSentence(facts: HolderFacts): string {
  const queued = count(facts.queued), waiting = count(facts.waiting);
  if (!queued && !waiting) return "";
  if (queued && waiting) return `${phrase(queued, "queued prompt", "queued prompts")} and ${phrase(waiting, "question", "questions")} wait there.`;
  if (queued) return `${phrase(queued, "queued prompt", "queued prompts")} ${queued === 1 ? "waits" : "wait"} there.`;
  return `${phrase(waiting, "question", "questions")} ${waiting === 1 ? "waits" : "wait"} for an answer there.`;
}

/** The line, or undefined when the holder didn't say where: the bar then keeps its plain sentence. `kind` "chat" is a
 *  ChatDGC chat, where the work is a reply being written. */
export function holderLine(facts: HolderFacts | undefined, kind: "session" | "chat" = "session"): HolderLine | undefined {
  if (!facts || facts.found !== true) return undefined;
  const editor = clean(facts.editor, MAX_EDITOR);
  if (facts.windowless !== true && !editor) return undefined;
  const place = facts.windowless === true ? "Kept running by DGC with no window open" : `Open in ${editor}`;
  const state = facts.working === true ? (kind === "chat" ? "writing a reply now" : "working now")
    : Number.isSafeInteger(facts.idle_s) ? idleWords(Number(facts.idle_s)) : "";
  const head = `${[place, folderShown(facts.folder), state].filter(Boolean).join(" · ")}.`;
  const things = (facts.working === true ? 1 : 0) + COUNTS.reduce((sum, key) => sum + count(facts[key]), 0);
  const tail = !things ? "" : `Open here moves ${things === 1 ? "it" : "them"} to this window.`;
  const detail = [runningSentence(facts), waitingSentence(facts), tail].filter(Boolean).join(" ");
  return { head, detail };
}
