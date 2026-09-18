import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DGCConfigError } from "./errors.ts";
import { privateDir } from "./state.ts";
import type { Env } from "./types.ts";

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
export function installedLauncher(env: Env = process.env): string | undefined {
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (dir && executable(join(dir, "dgc"))) return join(dir, "dgc");
  }
  const local = join(env.HOME || homedir(), ".local", "bin", "dgc");
  return executable(local) ? local : undefined;
}

const SAFE_PATH_CACHE = new Map<string, boolean>();

/** True when `python` has `-P` (3.11+): it keeps the working directory off sys.path. */
export function supportsSafePath(python: string, env: Env = process.env): boolean {
  const key = `${python}\0${env.PATH || ""}`;
  const cached = SAFE_PATH_CACHE.get(key);
  if (cached !== undefined) return cached;
  let answer = false;
  if (python.includes("/") ? executable(python) : true) {
    try {
      const out = execFileSync(python, ["-c", "import sys; print(int(sys.version_info >= (3, 11)))"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
        env: { PATH: env.PATH || "", PYTHONDONTWRITEBYTECODE: "1" },
      });
      answer = out.trim() === "1";
    } catch {
      answer = false;
    }
  }
  SAFE_PATH_CACHE.set(key, answer);
  return answer;
}

/**
 * `python -m dgc serve`, with `-P` where the interpreter has it: `-m` puts the working directory
 * (the session cwd) first on sys.path, so a workspace with its own `dgc/` package would replace
 * the runtime.
 */
export function pythonRuntime(python: string, env: Env = process.env): string[] {
  return supportsSafePath(python, env) ? [python, "-P", "-m", "dgc", "serve"] : [python, "-m", "dgc", "serve"];
}

/**
 * How to start `dgc serve`: DGC_PYTHON, then this checkout's .venv (source checkouts only),
 * then the installed `dgc` launcher, then `python3 -m dgc`. The ready handshake checks the
 * protocol either way.
 */
export function defaultRuntime(env: Env = process.env): string[] {
  if (env.DGC_PYTHON) return pythonRuntime(env.DGC_PYTHON, env);
  const checkoutPython = join(REPO_ROOT, ".venv/bin/python");
  if (isCheckout() && existsSync(checkoutPython)) return pythonRuntime(checkoutPython, env);
  const launcher = installedLauncher(env);
  if (launcher) return [launcher, "serve"];
  return pythonRuntime("python3", env);
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
  hostEnv: Env = process.env,
): Env {
  let env: Env;
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
        throw new DGCConfigError(`inheritEnv has an invalid variable name: ${JSON.stringify(name)}`);
      }
      if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
    }
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  if (!inherit) {
    for (const key of SECRET_ENV) delete env[key];
    const home = privateDir(join(stateDir, "home"));
    privateDir(join(home, ".dgc"));
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
