import MarkdownIt from "markdown-it";
import { renderGenerativeUi } from "./generativeUi";
import { addMath } from "./markdownMath";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import diff from "highlight.js/lib/languages/diff";

for (const [name, grammar] of Object.entries({ javascript, typescript, python, json, xml, css, bash,
  yaml, sql, rust, go, diff })) hljs.registerLanguage(name, grammar);

/** Render model output without executable HTML, automatic network requests, or webview navigation.
 * Links are inert buttons; the extension host validates them again on an explicit user click. */
// linkify is safe here precisely because a link is never an anchor: link_open below turns every
// one into an inert button that the extension host re-validates on click.
const parser = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
const escape = parser.utils.escapeHtml;

export type LinkTarget = { kind: "external" | "file"; target: string; line?: number; endLine?: number };

export function linkTarget(value: string): LinkTarget | undefined {
  if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (!url.username && !url.password) return { kind: "external", target: url.href };
    } catch { /* malformed URL */ }
    return;
  }
  let path: string;
  try { path = decodeURIComponent(value); } catch { return; }
  // A scheme that runs or reads something is refused whatever follows it, digits too ("javascript:1").
  if (/^(?:javascript|vbscript|data|file|command|vscode[\w.+-]*|about|blob):/i.test(path)) return;
  if (!path || path.startsWith("#") || path.includes("?")) return;
  // A file and its line or lines, as models write them (README.md:12, a.ts:3:7, a.py#L40, billing.py:9-12, a.py#L9-L12).
  // The lines come off first, so a bare name like "README.md:" or "billing.py:9-12" isn't read as a scheme and left as
  // raw text.
  const location = /(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?)$/.exec(path);
  const line = location ? Number(location[1] || location[3]) : undefined;
  const last = location ? Number(location[2] || location[4]) : undefined;
  if (location) path = path.slice(0, location.index);
  if (/[\u0000-\u001f\u007f]/.test(path) || /^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\)/i.test(path)
      && !/^[A-Za-z]:[\\/]/.test(path)) return;
  return path ? { kind: "file", target: path,
    ...(line && Number.isSafeInteger(line) ? { line } : {}),
    ...(line && last && Number.isSafeInteger(last) && last > line ? { endLine: last } : {}) } : undefined;
}

/** What a rendered link (`.md-link`) points at, as linkTarget read it when it was drawn: its one way back. */
export function linkOf(dataset: { target?: string; line?: string; endLine?: string }): LinkTarget | undefined {
  const lines = dataset.line ? `:${dataset.line}${dataset.endLine ? `-${dataset.endLine}` : ""}` : "";
  return linkTarget(String(dataset.target || "") + lines);
}

// What a failed model request means, for a person: the words Work, ChatDGC and a Pip's chat all use, with the provider's
// own answer (a status, a URL, its JSON) one click away and never in the sentence. `fix`: Settings -> Models is where it
// is put right. Reads either the kind the backend named (error.cause.kind), or the text a surface was handed.
export type ModelWords = { kind: string; headline: string; next: string; fix: boolean };
const REACH_KINDS = new Set(["connect", "dns", "tls", "proxy", "reset", "connect_timeout"]);
export function modelWords(kind: string, model = ""): ModelWords {
  const say = (headline: string, next: string, fix = false): ModelWords => ({ kind, headline, next, fix });
  if (kind === "no_provider") return say("No model provider yet.", "Add one to start.", true);
  if (kind === "model_not_found") {
    return say(model ? `The model ${model} isn't available.` : "That model isn't available.",
      "Choose another one, or add a provider.", true);
  }
  if (kind === "auth") return say("The model provider turned down the API key.", "Check the key.", true);
  if (REACH_KINDS.has(kind)) return say("DGC can't reach the model provider.", "Check that it's running, or change it.", true);
  if (kind === "rate_limited") return say("The model provider is limiting requests right now.", "Wait a moment and try again.");
  if (kind === "overloaded") return say("The model provider is too busy right now.", "Try again in a moment.");
  if (kind === "http") return say("The model provider had a problem on its side.", "Try again in a moment.");
  if (kind === "stream_cut") return say("The connection to the model kept breaking.", "Try again in a moment.");
  if (kind === "stall" || kind === "loading") return say("The model stopped responding.", "Try again, or choose another one.", true);
  return say("The model didn't answer.", "Try again in a moment.");
}
/** The same words for text a surface was handed, or null when the text isn't a model request's failure (it stays as it
 *  is). A model's own name is read from the provider's answer. */
export function modelFailure(text: string): (ModelWords & { detail: string }) | null {
  const detail = String(text || "");
  // How a failure reaches a surface: ChatDGC's "The model didn't answer: ...", or a Pip's run ending on the request's own
  // "HTTP 404 from ...". Anything else is someone else's sentence (a plugin's, a page's), whatever it mentions.
  const body = detail.replace(/^the model didn't answer: /i, "");
  const prefixed = body !== detail, said = body.toLowerCase();
  const status = Number(/^HTTP (\d{3})\b/.exec(body)?.[1] || 0);
  const unreachable = /cannot connect|connection refused|max retries|failed to establish|name or service not known|getaddrinfo|certificate verify failed|connection reset|could not connect|is not answering/.test(said);
  let kind = "";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429) kind = "rate_limited";
  else if (status === 503 || status === 529) kind = "overloaded";
  else if (status === 404 || (status && /no such model|unknown model|model\b.*\bnot found/.test(said))) kind = "model_not_found";
  else if (status >= 500) kind = "http";
  else if (status) kind = "other";
  else if (unreachable && (prefixed || /^(?:cannot connect|could not connect|the endpoint|connection|httpconnectionpool|httpsconnectionpool)/.test(said))) kind = "connect";
  else if (prefixed) kind = "other";
  if (!kind) return null;
  const named = /model ['"\u2018]([^'"\u2019]{1,200})['"\u2019]/i.exec(detail)?.[1] || "";
  return { ...modelWords(kind, named), detail };
}

// Which source a link points at. These bundled codicons cost no network and are what a link
// falls back to: when favicons are switched off, when the icon service cannot be reached, and
// when it has nothing for that host.
//
// They used to be the ONLY mark model output got, on the reasoning that a link a model wrote is
// not a link the user chose. Codex does not draw that line -- a link in one of its answers wears
// the site's real favicon -- and the maintainers asked for that behaviour, having been shown what it
// discloses. The disclosure is bounded: the icon service is asked about an ORIGIN, it fetches the
// site itself, so the site's operator sees a hit from Google rather than from the reader.
const LINK_SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)github\.com$/i, "github"],
  [/(^|\.)gitlab\.com$/i, "gitlab"],
  [/(^|\.)vibedgc\.com$/i, "dgc"],
  [/(^|\.)marketplace\.visualstudio\.com$/i, "marketplace"],
  [/(^|\.)open-vsx\.org$/i, "openvsx"],
  [/(^|\.)npmjs\.com$/i, "npm"],
  [/(^|\.)stackoverflow\.com$/i, "stackoverflow"],
];

// Which kind of file a link points at, for the mark shown beside it. Codex names a file with its
// icon rather than spelling the extension out in the sentence; the path stays in the hover label.
// Bundled codicons again -- no network, nothing leaked.
const FILE_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.(py|pyi|pyw)$/i, "python"],
  [/\.(tsx|jsx)$/i, "react"],              // before ts/js, which would otherwise claim them
  [/\.(ts|mts|cts)$/i, "ts"],
  [/\.(js|mjs|cjs)$/i, "js"],
  [/\.(json|jsonc|json5)$/i, "json"],
  [/\.(md|markdown|mdx|rst|txt)$/i, "doc"],
  [/\.(ya?ml|toml|ini|cfg|conf|env|properties)$/i, "config"],
  [/\.(css|scss|sass|less)$/i, "css"],
  [/\.svg$/i, "svg"],
  [/\.(html?|xml)$/i, "markup"],
  [/\.(sh|bash|zsh|fish|ps1|bat|cmd)$/i, "shell"],
  [/\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i, "image"],
  // One row per language, not one "code" bucket for eleven of them: collapsed, a .go and a .rs
  // drew the same glyph and the mark told you nothing you did not already know from the filename.
  [/\.go$/i, "go"],
  [/\.rs$/i, "rust"],
  [/\.java$/i, "java"],
  [/\.kts?$/i, "kotlin"],
  [/\.swift$/i, "swift"],
  [/\.rb$/i, "ruby"],
  [/\.php$/i, "php"],
  [/\.(cpp|hpp|cc|hh|cxx)$/i, "cpp"],     // before the single-letter c/h row below
  [/\.cs$/i, "csharp"],
  [/\.[ch]$/i, "c"],
  [/\.(sql|db|sqlite3?)$/i, "database"],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|whl|vsix)$/i, "archive"],
  [/\.(lock|sum)$/i, "lock"],
];

// The favicon for a link the USER typed. Codex's mechanism exactly: Google's icon service, keyed
// on the ORIGIN alone, so the path, query and fragment of the link never leave the machine -- a
// URL carrying a token in it discloses only its host. The trade Codex makes, and we make with it,
// is that Google learns that host. Never called for model output, which keeps the bundled marks.
// Off switches every favicon in the panel at once, model output included, so `dgc.linkFavicons`
// means what it says: no request leaves this machine for an icon.
let faviconsEnabled = true;
export function setFavicons(on: boolean): void { faviconsEnabled = !!on; }
export function faviconsOn(): boolean { return faviconsEnabled; }

export function faviconUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.origin)}&sz=32`;
  } catch { return; }
}

export function fileKind(target: string): string {
  const name = String(target || "").replace(/[\\/]+$/, "");
  if (!name) return "file";
  if (/[\\/]$/.test(String(target))) return "folder";
  for (const [pattern, kind] of FILE_KINDS) { if (pattern.test(name)) return kind; }
  return "file";
}

export function linkSource(target: string): string {
  try {
    const host = new URL(target).hostname;
    for (const [pattern, name] of LINK_SOURCES) { if (pattern.test(host)) return name; }
    return "web";
  } catch { return "web"; }
}

// markdown-it's default URL policy is an additional parser boundary. Our policy permits only
// HTTP(S) and file paths, including drive-letter paths for remote Windows workspaces.
parser.validateLink = (value: string) => !!linkTarget(value);
parser.renderer.rules.link_open = (tokens, index) => {
  const target = linkTarget(String(tokens[index].attrGet("href") || ""));
  if (!target) return "<span>";
  const location = target.line ? ` data-line="${target.line}"${target.endLine ? ` data-end-line="${target.endLine}"` : ""}` : "";
  if (target.kind !== "external") {
    return `<button type="button" class="md-link" data-link-kind="${target.kind}" data-target="${escape(target.target)}"${location}`
         + ` data-file-kind="${fileKind(target.target)}" title="${escape(target.target)}">`;
  }
  const mark = linkSource(target.target);
  const icon = faviconsEnabled ? faviconUrl(target.target) : undefined;
  // With a favicon the bundled glyph must NOT also render, so the mark travels as
  // data-link-fallback instead -- inert to the CSS until the one global error handler in main.js
  // promotes it, which is what happens when the image cannot load.
  const attr = icon ? ` data-link-fallback="${mark}"` : ` data-link-source="${mark}"`;
  const img = icon
    ? `<img class="link-favicon" src="${escape(icon)}" alt="" aria-hidden="true" referrerpolicy="no-referrer">`
    : "";
  return `<button type="button" class="md-link" data-link-kind="external" data-target="${escape(target.target)}"${location}${attr} title="${escape(target.target)}">${img}`;
};
parser.renderer.rules.link_close = () => "</button>";
// A link to a file whose name has a space: models write [notes](my notes.md:9-12), which Markdown doesn't read as a link
// (a destination can't hold one), so it stayed raw text. Only a destination that names a file: a word, a title, a URL or
// a scheme goes on to the ordinary rule, which keeps it as the text it is.
parser.inline.ruler.before("link", "spaced_file_link", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x5B) return false;
  const found = /^\[([^\[\]\n]+)\]\(([^()\n]+)\)/.exec(state.src.slice(state.pos));
  const destination = found?.[2].trim() || "";
  if (!found || !/\s/.test(destination) || /^[<"']|["']$/.test(destination)
      || !/[\\/]|\.[A-Za-z0-9]{1,8}(?:$|[:#])/.test(destination)) return false;
  if (linkTarget(destination)?.kind !== "file") return false;
  if (!silent) {
    state.push("link_open", "a", 1).attrSet("href", destination);
    state.push("text", "", 0).content = found[1];
    state.push("link_close", "a", -1);
  }
  state.pos += found[0].length;
  return true;
});
parser.renderer.rules.image = (tokens, index) => {
  // Model-provided image URLs must never trigger an invisible network request. A labelled link
  // lets the user decide whether to view it in the browser or open a local artifact.
  const token = tokens[index], target = linkTarget(String(token.attrGet("src") || ""));
  const label = escape(token.content || "Image");
  if (!target) return label;
  const kind = target.kind === "file" ? ` data-file-kind="${fileKind(target.target)}"` : "";
  return `<button type="button" class="md-link" data-link-kind="${target.kind}" data-target="${escape(target.target)}"${kind} title="${escape(target.target)}">${label}</button>`;
};
parser.renderer.rules.fence = (tokens, index, _options, env) => {
  const info = String(tokens[index].info || "").trim().toLowerCase();
  // A card is live only in DGC's own reply in a chat (render(..., { cards: true })). A skill's page, the docs, a
  // helper's or a Pip's report and the rest show its JSON as code: their author isn't the one answering you.
  if (info === "dgc-ui" && env?.cards === true) {
    const card = renderGenerativeUi(tokens[index].content);
    if (card) return card;
  }
  return codeBlock(tokens[index].content, tokens[index].info);
};
parser.renderer.rules.code_block = (tokens, index) => codeBlock(tokens[index].content, "");

function codeBlock(content: string, info: string): string {
  const language = /^[A-Za-z0-9_+.-]+/.exec(info.trim())?.[0] || "text";
  let highlighted = escape(content);
  // Explicit, bundled grammars only. Large blocks stay cheap and preserve exact source copying.
  if (content.length <= 20000 && hljs.getLanguage(language.toLowerCase())) {
    try { highlighted = hljs.highlight(content, { language: language.toLowerCase(), ignoreIllegals: true }).value; }
    catch { /* Preserve readable escaped source if a grammar cannot parse this block. */ }
  }
  // Keep the source in a data attribute for exact copy, separate from syntax/presentation markup.
  return `<pre class="code" data-language="${escape(language)}"><span class="code-language">${escape(language)}</span><button type="button" class="copy" data-c="${escape(encodeURIComponent(content))}" aria-label="Copy code" title="Copy code"><span class="codicon codicon-copy" aria-hidden="true"></span></button><code>${highlighted}</code></pre>`;
}

// A table is the one block a reader reliably wants out of the panel and into a document, and it
// was the only block with no copy path. The source is stashed the same way a code fence stashes
// its own, so the copy is the model's markdown rather than the rendered DOM.
parser.renderer.rules.table_open = (tokens, index) => {
  const source = tableSource(tokens, index);
  const copy = source
    ? `<button type="button" class="copy" data-c="${escape(encodeURIComponent(source))}" aria-label="Copy table" title="Copy table"><span class="codicon codicon-copy" aria-hidden="true"></span></button>`
    : "";
  return `<div class="md-table-wrap">${copy}<table class="md-table">`;
};
parser.renderer.rules.table_close = () => "</table></div>";

// A quoted block is usually the one part of a response meant to leave the panel whole -- a drafted
// mail, a message to forward -- and it was the last block with no copy of its own, so lifting it
// meant dragging a selection across the panel's own scroll. Only the outermost quote gets the
// button: a nested quote inside it is part of what you are copying, not a second thing to copy.
parser.renderer.rules.blockquote_open = (tokens, index, _options, env, self) => {
  const source = tokens[index].level === 0 ? quoteSource(tokens[index], env) : "";
  const copy = source
    ? `<button type="button" class="copy" data-c="${escape(encodeURIComponent(source))}" aria-label="Copy quoted text" title="Copy quoted text"><span class="codicon codicon-copy" aria-hidden="true"></span></button>`
    : "";
  return `${self.renderToken(tokens, index, _options)}${copy}`;
};

function quoteSource(token: any, env: any): string {
  // markdown-it keeps no raw text for a quote, but it does keep the line span, and render() hands
  // the source down in env. The quote markers come off: what belongs on the clipboard is the mail,
  // not "> " running down its left edge.
  const lines = typeof env?.src === "string" ? env.src.split("\n") : null;
  if (!lines || !Array.isArray(token.map)) return "";
  return lines.slice(token.map[0], token.map[1])
    .map((line: string) => line.replace(/^\s{0,3}>\s?/, ""))
    .join("\n").trim();
}

function tableSource(tokens: any[], index: number): string {
  // markdown-it does not keep the raw table text, so rebuild it from the inline tokens. Good
  // enough to paste into another markdown document, which is the whole point of the button.
  const rows: string[][] = [];
  let row: string[] = [];
  let headerRows = 0;
  let inHeader = false;
  for (let i = index; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "table_close") break;
    if (token.type === "thead_open") inHeader = true;
    else if (token.type === "thead_close") inHeader = false;
    if (token.type === "tr_open") row = [];
    else if (token.type === "tr_close") { rows.push(row); if (inHeader) headerRows = rows.length; }
    else if (token.type === "inline") row.push(String(token.content || "").replaceAll("\\", "\\\\").replaceAll("|", "\\|"));
  }
  if (!rows.length) return "";
  const width = rows.reduce((largest, cells) => Math.max(largest, cells.length), 0);
  const line = (cells: string[]) =>
    "| " + Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ") + " |";
  const out = [line(rows[0]), "| " + Array.from({ length: width }, () => "---").join(" | ") + " |"];
  for (const rest of rows.slice(Math.max(1, headerRows || 1))) out.push(line(rest));
  return out.join("\n");
}

// GitHub-style task lists. "- [ ] step" rendered as the literal characters, which made every
// checklist answer look broken.
parser.renderer.rules.list_item_open = (tokens, index, options, _env, self) => {
  // A numbered item keeps the number it was written with: 1, 2, 4 stays that, as the model wrote it.
  if (/^\d{1,9}$/.test(tokens[index].info || "")) tokens[index].attrSet("value", String(Number(tokens[index].info)));
  const inline = tokens[index + 2];
  const text = inline && inline.type === "inline" ? String(inline.content || "") : "";
  const task = /^\[([ xX])\]\s+/.exec(text);
  if (!task) return self.renderToken(tokens, index, options);
  const checked = task[1].toLowerCase() === "x";
  inline.content = text.slice(task[0].length);
  if (inline.children && inline.children.length && inline.children[0].type === "text") {
    inline.children[0].content = String(inline.children[0].content).replace(/^\[[ xX]\]\s+/, "");
  }
  return `<li class="task-item"><input type="checkbox" disabled${checked ? " checked" : ""} `
    + `aria-label="${checked ? "done" : "not done"}">`;
};

// A run of numbered lines right under a line of text, not starting at 1: "**Second heading**\n5. e\n6. f". Markdown lets only
// a 1 interrupt a paragraph, so it all ran together as one paragraph. Two numbered lines in a row, ascending, end the
// paragraph; the list rule then reads them as a list, from where they start. One such line stays the sentence it may be
// ("2026. was a good year"), and code is never looked at: this is asked only about a paragraph's next line.
const NUMBERED_LINE = /^(\d{1,9})[.)][ \t]+\S/;
parser.block.ruler.after("list", "numbered_run", (state, startLine, endLine, silent) => {
  if (!silent || state.parentType !== "paragraph") return false;
  const numberAt = (line: number) => {
    if (line >= endLine || state.sCount[line] < state.blkIndent || state.sCount[line] - state.blkIndent >= 4) return 0;
    const found = NUMBERED_LINE.exec(state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]));
    return found ? Number(found[1]) : 0;
  };
  const first = numberAt(startLine);
  if (!first) return false;
  // The first item may run on: a blank line, or lines indented under it, before the next number.
  let next = startLine + 1;
  while (next < endLine && (state.isEmpty(next) || state.sCount[next] - state.blkIndent >= 2)) next++;
  return numberAt(next) > first;
}, { alt: ["paragraph"] });

// Maths, for a page that asks for it (ChatDGC's replies; main DGC's chat doesn't): the rules are markdownMath.ts's,
// kept as TeX in a placeholder the page renders with KaTeX.
let mathEnabled = false;
export function setMath(on: boolean): void { mathEnabled = !!on; }
addMath(parser, () => mathEnabled);
// Until KaTeX draws it (or if it can't), the placeholder shows the TeX as written; data-tex is what it draws.
parser.renderer.rules.math_inline = (tokens, index) => {
  const t = tokens[index];
  return `<span class="md-math${t.meta?.display ? " md-math-display" : ""}" data-tex="${escape(t.content)}">${escape(t.markup + t.content + t.info)}</span>`;
};
parser.renderer.rules.math_block = (tokens, index) => {
  const t = tokens[index];
  return `<div class="md-math md-math-display" data-tex="${escape(t.content)}">${escape(t.markup + t.content + t.info)}</div>\n`;
};

/** Markdown as inert HTML. ``cards``: draw ```dgc-ui fences as interactive cards, for DGC's own reply in a chat
 *  only; everywhere else they stay code. */
export function render(source: string, options: { cards?: boolean } = {}): string {
  // JSON can carry lone UTF-16 surrogates; URI encoding in copy controls must not crash a turn.
  const cleaned = String(source).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  // The env carries the source so a block rule can quote it back exactly (see quoteSource).
  return parser.render(cleaned, { src: cleaned, cards: options?.cards === true });
}
