/**
 * Private SDK state: the `stateDir` tree and the isolated config each session starts from.
 * Mirrors sdk/python/dgc_sdk/_state.py.
 *
 * The isolated `home/.dgc/config.json` is owned by the SDK. Every session rewrites it from
 * scratch, under a lock, from the options the embedder passed; nothing a previous session, run,
 * or another local user left in that file is merged back in. That keeps per-session options
 * (model, verifier, run budgets, trusted_dirs) out of later sessions, and stops a planted file
 * from running commands (`verify_command`, `autonomous_gate`, `hooks`...). Extra CLI settings
 * are allowed only when passed explicitly (`new DGC({ extraConfig })`).
 */
import {
  chmodSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
  constants as fsConstants,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DGCConfigError } from "./errors.ts";

function posixOwnerChecks(): boolean {
  return process.platform !== "win32" && typeof process.geteuid === "function";
}

/** True for this user's own primary group with no other listed members (umask 002 hosts). */
function privateGroup(gid: number): boolean {
  try {
    if (typeof process.getegid !== "function" || gid !== process.getegid()) return false;
    const name = userInfo().username;
    for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 4 && Number(parts[2]) === gid) {
        return parts[3].split(",").filter(Boolean).every((member) => member === name);
      }
    }
    return true;   // the group is not listed: nobody else is a member by name
  } catch {
    return false;
  }
}

/** Create `path` (and missing parents) and leave it owner-only (0700). */
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      if ((statSync(path).mode & 0o777) !== 0o700) chmodSync(path, 0o700);
    } catch { /* best effort */ }
  }
  return path;
}

/**
 * A private state directory, created when needed.
 *
 * `undefined` makes a fresh `mkdtemp` directory (0700). An existing directory must be owned by
 * this user and must not be group- or world-writable; a readable one that we own is tightened
 * to 0700. Anything else is refused, because another local user could have planted files the
 * DGC child would read.
 */
export function prepareStateDir(stateDir?: string): string {
  if (stateDir === undefined || stateDir === null) {
    return realpathSync(mkdtempSync(join(tmpdir(), "dgc-sdk-")));
  }
  if (typeof stateDir !== "string" || !stateDir.trim()) {
    throw new DGCConfigError("stateDir must be a non-empty path");
  }
  let path = resolve(stateDir.startsWith("~/") ? join(userInfo().homedir, stateDir.slice(2)) : stateDir);
  const existed = existsSync(path);
  if (existed && !statSync(path).isDirectory()) {
    throw new DGCConfigError(`stateDir ${JSON.stringify(path)} exists and is not a directory`);
  }
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new DGCConfigError(`could not create stateDir ${JSON.stringify(path)}: ${String(error)}`);
  }
  path = realpathSync(path);
  if (posixOwnerChecks()) {
    const info = statSync(path);
    if (info.uid !== process.geteuid!()) {
      throw new DGCConfigError(
        `stateDir ${JSON.stringify(path)} is owned by another user; use a directory you own `
        + "(or leave stateDir unset for a private temporary one)");
    }
    const mode = info.mode & 0o777;
    if (existed && ((mode & 0o002) || ((mode & 0o020) && !privateGroup(info.gid)))) {
      throw new DGCConfigError(
        `stateDir ${JSON.stringify(path)} is group- or world-writable (mode ${mode.toString(8)}); `
        + "files in it cannot be trusted. Use a private directory (mode 0700)");
    }
    if (mode !== 0o700) {
      try {
        chmodSync(path, 0o700);
      } catch (error) {
        throw new DGCConfigError(`could not make stateDir ${JSON.stringify(path)} private: ${String(error)}`);
      }
    }
  }
  return path;
}

export function configPath(stateDir: string): string {
  return join(stateDir, "home", ".dgc", "config.json");
}

/**
 * Serialize isolated-config writes and child startups for one stateDir within this process.
 * (The Python SDK also takes a cross-process flock; Node has none, so use one stateDir per
 * process. A config another process rewrote while a session started is still detected and the
 * start is retried.)
 */
export class StateLock {
  private tail: Promise<void> = Promise.resolve();

  async hold<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const previous = this.tail;
    this.tail = previous.then(() => gate);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

const LOCKS = new Map<string, StateLock>();

export function stateLock(stateDir: string): StateLock {
  const key = resolve(stateDir);
  let lock = LOCKS.get(key);
  if (!lock) {
    lock = new StateLock();
    LOCKS.set(key, lock);
  }
  return lock;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Atomically replace the isolated config.json with exactly `values` (undefined/null dropped).
 * Hold {@link stateLock} while calling. Directories are 0700 and the file is 0600. Returns the
 * values as they read back from JSON, for {@link configDrift}.
 */
export function writeSessionConfig(stateDir: string, values: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) payload[key] = value;
  }
  const text = JSON.stringify(sortKeys(payload), null, 2) + "\n";
  const home = privateDir(join(stateDir, "home"));
  const folder = privateDir(join(home, ".dgc"));
  const path = join(folder, "config.json");
  const tmp = join(folder, `.config.json.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed */ }
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

/**
 * Keys of `expected` whose value in the isolated config.json now differs. A DGC child saves its
 * whole configuration when it persists anything; if another session's child did that between
 * our write and our child's startup, our child may have loaded that session's options.
 */
export function configDrift(stateDir: string, expected: Record<string, unknown>): string[] {
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(configPath(stateDir), "utf8"));
  } catch {
    return ["config.json"];
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return ["config.json"];
  const record = current as Record<string, unknown>;
  return Object.keys(expected).filter((key) => !same(record[key], expected[key])).sort();
}

/** Append `line` to an owner-only (0600) file, tightening an existing file's mode. */
export function appendPrivate(path: string, line: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600);
  try {
    if (process.platform !== "win32") {
      try {
        if (fstatSync(fd).mode & 0o077) fchmodSync(fd, 0o600);
      } catch { /* best effort */ }
    }
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}
