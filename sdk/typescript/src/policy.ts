/** Keep in sync with sdk/python/dgc_sdk/policy.py. */
import type { PermissionRequest, RuntimePolicy } from "./types.ts";

const DISPLAY: Record<string, string> = {
  read_file: "Read", view_image: "ViewImage", write_file: "Write", edit_file: "Edit",
  multi_edit: "MultiEdit", apply_patch: "ApplyPatch", bash: "Bash", python: "Python",
  web_fetch: "WebFetch", web_search: "WebSearch", browser: "Browser",
  monitor: "Monitor", glob: "Glob", grep: "Grep", task: "Task",
};

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

const NET_HINTS = [
  "curl ", "wget ", "nc ", "ncat ", "ssh ", "scp ", "sftp ",
  "http://", "https://", "ftp://", "invoke-webrequest", "fetch(",
];

const WRITE_BASH_PATTERNS = [
  "*>[!&]*",
  "cp *", "* cp *",
  "mv *", "* mv *",
  "tee *", "* tee *",
  "dd *", "* dd *",
  "touch *", "* touch *",
  "truncate *", "* truncate *",
  "sed -i*", "* sed -i*",
  "perl -i*", "* perl -i*",
  "perl -pi*",
  "*open(*",
  "*write_text(*",
  "*write_bytes(*",
  "*writeFile*",
  "*writeFileSync*",
];

const WRITE_ARGV = /(?:^|[\s;|&])\s*(?:(?:sudo|command|env|nice|nohup)\s+)*(?:cp|mv|tee|dd|touch|truncate)\b/i;
const INPLACE = /(?:^|[\s;|&])\s*(?:sed|perl)\s+-\S*i/i;
const REDIRECT = /(?:^|[^>&])(?:\d*)(?:>>|>\||>|&>>|&>)(?!&)/;
const INTERPRETER_WRITE = /open\s*\(|write_text\s*\(|write_bytes\s*\(|writefilesync|writefile\s*\(/i;

function writesDenied(policy: RuntimePolicy | undefined): boolean {
  const denied = policy?.denyTools || [];
  return denied.some((name) => WRITE_TOOLS.has(name));
}

export function looksLikeNetwork(command: string): boolean {
  const low = command.toLowerCase();
  return NET_HINTS.some((hint) => low.includes(hint));
}

export function looksLikeWrite(command: string): boolean {
  if (!command.trim()) return false;
  REDIRECT.lastIndex = 0;
  WRITE_ARGV.lastIndex = 0;
  INPLACE.lastIndex = 0;
  INTERPRETER_WRITE.lastIndex = 0;
  return REDIRECT.test(command) || WRITE_ARGV.test(command)
    || INPLACE.test(command) || INTERPRETER_WRITE.test(command);
}

export function inspectBashForEngine(onPermission?: unknown, mode?: string): boolean {
  return !onPermission || mode === "auto";
}

export function engineDenyRules(
  policy: RuntimePolicy | undefined,
  opts?: { inspectBash?: boolean },
): string[] {
  if (!policy) return [];
  const inspectBash = opts?.inspectBash ?? true;
  const rules: string[] = [];
  const add = (rule: string) => { if (!rules.includes(rule)) rules.push(rule); };
  for (const name of policy?.denyTools || []) add(DISPLAY[name] || name);
  if ((policy?.network ?? "deny") === "deny") {
    add("WebFetch"); add("WebSearch"); add("Browser");
    if (inspectBash) {
      for (const pattern of ["*curl*", "*wget*", "*http://*", "*https://*"]) add(`Bash(${pattern})`);
    }
  }
  if (writesDenied(policy) && inspectBash) {
    for (const pattern of WRITE_BASH_PATTERNS) add(`Bash(${pattern})`);
  }
  return rules;
}

export function policyDecision(
  policy: RuntimePolicy | undefined,
  request: PermissionRequest,
): "deny" | null {
  if (!policy) return null;
  const name = request.name || "";
  if ((policy.denyTools || []).includes(name)) return "deny";
  const args = request.args && typeof request.args === "object" ? request.args : {};
  const command = String(args.command || "");
  if ((policy.network ?? "deny") === "deny" && (name === "bash" || name === "monitor")) {
    if (looksLikeNetwork(command)) return "deny";
  }
  if (writesDenied(policy) && (name === "bash" || name === "monitor" || name === "python")) {
    const snippet = name === "python" ? String(args.code || "") : command;
    if (looksLikeWrite(snippet)) return "deny";
  }
  return null;
}
