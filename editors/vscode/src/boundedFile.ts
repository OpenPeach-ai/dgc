import * as fs from "fs";
import * as path from "path";

type Opened = { fd: number; target: string; before: fs.BigIntStats; buffer: Buffer };

function close(fd: number): void {
  try { fs.closeSync(fd); } catch { /* preserve the original read failure */ }
}

function same(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Linux has no Node openat API. Its descriptor paths let us walk held directories without
 * following mutable parent symlinks. Elsewhere, validate the canonical path and file identity
 * before and after the read; this is best-effort parent-race detection, not openat confinement. */
function openCanonical(target: string): number {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  if (process.platform !== "linux") return fs.openSync(target, flags);
  const dirFlags = flags | fs.constants.O_DIRECTORY;
  const anchor = path.parse(target).root;
  let parent = fs.openSync(anchor, dirFlags);
  try {
    const relative = path.relative(anchor, path.dirname(target));
    for (const part of relative ? relative.split(path.sep) : []) {
      const child = fs.openSync(`/proc/self/fd/${parent}/${part}`, dirFlags);
      close(parent);
      parent = child;
    }
    return fs.openSync(`/proc/self/fd/${parent}/${path.basename(target)}`, flags);
  } finally { close(parent); }
}

function open(target: string, maximum: number): Opened {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || !path.isAbsolute(target)
      || path.resolve(target) !== target) throw new Error("Expected a canonical path and byte limit");
  const before = fs.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maximum) || fs.realpathSync(target) !== target)
    throw new Error("File is not a bounded canonical regular file");
  const fd = openCanonical(target);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !same(before, opened)) throw new Error("File changed before reading");
    // One extra byte detects growth without allocating or reading the growing file in full.
    return { fd, target, before, buffer: Buffer.alloc(Number(before.size) + 1) };
  } catch (error) { close(fd); throw error; }
}

function finish(file: Opened, total: number): Buffer | undefined {
  if (BigInt(total) !== file.before.size || fs.realpathSync(file.target) !== file.target
      || !same(file.before, fs.fstatSync(file.fd, { bigint: true }))
      || !same(file.before, fs.lstatSync(file.target, { bigint: true }))) return;
  return file.buffer.subarray(0, total);
}

/** Read a previously authorized canonical file. No path permission is granted by this helper. */
export async function readBoundedFile(target: string, maximum: number): Promise<Buffer | undefined> {
  let file: Opened | undefined;
  try {
    file = open(target, maximum);
    const held = file;
    let total = 0;
    while (total < held.buffer.length) {
      const bytes = await new Promise<number>((resolve, reject) => {
        fs.read(held.fd, held.buffer, total, Math.min(65_536, held.buffer.length - total), total,
          (error, read) => error ? reject(error) : resolve(read));
      });
      if (!bytes) break;
      total += bytes;
    }
    return finish(held, total);
  } catch { return undefined; }
  finally { if (file) close(file.fd); }
}

/** Small installed assets use the same descriptor/size checks without asynchronous host callbacks. */
export function readBoundedFileSync(target: string, maximum: number): Buffer | undefined {
  let file: Opened | undefined;
  try {
    file = open(target, maximum);
    let total = 0;
    while (total < file.buffer.length) {
      const bytes = fs.readSync(file.fd, file.buffer, total, Math.min(65_536, file.buffer.length - total), total);
      if (!bytes) break;
      total += bytes;
    }
    return finish(file, total);
  } catch { return undefined; }
  finally { if (file) close(file.fd); }
}
