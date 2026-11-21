/** Moving a file to the trash where the editor can't (19 Nov: removing a Library picture over Remote-SSH said "Unable to
 *  delete file ... via trash because provider does not support it"). The editor's own trash is tried first; where the
 *  computer the file is on has none the editor can reach, the file goes to that computer's own trash folder (the
 *  freedesktop one: ~/.local/share/Trash, with its .trashinfo), so it can still be restored. Never a delete outright. */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";

/** The trash folder's own spelling of a path: each byte outside the safe set as %XX. */
const trashPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const stamp = (now: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
};

/** Move `path` into `home`'s trash; returns where it went. A name already there gets " 2", " 3"… before its extension. */
export async function moveToComputersTrash(path: string, home = homedir(), now = new Date()): Promise<string> {
  const files = join(home, ".local", "share", "Trash", "files"), info = join(home, ".local", "share", "Trash", "info");
  await fs.mkdir(files, { recursive: true, mode: 0o700 });
  await fs.mkdir(info, { recursive: true, mode: 0o700 });
  const ext = extname(path), stem = basename(path, ext);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`;
    const record = join(info, `${name}.trashinfo`);
    try {
      // The record first, made exclusively: two removals at once never take one name.
      await fs.writeFile(record, `[Trash Info]\nPath=${trashPath(path)}\nDeletionDate=${stamp(now)}\n`, { flag: "wx", mode: 0o600 });
    } catch (err: any) {
      if (err?.code === "EEXIST") continue;
      throw err;
    }
    try {
      await fs.rename(path, join(files, name));
    } catch (err) {
      await fs.rm(record, { force: true });
      throw err;
    }
    return join(files, name);
  }
  throw new Error(`The trash in ${dirname(files)} has too many files named ${stem}${ext}.`);
}

/** The editor's trash, else the computer's own (a remote one whose file access has no trash). */
export async function trashFile(deleteWithTrash: () => Thenable<void> | Promise<void>, path: string,
                                home = homedir()): Promise<void> {
  try {
    await deleteWithTrash();
  } catch (err: any) {
    if (!/does not support|not supported|trash/i.test(String(err?.message || err))) throw err;
    await moveToComputersTrash(path, home);
  }
}
