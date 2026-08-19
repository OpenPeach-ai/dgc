# Changelog

## 0.8.0 — 2026-08-19

- **Artifacts in the panel.** When the agent serves a localhost preview with the new `artifact` tool, DGC now shows an **"Artifact ready"** card with the URL and an **Open in browser** button (plus **Stop** to shut the preview down and free its port). Powered by the CLI's `artifact` tool + `dgc-design` skill, so previews look intentional by default.

## 0.7.3 — 2026-08-19

- **Readable, wrapping option prompts.** When the agent asks you to choose, options now render as a stacked list of full-width rows that **wrap** (long options no longer overflow the card), each numbered, with the recommended one marked by an accent bar instead of an unreadable solid-purple fill.
- **Grok-style task list.** Todos now use `□` pending · `▶` in-progress (gold, bold) · `✓` done (green, struck through) · `✗` cancelled (red), under a `Tasks n/N` header.

## 0.7.2 — 2026-08-19

- **Fixed: your prompt vanishing after resuming a session.** A resumed session's history could arrive *after* you'd already sent a prompt (slow session load), and rendering it wiped the whole log — including your just-sent message — while the turn kept streaming. History now renders non-destructively, above any live prompt/turn.

## 0.7.1 — 2026-08-19

- **New Marketplace icon** — the current `///` + `DGC` brand mark (on black), replacing the old pixel-block logo. Matches vibedgc.com and the CLI.

## 0.7.0 — 2026-08-19

- **Publisher renamed to `vibedgc`** (matching vibedgc.com). The extension id is now **`vibedgc.dgc`**. The old `daguccicode.dgc` is deprecated — reinstall from Open VSX / the Marketplace / vibedgc.com.

## 0.6.5 — 2026-08-19

- **Update the CLI from the editor.** New command **DGC: Update CLI to Latest** runs the installer in a terminal (parity with the CLI's `/update`), then prompts you to restart the backend.
- Tracks CLI **v0.17.5**: the new dotted `///` welcome mark and the built-in update nudge.

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
