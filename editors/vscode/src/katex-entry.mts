// The ChatDGC page loads this file on demand, the first time a reply has maths in it. It exists only to put KaTeX on
// the window for media/chatdgc.js; see renderMath there. Its stylesheet and fonts are dist/katex/.
import katex from "katex";

(globalThis as any).katex = katex;
