import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

export function defaultRuntime(): string[] {
  const python = process.env.DGC_PYTHON
    || (existsSync(join(REPO_ROOT, ".venv/bin/python")) ? join(REPO_ROOT, ".venv/bin/python") : "python3");
  return [python, "-m", "dgc", "serve"];
}

export function isolatedEnv(
  stateDir: string,
  extra?: Record<string, string>,
  inherit = false,
  projectRoot?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
  if (!inherit) {
    delete env.DGC_API_KEY;
    delete env.DGC_SEARCH_API_KEY;
    delete env.DGC_SUBAGENT_API_KEY;
    delete env.DGC_FALLBACK_API_KEY;
    const home = join(stateDir, "home");
    mkdirSync(join(home, ".dgc"), { recursive: true });
    mkdirSync(join(home, ".config"), { recursive: true });
    mkdirSync(join(home, ".local/share"), { recursive: true });
    mkdirSync(join(home, ".local/state"), { recursive: true });
    env.HOME = home;
    env.USERPROFILE = home;
    env.DGC_HOME = home;
    env.DGC_SDK_ISOLATED = "1";
    if (projectRoot) env.DGC_PROJECT_ROOT = projectRoot;
    env.XDG_CONFIG_HOME = join(home, ".config");
    env.XDG_DATA_HOME = join(home, ".local/share");
    env.XDG_STATE_HOME = join(home, ".local/state");
  }
  Object.assign(env, extra);
  const pathParts = [REPO_ROOT];
  if (env.PYTHONPATH) pathParts.push(env.PYTHONPATH);
  env.PYTHONPATH = pathParts.join(":");
  return env;
}

export function writeIsolatedConfig(stateDir: string, values: Record<string, unknown>): void {
  const dir = join(stateDir, "home", ".dgc");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const loaded = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (loaded && typeof loaded === "object") current = loaded as Record<string, unknown>;
    } catch {
      /* start fresh if the isolated file is corrupt */
    }
  }
  const incoming = { ...values };
  if ("trusted_dirs" in incoming || "trusted_dirs" in current) {
    const merged: string[] = [];
    for (const item of [
      ...((current.trusted_dirs as unknown[]) || []),
      ...((incoming.trusted_dirs as unknown[]) || []),
    ]) {
      const text = String(item || "");
      if (text && !merged.includes(text)) merged.push(text);
    }
    incoming.trusted_dirs = merged;
  }
  writeFileSync(path, JSON.stringify({ ...current, ...incoming }, null, 2) + "\n");
}
