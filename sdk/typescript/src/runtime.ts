import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

/** True when this file runs from a DGC source checkout (sdk/typescript inside the repository). */
export function isCheckout(): boolean {
  return existsSync(join(REPO_ROOT, "dgc", "__init__.py"))
    && existsSync(join(REPO_ROOT, "sdk", "typescript", "package.json"));
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The installed CLI launcher: `dgc` on PATH, then the vibedgc.com installer's ~/.local/bin/dgc. */
export function installedLauncher(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (dir && executable(join(dir, "dgc"))) return join(dir, "dgc");
  }
  const local = join(env.HOME || homedir(), ".local", "bin", "dgc");
  return executable(local) ? local : undefined;
}

/**
 * How to start `dgc serve`: DGC_PYTHON, then this checkout's .venv (source checkouts only),
 * then the installed `dgc` launcher, then `python3 -m dgc`. The ready handshake checks the
 * protocol either way.
 */
export function defaultRuntime(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.DGC_PYTHON) return [env.DGC_PYTHON, "-m", "dgc", "serve"];
  const checkoutPython = join(REPO_ROOT, ".venv/bin/python");
  if (isCheckout() && existsSync(checkoutPython)) return [checkoutPython, "-m", "dgc", "serve"];
  const launcher = installedLauncher(env);
  if (launcher) return [launcher, "serve"];
  return ["python3", "-m", "dgc", "serve"];
}

/** Host variables every runtime child receives: program lookup, locale, terminal, time zone,
 *  temp and certificate locations. None is a credential; anything else must be passed on purpose
 *  (`extraEnv`, `inheritEnv`). Mirrors the Python SDK's BASE_ENV. */
export const BASE_ENV: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "LC_MESSAGES", "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY", "TERM", "COLORTERM",
  "NO_COLOR", "TZ", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "PATHEXT",
]);
const SECRET_ENV = ["DGC_API_KEY", "DGC_SEARCH_API_KEY", "DGC_SUBAGENT_API_KEY", "DGC_FALLBACK_API_KEY"];

/**
 * The runtime child's environment. `inheritEnv` false (default) passes only BASE_ENV, a list of
 * names adds those host variables, true passes everything (the host DGC_*_API_KEY values are
 * still dropped in isolated mode). With `inherit` (inheritUserState) DGC_* and XDG_* variables
 * pass too, since they locate the user's own DGC state.
 */
export function isolatedEnv(
  stateDir: string,
  extra?: Record<string, string>,
  inherit = false,
  projectRoot?: string,
  inheritEnv: boolean | readonly string[] = false,
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv;
  if (inheritEnv === true) {
    env = { ...hostEnv };
  } else {
    env = {};
    for (const [key, value] of Object.entries(hostEnv)) {
      const upper = key.toUpperCase();
      if (BASE_ENV.has(upper) || (inherit && (upper.startsWith("DGC_") || upper.startsWith("XDG_")))) {
        env[key] = value;
      }
    }
    for (const name of inheritEnv || []) {
      if (!name || name.includes("=") || name.includes("\0")) {
        throw new Error(`inheritEnv has an invalid variable name: ${JSON.stringify(name)}`);
      }
      if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
    }
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  if (!inherit) {
    for (const key of SECRET_ENV) delete env[key];
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
  // Only a source checkout puts its own dgc/ on the child's path. An installed package must not:
  // REPO_ROOT is then node_modules, and anything importable there would shadow the CLI's own
  // pinned dependencies.
  if (isCheckout()) {
    const pathParts = [REPO_ROOT];
    if (env.PYTHONPATH) pathParts.push(env.PYTHONPATH);
    env.PYTHONPATH = pathParts.join(delimiter);
  }
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
  if ("permissions" in incoming || "permissions" in current) {
    const merged: Record<string, string[]> = { allow: [], ask: [], deny: [] };
    const oldP = (current.permissions && typeof current.permissions === "object")
      ? current.permissions as Record<string, unknown> : {};
    const newP = (incoming.permissions && typeof incoming.permissions === "object")
      ? incoming.permissions as Record<string, unknown> : {};
    for (const action of ["allow", "ask", "deny"]) {
      const seen: string[] = [];
      for (const item of [...((oldP[action] as unknown[]) || []), ...((newP[action] as unknown[]) || [])]) {
        const text = String(item || "");
        if (text && !seen.includes(text)) seen.push(text);
      }
      merged[action] = seen;
    }
    incoming.permissions = merged;
  }
  writeFileSync(path, JSON.stringify({ ...current, ...incoming }, null, 2) + "\n");
}
