// A link's preview card: point at a link in a chat and a card under it shows the site's icon and name, the site's own
// picture, the page's title and what it says. The host's half of ONE module (media/shared/linkpreview.js is the
// page's), used by every host that draws a chat: Work's, ChatDGC's and the Pips tab's.
//
// A preview reads a page because someone pointed at a link, so what it may read is kept narrow:
//   - Only public http(s) hosts. A private, local, LAN or tailnet name, an address in a private range, and a name that
//     RESOLVES to one are never read: the name is resolved here, every address it gives is checked, and the connection
//     is made to the address that was checked (a name can't answer "public" to the check and "private" to the socket).
//   - No one-time links. An address that carries a token or an action (a reset, a sign-in, an unsubscribe, a signed
//     download, a long opaque part) is never read: reading it could spend it.
//   - Nothing that carries a secret: the saved keys this machine's environment and the project's .env name, and
//     anything shaped like a key.
//   - Only the head: one GET with no cookies, no sign-in and no script run, stopped at </head> or 256 KB, six seconds
//     at most, three redirects at most and never to a private host.
//   - The picture and the site's icon are read here under the same public-only rule (an image, 600 KB at most) and
//     handed to the page as data: URIs, so a page never loads an outside picture and its own policy stays as it is.
//   - Kept for 24 hours, in memory and in a small folder, so pointing again asks nothing.
//   - A setting, dgc.linkPreviews (Settings -> Security), on by default. Off: nothing is read.
// Over a remote connection this runs where the extension host runs, the machine DGC is on: the read leaves from there.
import * as vscode from "vscode";
import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns";
import * as net from "node:net";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_HOST } from "./privateHost";

/** The message a page asks with and is answered with (media/shared/linkpreview.js). */
export const LINK_PREVIEW_MESSAGE = "dgcLinkPreview";

export const LIMITS = Object.freeze({
  /** The most of a page that is read: its head ends well inside this. */
  headBytes: 256 * 1024,
  /** One read, redirects and all. */
  timeoutMs: 6000,
  pictureBytes: 1024 * 1024,
  iconBytes: 100 * 1024,
  redirects: 3,
  /** How many sites are read at the same time; the rest wait their turn. */
  atOnce: 4,
  /** How long an answer is kept. */
  keepMs: 24 * 3_600_000,
  /** How long a page that could not be read is left alone. */
  retryMs: 10 * 60_000,
  memoryEntries: 200,
  diskFiles: 200,
  diskBytes: 24 * 1024 * 1024,
  /** What went out, newest last (see sent()). */
  sentEntries: 200,
});
export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

/** Why an address is shown alone, with nothing read: a private host, a one-time link, a secret in it, not a web
 *  address, or a page that could not be read. */
export type NotRead = "private" | "one-time" | "secret" | "not-web" | "unread";
/** What a card shows. `site` is the host as the card names it. A page's words are plain text; `image` and `icon` are
 *  data: URIs read here. `at`: when it was read. */
export type Preview =
  | { state: "page"; site: string; title: string; description: string; image?: string; icon?: string; at: number }
  | { state: "address"; why: NotRead; site: string };
/** One request that left for a site: which site, what for, and how much came back. Never the address's path. */
export type Sent = { at: number; host: string; kind: "page" | "picture" | "icon"; status: number; received_bytes: number };

// ---- which hosts are public ------------------------------------------------------------------------------------------
const PRIVATE_NETS = new net.BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  PRIVATE_NETS.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64]] as const) {
  PRIVATE_NETS.addSubnet(address, prefix, "ipv6");
}
/** The sixteen bytes of an IPv6 address, or null. */
function v6Bytes(address: string): number[] | null {
  let text = address.replace(/%.*$/, "");
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const q = tail[2].split(".").map(Number);
    if (q.some((n) => n > 255)) return null;
    text = `${tail[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part ? part.split(":") : []);
  const head = groups(halves[0]), rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
}
/** Whether an address (as a name resolves to it, or written in a link) is one no public site has: loopback, a private
 *  or shared range (a tailnet's 100.64/10 among them), link-local, unique-local, multicast, a documentation range, or
 *  one of those wrapped in an IPv6 form. Anything that isn't an address at all is treated as private. */
export function isPrivateAddress(address: string): boolean {
  const text = String(address || "").trim().replace(/^\[|\]$/g, "");
  if (net.isIPv4(text)) return PRIVATE_NETS.check(text, "ipv4");
  if (!net.isIPv6(text)) return true;
  const b = v6Bytes(text);
  if (!b) return true;
  const inner = (at: number) => PRIVATE_NETS.check(b.slice(at, at + 4).join("."), "ipv4");
  // An IPv4 address inside an IPv6 one is judged as the IPv4 address it reaches: mapped, translated (64:ff9b::/96),
  // and 6to4 (2002::/16).
  if (b.slice(0, 10).every((n) => n === 0) && b[10] === 0xff && b[11] === 0xff) return inner(12);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((n) => n === 0)) return inner(12);
  if (b[0] === 0x20 && b[1] === 0x02) return inner(2);
  return PRIVATE_NETS.check(text, "ipv6");
}
/** Whether a link's host is one no public site has, by its name or its written address. (The link's own check, before
 *  anything is resolved: a public name that resolves to a private address is caught where it is resolved.) */
export function privateHost(hostname: string): boolean {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return isPrivateAddress(bare);
  return PRIVATE_HOST.test(host);
}

// ---- one-time links ----------------------------------------------------------------------------------------------------
// A key or a path part that says the address is someone's own, or does something when it is opened.
const ONCE_WORDS = new Set(["token", "code", "key", "signature", "sig", "auth", "session", "otp", "magic", "reset", "verify", "confirm", "unsubscribe", "invite", "login", "signin",
  "password", "access_token", "id_token", "apikey", "api_key", "secret", "passwd", "pwd", "logout", "signout", "oauth", "sso", "authorize", "activate", "ticket", "nonce"]);
// In a path, these two are also ordinary words (a repository's "code", a page about a "key"): only as a whole part.
const WHOLE_PART_ONLY = new Set(["code", "key"]);
const bits = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** A part that reads as words (an article's slug, a file's name), not as an opaque value: two or more words of four
 *  letters or more, each lowercase or Capitalized. A key, a digest or an id has none. */
function readsAsWords(value: string): boolean {
  const words = (value.match(/[A-Za-z]+/g) || []).filter((run) => run.length >= 4 && (run === run.toLowerCase() || (run[0] === run[0].toUpperCase() && run.slice(1) === run.slice(1).toLowerCase())));
  return words.length >= 2;
}
/** A long opaque part: 24 or more characters of hex or base64, that doesn't read as words. */
function opaque(value: string): boolean {
  let text = value;
  try { text = decodeURIComponent(value); } catch { /* as written */ }
  for (const run of text.match(/[A-Za-z0-9+/_=-]{24,}/g) || []) {
    if (/^[0-9a-f-]+$/i.test(run) && run.replace(/-/g, "").length >= 24) return true;
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run) && !readsAsWords(run)) return true;
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && !/[-_]/.test(run) && !readsAsWords(run)) return true;
  }
  return false;
}
/** Whether an address looks like it carries a token or an action: reading it could spend a one-time link, sign
 *  someone in or out, or confirm something. Such a link is shown as its address alone. */
export function oneTimeLink(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return true; }
  const keys: string[] = [], values: string[] = [];
  const pairs = (text: string) => { for (const pair of text.split(/[&;]/)) { if (!pair) continue; const at = pair.indexOf("="); keys.push(at < 0 ? pair : pair.slice(0, at)); if (at >= 0) values.push(pair.slice(at + 1)); } };
  pairs(url.search.replace(/^\?/, ""));
  // (What follows "#" never leaves this machine, but a link that keeps a token there is still someone's own.)
  const hash = url.hash.replace(/^#/, "");
  if (hash.includes("=")) pairs(hash);
  for (const raw of keys) {
    let key = raw; try { key = decodeURIComponent(raw); } catch { /* as written */ }
    const low = key.toLowerCase();
    if (low.startsWith("x-amz-") || low.startsWith("x-goog-") || ONCE_WORDS.has(low) || bits(low).some((w) => ONCE_WORDS.has(w))) return true;
  }
  if (values.some(opaque)) return true;
  for (const raw of url.pathname.split("/")) {
    if (!raw) continue;
    let part = raw; try { part = decodeURIComponent(raw); } catch { /* as written */ }
    const low = part.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "");
    if (ONCE_WORDS.has(low)) return true;
    // ("reset-password", "verify-email", "magic-link"; a longer part is a title that happens to hold the word.)
    const parts = bits(low);
    if (parts.length <= 2 && parts.some((w) => ONCE_WORDS.has(w) && !WHOLE_PART_ONLY.has(w))) return true;
    if (opaque(part)) return true;
  }
  return false;
}

// ---- the outbound guard: an address that carries a secret is never read ------------------------------------------------
// DGC's own rule for what is a secret (the backend's redaction: known values, and anything shaped like a key), as far
// as this host can see: the environment's credential-named values and the project's .env secrets.
const SAFE_PLACEHOLDERS = new Set(["ollama", "sk-local", "lm-studio", "none", "null", "undefined", "password", "changeme", "example", "placeholder"]);
const SENSITIVE_NAME = /(?:^|[_-])(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?(?:access[_-]?)?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|passphrase|client[_-]?secret|private[_-]?key|credential)(?:$|[_-])/i;
const ENV_PASSWORD_NAME = /(?:^|[_-])(?:sudo|pass|pw)(?:$|[_-])/i;
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]+)@/i;
const PREFIX_TOKEN = /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[opusr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{12,})\b/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const usable = (value: unknown): string => { const v = typeof value === "string" ? value.trim() : ""; return v.length >= 8 && v.length <= 16_384 && !SAFE_PLACEHOLDERS.has(v.toLowerCase()) ? v : ""; };
/** Whether text holds a secret this host knows (`known`) or one shaped like a key, a sign-in in a URL or a signed token. */
export function carriesSecret(text: string, known: readonly string[] = []): boolean {
  const value = String(text || "");
  let plain = value;
  try { plain = decodeURIComponent(value); } catch { /* as written */ }
  for (const secret of known) { const s = usable(secret); if (s && (value.includes(s) || plain.includes(s))) return true; }
  return [value, plain].some((t) => URL_CREDENTIAL.test(t) || PREFIX_TOKEN.test(t) || JWT.test(t));
}
function looksSecret(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  if (/^(?:sk|pk|rk)_(?:live|test)_|^sk-|^ghp_|^gho_|^github_pat_|^xox[abposr]-|^AKIA|^AIza|^glpat-|^hf_/.test(value) || URL_CREDENTIAL.test(value)) return true;
  if (/^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(value)) return false;
  if (/[-.:/_]/.test(value) && readsAsWords(value)) return false;
  return value.length >= 20 && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}
/** The secret values in one .env file's text: a name that says so, a value that looks like one, a password inside a
 *  URL. A port, a mode or a plain address is not one. */
export function envSecrets(text: string): string[] {
  const found: string[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    else value = value.split(" #", 1)[0].trim();
    if (!value) continue;
    if (SENSITIVE_NAME.test(m[1]) || ENV_PASSWORD_NAME.test(m[1]) || looksSecret(value)) found.push(value);
    const password = URL_CREDENTIAL.exec(value);
    if (password) found.push(password[1]);
  }
  return found;
}
const envFileCache = new Map<string, { mtime: number; size: number; values: string[] }>();
let ambient: string[] | undefined;
/** What this host knows to be secret: the environment's credential-named values, and the secrets in each open
 *  project's top-level .env files (.env.example and its kind hold placeholders). Bounded, and read again only when a
 *  file changes. */
export function knownSecrets(): string[] {
  ambient ??= Object.entries(process.env).filter(([name, value]) => SENSITIVE_NAME.test(name) && usable(value)).map(([, value]) => String(value).trim()).slice(0, 256);
  const out = new Set(ambient);
  let folders: readonly { uri: { scheme?: string; fsPath?: string } }[] = [];
  try { folders = vscode.workspace?.workspaceFolders || []; } catch { folders = []; }
  for (const folder of folders.slice(0, 8)) {
    const root = folder?.uri?.fsPath;
    if (!root || (folder.uri.scheme && folder.uri.scheme !== "file")) continue;
    let names: string[] = [];
    try { names = readdirSync(root).filter((n) => (n === ".env" || n.startsWith(".env.")) && !/\.env\.(?:example|sample|template|dist|defaults?)$/i.test(n)).sort().slice(0, 16); } catch { continue; }
    for (const name of names) {
      const path = join(root, name);
      try {
        const info = statSync(path);
        if (!info.isFile() || info.size > 256 * 1024) continue;
        const had = envFileCache.get(path);
        if (!had || had.mtime !== info.mtimeMs || had.size !== info.size) envFileCache.set(path, { mtime: info.mtimeMs, size: info.size, values: envSecrets(readFileSync(path, "utf8")) });
        for (const value of envFileCache.get(path)!.values) if (out.size < 512) out.add(value);
      } catch { /* a file that can't be read holds nothing to match */ }
    }
  }
  return [...out];
}

/** Why a link is not read, or "" when it may be: not a web address, a private host, a secret in it, a one-time link. */
export function whyNotRead(value: string, known: readonly string[] = []): "" | Exclude<NotRead, "unread"> {
  let url: URL;
  try { url = new URL(String(value || "")); } catch { return "not-web"; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return "not-web";
  if (privateHost(url.hostname)) return "private";
  if (url.username || url.password || carriesSecret(url.href, known)) return "secret";
  if (oneTimeLink(url.href)) return "one-time";
  return "";
}

// ---- the head's words ----------------------------------------------------------------------------------------------------
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", times: "×", deg: "°", eacute: "é" };
function entities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""; } catch { return ""; }
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}
/** Words for a card: entities read, control and direction-override characters dropped, spaces folded, bounded. */
function words(text: string, most: number): string {
  const clean = entities(String(text || "")).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, (c) => (/[\t\n\r]/.test(c) ? " " : "")).replace(/\s+/g, " ").trim();
  return clean.length > most ? `${clean.slice(0, most - 1).trimEnd()}…` : clean;
}
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}
/** An address a page names (its picture, its icon), made whole against the page's own: only http(s). */
function webAddress(value: string, base: string): string {
  const text = entities(String(value || "")).trim();
  if (!text) return "";
  try { const url = new URL(text, base); return url.protocol === "http:" || url.protocol === "https:" ? url.href : ""; } catch { return ""; }
}
/** A page that says nothing of itself in its head (no description of any kind): its own first paragraph, from the part
 *  of the page already read (user test 2, W19: such a page's card repeated the link's words and said no more). Never
 *  a menu's, a header's or a footer's words, a cookie line, or a paragraph too short to say anything; cut at a word.
 *  Plain text only: tags are dropped, and what is left goes through the same cleaning as every other word here. */
function firstParagraph(text: string): string {
  const body = text.replace(/^[\s\S]*?<body\b[^>]*>/i, "").replace(/<(nav|header|footer|aside|form|button|select|figure|table)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)(?:<\/p\s*>|<p\b|<\/(?:div|section|article|main|body)\s*>|$)/gi)) {
    const said = words(m[1].replace(/<[^>]*>/g, " ").replace(/[<>]/g, " "), 2000);
    if (said.length < 50 || said.split(" ").length < 8 || /\bcookies?\b|\bjavascript\b|all rights reserved|©/i.test(said)) continue;
    if (said.length <= 240) return said;
    const cut = said.slice(0, 239), at = cut.lastIndexOf(" ");
    return `${(at > 120 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
  }
  return "";
}
/** What a page's head says of itself: og:, then twitter:, then <title> and the description, and where its picture and
 *  icon are. Read as text: no script runs, and nothing inside a script, a style or a comment counts. */
export function parseHead(html: string, base: string): { title: string; description: string; site: string; image: string; icon: string } {
  const text = String(html || "").replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/<(script|style|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");
  const meta = new Map<string, string>();
  for (const m of text.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = attributes(m[1]), name = (a.property || a.name || "").trim().toLowerCase();
    if (name && a.content !== undefined && a.content.trim() && !meta.has(name)) meta.set(name, a.content);
  }
  const first = (...names: string[]) => { for (const n of names) { const v = meta.get(n); if (v) return v; } return ""; };
  const title = words(first("og:title", "twitter:title") || (/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(text)?.[1] ?? ""), 200);
  const description = words(first("og:description", "twitter:description", "description"), 400) || firstParagraph(text);
  const site = words(first("og:site_name", "application-name"), 80);
  const image = webAddress(first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"), base);
  // The site's icon: a plain "icon" before any other kind, and one that isn't a drawing before one that is.
  let icon = "", rank = 0;
  for (const m of text.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attributes(m[1]), rel = (a.rel || "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") || rel.includes("mask-icon") || !a.href) continue;
    const drawing = /svg/i.test(a.type || "") || /\.svg(?:[?#]|$)/i.test(a.href);
    const score = (drawing ? 1 : 3) + (rel.length === 1 ? 1 : 0);
    const address = webAddress(a.href, base);
    if (address && score > rank) { icon = address; rank = score; }
  }
  return { title, description, site, image, icon };
}

// ---- reading, narrowly -------------------------------------------------------------------------------------------------------
type Address = { address: string; family: number };
export type LinkPreviewOptions = {
  /** dgc.linkPreviews, read each time. */
  enabled?: () => boolean;
  /** Where answers are kept between windows; none: in memory only. */
  dir?: string;
  now?: () => number;
  /** What this host knows to be secret (knownSecrets). */
  secrets?: () => readonly string[];
  /** A name's addresses (the system's resolver). */
  resolve?: (hostname: string) => Promise<Address[]>;
  /** Where a checked address is reached. Itself, always: a test stands its sites on this machine through it. */
  dial?: (address: string, port: number, hostname: string) => { address: string; port: number };
  limits?: Partial<Limits>;
};
class Refused extends Error { constructor(readonly why: NotRead) { super(why); } }
const USER_AGENT = "Mozilla/5.0 (compatible; DGC link preview)";
const PICTURE_TYPES = /^image\/(?:png|jpeg|gif|webp|avif)$/, ICON_TYPES = /^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)$/, PAGE_TYPES = /^(?:text\/html|application\/xhtml\+xml)$/;
const systemResolve = (hostname: string) => dns.promises.lookup(hostname, { all: true, verbatim: true });
const display = (url: URL) => url.host.replace(/^www\./i, "");

export interface LinkPreviews {
  /** What a card for this address shows. Never throws: an address that isn't read, or couldn't be, is "address". */
  preview(url: string): Promise<Preview>;
  /** A page's question ({type, id, url, have?}), answered through `reply` on the page that asked. True when the
   *  message was the question (answered or not). */
  handle(message: unknown, reply: (message: Record<string, unknown>) => unknown): Promise<boolean>;
  /** What left for the web, newest last: each site asked, what for, and how much came back. */
  sent(): readonly Sent[];
  /** Forget what is kept in memory. */
  forget(): void;
  /** Once what is being written to the folder has been. */
  settled(): Promise<void>;
}

export function createLinkPreviews(options: LinkPreviewOptions = {}): LinkPreviews {
  const limits: Limits = { ...LIMITS, ...(options.limits || {}) };
  const now = options.now || Date.now, enabled = options.enabled || (() => true), secrets = options.secrets || (() => []);
  const resolve = options.resolve || systemResolve, dial = options.dial || ((address: string, port: number) => ({ address, port }));
  const kept = new Map<string, { until: number; preview: Preview }>();
  const reading = new Map<string, Promise<Preview>>();
  const log: Sent[] = [];
  let busy = 0; const waiting: (() => void)[] = [];
  let writes: Promise<unknown> = Promise.resolve();

  /** One GET of one address, following at most `limits.redirects` redirects, each checked as the first was. Resolves
   *  with what came back under the caps; rejects with Refused("private") or an error. */
  async function get(start: string, kind: Sent["kind"], accept: string, types: RegExp, most: number, whole: boolean, deadline: number): Promise<{ url: URL; body: Buffer; type: string }> {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      url.hash = "";
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Refused("unread");
      if (privateHost(url.hostname)) throw new Refused("private");
      if (url.username || url.password || carriesSecret(url.href, secrets())) throw new Refused("secret");
      const name = url.hostname.replace(/^\[|\]$/g, "");
      const addresses: Address[] = net.isIP(name) ? [{ address: name, family: net.isIP(name) }] : await resolve(name);
      // Every address the name gives is checked, and the one connected to is one of those: a name can't pass the
      // check with one address and be reached at another.
      if (!addresses.length) throw new Refused("unread");
      if (addresses.some((a) => isPrivateAddress(a.address))) throw new Refused("private");
      const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      const to = dial(addresses[0].address, port, name);
      const family = net.isIP(to.address) || addresses[0].family;
      const left = deadline - Date.now();
      if (left <= 0) throw new Refused("unread");
      const answer = await new Promise<{ status: number; location: string; type: string; body: Buffer }>((done, fail) => {
        let settled = false, received = 0, status = 0;
        const finish = (error: Error | null, value?: { status: number; location: string; type: string; body: Buffer }) => {
          if (settled) return;
          settled = true; clearTimeout(timer); request.destroy();
          log.push({ at: now(), host: url.host, kind, status, received_bytes: received });
          if (log.length > limits.sentEntries) log.splice(0, log.length - limits.sentEntries);
          if (error || !value) fail(error || new Error("no answer")); else done(value);
        };
        const request = (url.protocol === "https:" ? https : http).request({
          protocol: url.protocol, host: name, servername: net.isIP(name) ? undefined : name, port: to.port, path: `${url.pathname}${url.search}`, method: "GET", agent: false,
          headers: { Host: url.host, "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "en", "Accept-Encoding": "identity", Connection: "close" },
          // The socket goes to the address that was checked, whatever the name says when asked again.
          lookup: ((_host: string, opts: unknown, callback: (...args: unknown[]) => void) => {
            const cb = typeof opts === "function" ? (opts as typeof callback) : callback;
            if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) cb(null, [{ address: to.address, family }]); else cb(null, to.address, family);
          }) as unknown as net.LookupFunction,
        }, (response) => {
          status = response.statusCode || 0;
          const type = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          if (status >= 300 && status < 400 && response.headers.location) { finish(null, { status, location: String(response.headers.location), type, body: Buffer.alloc(0) }); return; }
          if (status < 200 || status >= 300 || !types.test(type)) { finish(new Refused("unread")); return; }
          // A picture is taken whole or not at all; a page is taken up to where its head ends.
          if (whole && Number(response.headers["content-length"]) > most) { finish(new Refused("unread")); return; }
          const chunks: Buffer[] = [];
          let tail = "";
          response.on("data", (chunk: Buffer) => {
            received += chunk.length; chunks.push(chunk);
            if (whole) { if (received > most) finish(new Refused("unread")); return; }
            const seen = tail + chunk.toString("latin1");
            tail = seen.slice(-16);
            if (received >= most || /<\/head\s*>|<body[\s>]/i.test(seen)) finish(null, { status, location: "", type: String(response.headers["content-type"] || ""), body: Buffer.concat(chunks) });
          });
          response.on("end", () => finish(null, { status, location: "", type: whole ? type : String(response.headers["content-type"] || ""), body: Buffer.concat(chunks) }));
          response.on("error", (error) => finish(error));
        });
        const timer = setTimeout(() => finish(new Refused("unread")), left);
        // The other end is the address that was checked, or nothing is read (a proxy in between is not that address).
        request.on("socket", (socket) => {
          const check = () => { const remote = String(socket.remoteAddress || "").replace(/^::ffff:(?=\d+\.)/i, ""); if (remote && remote !== to.address && !sameAddress(remote, to.address)) finish(new Refused("private")); };
          if (socket.connecting) socket.once("connect", check); else check();
        });
        request.on("error", (error) => finish(error));
        request.end();
      });
      if (answer.location) {
        if (hop >= limits.redirects) throw new Refused("unread");
        url = new URL(answer.location, url);
        continue;
      }
      return { url, body: answer.body, type: answer.type };
    }
  }

  async function turn<T>(work: () => Promise<T>): Promise<T> {
    // (A place that frees goes straight to whoever waited longest: never more than `atOnce` are reading.)
    if (busy >= limits.atOnce) await new Promise<void>((go) => waiting.push(go)); else busy++;
    try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else busy--; }
  }
  async function picture(address: string, kind: "picture" | "icon", deadline: number): Promise<string | undefined> {
    if (!address) return undefined;
    try {
      const got = await get(address, kind, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", kind === "icon" ? ICON_TYPES : PICTURE_TYPES, kind === "icon" ? limits.iconBytes : limits.pictureBytes, true, deadline);
      return got.body.length ? `data:${got.type};base64,${got.body.toString("base64")}` : undefined;
    } catch { return undefined; }
  }
  async function read(url: URL): Promise<Preview> {
    const site = display(url);
    try {
      const page = await get(url.href, "page", "text/html,application/xhtml+xml;q=0.9", PAGE_TYPES, limits.headBytes, false, Date.now() + limits.timeoutMs);
      const charset = /charset\s*=\s*"?([\w-]+)/i.exec(page.type)?.[1] || /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(page.body.subarray(0, 2048).toString("latin1"))?.[1] || "utf-8";
      let html: string;
      try { html = new TextDecoder(charset).decode(page.body); } catch { html = new TextDecoder("utf-8").decode(page.body); }
      const head = parseHead(html, page.url.href);
      if (!head.title && !head.description) return { state: "address", why: "unread", site };
      const until = Date.now() + limits.timeoutMs;
      const [image, icon] = await Promise.all([picture(head.image, "picture", until), picture(head.icon, "icon", until)]);
      return { state: "page", site: display(page.url) || site, title: head.title || head.site || site, description: head.description, ...(image ? { image } : {}), ...(icon ? { icon } : {}), at: now() };
    } catch (error) {
      return { state: "address", why: error instanceof Refused ? error.why : "unread", site };
    }
  }

  // ---- kept for a day ----
  const fileOf = (key: string) => join(options.dir!, `${createHash("sha256").update(key).digest("hex")}.json`);
  async function fromDisk(key: string): Promise<Preview | undefined> {
    if (!options.dir) return undefined;
    try {
      const saved = JSON.parse(await readFile(fileOf(key), "utf8"));
      const p = saved?.preview;
      if (saved?.v !== 1 || p?.state !== "page" || typeof p.at !== "number" || p.at + limits.keepMs <= now() || p.at > now() + 60_000) return undefined;
      const data = (v: unknown) => (typeof v === "string" && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(v) ? v : undefined);
      const image = data(p.image), icon = data(p.icon);
      return { state: "page", site: String(p.site || "").slice(0, 300), title: String(p.title || "").slice(0, 200), description: String(p.description || "").slice(0, 400), ...(image ? { image } : {}), ...(icon ? { icon } : {}), at: p.at };
    } catch { return undefined; }
  }
  function toDisk(key: string, preview: Preview): void {
    if (!options.dir || preview.state !== "page") return;
    const dir = options.dir, file = fileOf(key);
    writes = writes.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const part = `${file}.${process.pid}.part`;
      await writeFile(part, JSON.stringify({ v: 1, preview }), { mode: 0o600 });
      await rename(part, file);
      // The folder stays small: past its count or its size, the oldest go.
      const names = (await readdir(dir)).filter((n) => /^[a-f0-9]{64}\.json$/.test(n));
      const files = (await Promise.all(names.map(async (n) => { try { const s = await stat(join(dir, n)); return { n, at: s.mtimeMs, size: s.size }; } catch { return null; } }))).filter((f): f is { n: string; at: number; size: number } => !!f);
      files.sort((a, b) => b.at - a.at || (a.n < b.n ? -1 : 1));
      let total = 0;
      for (const [i, f] of files.entries()) { total += f.size; if (i >= limits.diskFiles || total > limits.diskBytes) await unlink(join(dir, f.n)).catch(() => undefined); }
    }).catch(() => undefined);
  }
  function keep(key: string, preview: Preview): void {
    kept.delete(key);
    kept.set(key, { until: now() + (preview.state === "page" ? limits.keepMs : limits.retryMs), preview });
    for (const old of kept.keys()) { if (kept.size <= limits.memoryEntries) break; kept.delete(old); }
  }
  function held(key: string): Preview | undefined {
    const entry = kept.get(key);
    if (!entry) return undefined;
    if (entry.until > now() && (entry.preview.state !== "page" || entry.preview.at + limits.keepMs > now())) return entry.preview;
    kept.delete(key);
    return undefined;
  }

  /** The address as it is asked for and kept: whole, without what follows "#". */
  function keyOf(value: string): { url: URL; key: string } | undefined {
    try { const url = new URL(String(value)); url.hash = ""; return { url, key: url.href }; } catch { return undefined; }
  }
  function alone(value: string, why: NotRead): Preview {
    let site = "";
    try { site = new URL(value).host; } catch { site = String(value).slice(0, 120); }
    return { state: "address", why, site };
  }
  /** What is known without reading anything: an address that is never read, or an answer still kept. */
  function known(value: string): Preview | undefined {
    const why = whyNotRead(value, secrets());
    if (why) return alone(value, why);
    return held(keyOf(value)!.key);
  }
  function preview(value: string): Promise<Preview> {
    const ready = known(value);
    if (ready) return Promise.resolve(ready);
    const { url, key } = keyOf(value)!;
    const going = reading.get(key);
    if (going) return going;
    const work = (async () => {
      const saved = await fromDisk(key);
      if (saved) { keep(key, saved); return saved; }
      const got = await turn(() => read(url));
      // (A private answer is the address's own, said again each time; one that could not be read is left alone a while.)
      if (got.state === "page" || got.why === "unread") keep(key, got);
      toDisk(key, got);
      return got;
    })().finally(() => reading.delete(key));
    reading.set(key, work);
    return work;
  }

  async function handle(message: unknown, reply: (message: Record<string, unknown>) => unknown): Promise<boolean> {
    const m = message as { type?: unknown; id?: unknown; url?: unknown; have?: unknown } | null;
    if (!m || m.type !== LINK_PREVIEW_MESSAGE) return false;
    if (typeof m.id !== "string" || !m.id || m.id.length > 64 || typeof m.url !== "string" || !m.url || m.url.length > 8192) return true;
    const say = (answer: Record<string, unknown>) => { try { void reply({ type: LINK_PREVIEW_MESSAGE, id: m.id, url: m.url, ...answer }); } catch { /* a page that has gone */ } };
    let on = false;
    try { on = enabled() !== false; } catch { on = false; }
    if (!on) { say({ state: "off" }); return true; }
    const answer = (p: Preview) => say(p.state === "page" && typeof m.have === "number" && m.have === p.at ? { state: "same" } : p);
    const ready = known(m.url);
    if (ready) { answer(ready); return true; }
    say({ state: "reading", site: display(keyOf(m.url)!.url) });
    answer(await preview(m.url));
    return true;
  }
  return { preview, handle, sent: () => log.slice(), forget: () => { kept.clear(); }, settled: () => writes.then(() => undefined) };
}
/** Two written forms of one address. */
function sameAddress(a: string, b: string): boolean {
  if (net.isIPv6(a) && net.isIPv6(b)) { const x = v6Bytes(a), y = v6Bytes(b); return !!x && !!y && x.join(".") === y.join("."); }
  return a === b;
}

// ---- the editor's one -------------------------------------------------------------------------------------------------------
/** Settings -> Security -> "Show a preview when you point at a link" (dgc.linkPreviews): on unless it was turned off. */
/** Today's record of what previews read, one row per site, newest first (Settings › Security › Links shows it). */
export function sentToday(list: readonly Sent[], now = Date.now()): { host: string; times: number; last: number; bytes: number }[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const bySite = new Map<string, { host: string; times: number; last: number; bytes: number }>();
  for (const s of list) {
    if (!(s.at >= start.getTime()) || !s.host) continue;
    const row = bySite.get(s.host) ?? { host: s.host, times: 0, last: 0, bytes: 0 };
    row.times += 1; row.last = Math.max(row.last, s.at); row.bytes += Number(s.received_bytes) || 0;
    bySite.set(s.host, row);
  }
  return [...bySite.values()].sort((a, b) => b.last - a.last);
}

export function linkPreviewsOn(): boolean {
  try { return vscode.workspace.getConfiguration("dgc").get<boolean>("linkPreviews", true) !== false; } catch { return false; }
}
/** Settings' switch: for every window, at once. */
export async function setLinkPreviews(on: unknown): Promise<void> {
  if (typeof on !== "boolean") return;
  await vscode.workspace.getConfiguration("dgc").update("linkPreviews", on, vscode.ConfigurationTarget.Global);
}
let shared: LinkPreviews | undefined, sharedDir: string | undefined;
/** Where the editor keeps answers between windows (its own storage folder). Said once, as the extension starts. */
export function useLinkPreviewFolder(dir: string | undefined): void {
  if (dir && dir !== sharedDir) { sharedDir = dir; shared = undefined; }
}
/** The one reader every host in this window answers with. */
export function linkPreviews(): LinkPreviews {
  return shared ??= createLinkPreviews({ enabled: linkPreviewsOn, secrets: knownSecrets, ...(sharedDir ? { dir: sharedDir } : {}) });
}
/** A page's question, answered on the page that asked. Every host's one way in: Work's, ChatDGC's and the Pips tab's. */
export function handleLinkPreview(message: unknown, reply: (message: Record<string, unknown>) => unknown): Promise<boolean> {
  return linkPreviews().handle(message, reply).catch(() => true);
}
