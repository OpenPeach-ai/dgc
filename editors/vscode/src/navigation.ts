import { realpath, stat } from "fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "path";
import { readBoundedFile } from "./boundedFile";

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

const THUMB_TYPES: Record<string, string> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp" };
export const THUMB_MAX_BYTES = 8 * 1024 * 1024;

/** A shown image's picture for its chat tile, as a data URL; "" for anything else. The same path check as opening
 * the file, then raster images only (SVG can carry script) and nothing over 8 MB. */
export async function workspaceImage(value: unknown, roots: string[]): Promise<string> {
  const target = await workspaceFile(value, roots);
  const type = target ? THUMB_TYPES[extname(target).toLowerCase()] : undefined;
  if (!target || !type) return "";
  const bytes = await readBoundedFile(target, THUMB_MAX_BYTES);
  return bytes ? `data:image/${type};base64,${bytes.toString("base64")}` : "";
}
