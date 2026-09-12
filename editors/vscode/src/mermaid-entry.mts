// The webview loads this file on demand, the first time a ```mermaid fence is rendered.
// It exists only to put mermaid on the window for media/main.js; see renderMermaid there.
import mermaid from "mermaid";

(globalThis as any).mermaid = mermaid;
