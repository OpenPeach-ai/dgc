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
