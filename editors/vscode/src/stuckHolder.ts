/**
 * A DGC that holds a session and has stopped answering (0.52; seen 13 Nov: "This session is open in another window"
 * → Open here → the same again, because the process holding it couldn't be asked and nothing showed it).
 *
 * DGC lists such a process with liveness "stuck" (dgc/peers.py: alive, the same process, its heartbeat stopped) in
 * list_live_sessions' rows. This reads those rows as they are, with nothing new on the wire:
 *
 * - Settings › Running sessions gives it a row that says "Not responding since 12:00" with Stop;
 * - a read-only chat whose holder is stuck says who holds it in plain words ("Held by a DGC with no window, since
 *   11:53, running a turn.") and offers "Stop it and open here".
 *
 * The rows don't carry the heartbeat itself, so "since 12:00" is read from the process's own note in DGC's home
 * (peers/<pid>.json, which DGC keeps for a stuck process). When that can't be read here, no time is made up.
 * Times travel as milliseconds: the page that shows them says them on the reader's own clock.
 */
import * as fs from "fs";
import { join } from "path";
import { dgcHome } from "./wslSetup";

/** What the bar says of a stuck holder: where it runs, since when (ms; 0 when unknown), whether a turn was running,
 *  and when it last answered (its heartbeat, ms; 0 when it can't be read). */
export interface StuckFacts { place: string; since: number; working: boolean; heartbeat: number }
export interface StuckHolder { pid: number; instance: string; facts: StuckFacts }

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A note's instance: hex, or none at all (a DGC in a terminal names none). */
export const INSTANCE = /^[a-f0-9]{0,64}$/;
const MAX_NOTE_BYTES = 1024 * 1024;

/** "12:00" on this clock, or "" for a time that isn't one. */
export function clock(ms: unknown): string {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) { return ""; }
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? "" : `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

/** The row's own line in Settings › Running sessions. */
export function notResponding(heartbeat: unknown): string {
  const at = clock(heartbeat);
  return at ? `Not responding since ${at}` : "Not responding";
}

/** The bar's two parts: who holds it (bold), then why Open here can't and what the button does. */
export function stuckLine(facts: StuckFacts): { head: string; detail: string } {
  const place = String(facts?.place || "another DGC").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 80);
  const since = clock(facts?.since), last = clock(facts?.heartbeat);
  const head = `Held by ${[place, since ? `since ${since}` : "", facts?.working === true ? "running a turn" : ""].filter(Boolean).join(", ")}.`;
  const detail = `${last ? `It stopped answering at ${last}` : "It has stopped answering"}, so Open here can't take it. `
    + "Stop it and open here ends it and opens the session in this window as it was last saved.";
  return { head, detail };
}

/** DGC's own home, as the process this editor starts sees it. */
function peersFolder(): string {
  const named = process.env.DGC_HOME;
  return join(named && named.trim() ? named : dgcHome(), "peers");
}

/** A process's last heartbeat (ms), from its own note; 0 when the note isn't there or doesn't say. */
export function heartbeatOf(pid: number): number {
  if (!Number.isSafeInteger(pid) || pid <= 0) { return 0; }
  try {
    const path = join(peersFolder(), `${pid}.json`);
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) { return 0; }
    const note = JSON.parse(fs.readFileSync(path, "utf8"));
    const beat = Number(note?.pid) === pid ? Number(note?.heartbeat) : NaN;
    // Seconds since 1970, as DGC writes it: a sane one is between 2001 and a day from now.
    return Number.isFinite(beat) && beat > 1e9 && beat * 1000 < Date.now() + 86_400_000 ? Math.round(beat * 1000) : 0;
  } catch { return 0; }
}

/** Where a process runs, in plain words, from its row. */
function placeOf(row: any): string {
  if (row.kind === "tui") { return "a DGC in a terminal"; }
  return row.attached === false ? "a DGC with no window" : "a DGC in an editor window";
}

/** Since when: for one with no window, when its window went; otherwise when it started. 0 when the row doesn't say. */
function sinceOf(row: any, now: number): number {
  const windowless = Number(row.windowless_s), up = Number(row.uptime_s);
  const seconds = row.attached === false && windowless > 0 ? windowless : up > 0 ? up : 0;
  return seconds > 0 && Number.isFinite(seconds) ? now - Math.round(seconds) * 1000 : 0;
}

/** Whether a row is a stuck process this window may offer to stop: another process, by its pid and instance. */
export function isStuck(row: any): boolean {
  return !!row && typeof row === "object" && row.liveness === "stuck" && row.here !== true
    && Number.isSafeInteger(row.pid) && row.pid > 0 && INSTANCE.test(String(row.instance ?? ""))
    && (row.kind === "serve" || row.kind === "tui");
}

/** The stuck process that holds `sessionId`, among list_live_sessions' rows; undefined when its holder answers (or
 *  nobody says it holds it). */
export function stuckHolder(rows: unknown, sessionId: string, now = Date.now()): StuckHolder | undefined {
  if (!Array.isArray(rows) || !SESSION_ID.test(String(sessionId || ""))) { return undefined; }
  for (const row of rows) {
    if (!isStuck(row)) { continue; }
    const held = (Array.isArray(row.sessions) ? row.sessions : []).find((s: any) => s && s.session_id === sessionId);
    if (!held) { continue; }
    return { pid: row.pid, instance: String(row.instance ?? ""),
             facts: { place: placeOf(row), since: sinceOf(row, now), working: held.status === "working", heartbeat: heartbeatOf(row.pid) } };
  }
  return undefined;
}
