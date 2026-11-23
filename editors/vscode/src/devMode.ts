// Settings → Dev Mode, the extension's half. DGC keeps the table of capacity limits (ready.capabilities.dev_limits)
// and the two settings (dev_mode, dev_limits); this reads the table for the Settings page and shapes what Save sends.

/** One capacity limit, as DGC lists it: its name, what it is, today's default, the most without Dev Mode, its cost. */
export interface DevLimit { name: string; label: string; default: number; ceiling: number | null; cost: string }

/** The warning was shown in this editor (it shows once). */
export const DEV_WARNED_KEY = "dgc.devModeWarned.v1";
/** What this editor last saved, shown only while DGC's config does not say the two settings itself. */
export const DEV_SAVED_KEY = "dgc.devModeSaved.v1";

/** DGC's table, or none from a DGC without one (then Settings has no Dev Mode). A row that can't be drawn is left out. */
export function devLimitsTable(capabilities: any): DevLimit[] {
  const rows = capabilities && typeof capabilities === "object" ? capabilities.dev_limits : undefined;
  if (!Array.isArray(rows)) { return []; }
  const out: DevLimit[] = [];
  for (const row of rows.slice(0, 256)) {
    if (!row || typeof row !== "object") { continue; }
    const name = typeof row.name === "string" ? row.name : "";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof row.default !== "number" || !Number.isFinite(row.default)) { continue; }
    out.push({ name, label: typeof row.label === "string" && row.label ? row.label.slice(0, 120) : name, default: row.default,
               ceiling: typeof row.ceiling === "number" && Number.isFinite(row.ceiling) ? row.ceiling : null,
               cost: typeof row.cost === "string" ? row.cost.slice(0, 300) : "" });
  }
  return out;
}

/** dev_limits as set_config takes it: only the limits that were set. An empty one is its default, so it is left out.
 *  A number in text becomes that number; anything else goes as it is, for DGC to refuse in its own words. */
export function devLimitValues(raw: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { return out; }
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || value === undefined) { continue; }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) { continue; }
      out[name] = Number.isFinite(Number(text)) ? Number(text) : text;
    } else { out[name] = value; }
  }
  return out;
}

/** What the page shows for the two settings: DGC's own answer where its config says them, else what this editor last
 *  saved. */
export function devShown(config: any, saved: any): { dev_mode: boolean; dev_limits: Record<string, unknown> } {
  const kept = saved && typeof saved === "object" ? saved : {};
  const own = (value: any) => value && typeof value === "object" && !Array.isArray(value);
  return { dev_mode: typeof config?.dev_mode === "boolean" ? config.dev_mode : kept.dev_mode === true,
           dev_limits: { ...(own(config?.dev_limits) ? config.dev_limits : own(kept.dev_limits) ? kept.dev_limits : {}) } };
}

/** "Let DGC change Dev Mode settings" (config key dev_mode_tools; off unless the user turns it on): whether this DGC
 *  takes the key in set_config. It says so (ready.capabilities.dev_mode_tools); one that doesn't refuses a whole save
 *  for a key it doesn't know, so the switch isn't shown and the key is never sent. */
export function devToolsOffered(capabilities: any): boolean {
  return devLimitsTable(capabilities).length > 0 && Number(capabilities?.dev_mode_tools) >= 1;
}

/** What the switch shows: DGC's own answer where its config says it, else what this editor last saved. */
export function devToolsShown(config: any, saved: any): boolean {
  if (typeof config?.dev_mode_tools === "boolean") { return config.dev_mode_tools; }
  return !!saved && typeof saved === "object" && saved.dev_mode_tools === true;
}

/** "Work on a subscription uses DGC's tools" (config key dev_subscription_tools, off unless the user turns it on): with
 *  Dev Mode on, Claude Code or Codex is Work's model only and DGC's tools do the work. Its warning shows once here. */
export const DEV_SUB_WARNED_KEY = "dgc.devSubscriptionWarned.v1";

/** What this DGC says of it (ready.capabilities.dev_subscription_tools): the switch as the chat opened, whether it is in
 *  force (with Dev Mode), and the CLIs it applies to. Null from a DGC without it. */
export interface DevSubTools { set: boolean; on: boolean; engines: string[] }
export function devSubTools(capabilities: any): DevSubTools | null {
  const raw = capabilities && typeof capabilities === "object" ? capabilities.dev_subscription_tools : undefined;
  if (!raw || typeof raw !== "object" || Number(raw.version) < 1) { return null; }
  const engines = Array.isArray(raw.engines) ? raw.engines.filter((e: unknown) => typeof e === "string" && /^[a-z]{1,16}$/.test(e)).slice(0, 8) : [];
  return { set: raw.set === true, on: raw.on === true, engines };
}

/** Whether this DGC takes the key in set_config (one that doesn't refuses a whole save for it). */
export function devSubOffered(capabilities: any): boolean {
  return devLimitsTable(capabilities).length > 0 && devSubTools(capabilities) !== null;
}

// What this editor saved since its chats opened, for every panel in this window (a chat's capability says the switch
// as that chat opened), and who hears it: each Work tab, so steering and the context meter follow it at once.
let savedHere: boolean | undefined;
const listeners = new Set<(on: boolean) => void>();

/** What the switch shows: what this editor last saved, else the switch as DGC said it when the chat opened. */
export function devSubShown(capabilities: any): boolean {
  return savedHere ?? devSubTools(capabilities)?.set ?? false;
}

/** A save of Settings › Dev Mode went through: every Work tab hears whether the switch is now in force. */
export function devSubSaved(devMode: boolean, set: boolean): void {
  savedHere = set;
  for (const listener of [...listeners]) {
    try { listener(devMode && set); } catch { /* one tab never stops the rest */ }
  }
}

export function onDevSubSaved(listener: (on: boolean) => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}
