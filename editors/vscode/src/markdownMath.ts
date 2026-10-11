// Maths in Markdown, for a page that asks for it: $…$ and \(…\) in a line, $$…$$ and \[…\] as a block (or $$…$$
// inside a line), kept as TeX. Never inside code, never across an escaped \$, and a dollar amount is text: as pandoc
// reads it, an opening $ is followed by a non-space and a closing one follows a non-space and isn't followed by a digit
// ("$5 and $10" is money). ChatDGC's replies (markdown.ts) and its formatted canvas (canvasMarkdown.ts) read it alike.
const MAX_MATH = 4000;

/** The maths rules on any markdown-it (ChatDGC's canvas reads its Markdown with them too): `on` says whether they
 *  apply now. Tokens: math_inline (meta.display for $$…$$ or \[…\] inside a line) and math_block. */
export function addMath(md: any, on: () => boolean = () => true): void {
  md.inline.ruler.before("escape", "math_inline", (state: any, silent: boolean) => on() && mathInline(state, silent));
  md.block.ruler.before("fence", "math_block", (state: any, startLine: number, endLine: number, silent: boolean) =>
    on() && mathBlock(state, startLine, endLine, silent), { alt: ["paragraph", "reference", "blockquote", "list"] });
}

function mathInline(state: any, silent: boolean): boolean {
  const src: string = state.src, start: number = state.pos, max: number = state.posMax;
  let open: string, close: string, from: number, end: number, display = false;
  if (src.startsWith("\\(", start)) {
    open = "\\("; close = "\\)"; from = start + 2;
    end = src.indexOf(close, from);
  } else if (src.startsWith("$$", start) || src.startsWith("\\[", start)) {
    open = src[start] === "$" ? "$$" : "\\["; close = open === "$$" ? "$$" : "\\]"; from = start + 2; display = true;
    end = src.indexOf(close, from);
  } else if (src[start] === "$") {
    open = close = "$"; from = start + 1;
    if (from >= max || /\s/.test(src[from])) return false;
    end = from;
    for (;;) {
      end = src.indexOf("$", end);
      if (end < 0 || end >= max) return false;
      if (src[end - 1] === "\\" || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || "")) { end += 1; continue; }
      break;
    }
  } else return false;
  if (end < 0 || end + close.length > max) return false;
  const content = src.slice(from, end);
  if (!content.trim() || content.length > MAX_MATH) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = content; token.markup = open; token.info = close; token.meta = { display };
  }
  state.pos = end + close.length;
  return true;
}

function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const lineText = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const first: string = lineText(startLine);
  const open = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\[" : "";
  if (!open) return false;
  const close = open === "$$" ? "$$" : "\\]";
  const lines: string[] = [];
  let line = startLine, rest = first.slice(open.length), found = false;
  for (;;) {
    const at = rest.indexOf(close);
    if (at >= 0) {
      if (rest.slice(at + close.length).trim()) return false;      // words after it: maths inside a paragraph
      lines.push(rest.slice(0, at)); found = true; break;
    }
    lines.push(rest);
    line += 1;
    if (line >= endLine || (state.sCount[line] < state.blkIndent && state.bMarks[line] + state.tShift[line] < state.eMarks[line])) break;
    rest = lineText(line);
  }
  const content = lines.join("\n");
  if (!found || !content.trim() || content.length > MAX_MATH) return false;
  if (silent) return true;
  state.line = line + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true; token.content = content; token.markup = open; token.info = close; token.map = [startLine, state.line];
  return true;
}

