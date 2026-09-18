/**
 * Run audit log with secret redaction. Stored in the isolated stateDir, never the host ~/.dgc.
 * Mirrors sdk/python/dgc_sdk/audit.py.
 *
 * Files are owner-only (0600 in a 0700 directory). Redaction removes the same high-confidence
 * credential shapes DGC removes from its own transcripts (provider and forge tokens, JWTs, PEM
 * private keys, `Authorization` headers, credential-named JSON/env/flag values, URL userinfo),
 * plus the exact values of credential-named variables in this process's environment and any
 * secret the SDK was given (the provider `apiKey`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendPrivate, privateDir } from "./state.ts";

export const REDACTED = "[redacted]";
const MIN_EXACT_SECRET = 8;
const MAX_SECRET_VALUES = 256;
const SAFE_PLACEHOLDERS = new Set([
  "ollama", "sk-local", "lm-studio", "none", "null", "undefined", "password",
  "changeme", "example", "placeholder",
]);
// Key names that carry credentials (`max_tokens` / `token_estimate` are not).
const COUNT_NAME = /(?:^|[_-])tokens?[_-](?:estimate|count|budget|limit|usage|used)(?:$|[_-])/i;
const SENSITIVE_NAME = new RegExp(
  "(?:^|[_-])(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|"
  + "secret[_-]?(?:access[_-]?)?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
  + "session[_-]?token|oauth[_-]?token|id[_-]?token|token|password|passwd|passphrase|"
  + "client[_-]?secret|private[_-]?key|credentials?|secret|authorization|cookie)(?:$|[_-])", "i");
const AUTH_HEADER = /(\b(?:proxy-)?authorization\s*[:=]\s*(?:bearer|basic|token)?\s*)([^\s"'`,;}{\]]{4,})/gim;
const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const HEADER_KEY = /(\bx-(?:api|auth)-(?:key|token)\s*[:=]\s*)(\S{4,})/gim;
const JSON_SECRET = new RegExp(
  "([\"']?[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
  + "session[_-]?token|oauth[_-]?token|token|password|passwd|passphrase|client[_-]?secret|"
  + "secret[_-]?(?:access[_-]?)?key|private[_-]?key|credential|secret)[\"']?\\s*:\\s*)"
  + "([\"'])([^\\r\\n]*?)(\\2)", "gi");
// `NAME=value` / `name: value` lines (.env, YAML, shell), bare names included. A value that is
// code reading the secret (`config.get(...)`, `os.environ["..."]`) is left alone.
const ASSIGN_SECRET = new RegExp(
  "(\\b[A-Za-z0-9_]*(?:API_KEY|APIKEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SECRET_KEY|"
  + "ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SESSION_TOKEN|OAUTH_TOKEN|TOKEN|PASSWORD|PASSWD|"
  + "PASSPHRASE|CLIENT_SECRET|PRIVATE_KEY|CREDENTIAL|SECRET)\\s*[:=]\\s*[\"']?)"
  + "(?![A-Za-z_][A-Za-z0-9_.]*[(\\[])"
  + "([^\\s\"'`;,]{4,})", "gim");
const FLAG_SECRET = new RegExp(
  "(\\B--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|"
  + "session[_-]?token|token|password|client[_-]?secret|secret[_-]?key|credential)"
  + "(?:=|\\s+))([^\\s\"'`,;]{4,})", "gi");
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const PREFIX_TOKEN = new RegExp(
  "\\b(?:sk-(?:ant-|proj-|svcacct-|or-)?[A-Za-z0-9_-]{12,}|"
  + "github_pat_[A-Za-z0-9_]{12,}|gh[opusr]_[A-Za-z0-9]{12,}|glpat-[A-Za-z0-9_-]{12,}|"
  + "xox[abeprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|AIza[0-9A-Za-z_-]{30,}|"
  + "(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{12,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|"
  + "pypi-[A-Za-z0-9_-]{30,})\\b", "gi");
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g;
const MARKER = "\u0000DGC-SDK-REDACTED\u0000";

const EXTRA_SECRETS = new Set<string>();
let ENV_SECRETS: string[] | null = null;

function usableSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < MIN_EXACT_SECRET || text.length > 16_384
      || SAFE_PLACEHOLDERS.has(text.toLowerCase()) || text.includes("\u0000")) {
    return null;
  }
  return text;
}

/** Whether a key or variable name conventionally carries a credential. */
export function sensitiveName(name: unknown): boolean {
  const text = String(name ?? "");
  return SENSITIVE_NAME.test(text) && !COUNT_NAME.test(text);
}

/** Mask this exact value in every later audit row (the provider key passed to DGC). */
export function rememberSecret(value: unknown): void {
  const usable = usableSecret(value);
  if (usable !== null && EXTRA_SECRETS.size < MAX_SECRET_VALUES) EXTRA_SECRETS.add(usable);
}

function knownSecrets(): string[] {
  if (ENV_SECRETS === null) {
    const found: string[] = [];
    for (const [name, value] of Object.entries(process.env).slice(0, 4096)) {
      const usable = usableSecret(value);
      if (usable !== null && sensitiveName(name)) {
        found.push(usable);
        if (found.length >= MAX_SECRET_VALUES) break;
      }
    }
    ENV_SECRETS = found;
  }
  return [...new Set([...ENV_SECRETS, ...EXTRA_SECRETS])]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** Remove known secret values and high-confidence credential syntax from one string. */
export function redactText(value: unknown, secrets: Iterable<string> = []): string {
  let text = String(value ?? "").split(REDACTED).join(MARKER);
  for (const secret of [...knownSecrets(), ...secrets]) {
    const usable = usableSecret(secret);
    if (usable) text = text.split(usable).join(MARKER);
  }
  text = text.replace(PRIVATE_KEY, MARKER);
  text = text.replace(URL_CREDENTIAL, (_m, scheme: string) => scheme + MARKER + "@");
  text = text.replace(AUTH_HEADER, (_m, head: string) => head + MARKER);
  text = text.replace(BEARER, (_m, head: string) => head + MARKER);
  text = text.replace(HEADER_KEY, (_m, head: string) => head + MARKER);
  text = text.replace(JSON_SECRET, (_m, head: string, open: string, _v: string, close: string) =>
    head + open + MARKER + close);
  text = text.replace(ASSIGN_SECRET, (_m, head: string) => head + MARKER);
  text = text.replace(FLAG_SECRET, (_m, head: string) => head + MARKER);
  text = text.replace(PREFIX_TOKEN, MARKER);
  text = text.replace(JWT, MARKER);
  return text.split(MARKER).join(REDACTED);
}

/** Redact a JSON-like value: credential-named keys lose their scalar values; strings are scrubbed. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 80).map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (sensitiveName(key) && (typeof item === "string" || typeof item === "number")) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(item);
      }
    }
    return out;
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  return redactText(String(value).slice(0, 2000));
}

function stem(sessionId: string): string {
  const cleaned = [...(sessionId || "unknown")]
    .map((ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : "_")).join("").slice(0, 80);
  return cleaned || "unknown";
}

export class AuditLog {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = privateDir(directory);
  }

  pathFor(sessionId: string): string {
    return join(this.directory, `${stem(sessionId)}.jsonl`);
  }

  append(sessionId: string, runId: string, kind: string, payload: Record<string, unknown>,
    doRedact = true): void {
    const row = {
      ts: Date.now() / 1000,
      session_id: sessionId,
      run_id: runId,
      type: kind,
      payload: doRedact ? redact(payload) : payload,
    };
    appendPrivate(this.pathFor(sessionId), JSON.stringify(row) + "\n");
  }

  export(sessionId?: string, redactOutput = true): Array<Record<string, unknown>> {
    const paths = sessionId
      ? [this.pathFor(sessionId)]
      : (existsSync(this.directory) ? readdirSync(this.directory).filter((name) => name.endsWith(".jsonl"))
        .sort().map((name) => join(this.directory, name)) : []);
    const rows: Array<Record<string, unknown>> = [];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          rows.push(redactOutput ? redact(row) as Record<string, unknown> : row);
        } catch { /* skip a torn line */ }
      }
    }
    return rows;
  }
}
