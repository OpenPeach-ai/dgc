// The two migration notes of 0.52 (pips-flow-design §3.3, items 2 and 3), the extension's half: what is remembered, and
// what DGC's answer is checked for before a page is told. The pop-up and the note are the page's
// (media/shared/pipswelcome.js).
//
// "Your Pips moved into one list" shows once, the first time the Pips tab opens with a DGC at Pips API 96, only for
// someone whose Pips came from 0.51 (get_pips_welcome's had_pips). Got it, Esc or a click outside is remembered in the
// editor's global state, as What's new is (src/whatsNew.ts), which every window of this editor shares.
//
// The quiet note above a Work session that used to get Pip cards is remembered per session, the same way: closed once
// (its ×, or opening one of the Pips it names), it never comes back in any window.
import type * as vscode from "vscode";

/** The Pips API whose DGC has the flow (a Pip tells you in its own chat) and get_pips_welcome. */
export const WELCOME_API = 96;
/** The release whose welcome was answered, in the editor's global state. */
export const PIPS_WELCOME_KEY = "dgc.pipsWelcomeSeen";
export const PIPS_WELCOME_RELEASE = "0.52";
/** The sessions whose note was closed, oldest first, in the editor's global state. */
export const SESSION_NOTES_KEY = "dgc.pipSessionNotesGone";
const SESSION_NOTES_KEPT = 2000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/, PIP_ID = /^pip_[0-9a-f]{32}$/;

type Kept = { globalState?: Pick<vscode.Memento, "get" | "update"> };

export interface WelcomePip { id: string; name: string }
export interface PipsWelcome { had_pips: boolean; folders: { folder: string; pips: WelcomePip[] }[]; personal: WelcomePip[]; do_it_all: WelcomePip[] }

/** Whether the pop-up has not been answered in this editor yet. */
export function pipsWelcomeDue(context: Kept): boolean {
  try { return context?.globalState?.get?.(PIPS_WELCOME_KEY) !== PIPS_WELCOME_RELEASE; } catch { return false; }
}
/** Got it, Esc or a click outside: never by itself again, in any window of this editor. */
export async function pipsWelcomeAnswered(context: Kept): Promise<void> {
  try { await context?.globalState?.update?.(PIPS_WELCOME_KEY, PIPS_WELCOME_RELEASE); } catch { /* kept for this window's page still */ }
}

/** get_pips_welcome, checked: only real Pip ids, each Pip once in its list, a name of 1 to 120 characters, a folder by
 *  its name, 50 folders and 50 Pips a list at most; a folder with no Pip left is left out. null: not an answer. */
export function pipsWelcomeOf(value: any): PipsWelcome | null {
  if (!value || typeof value !== "object" || typeof value.had_pips !== "boolean") return null;
  const pips = (list: unknown): WelcomePip[] => {
    const seen = new Set<string>(), out: WelcomePip[] = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p !== "object" || typeof p.id !== "string" || !PIP_ID.test(p.id) || seen.has(p.id) || typeof p.name !== "string" || !p.name.trim() || out.length >= 50) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: [...p.name.replace(/\s+/g, " ").trim()].slice(0, 120).join("") });
    }
    return out;
  };
  const folders: PipsWelcome["folders"] = [];
  for (const f of Array.isArray(value.folders) ? value.folders : []) {
    if (!f || typeof f !== "object" || folders.length >= 50) continue;
    const listed = pips(f.pips);
    if (listed.length) folders.push({ folder: typeof f.folder === "string" ? [...f.folder.replace(/\s+/g, " ").trim()].slice(0, 200).join("") : "", pips: listed });
  }
  return { had_pips: value.had_pips, folders, personal: pips(value.personal), do_it_all: pips(value.do_it_all) };
}
/** What the page is told: open the pop-up. `auto`: by itself, the first time; false from Pips settings. */
export function pipsWelcomeMessage(auto: boolean, welcome: PipsWelcome): { type: "pipsWelcome"; auto: boolean; welcome: PipsWelcome } {
  return { type: "pipsWelcome", auto, welcome };
}
/** Someone for whom nothing moved: "How Pips work now" still says how Pips work, without a list. */
export const NO_PIPS_MOVED: PipsWelcome = { had_pips: false, folders: [], personal: [], do_it_all: [] };

/** A session id as DGC writes them; anything else is not one. */
export function noteSession(value: unknown): string { return typeof value === "string" && SESSION_ID.test(value) ? value : ""; }
function notesGone(context: Kept): string[] {
  try { const kept = context?.globalState?.get?.(SESSION_NOTES_KEY); return Array.isArray(kept) ? kept.filter((s): s is string => typeof s === "string") : []; } catch { return []; }
}
/** Whether this session's note was closed (in any window of this editor). */
export function sessionNoteGone(context: Kept, session: string): boolean { return notesGone(context).includes(session); }
/** Its × or one of its Pips opened: gone for good. The newest 2,000 are kept. */
export async function sessionNoteClosed(context: Kept, session: string): Promise<void> {
  const kept = notesGone(context);
  if (kept.includes(session)) return;
  try { await context?.globalState?.update?.(SESSION_NOTES_KEY, [...kept, session].slice(-SESSION_NOTES_KEPT)); } catch { /* closed in this page still */ }
}
