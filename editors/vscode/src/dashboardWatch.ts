// A dashboard that stays live: how often it refreshes by itself (its page keeps the timer, media/artifact.js), and,
// when it refreshes on its files' change, the watch on them here. The editor keeps the choice per dashboard (it isn't a
// change to the dashboard). Only the files the dashboard reads are watched, and only while its panel is open.
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/** "" (by hand), every 1/5/15/60 minutes, or when its files change. */
export const REFRESH_EVERY: ReadonlySet<string> = new Set(["", "1m", "5m", "15m", "60m", "files"]);

/** A choice from the page, or undefined when it isn't one. */
export function cleanEvery(value: unknown): string | undefined {
  return typeof value === "string" && REFRESH_EVERY.has(value) ? value : undefined;
}

/** The files a dashboard reads, as paths here: absolute ones as they are, relative ones under its project (none
 *  without a project). At most 20, each at most 1000 characters. */
export function filePaths(files: unknown, project?: string): string[] {
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const item of files.slice(0, 20)) {
    if (typeof item !== "string" || !item || item.length > 1000 || item.includes("\0")) continue;
    const path = isAbsolute(item) ? item : project && isAbsolute(project) ? join(project, item) : "";
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Watch these files; `onChange` once a burst of changes has settled (an editor's save is a few events, and some save
 *  by writing a new file and renaming it over the old: so the folder is watched, for the file's name). Returns the stop. */
export function watchFiles(paths: string[], onChange: () => void, settleMs = 1500): () => void {
  const byFolder = new Map<string, Set<string>>();
  for (const path of paths) {
    const folder = dirname(path);
    if (!byFolder.has(folder)) byFolder.set(folder, new Set());
    byFolder.get(folder)!.add(basename(path));
  }
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const changed = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; if (!stopped) onChange(); }, settleMs);
    timer.unref?.();
  };
  for (const [folder, names] of byFolder) {
    try {
      const w = watch(folder, { persistent: false }, (_event, name) => { if (name && names.has(String(name))) changed(); });
      w.on("error", () => { try { w.close(); } catch { /* gone */ } });
      watchers.push(w);
    } catch { /* a folder that isn't there: nothing to watch */ }
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
  };
}
