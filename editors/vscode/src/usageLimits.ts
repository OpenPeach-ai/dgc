// The usage meter's numbers on the extension's side (0.52): what each connection reported of its usage limits, kept
// for the window and handed to Work, ChatDGC and a Pip's chat, which draw it with ONE module
// (media/shared/usagemeter.js).
//
// - ChatGPT · your plan, Codex and Claude Code: DGC's own report (usage_limits, dgc/usage_limits.py), from any backend
//   of this window; every source's latest wins, by when it was reported.
// - OpenRouter: its own key check (GET /api/v1/key, src/providerConnect.js keyState) with the key the extension keeps,
//   at most once a minute per key, after a turn. A key with a credit limit has a meter; one without has none (there
//   is no limit to measure), but one out of credit still says so, with Top up.
// - Every other connection reports nothing, and has no meter.
//
// A page is never handed an address: each source's page is named here (usagePage), and the page asks for it by name.
import { keyState, type KeyState } from "./providerConnect.js";

export type UsageSource = "chatgpt_plan" | "codex" | "claude" | "openrouter";
export interface UsageWindow { id: string; used_percent: number; window_minutes: number | null; resets_at: number | null }
export interface UsageRow { source: UsageSource; windows: UsageWindow[]; at: number; limited: boolean }
/** What a page draws: the row of the source its model draws on (null for none), and whether requests use the plan
 *  ("Using ChatGPT plan" near its model picker, as OpenAI asks). */
export interface UsageMeterMessage { type: "usageMeter"; meter: UsageRow | null; plan: boolean }

const SOURCES: readonly string[] = ["chatgpt_plan", "codex", "claude"];
/** Each source's usage page (Manage usage) and OpenRouter's credits (Top up). */
const PAGES: Record<UsageSource, { usage?: string; credits?: string }> = {
  chatgpt_plan: { usage: "https://chatgpt.com/settings/usage" },
  codex: { usage: "https://chatgpt.com/codex/settings/usage" },
  claude: { usage: "https://claude.ai/settings/usage" },
  openrouter: { credits: "https://openrouter.ai/settings/credits" },
};
export function usagePage(source: unknown, page: unknown): string {
  const known = PAGES[String(source) as UsageSource];
  return known ? (page === "credits" ? known.credits : known.usage) || "" : "";
}

function cleanWindow(raw: any): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const used = Number(raw.used_percent);
  if (!Number.isFinite(used) || typeof raw.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(raw.id)) return null;
  const whole = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);
  return { id: raw.id, used_percent: Math.min(100, Math.max(0, used)), window_minutes: whole(raw.window_minutes), resets_at: whole(raw.resets_at) };
}
/** A report's rows, checked (what reaches a page is plain numbers and names). */
export function cleanRows(limits: unknown): UsageRow[] {
  return (Array.isArray(limits) ? limits : []).filter((r: any) => r && SOURCES.includes(r.source)).slice(0, 8).map((r: any) => ({
    source: r.source, windows: (Array.isArray(r.windows) ? r.windows : []).map(cleanWindow).filter(Boolean).slice(0, 6) as UsageWindow[],
    at: Number.isSafeInteger(r.at) && r.at > 0 ? r.at : 0, limited: r.limited === true }));
}

/** When an OpenRouter key's limit resets: midnight UTC, Mondays for a weekly one, the 1st for a monthly one. */
export function openRouterReset(reset: unknown, now = Date.now()): number | null {
  const d = new Date(now), day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (reset === "daily") return (day + 86400000) / 1000;
  if (reset === "weekly") { const toMonday = ((8 - d.getUTCDay()) % 7) || 7; return (day + toMonday * 86400000) / 1000; }
  if (reset === "monthly") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  return null;
}
/** An OpenRouter key's state as a meter row: its credit limit's share used, or out of credit; null for no limit. */
export function openRouterRow(state: KeyState & { limit_reset?: unknown }, now = Date.now()): UsageRow | null {
  if (state.state === "no_credit" && !(Number(state.limit) > 0)) return { source: "openrouter", windows: [], at: now, limited: true };
  const limit = Number(state.limit);
  if (state.state !== "ok" && state.state !== "no_credit" || !(limit > 0)) return null;
  const remaining = typeof state.limit_remaining === "number" ? state.limit_remaining : limit - (Number(state.usage) || 0);
  const used = Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
  const reset = typeof state.limit_reset === "string" && ["daily", "weekly", "monthly"].includes(state.limit_reset) ? state.limit_reset : "key";
  return { source: "openrouter", windows: [{ id: reset, used_percent: Math.round(used * 10) / 10, window_minutes: null, resets_at: openRouterReset(reset, now) }],
    at: now, limited: state.state === "no_credit" || used >= 100 };
}

/** The window's one keeper of the numbers. */
export class UsageLimits {
  private rows = new Map<string, UsageRow>();
  private keys = new Map<string, { at: number; row: UsageRow | null }>();
  private watchers = new Set<() => void>();
  constructor(private readonly check: (key: string) => Promise<any> = keyState) {}

  /** DGC's usage_limits, from any backend: every source's latest wins. Returns whether anything changed. */
  arrived(limits: unknown): boolean {
    let changed = false;
    const said = new Set<string>();
    for (const row of cleanRows(limits)) {
      said.add(row.source);
      const before = this.rows.get(row.source);
      if (before && before.at > row.at) continue;
      if (JSON.stringify(before) !== JSON.stringify(row)) { this.rows.set(row.source, row); changed = true; }
    }
    // A full report (every source's latest) that leaves one out: it has nothing to show now (a limit cleared).
    for (const source of [...this.rows.keys()]) if (!said.has(source) && source !== "openrouter") { this.rows.delete(source); changed = true; }
    if (changed) this.changed();
    return changed;
  }
  row(source: string): UsageRow | null { return this.rows.get(source) || null; }

  /** An OpenRouter key's meter row: asked of OpenRouter at most once a minute per key (`fresh` after a turn). */
  async openRouter(id: string, key: string, { fresh = false } = {}): Promise<UsageRow | null> {
    if (!key) return null;
    const cached = this.keys.get(id);
    if (cached && (Date.now() - cached.at < 60_000 || !fresh)) return cached.row;
    let state: any;
    try { state = await this.check(key); } catch { state = { state: "unreachable" }; }
    if (state?.state === "unreachable") return cached?.row || null;
    const row = openRouterRow(state);
    const changed = JSON.stringify(cached?.row || null) !== JSON.stringify(row);
    this.keys.set(id, { at: Date.now(), row });
    if (changed) this.changed();
    return row;
  }

  watch(fn: () => void): { dispose(): void } {
    this.watchers.add(fn);
    return { dispose: () => { this.watchers.delete(fn); } };
  }
  private changed(): void { for (const fn of [...this.watchers]) { try { fn(); } catch { /* one page's trouble is its own */ } } }
}
