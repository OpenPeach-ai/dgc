/**
 * Embedder policy: tool, path, network and shell limits for every session of a DGC client.
 * Keep in sync with sdk/python/dgc_sdk/policy.py (a test compares the compiled output).
 *
 * The policy reaches a session's runtime only through its environment (`DGC_SESSION_POLICY`),
 * which DGC reads at startup, confirms in the ready handshake, and never saves: nothing is
 * written to any config.json, so a policy never outlives its session and never touches the
 * user's own ~/.dgc (inheritUserState included).
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { userInfo } from "node:os";
import { DGCConfigError, DGCUnsupportedError } from "./errors.ts";
import type {
  PermissionAction, PermissionMode, PermissionRequest, RuntimePolicy, SandboxRequirement,
  SandboxSetting, SandboxStatus, UnhandledPolicy,
} from "./types.ts";

// DGC's internal tool name -> the display name its permission rules use. Mirrors
// dgc.permissions.DISPLAY, minus the ExternalDirectory pseudo-tool.
export const DISPLAY: Readonly<Record<string, string>> = {
  read_file: "Read", view_image: "ViewImage", write_file: "Write", edit_file: "Edit",
  multi_edit: "MultiEdit", apply_patch: "ApplyPatch", repo_map: "RepoMap",
  code_intel: "CodeIntel", git_diff: "GitDiff", bash: "Bash", bash_output: "BashOutput",
  bash_kill: "BashKill", python: "Python", monitor: "Monitor", monitor_stop: "MonitorStop",
  glob: "Glob", grep: "Grep", web_fetch: "WebFetch", web_search: "WebSearch",
  browser: "Browser", todo: "Todo", notes: "Notes", skill: "Skill",
  add_skill: "AddSkill", save_memory: "SaveMemory", mcp_search: "MCPSearch",
  mcp_call: "MCPCall", present_plan: "PresentPlan", present_document: "PresentDocument",
  propose_options: "ProposeOptions", artifact: "Artifact", task: "Task",
};
// Tools a rule cannot name (goal bookkeeping), and tools an allowlist keeps unless it is denied
// by name: the option picker is how the agent asks the application a question.
const UNRULED_TOOLS = new Set(["update_goal"]);
const ALWAYS_OFFERED = new Set(["propose_options"]);

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const READ_PATH_TOOLS = new Set(["read_file", "view_image", "code_intel", "git_diff", "repo_map", "grep", "glob"]);
const PATH_TOOLS = new Set([...READ_PATH_TOOLS, ...WRITE_TOOLS, "artifact"]);
// Tools that search a tree rather than open one path; with a denied path inside a readable tree
// they become permission requests the SDK answers from the search root.
const SEARCH_TOOLS = new Set(["grep", "glob", "repo_map", "code_intel", "git_diff"]);
// Rules match these tools' `path` argument, in absolute and project-relative spellings.
const PATH_RULE_TOOLS = ["Read", "ViewImage", "Write", "Edit", "MultiEdit", "ApplyPatch", "Artifact",
  "CodeIntel", "GitDiff"];
const NETWORK_TOOLS = ["WebFetch", "WebSearch", "Browser", "AddSkill"];
const APP_SERVER = "app";

const MCP_EXACT = /^mcp__[A-Za-z0-9_-]{1,506}$/;
const MCP_WILDCARD = /^mcp__[A-Za-z0-9_-]{0,505}\*$/;

const NET_HINTS = [
  "curl ", "wget ", "nc ", "ncat ", "ssh ", "scp ", "sftp ", "telnet ", "ftp ", "rsync ",
  "http://", "https://", "ftp://", "invoke-webrequest", "fetch(", "socket", "urllib",
  "http.client", "requests.", "git push", "git fetch", "git pull", "git clone",
];
const NET_BASH_PATTERNS = [
  "*curl*", "*wget*", "*http://*", "*https://*", "*ftp://*", "nc *", "* nc *", "ncat *",
  "* ncat *", "ssh *", "* ssh *", "scp *", "* scp *", "sftp *", "rsync *", "* rsync *",
  "telnet *", "*socket*", "*urllib*", "*http.client*", "*requests.*", "git push*",
  "* git push*", "git fetch*", "git pull*", "git clone*",
];
// Command-screening globs (`shell: "screened"` only). Deny matches ANY compound subcommand.
// `*>[!&]*` is `>`/`>>` except `>&fd` (so `ls 2>&1` still runs).
const WRITE_BASH_PATTERNS = [
  "*>[!&]*",
  "cp *", "* cp *", "mv *", "* mv *", "tee *", "* tee *", "dd *", "* dd *",
  "touch *", "* touch *", "truncate *", "* truncate *",
  "rm *", "* rm *", "rmdir *", "* rmdir *", "ln *", "* ln *", "install *", "* install *",
  "mkdir *", "* mkdir *", "chmod *", "* chmod *", "rsync *", "* rsync *",
  "patch *", "* patch *", "unlink *", "* unlink *",
  "git apply*", "git checkout*", "git restore*", "git rm*", "git reset*", "git clean*",
  "git mv*", "git stash*", "git commit*", "git init*", "git add*",
  "sed -i*", "* sed -i*", "perl -i*", "* perl -i*", "perl -pi*",
  "*open(*", "*write_text(*", "*write_bytes(*", "*writeFile*", "*writeFileSync*", "*shutil*",
  "*os.remove*", "*os.rename*", "*os.replace*", "*os.unlink*", "*os.mkdir*", "*os.makedirs*",
  "*.unlink(*", "*.rename(*", "*.touch(*", "*.mkdir(*",
];

const WRITE_ARGV = new RegExp(
  "(?:^|[\\s;|&])\\s*(?:(?:sudo|command|env|nice|nohup)\\s+)*"
  + "(?:cp|mv|tee|dd|touch|truncate|rm|rmdir|ln|install|mkdir|chmod|rsync|patch|unlink)\\b"
  + "|(?:^|[\\s;|&])\\s*git\\s+(?:apply|checkout|restore|rm|reset|clean|mv|stash|commit|init|add)\\b", "i");
const INPLACE = /(?:^|[\s;|&])\s*(?:sed|perl)\s+-\S*i/i;
const REDIRECT = /(?:^|[^>&])(?:\d*)(?:>>|>\||>|&>>|&>)(?!&)/;
const INTERPRETER_WRITE = new RegExp(
  "open\\s*\\(|write_text\\s*\\(|write_bytes\\s*\\(|writefilesync|writefile\\s*\\(|shutil|"
  + "os\\.(?:remove|rename|replace|unlink|mkdir|makedirs)|\\.(?:unlink|rename|touch|mkdir)\\s*\\(", "i");

export const SESSION_POLICY_ENV = "DGC_SESSION_POLICY";
const SESSION_POLICY_VERSION = 1;
// Linux refuses a single environment string over 128 KiB (MAX_ARG_STRLEN).
const SESSION_POLICY_MAX_BYTES = 96 * 1024;

function warn(message: string): void {
  process.emitWarning(message, { code: "DGC_SDK" });
}

function asNames(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new DGCConfigError(`RuntimePolicy.${field} must be an array of tool names, not ${JSON.stringify(value)}`);
  }
  for (const name of value) {
    if (typeof name !== "string" || !name) {
      throw new DGCConfigError(`RuntimePolicy.${field} must contain non-empty tool names`);
    }
    if (name in DISPLAY || (field === "allowTools" && UNRULED_TOOLS.has(name))) continue;
    if (MCP_EXACT.test(name) || MCP_WILDCARD.test(name)) continue;
    const hint = UNRULED_TOOLS.has(name) ? " (update_goal cannot be denied)"
      : "; known tools: " + Object.keys(DISPLAY).sort().join(", ")
        + ", and MCP routes such as mcp__app__<tool> or mcp__app__*";
    throw new DGCConfigError(`RuntimePolicy.${field} names an unknown tool ${JSON.stringify(name)}${hint}`);
  }
  return [...value] as string[];
}

function asPaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new DGCConfigError(`RuntimePolicy.${field} must be an array of paths, not ${JSON.stringify(value)}`);
  }
  const paths = value.map((item) => String(item));
  if (paths.some((item) => !item.trim())) {
    throw new DGCConfigError(`RuntimePolicy.${field} must not contain empty paths`);
  }
  return paths;
}

/** Quote fnmatch metacharacters so a literal path or route matches only itself. */
export function escapeGlob(text: string): string {
  return text.replace(/[[\]*?]/g, (ch) => (ch === "[" ? "[[]" : `[${ch}]`));
}

function unique(items: Iterable<string>): string[] {
  return [...new Set(items)];
}

function bracket(chars: Iterable<string>): string {
  const items = [...new Set(chars)].sort();
  const tail = items.includes("-") ? ["-"] : [];
  const head = items.includes("]") ? ["]"] : [];
  const body = items.filter((c) => !["-", "]", "!", "^"].includes(c));
  const bang = items.includes("!") ? ["!"] : [];
  const caret = items.includes("^") ? ["^"] : [];
  return [...head, ...body, ...bang, ...caret, ...tail].join("");
}

type Trie = { [key: string]: Trie | true };

/**
 * fnmatch patterns that match every string except the allowed ones. An entry ending in `*`
 * allows every string starting with the text before it. DGC rules can only deny, so an allowlist
 * becomes denies of everything else.
 */
export function complementPatterns(allowed: Iterable<string>): string[] {
  const root: Trie = {};
  for (const entry of allowed) {
    const wildcard = entry.endsWith("*");
    const text = wildcard ? entry.slice(0, -1) : entry;
    let node = root;
    let covered = false;
    for (const ch of text) {
      if ("$all" in node) {
        covered = true;
        break;
      }
      if (!(ch in node)) node[ch] = {};
      node = node[ch] as Trie;
    }
    if (covered || "$all" in node) continue;
    if (wildcard) {
      for (const key of Object.keys(node)) delete node[key];
      node.$all = true;
    } else {
      node.$end = true;
    }
  }
  const patterns: string[] = [];
  const walk = (prefix: string, node: Trie): void => {
    if ("$all" in node) return;
    if (prefix && !("$end" in node)) patterns.push(escapeGlob(prefix));
    // Python sorts by code point; so does this comparison.
    const chars = Object.keys(node).filter((key) => [...key].length === 1).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    patterns.push(escapeGlob(prefix) + (chars.length ? `[!${bracket(chars)}]*` : "?*"));
    for (const ch of chars) walk(prefix + ch, node[ch] as Trie);
  };
  walk("", root);
  return patterns;
}

function appRoute(name: string): string {
  const safe = String(name).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
  return `mcp__${APP_SERVER}__${safe}`;
}

function subject(name: string, args: Record<string, unknown>): [string, string] {
  if (name.startsWith("mcp__")) return ["mcp_call", name];
  if (name === "mcp_call") return ["mcp_call", String(args.name || "")];
  return [name, ""];
}

function routeMatches(route: string, entry: string): boolean {
  return entry.endsWith("*") ? route.startsWith(entry.slice(0, -1)) : route === entry;
}

/** Like Python's Path.resolve(strict=False): symlinks resolved for the part that exists. */
export function resolvePath(raw: string, cwd?: string | null): string | null {
  try {
    let text = raw;
    if (text === "~" || text.startsWith("~/")) text = join(userInfo().homedir, text.slice(1));
    let path = isAbsolute(text) ? resolve(text) : resolve(cwd || process.cwd(), text);
    const rest: string[] = [];
    // Walk up until an existing ancestor, realpath it, then re-append the missing tail.
    for (;;) {
      if (existsSync(path)) {
        const real = realpathSync(path);
        return rest.length ? join(real, ...rest.reverse()) : real;
      }
      const parent = resolve(path, "..");
      if (parent === path) return resolve(text);
      rest.push(path.slice(parent.length).replace(/^[\\/]+/, ""));
      path = parent;
    }
  } catch {
    return null;
  }
}

export function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

export function looksLikeNetwork(command: string): boolean {
  const low = command.toLowerCase();
  return NET_HINTS.some((hint) => low.includes(hint));
}

/** True when a shell/python snippet is a file-write, not merely a read or `2>&1`. */
export function looksLikeWrite(command: string): boolean {
  if (!command || !command.trim()) return false;
  return REDIRECT.test(command) || WRITE_ARGV.test(command) || INPLACE.test(command)
    || INTERPRETER_WRITE.test(command);
}

/** A validated {@link RuntimePolicy}. */
export class Policy {
  readonly network: "deny" | "allow";
  readonly extraReadDirs: readonly string[];
  readonly denyPathPrefixes: readonly string[];
  readonly denyTools: readonly string[];
  readonly allowTools: readonly string[] | null;
  readonly redactEvents: boolean;
  readonly shell: "sandboxed" | "screened";

  constructor(options: RuntimePolicy) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new DGCConfigError("policy must be a RuntimePolicy object");
    }
    const known = new Set(["network", "extraReadDirs", "denyPathPrefixes", "denyTools", "allowTools",
      "redactEvents", "shell"]);
    const unknown = Object.keys(options).filter((key) => !known.has(key)).sort();
    if (unknown.length) throw new DGCConfigError(`RuntimePolicy has an unknown field ${JSON.stringify(unknown[0])}`);
    const network = options.network ?? "deny";
    if (network !== "deny" && network !== "allow") throw new DGCConfigError("RuntimePolicy.network must be 'deny' or 'allow'");
    const shell = options.shell ?? "sandboxed";
    if (shell !== "sandboxed" && shell !== "screened") {
      throw new DGCConfigError("RuntimePolicy.shell must be 'sandboxed' or 'screened'");
    }
    this.network = network;
    this.shell = shell;
    this.denyTools = asNames(options.denyTools ?? [], "denyTools");
    this.allowTools = options.allowTools === undefined || options.allowTools === null
      ? null : asNames(options.allowTools, "allowTools");
    this.extraReadDirs = asPaths(options.extraReadDirs ?? [], "extraReadDirs");
    this.denyPathPrefixes = asPaths(options.denyPathPrefixes ?? [], "denyPathPrefixes");
    this.redactEvents = options.redactEvents ?? true;
  }

  writesDenied(): boolean {
    if (this.denyTools.some((name) => WRITE_TOOLS.has(name))) return true;
    if (this.allowTools !== null && !this.allowTools.some((name) => WRITE_TOOLS.has(name))) return true;
    return false;
  }

  /** True when this policy forbids the tool by name, independent of command screening. */
  namedToolDenied(name: string, args: Record<string, unknown> = {}): boolean {
    const [tool, route] = subject(name, args);
    if (tool === "mcp_call") {
      if (this.denyTools.includes("mcp_call")
          || this.denyTools.some((entry) => entry.startsWith("mcp__") && routeMatches(route, entry))) {
        return true;
      }
      if (this.allowTools === null || this.allowTools.includes("mcp_call")) return false;
      return !this.allowTools.some((entry) => entry.startsWith("mcp__") && routeMatches(route, entry));
    }
    if (this.denyTools.includes(tool)) return true;
    if (this.allowTools !== null && !this.allowTools.includes(tool)) {
      return !ALWAYS_OFFERED.has(tool) && !UNRULED_TOOLS.has(tool);
    }
    return false;
  }

  /** Throw when an `mcp__app__` route names none of the session's own tools. */
  checkSessionTools(customTools: readonly string[]): void {
    const routes = new Set(customTools.map(appRoute));
    if (!routes.size) return;
    for (const [field, entries] of [["denyTools", this.denyTools], ["allowTools", this.allowTools ?? []]] as const) {
      for (const entry of entries) {
        if (!entry.startsWith(`mcp__${APP_SERVER}__`) || entry.endsWith("*")) continue;
        if (!routes.has(entry)) {
          throw new DGCConfigError(`RuntimePolicy.${field} names ${JSON.stringify(entry)}, which is not one of `
            + `this session's tools (defined: ${[...routes].sort().join(", ") || "none"})`);
        }
      }
    }
  }

  namedRules(): string[] {
    const rules: string[] = [];
    const mcpDenied: string[] = [];
    for (const name of this.denyTools) {
      if (name.startsWith("mcp__")) mcpDenied.push(name);
      else rules.push(DISPLAY[name]);
    }
    for (const name of mcpDenied) {
      rules.push(`MCPCall(${name.endsWith("*") ? escapeGlob(name.slice(0, -1)) + "*" : escapeGlob(name)})`);
    }
    if (this.allowTools !== null) {
      const allowed = new Set(this.allowTools);
      for (const [internal, display] of Object.entries(DISPLAY)) {
        if (allowed.has(internal) || ALWAYS_OFFERED.has(internal)) continue;
        if (internal === "mcp_call") {
          const routes = [...allowed].filter((name) => name.startsWith("mcp__"));
          if (routes.length) {
            rules.push(...complementPatterns(routes).map((pattern) => `MCPCall(${pattern})`));
            continue;
          }
        }
        rules.push(display);
      }
    }
    return rules;
  }

  /**
   * Named-tool, network-tool and write-path rules, plus command-screening globs (best-effort
   * screening, not a boundary; what `shell: "screened"` applies in auto mode).
   */
  engineDenyRules(inspectBash = true): string[] {
    let rules = unique(this.namedRules());
    if (this.network === "deny") {
      rules = unique([...rules, ...NETWORK_TOOLS]);
      if (inspectBash) rules = unique([...rules, ...NET_BASH_PATTERNS.map((p) => `Bash(${p})`)]);
    }
    if (this.writesDenied() && inspectBash) {
      rules = unique([...rules, ...WRITE_BASH_PATTERNS.map((p) => `Bash(${p})`)]);
    }
    for (const prefix of this.denyPathPrefixes) {
      const text = prefix.replace(/\/+$/, "");
      if (text) {
        rules = unique([...rules, ...["Write", "Edit", "MultiEdit", "ApplyPatch"].map((tool) => `${tool}(${escapeGlob(text)}/**)`)]);
      }
    }
    return rules;
  }

  /**
   * Classify one permission request: "deny" (the policy forbids it), "once" (the policy itself
   * allows it: a read in extraReadDirs, or a search clear of denied paths), "screen" (command
   * text looks like a network call or file write; best effort), or null (no opinion).
   */
  evaluate(request: PermissionRequest, cwd: string | null): "deny" | "once" | "screen" | null {
    const name = request.name || "";
    const args = request.args && typeof request.args === "object" ? request.args : {};
    if (this.namedToolDenied(name, args)) return "deny";
    if (PATH_TOOLS.has(name)) {
      const verdict = this.pathVerdict(name, args, cwd);
      if (verdict !== null) return verdict;
    }
    const command = String(args.command || request.command || "");
    if (name === "bash" || name === "monitor") {
      if (this.network === "deny" && looksLikeNetwork(command)) return "screen";
      if (this.writesDenied() && looksLikeWrite(command)) return "screen";
    }
    if (name === "python" && this.writesDenied() && looksLikeWrite(String(args.code || ""))) return "screen";
    return null;
  }

  /** "deny" when this policy forbids the call, "once" when it allows it itself, else null. */
  decision(request: PermissionRequest, cwd: string | null = null): PermissionAction | null {
    const verdict = this.evaluate(request, cwd);
    if (verdict === "deny" || verdict === "screen") return "deny";
    if (verdict === "once") return "once";
    return null;
  }

  pathVerdict(name: string, args: Record<string, unknown>, cwd: string | null): "deny" | "once" | null {
    const raw = String(args.path || "");
    if (!raw && !SEARCH_TOOLS.has(name)) return null;
    const target = resolvePath(raw || ".", cwd);
    if (target === null) return "deny";
    const denied = this.deniedPrefixes(cwd);
    if (denied.some((prefix) => within(target, prefix))) return "deny";
    if (SEARCH_TOOLS.has(name) && denied.some((prefix) => within(prefix, target))) return "deny";
    if (cwd !== null) {
      const root = resolvePath(cwd) || cwd;
      if (!within(target, root)) {
        if (READ_PATH_TOOLS.has(name) && this.extraDirs(cwd).some((extra) => within(target, extra))) return "once";
        return "deny";
      }
    }
    if (SEARCH_TOOLS.has(name) && this.searchGuard(cwd)) return "once";
    return null;
  }

  deniedPrefixes(cwd: string | null): string[] {
    return this.denyPathPrefixes.map((prefix) => resolvePath(prefix, cwd)).filter((p): p is string => p !== null);
  }

  extraDirs(cwd: string | null): string[] {
    return this.extraReadDirs.map((extra) => resolvePath(extra, cwd)).filter((p): p is string => p !== null);
  }

  /** True when a denied prefix sits inside a tree the agent may search. */
  searchGuard(cwd: string | null): boolean {
    const roots = [...(cwd !== null ? [resolvePath(cwd) || cwd] : []), ...this.extraDirs(cwd)];
    return this.deniedPrefixes(cwd).some((prefix) => roots.some((root) => within(prefix, root)));
  }
}

/** Normalize the public policy option. */
export function toPolicy(value: RuntimePolicy | Policy | undefined | null): Policy | null {
  if (value === undefined || value === null) return null;
  return value instanceof Policy ? value : new Policy(value);
}

/**
 * Compile bash write/network globs only when nobody will answer a permission_request. Auto mode
 * never raises one, so the engine must deny by itself. Kept for API compatibility.
 */
export function inspectBashForEngine(onPermission?: unknown, mode?: string): boolean {
  return !onPermission || mode === "auto";
}

/** The policy's named-tool, network and path rules plus screening globs (see {@link Policy.engineDenyRules}). */
export function engineDenyRules(policy: RuntimePolicy | Policy | undefined | null,
  opts?: { inspectBash?: boolean }): string[] {
  const normalized = toPolicy(policy);
  return normalized ? normalized.engineDenyRules(opts?.inspectBash ?? true) : [];
}

/** "deny" when the policy forbids this request (including screened command text), else null. */
export function policyDecision(policy: RuntimePolicy | Policy | undefined | null, request: PermissionRequest,
  cwd: string | null = null): "deny" | null {
  const normalized = toPolicy(policy);
  if (!normalized) return null;
  const verdict = normalized.evaluate(request, cwd);
  return verdict === "deny" || verdict === "screen" ? "deny" : null;
}

// ---------------------------------------------------------------- settings ---

/**
 * Normalize `session({ permissions })` into [mode, unhandled]. `unhandled: "deny"`: a request the
 * callback does not answer is denied and the agent carries on (no callback denies every request).
 * `"callback"`: every request must go to your callback, so `session()` refuses to start without
 * one; a request it still leaves unanswered (it threw, returned something else, or ran past
 * `decisionTimeoutMs`) is denied and the run stops with `reason: "decision_failed"`.
 */
export function permissionSettings(value: unknown, mode: PermissionMode | undefined,
  defaultMode: PermissionMode, onPermission: unknown): [PermissionMode, UnhandledPolicy] {
  let data: Record<string, unknown> = {};
  if (value !== undefined && value !== null) {
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new DGCConfigError("permissions must be an object such as { mode, unhandled }");
    }
    data = { ...(value as Record<string, unknown>) };
    const unknown = Object.keys(data).filter((key) => key !== "mode" && key !== "unhandled").sort();
    if (unknown.length) {
      throw new DGCConfigError(`permissions has an unknown key ${JSON.stringify(unknown[0])} (expected 'mode' and 'unhandled')`);
    }
  }
  const unhandled = (data.unhandled || "deny") as UnhandledPolicy;
  if (unhandled !== "deny" && unhandled !== "callback") {
    throw new DGCConfigError("permissions.unhandled must be 'deny' or 'callback'");
  }
  const chosen = (mode || data.mode || defaultMode) as PermissionMode;
  if (!["default", "acceptEdits", "plan", "auto"].includes(chosen)) {
    throw new DGCConfigError("invalid permission mode");
  }
  if (unhandled === "callback" && !onPermission) {
    throw new DGCConfigError("permissions.unhandled='callback' needs onPermission; pass a callback or use "
      + "unhandled='deny' to deny every request");
  }
  return [chosen, unhandled];
}

/** Normalize `sandbox` ("required" | "preferred" | "off", or `{ requirement }`). */
export function sandboxRequirement(value: SandboxSetting | undefined | null): SandboxRequirement {
  if (value === undefined || value === null) return "off";
  let requirement: unknown;
  if (typeof value === "string") requirement = value;
  else if (typeof value === "object" && !Array.isArray(value)) {
    const unknown = Object.keys(value).filter((key) => key !== "requirement").sort();
    if (unknown.length) {
      throw new DGCConfigError(`sandbox has an unknown key ${JSON.stringify(unknown[0])} (expected 'requirement')`);
    }
    requirement = (value as { requirement?: unknown }).requirement || "off";
  } else {
    throw new DGCConfigError("sandbox must be 'required', 'preferred', 'off' or { requirement }");
  }
  if (requirement !== "required" && requirement !== "preferred" && requirement !== "off") {
    throw new DGCConfigError("sandbox.requirement must be required, preferred, or off");
  }
  return requirement;
}

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try {
      if (statSync(join(dir, name)).isFile()) return true;
    } catch { /* keep looking */ }
  }
  return false;
}

/** Fail early for "required" when this host plainly has no backend (the runtime decides finally). */
export function sandboxPrecheck(requirement: SandboxRequirement): void {
  if (requirement !== "required") return;
  let name: string;
  if (process.platform === "linux") name = "bwrap";
  else if (process.platform === "darwin") name = "sandbox-exec";
  else {
    throw new DGCUnsupportedError(`sandbox.requirement is 'required' but DGC has no sandbox backend on ${process.platform}`);
  }
  if (!onPath(name)) throw new DGCUnsupportedError(`sandbox.requirement is 'required' but this host has no ${name}`);
}

// ------------------------------------------------------------ per session ---

/** What one session's runtime is told, and how to confirm it took effect. */
export class SessionPlan {
  readonly env: Record<string, string>;
  readonly requirement: SandboxRequirement;
  readonly policy: Policy | null;
  readonly notes: readonly string[];

  constructor(env: Record<string, string>, requirement: SandboxRequirement, policy: Policy | null,
    notes: readonly string[] = []) {
    this.env = env;
    this.requirement = requirement;
    this.policy = policy;
    this.notes = notes;
  }

  get payload(): string {
    return this.env[SESSION_POLICY_ENV] || "";
  }

  /**
   * Check the ready handshake: the runtime read this policy and has the sandbox asked for.
   * Throws DGCUnsupportedError when the runtime cannot honour it.
   */
  confirm(ready: Record<string, unknown>): SandboxStatus {
    const caps = ready.capabilities && typeof ready.capabilities === "object"
      ? ready.capabilities as Record<string, unknown> : {};
    const report = caps.session_policy;
    if (!this.payload) return { requirement: this.requirement, active: false, backend: "", reason: "" };
    const version = String(ready.version || "unknown");
    if (!report || typeof report !== "object") {
      throw new DGCUnsupportedError(`DGC runtime ${version} cannot apply a session policy (RuntimePolicy or `
        + "sandbox); CLI 0.41.6 or newer is required");
    }
    const info = report as Record<string, unknown>;
    if (info.error) throw new DGCUnsupportedError(`DGC runtime ${version} rejected the session policy: ${String(info.error)}`);
    const digest = createHash("sha256").update(this.payload, "utf8").digest("hex");
    if (info.digest !== digest) throw new DGCUnsupportedError(`DGC runtime ${version} did not confirm this session's policy`);
    this.confirmTools(ready);
    for (const note of this.notes) warn(`DGC session policy: ${note}`);
    const backend = String(info.sandbox || "");
    if (this.requirement === "required" && !backend) {
      throw new DGCUnsupportedError("sandbox.requirement is 'required' but the DGC runtime has no OS sandbox "
        + "(bubblewrap on Linux, sandbox-exec on macOS)");
    }
    if (this.requirement === "preferred" && !backend) {
      const detail = this.policy !== null && this.policy.shell === "sandboxed"
        ? "; in auto mode the shell is refused, and in the other modes an approved command runs unconfined"
        : "; shell commands run unconfined";
      const reason = "no OS sandbox is available to the DGC runtime" + detail;
      warn(`DGC sandbox 'preferred' fell back: ${reason}`);
      return { requirement: this.requirement, active: false, backend: "", reason };
    }
    return { requirement: this.requirement, active: Boolean(backend), backend, reason: "" };
  }

  private confirmTools(ready: Record<string, unknown>): void {
    const policy = this.policy;
    if (policy === null || !Array.isArray(ready.tools) || policy.allowTools === null) return;
    const allowed = new Set([...policy.allowTools, ...ALWAYS_OFFERED, ...UNRULED_TOOLS]);
    const unknown = ready.tools.map(String)
      .filter((name) => !(name in DISPLAY) && !allowed.has(name) && !name.startsWith("mcp__")).sort();
    if (unknown.length) {
      throw new DGCUnsupportedError(`RuntimePolicy.allowTools cannot refuse the runtime's tool ${JSON.stringify(unknown[0])}, `
        + "which this SDK does not know; upgrade the SDK or allow it");
    }
  }
}

function sortedJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) out[key] = sort((item as Record<string, unknown>)[key]);
      return out;
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

/**
 * True when DGC's sandbox surely masks `path`, which lies outside cwd. Both backends hide the
 * account's home directory; bubblewrap also gives the shell private /root, /tmp and /run.
 */
function sandboxHides(path: string, workspace: string): boolean {
  if (within(path, workspace)) return false;
  const hidden: string[] = [];
  try { hidden.push(userInfo().homedir); } catch { /* no account entry */ }
  if (process.platform === "linux") hidden.push("/root", "/tmp", "/run");
  for (const base of hidden) {
    const real = resolvePath(base);
    if (real && within(path, real)) return true;
  }
  return false;
}

/**
 * Turn a RuntimePolicy and sandbox choice into the runtime's per-session policy. It travels to
 * `dgc serve` in the DGC_SESSION_POLICY environment variable; nothing is written to any config.
 */
export function compileSession(policy: Policy | null, options: {
  cwd: string; mode: PermissionMode; sandbox: SandboxRequirement; tools?: readonly string[];
}): SessionPlan {
  let requirement = options.sandbox;
  if (policy === null) {
    if (requirement === "off") return new SessionPlan({}, "off", null);
    const payload = { version: SESSION_POLICY_VERSION, sandbox: requirement };
    return new SessionPlan({ [SESSION_POLICY_ENV]: sortedJson(payload) }, requirement, null);
  }
  policy.checkSessionTools(options.tools ?? []);
  const workspace = resolvePath(options.cwd) || resolve(options.cwd);
  const deny = policy.namedRules();
  const ask: string[] = [];
  const autoDeny: string[] = [];
  const notes: string[] = [];
  if (policy.network === "deny") {
    deny.push(...NETWORK_TOOLS);
    // MCP servers other than the application's own tools run as unconfined processes.
    deny.push(...complementPatterns([`mcp__${APP_SERVER}__*`]).map((pattern) => `MCPCall(${pattern})`));
  }
  const denied = policy.deniedPrefixes(workspace);
  for (const prefix of denied) {
    const spellings = [prefix];
    if (within(prefix, workspace) && prefix !== workspace) {
      // The project-relative spelling also covers a subagent's worktree copy of the tree.
      spellings.push(relative(workspace, prefix).split(sep).join("/"));
    }
    for (const text of spellings.map(escapeGlob)) {
      for (const tool of PATH_RULE_TOOLS) deny.push(`${tool}(${text})`, `${tool}(${text}/**)`);
    }
  }
  if (policy.searchGuard(workspace)) ask.push(...[...SEARCH_TOOLS].sort().map((name) => DISPLAY[name]));
  (policy.extraDirs(workspace).length ? ask : deny).push("ExternalDirectory");
  let sandboxReadOnly = false;
  let shellRequiresSandbox = false;
  if (policy.shell === "sandboxed") {
    shellRequiresSandbox = true;
    if (requirement === "off") requirement = "preferred";
    sandboxReadOnly = policy.writesDenied();
    const exposed = denied.filter((prefix) => !sandboxHides(prefix, workspace));
    if (exposed.length) {
      // The sandbox shows the rest of the host read-only, so it cannot keep the shell away from
      // these paths. Unattended, the shell is refused.
      autoDeny.push("Bash", "Monitor");
      if (options.mode === "auto") {
        notes.push(`RuntimePolicy.denyPathPrefixes names ${exposed[0]}, which the OS sandbox cannot hide, `
          + "so bash and monitor are refused in auto mode");
      }
    }
  } else {
    if (policy.network === "deny") autoDeny.push(...NET_BASH_PATTERNS.map((p) => `Bash(${p})`));
    if (policy.writesDenied()) autoDeny.push(...WRITE_BASH_PATTERNS.map((p) => `Bash(${p})`));
  }
  const payload = {
    version: SESSION_POLICY_VERSION,
    deny: unique(deny),
    ask: unique(ask),
    auto_deny: unique(autoDeny),
    sandbox: requirement,
    sandbox_network: policy.network === "allow",
    sandbox_read_only: sandboxReadOnly,
    shell_requires_sandbox: shellRequiresSandbox,
    // A workspace's own .dgc/permissions.json may narrow what runs, never pre-approve it.
    project_allow: false,
  };
  const text = sortedJson(payload);
  if (Buffer.byteLength(text, "utf8") > SESSION_POLICY_MAX_BYTES) {
    throw new DGCConfigError("RuntimePolicy compiles to more rules than one environment variable can carry; "
      + "use fewer denyPathPrefixes or broader ones");
  }
  return new SessionPlan({ [SESSION_POLICY_ENV]: text }, requirement, policy, notes);
}

/**
 * Answer one permission_request: the policy first, then the callback. A policy deny is final; a
 * request the policy raised only to check it ("once") is answered without the callback; command
 * screening denies unless a reviewing callback is present outside auto mode.
 */
export async function resolvePermission(policy: Policy | null, request: PermissionRequest, options: {
  cwd: string | null; permissionMode: string; onPermission: unknown; ask: () => Promise<unknown>;
}): Promise<PermissionAction> {
  if (policy !== null) {
    const verdict = policy.evaluate(request, options.cwd);
    if (verdict === "deny") return "deny";
    if (verdict === "once") return "once";
    if (verdict === "screen" && (!options.onPermission || options.permissionMode === "auto")) return "deny";
  }
  const action = await options.ask();
  return action === "once" || action === "always" || action === "deny" ? action : "deny";
}
