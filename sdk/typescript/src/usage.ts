/**
 * Per-run usage records and cost. Prices are embedder-supplied; DGC does not invent tariffs.
 * Mirrors sdk/python/dgc_sdk/usage.py.
 *
 * Token counts come from the provider usage DGC reports for the session (the `context` event's
 * cumulative `input_tokens` / `output_tokens` / `cached_input_tokens` totals); a run records the
 * change across its turns. When the provider reported nothing, the count is `null` (unknown),
 * never 0. `token_estimate` is DGC's estimate of the conversation's context size, not billed
 * tokens.
 */
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendPrivate, privateDir } from "./state.ts";
import type { Pricing } from "./types.ts";

export const USAGE_TOTAL_KEYS = [
  "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "requests",
] as const;
export type UsageKey = typeof USAGE_TOTAL_KEYS[number];
export type UsageTotals = Record<UsageKey, number>;
const MAX_USAGE_LINE_CHARS = 1024 * 1024;

export function emptyTotals(): UsageTotals {
  return { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0, requests: 0 };
}

export function count(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const whole = Math.trunc(number);
  return whole >= 0 ? whole : null;
}

/**
 * Cost of one usage record, or null without pricing or when the token counts are unknown.
 * `inputTokens` counts every prompt token, cached ones included (as DGC reports them);
 * `cachedInputTokens` is the part served from a cache, billed at the cached price.
 */
export function costUsd(inputTokens: number | null, outputTokens: number | null,
  cachedInputTokens: number | null, pricing: Pricing | undefined): number | null {
  if (!pricing || inputTokens === null || outputTokens === null) return null;
  const totalIn = Math.max(0, inputTokens);
  const cached = Math.min(totalIn, Math.max(0, cachedInputTokens || 0));
  const inputRate = Number(pricing.inputPerMillion || 0);
  const cachedRate = Number(pricing.cachedInputPerMillion || 0) || inputRate;
  const dollars = ((totalIn - cached) / 1_000_000) * inputRate
    + (cached / 1_000_000) * cachedRate
    + (Math.max(0, outputTokens) / 1_000_000) * Number(pricing.outputPerMillion || 0);
  return Math.round(dollars * 1e8) / 1e8;
}

/** The cumulative session totals a `context` event carries, or null if it has none. */
export function usageTotals(event: Record<string, unknown>): UsageTotals | null {
  const totals = emptyTotals();
  for (const key of USAGE_TOTAL_KEYS) {
    const number = count(event[key]);
    if (number === null) {
      if (key === "input_tokens" || key === "output_tokens" || key === "requests") return null;
      continue;
    }
    totals[key] = number;
  }
  return totals;
}

/** What one turn added, or null when the totals were reset (a new or resumed session). */
export function usageDelta(before: UsageTotals, after: UsageTotals): UsageTotals | null {
  const delta = emptyTotals();
  for (const key of USAGE_TOTAL_KEYS) {
    delta[key] = (after[key] || 0) - (before[key] || 0);
    if (delta[key] < 0) return null;
  }
  return delta;
}

/** False when requests were made but the provider reported no token usage for them. */
export function reported(delta: UsageTotals): boolean {
  if ((delta.requests || 0) <= 0) return true;
  return Boolean(delta.input_tokens || delta.output_tokens);
}

export type UsageReport = {
  runs: number;
  /** Runs whose provider did not report tokens; their tokens and cost are left out of the sums. */
  unknownUsageRuns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Sum over runs with a known cost, or null when none has one. */
  costUsd: number | null;
  byDepartment: Array<{
    department: string; runs: number; unknownUsageRuns: number; inputTokens: number;
    outputTokens: number; costUsd: number;
  }>;
  /** The last 500 rows as recorded (snake_case keys, the same JSONL the Python SDK writes). */
  rows: Array<Record<string, unknown>>;
};

function rowKnown(row: Record<string, unknown>): boolean {
  return count(row.input_tokens) !== null && count(row.output_tokens) !== null;
}

/** Append-only JSONL under the isolated stateDir. Queryable without dgc serve. */
export class UsageLog {
  readonly directory: string;
  readonly path: string;

  constructor(directory: string) {
    this.directory = privateDir(directory);
    this.path = join(this.directory, "usage.jsonl");
  }

  record(row: Record<string, unknown>): void {
    const payload = { ts: Date.now() / 1000, ...row };
    appendPrivate(this.path, JSON.stringify(payload) + "\n");
  }

  query(options: { department?: string; since?: number; until?: number } = {}): UsageReport {
    const rows: Array<Record<string, unknown>> = [];
    let runs = 0;
    let unknownUsageRuns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let totalCost = 0;
    let hasCost = false;
    const buckets = new Map<string, UsageReport["byDepartment"][number]>();
    const accept = (line: string) => {
      if (!line.trim()) return;
      let row: unknown;
      try { row = JSON.parse(line); } catch { return; }
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      const record = row as Record<string, unknown>;
      if (options.department && String(record.department || "") !== options.department) return;
      const rawTs = record.ts || 0;
      if (!["number", "string", "boolean"].includes(typeof rawTs)) return;
      const ts = Number(rawTs);
      if (!Number.isFinite(ts)) return;
      if (options.since !== undefined && ts < options.since) return;
      if (options.until !== undefined && ts > options.until) return;
      runs += 1;
      rows.push(record);
      if (rows.length > 500) rows.shift();
      const key = String(record.department || "");
      let slot = buckets.get(key);
      if (!slot) {
        slot = { department: key, runs: 0, unknownUsageRuns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        buckets.set(key, slot);
      }
      slot.runs += 1;
      if (!rowKnown(record)) {
        unknownUsageRuns += 1;
        slot.unknownUsageRuns += 1;
        return;
      }
      const inp = count(record.input_tokens) || 0;
      const out = count(record.output_tokens) || 0;
      inputTokens += inp;
      outputTokens += out;
      cachedInputTokens += count(record.cached_input_tokens) || 0;
      slot.inputTokens += inp;
      slot.outputTokens += out;
      if (typeof record.cost_usd === "number" && Number.isFinite(record.cost_usd)) {
        totalCost += record.cost_usd;
        slot.costUsd += record.cost_usd;
        hasCost = true;
      }
    };
    if (existsSync(this.path)) {
      const fd = openSync(this.path, "r");
      const decoder = new StringDecoder("utf8");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let pending = "";
      let discarding = false;
      const feed = (text: string) => {
        pending += text;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          if (!discarding && end <= MAX_USAGE_LINE_CHARS) accept(pending.slice(0, end));
          pending = pending.slice(end + 1);
          discarding = false;
        }
        if (pending.length > MAX_USAGE_LINE_CHARS) {
          pending = "";
          discarding = true;
        }
      };
      try {
        let size: number;
        while ((size = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          feed(decoder.write(chunk.subarray(0, size)));
        }
        feed(decoder.end());
        if (!discarding && pending.length <= MAX_USAGE_LINE_CHARS) accept(pending);
      } finally {
        closeSync(fd);
      }
    }
    return {
      runs,
      unknownUsageRuns,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      costUsd: hasCost ? Math.round(totalCost * 1e8) / 1e8 : null,
      byDepartment: [...buckets.values()],
      rows,
    };
  }
}
