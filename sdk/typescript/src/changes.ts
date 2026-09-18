/**
 * What a run changed under the session cwd. Mirrors the workspace-change code in
 * sdk/python/dgc_sdk/session.py.
 *
 * Only VCS metadata and dependency/tool caches are skipped. Everything else under the session cwd
 * is reported, including dot-directories (.github), lockfiles and directories named home/ or
 * locks/. The SDK's own stateDir (and, when inheriting user state, ~/.dgc) is skipped by absolute
 * path when it lives under the cwd. Each change carries the before/after text (up to 1 MB) and a
 * `git apply`-able unified diff.
 */
import {
  closeSync, constants as fsConstants, lstatSync, openSync, readdirSync, readSync, statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { FileChange } from "./types.ts";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", ".mypy_cache",
  ".pytest_cache", ".ruff_cache",
]);
const TEXT_LIMIT = 1_000_000;               // bytes kept per file for before/after/diff
const SNAPSHOT_BUDGET = 64 * 1024 * 1024;   // before-content kept per run
const CONTEXT = 3;

export type FileState = { mtimeNs: bigint; size: number; mode: number; content: Uint8Array | null };
export type Snapshot = Map<string, FileState>;

function normcase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function readRegular(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    let total = 0;
    while (total < buffer.length) {
      const got = readSync(fd, buffer, total, buffer.length - total, null);
      if (!got) break;
      total += got;
    }
    return buffer.subarray(0, total);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** relpath -> state. Bounded to the session cwd, not a parent git tree. No symlink is followed. */
export function snapshotWorkspace(root: string | null, exclude: readonly string[] = [],
  keepContent = true): Snapshot {
  const snap: Snapshot = new Map();
  if (!root) return snap;
  try {
    if (!statSync(root).isDirectory()) return snap;
  } catch {
    return snap;
  }
  const base = resolve(root);
  const skip = new Set(exclude.map((item) => normcase(resolve(item))));
  let budget = keepContent ? SNAPSHOT_BUDGET : 0;
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (skip.has(normcase(path))) continue;
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        // Like os.walk: a link to a directory is listed with the directories (not descended).
        try { isDir = statSync(path).isDirectory(); } catch { isDir = false; }
        if (isDir) continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(entry.name)) subdirs.push(entry.name);
        continue;
      }
      let info;
      try {
        info = lstatSync(path, { bigint: true });
      } catch {
        continue;
      }
      const size = Number(info.size);
      let content: Buffer | null = null;
      if (budget > 0 && info.isFile() && size <= TEXT_LIMIT && size <= budget) {
        content = readRegular(path);
        if (content !== null) budget -= content.length;
      }
      snap.set(rel ? `${rel}/${entry.name}` : entry.name, {
        mtimeNs: info.mtimeNs, size, mode: Number(info.mode), content,
      });
    }
    for (const name of subdirs) walk(join(dir, name), rel ? `${rel}/${name}` : name);
  };
  walk(base, "");
  return snap;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left.buffer, left.byteOffset, left.byteLength)
    .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
}

function asText(payload: Uint8Array | null): string | null {
  if (payload === null || payload.length > TEXT_LIMIT || payload.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  const parts = text.split("\n");
  const lines = parts.slice(0, -1).map((part) => part + "\n");
  const last = parts[parts.length - 1];
  if (last) lines.push(last);
  return lines;
}

function gitPath(prefix: string, rel: string): string {
  const path = `${prefix}/${rel}`;
  // eslint-disable-next-line no-control-regex
  if (/["\\\t\n]/.test(path) || [...path].some((ch) => ch.charCodeAt(0) < 32)) {
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    return `"${escaped}"`;
  }
  return path;
}

function fileMode(mode: number): string {
  return mode & 0o111 ? "100755" : "100644";
}

type Op = { kind: "=" | "-" | "+"; line: string };

/** A line edit script (Myers, O(ND)); a very different pair falls back to replace-all. */
function editScript(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head: Op[] = a.slice(0, start).map((line) => ({ kind: "=", line }));
  const tail: Op[] = a.slice(endA).map((line) => ({ kind: "=", line }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const n = x.length;
  const m = y.length;
  const middle: Op[] = [];
  const replaceAll = () => {
    for (const line of x) middle.push({ kind: "-", line });
    for (const line of y) middle.push({ kind: "+", line });
  };
  // Past this many edits the pair is treated as rewritten (still a valid, applicable diff).
  const maxD = Math.min(n + m, 2000);
  if (n === 0 || m === 0) {
    replaceAll();
    return [...head, ...middle, ...tail];
  }
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  // trace[d] keeps the frontier before round d, for diagonals -d-1..d+1 only (O(D^2) memory).
  const trace: Int32Array[] = [];
  const at = (frame: Int32Array, d: number, k: number) => frame[k + d + 1];
  let found = -1;
  for (let d = 0; d <= maxD && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let px: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) px = v[offset + k + 1];
      else px = v[offset + k - 1] + 1;
      let py = px - k;
      while (px < n && py < m && x[px] === y[py]) {
        px += 1;
        py += 1;
      }
      v[offset + k] = px;
      if (px >= n && py >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    replaceAll();
    return [...head, ...middle, ...tail];
  }
  // Backtrack through the saved frontiers.
  const reversed: Op[] = [];
  let px = n;
  let py = m;
  for (let d = found; d > 0; d--) {
    const frame = trace[d];
    const k = px - py;
    const down = k === -d || (k !== d && at(frame, d, k - 1) < at(frame, d, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(frame, d, prevK);
    const prevY = prevX - prevK;
    while (px > prevX && py > prevY) {
      px -= 1;
      py -= 1;
      reversed.push({ kind: "=", line: x[px] });
    }
    if (down) {
      py -= 1;
      reversed.push({ kind: "+", line: y[py] });
    } else {
      px -= 1;
      reversed.push({ kind: "-", line: x[px] });
    }
  }
  while (px > 0 && py > 0) {
    px -= 1;
    py -= 1;
    reversed.push({ kind: "=", line: x[px] });
  }
  middle.push(...reversed.reverse());
  return [...head, ...middle, ...tail];
}

function formatRange(start: number, length: number): string {
  let beginning = start + 1;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

function withEol(line: string): string {
  return line.endsWith("\n") ? line : line + "\n\\ No newline at end of file\n";
}

/** Unified hunks (3 lines of context) for two line lists, in difflib's format. */
export function unifiedHunks(a: string[], b: string[]): string[] {
  const ops = editScript(a, b);
  const changed: number[] = [];
  ops.forEach((op, index) => { if (op.kind !== "=") changed.push(index); });
  if (!changed.length) return [];
  const groups: Array<[number, number]> = [];
  let groupStart = Math.max(0, changed[0] - CONTEXT);
  let groupEnd = Math.min(ops.length, changed[0] + CONTEXT + 1);
  for (const index of changed.slice(1)) {
    if (index - CONTEXT <= groupEnd) {
      groupEnd = Math.min(ops.length, index + CONTEXT + 1);
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = index - CONTEXT;
      groupEnd = Math.min(ops.length, index + CONTEXT + 1);
    }
  }
  groups.push([groupStart, groupEnd]);
  // Line numbers before each op.
  const aAt: number[] = [];
  const bAt: number[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    aAt.push(ai);
    bAt.push(bi);
    if (op.kind !== "+") ai += 1;
    if (op.kind !== "-") bi += 1;
  }
  const out: string[] = [];
  for (const [from, to] of groups) {
    const slice = ops.slice(from, to);
    const aLen = slice.filter((op) => op.kind !== "+").length;
    const bLen = slice.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${formatRange(aAt[from], aLen)} +${formatRange(bAt[from], bLen)} @@\n`);
    for (const op of slice) out.push(withEol((op.kind === "=" ? " " : op.kind) + op.line));
  }
  return out;
}

/** A `git apply`-able diff for one text file, or "" when either side is not text. */
export function unifiedDiff(rel: string, kind: FileChange["kind"], before: string | null,
  after: string | null, modeBefore: number, modeAfter: number): string {
  if ((kind !== "added" && before === null) || (kind !== "deleted" && after === null)) return "";
  const oldLines = kind !== "added" ? splitLines(before || "") : [];
  const newLines = kind !== "deleted" ? splitLines(after || "") : [];
  const aName = gitPath("a", rel);
  const bName = gitPath("b", rel);
  const header = [`diff --git ${aName} ${bName}\n`];
  if (kind === "added") header.push(`new file mode ${fileMode(modeAfter)}\n`);
  else if (kind === "deleted") header.push(`deleted file mode ${fileMode(modeBefore)}\n`);
  else if (fileMode(modeBefore) !== fileMode(modeAfter)) {
    header.push(`old mode ${fileMode(modeBefore)}\nnew mode ${fileMode(modeAfter)}\n`);
  }
  const hunks = unifiedHunks(oldLines, newLines);
  const body = hunks.length
    ? [`--- ${kind === "added" ? "/dev/null" : aName}\n`, `+++ ${kind === "deleted" ? "/dev/null" : bName}\n`, ...hunks]
    : [];
  if (!body.length && kind === "modified" && header.length === 1) return "";
  return [...header, ...body].join("");
}

function isRegular(mode: number): boolean {
  return (mode & 0o170000) === 0o100000;
}

/**
 * Changes from `before` to `after` (a snapshot taken when the run's last turn ended; a fresh one
 * when omitted). With `after` given, its kept content is used, so edits a later turn made in the
 * meantime are not attributed to this run.
 */
export function diffWorkspace(root: string | null, before: Snapshot, exclude: readonly string[] = [],
  afterSnapshot?: Snapshot | null): FileChange[] {
  const after = afterSnapshot ?? snapshotWorkspace(root, exclude, false);
  const rootText = root ? resolve(root) : "";
  const changes: FileChange[] = [];
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const rel of names) {
    const old = before.get(rel);
    const now = after.get(rel);
    let kind: FileChange["kind"];
    if (!now && old) kind = "deleted";
    else if (!old && now) kind = "added";
    else if (old && now && (old.mtimeNs !== now.mtimeNs || old.size !== now.size || old.mode !== now.mode)) {
      kind = "modified";
    } else continue;
    const oldMode = old ? old.mode : 0;
    const newMode = now ? now.mode : 0;
    let afterBytes: Uint8Array | null = null;
    if (now && isRegular(newMode) && root) afterBytes = now.content ?? readRegular(join(root, rel));
    if (kind === "modified" && old && old.content !== null && afterBytes !== null
        && sameBytes(afterBytes, old.content) && oldMode === newMode) {
      continue;          // touched, not changed
    }
    const beforeText = old ? asText(old.content) : "";
    let afterText = now ? asText(afterBytes) : "";
    if (kind === "added" && !isRegular(newMode)) afterText = null;
    const diff = unifiedDiff(rel, kind, beforeText, afterText, oldMode, newMode);
    changes.push({ path: rel, kind, before: beforeText || "", after: afterText || "", root: rootText, diff });
  }
  return changes;
}
