# Changelog

## 0.5.0 — 2026-08-18

- **New logo mark.** The three-stripe DGC mark now sits before the `DGC` wordmark in the panel header — inline SVG, single purple, sized to the header.
- **Animated thinking indicator.** While the agent is working, the `working…` indicator shows the mark with its three stripes lighting up one-by-one, holding all three, then repeating (~1.2s loop, CSS-driven), replacing the braille spinner. Reduced-motion renders all three stripes lit and static.

## 0.4.0 — 2026-08-18

- **New look — mono + one purple accent.** The whole panel now matches the CLI and vibedgc.com: near-black canvas, neutral greys, a single purple (`#7C5CFF`) accent with a lavender glint, and **no** other colours. Diffs render **mono + purple** (added lines purple-tinted, removed lines faint) instead of green/red. A slim `DGC` header shows the current model; the composer has a purple `❯` prompt.
- **Per-tool glyphs.** Tool cards lead with the CLI's glyph set — `→` read · `✎` write/edit · `$` shell · `✱` search · `▸` other — and show the raw tool name.
- **Editor-context injection.** Every prompt now carries a compact `<editor-context>` block — the focused file (path + language), your open tabs, and the current selection (truncated to ~2KB) — so the agent grounds on what you're looking at. `/command` prompts are left untouched. No change to the DGC CLI is required.
- **One status-bar item** — `model · mode`, click to change model.
- Pasted / attached images are now forwarded to vision models.

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
