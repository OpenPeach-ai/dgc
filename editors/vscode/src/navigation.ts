import { realpath, stat } from "fs/promises";
import { isAbsolute, relative, resolve, sep } from "path";

/** Resolve a clicked file against the current workspace, including symlink boundaries. */
export async function workspaceFile(value: unknown, roots: string[]): Promise<string | undefined> {
  if (typeof value !== "string" || !value || value.length > 8192
      || /[\u0000-\u001f\u007f]/.test(value) || !roots.length) return;
  const allowed = await Promise.all(roots.map(root => realpath(root).catch(() => "")));
  const candidates = isAbsolute(value) ? [value] : roots.map(root => resolve(root, value));
  for (const candidate of candidates) {
    const canonical = await realpath(candidate).catch(() => "");
    if (!canonical || !allowed.some(root => {
      if (!root) return false;
      const path = relative(root, canonical);
      return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    })) continue;
    if ((await stat(canonical).catch(() => undefined))?.isFile()) return canonical;
  }
}
