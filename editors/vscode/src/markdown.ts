import MarkdownIt from "markdown-it";
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

export type LinkTarget = { kind: "external" | "file"; target: string; line?: number };

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
  if (/[\u0000-\u001f\u007f]/.test(path) || /^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\)/i.test(path)
      && !/^[A-Za-z]:[\\/]/.test(path)) return;
  if (!path || path.startsWith("#") || path.includes("?")) return;
  const location = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)$/.exec(path);
  const line = location ? Number(location[1] || location[2]) : undefined;
  if (location) path = path.slice(0, location.index);
  return path ? { kind: "file", target: path,
    ...(line && Number.isSafeInteger(line) ? { line } : {}) } : undefined;
}

// Which source a link points at, for the mark shown beside it. Bundled icons only: fetching a
// favicon would mean a network request per link, which the panel's CSP forbids and which would
// leak every URL a model mentions to whoever hosts it.
const LINK_SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)github\.com$/i, "github"],
  [/(^|\.)gitlab\.com$/i, "gitlab"],
  [/(^|\.)vibedgc\.com$/i, "dgc"],
  [/(^|\.)marketplace\.visualstudio\.com$/i, "marketplace"],
  [/(^|\.)open-vsx\.org$/i, "openvsx"],
  [/(^|\.)npmjs\.com$/i, "npm"],
  [/(^|\.)stackoverflow\.com$/i, "stackoverflow"],
];

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
  const location = target.line ? ` data-line="${target.line}"` : "";
  const source = target.kind === "external"
    ? ` data-link-source="${linkSource(target.target)}"` : "";
  return `<button type="button" class="md-link" data-link-kind="${target.kind}" data-target="${escape(target.target)}"${location}${source} title="${escape(target.target)}">`;
};
parser.renderer.rules.link_close = () => "</button>";
parser.renderer.rules.image = (tokens, index) => {
  // Model-provided image URLs must never trigger an invisible network request. A labelled link
  // lets the user decide whether to view it in the browser or open a local artifact.
  const token = tokens[index], target = linkTarget(String(token.attrGet("src") || ""));
  const label = escape(token.content || "Image");
  return target ? `<button type="button" class="md-link" data-link-kind="${target.kind}" data-target="${escape(target.target)}" title="${escape(target.target)}">${label}</button>` : label;
};
parser.renderer.rules.fence = (tokens, index) => codeBlock(tokens[index].content, tokens[index].info);
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
  return `<pre class="code" data-language="${escape(language)}"><span class="code-language">${escape(language)}</span><button type="button" class="copy" data-c="${escape(encodeURIComponent(content))}" aria-label="Copy code">Copy</button><code>${highlighted}</code></pre>`;
}

// A table is the one block a reader reliably wants out of the panel and into a document, and it
// was the only block with no copy path. The source is stashed the same way a code fence stashes
// its own, so the copy is the model's markdown rather than the rendered DOM.
parser.renderer.rules.table_open = (tokens, index) => {
  const source = tableSource(tokens, index);
  const copy = source
    ? `<button type="button" class="copy" data-c="${escape(encodeURIComponent(source))}" aria-label="Copy table">Copy</button>`
    : "";
  return `<div class="md-table-wrap">${copy}<table class="md-table">`;
};
parser.renderer.rules.table_close = () => "</table></div>";

function tableSource(tokens: any[], index: number): string {
  // markdown-it does not keep the raw table text, so rebuild it from the inline tokens. Good
  // enough to paste into another markdown document, which is the whole point of the button.
  const rows: string[][] = [];
  let row: string[] = [];
  let headerRows = 0;
  for (let i = index; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "table_close") break;
    if (token.type === "tr_open") row = [];
    else if (token.type === "tr_close") { rows.push(row); if (token.level === 2) headerRows = rows.length; }
    else if (token.type === "inline") row.push(String(token.content || "").replace(/\|/g, "\\|"));
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map(r => r.length));
  const line = (cells: string[]) =>
    "| " + Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ") + " |";
  const out = [line(rows[0]), "| " + Array.from({ length: width }, () => "---").join(" | ") + " |"];
  for (const rest of rows.slice(Math.max(1, headerRows || 1))) out.push(line(rest));
  return out.join("\n");
}

// GitHub-style task lists. "- [ ] step" rendered as the literal characters, which made every
// checklist answer look broken.
parser.renderer.rules.list_item_open = (tokens, index, options, _env, self) => {
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

export function render(source: string): string {
  // JSON can carry lone UTF-16 surrogates; URI encoding in copy controls must not crash a turn.
  return parser.render(String(source).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"));
}
