# Changelog

## 0.3.0 — 2026-08-17

- **Claude-Code-style composer** — model, permission mode and thinking level now live in the prompt box: inline model menu, mode/thinking picker, native VS Code (codicon) icons, and a context-usage pill that compacts on click. **Shift+Tab** cycles permission modes.
- **In-panel Settings page** (gear icon) — edit provider / host / API key / model, sub-agent model + host, fallback model + host, permission mode, thinking level and context size, all live. The same settings are also exposed as native VS Code settings (Settings UI → DGC), which override the CLI config when set.
- **Sub-agent model/host selection** — point the `task` tool's sub-agents at a different model or host from the settings.
- **Session resume** now renders the full transcript.

## 0.2.0

- **Markdown** rendering in responses (headings, bold, lists, code blocks with copy).
- **`@file` mentions** — type `@` in the composer to attach workspace files.
- **`/` slash-commands** — type `/` for model, connect, mode, thinking, resume, new, compact, clear.
- **Open file** from tool and diff cards.
- **Session resume** — `DGC: Resume Session` (and the panel toolbar).
- **Status bar** — model + permission mode, click to change.
- Fixed the self-hosted update-check (Cloudflare requires a User-Agent).

## 0.1.0

- First release. Chat panel (Webview) that drives the DGC CLI's `dgc serve` headless backend.
- Streaming text + thinking indicator, tool cards, inline diffs.
- Native QuickPicks for model, provider, permission mode, and thinking level.
- Inline permission prompts, plan-mode approval, options prompts.
- Works in both VS Code and Cursor.
