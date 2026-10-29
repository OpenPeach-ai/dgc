/** A small, owner-local index of projects the user chose to keep in Work. No project files are copied. */
import { constants } from "fs";
import * as fs from "fs/promises";
import { homedir } from "os";
import * as path from "path";
import { randomBytes } from "crypto";

export type WorkApp = {
  id: string;
  name: string;
  projectRoot: string;
  url: string;
  healthUrl: string;
  addedAt: string;
};

const ID = /^app_[a-f0-9]{16}$/;
const MAX_APPS = 32;
const MAX_FILE = 128 * 1024;

export function workAppsFile(): string {
  const home = path.join(process.env.DGC_HOME && path.isAbsolute(process.env.DGC_HOME)
    ? process.env.DGC_HOME : homedir(), ".dgc");
  return path.join(home, "work_apps", "v1.json");
}

function address(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Give an HTTP or HTTPS app address.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Give a complete app address, including http:// or https://."); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash)
    throw new Error("The app address must be HTTP or HTTPS, without credentials or a fragment.");
  return parsed.toString();
}

function checked(raw: unknown): WorkApp | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || !ID.test(row.id)
    || typeof row.name !== "string" || !row.name.trim() || row.name.length > 80
    || typeof row.projectRoot !== "string" || !path.isAbsolute(row.projectRoot)
    || typeof row.addedAt !== "string" || !Number.isFinite(Date.parse(row.addedAt))) return;
  try {
    const url = address(row.url), healthUrl = address(row.healthUrl);
    if (new URL(url).origin !== new URL(healthUrl).origin) return;
    return { id: row.id, name: row.name.trim(), projectRoot: row.projectRoot, url, healthUrl, addedAt: row.addedAt };
  } catch { return; }
}

export async function listWorkApps(file = workAppsFile()): Promise<WorkApp[]> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  try {
    if ((await handle.stat()).size > MAX_FILE) throw new Error("The Apps index is unexpectedly large.");
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (parsed?.version !== 1 || !Array.isArray(parsed.apps) || parsed.apps.length > MAX_APPS)
      throw new Error("The Apps index has an unsupported format.");
    const result = parsed.apps.map(checked);
    if (result.some((item: WorkApp | undefined) => !item)) throw new Error("The Apps index contains an invalid entry.");
    const seen = new Set<string>();
    for (const item of result as WorkApp[]) {
      if (seen.has(item.id)) throw new Error("The Apps index contains a duplicate ID.");
      seen.add(item.id);
    }
    return result as WorkApp[];
  } finally { await handle.close(); }
}

async function writeWorkApps(apps: WorkApp[], file: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const name = path.join(dir, `.v1-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(name, JSON.stringify({ version: 1, apps }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(name, file);
    if (process.platform !== "win32") await fs.chmod(file, 0o600);
  } finally { await fs.rm(name, { force: true }); }
}

export async function addWorkApp(input: { name: string; projectRoot: string; url: string; healthUrl?: string },
                                 file = workAppsFile()): Promise<WorkApp> {
  const name = String(input.name || "").trim();
  if (!name || name.length > 80) throw new Error("Give the app a name of at most 80 characters.");
  const root = await fs.realpath(input.projectRoot);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Choose the app's project folder.");
  const url = address(input.url), healthUrl = address(input.healthUrl || input.url);
  if (new URL(url).origin !== new URL(healthUrl).origin) throw new Error("The health check must use the app's origin.");
  const apps = await listWorkApps(file);
  if (apps.some((app) => app.projectRoot === root && app.url === url)) throw new Error("That project and address are already in Apps.");
  if (apps.length >= MAX_APPS) throw new Error("Apps is full (32 projects).");
  const app = { id: `app_${randomBytes(8).toString("hex")}`, name, projectRoot: root, url, healthUrl,
                addedAt: new Date().toISOString() };
  await writeWorkApps([...apps, app], file);
  return app;
}

export async function removeWorkApp(id: string, file = workAppsFile()): Promise<boolean> {
  if (!ID.test(id)) return false;
  const apps = await listWorkApps(file);
  if (!apps.some((app) => app.id === id)) return false;
  await writeWorkApps(apps.filter((app) => app.id !== id), file);
  return true;
}
