# DGC for VS Code & Cursor

Run the **DGC** coding agent inside your editor — a docked chat panel, native menus, streaming tool calls and diffs — driven by **your own model**: Ollama, llama.cpp, LM Studio, vLLM, or any OpenAI-compatible endpoint. Your code stays on your machine.

> Requires the DGC CLI **v0.4.0+** on your PATH. Install it with
> `curl -fsSL https://vibedgc.com/install.sh | bash`, then `dgc setup`.

## What it does

- **Chat panel** in the activity bar — streaming responses, a live *thinking* indicator, collapsible tool cards, and inline diffs. The panel matches the DGC CLI's look: a mono, near-black surface with a single purple accent — tool cards lead with the CLI's glyphs (`→` read · `✎` edit · `$` shell · `✱` search · `▸` other), and diffs render **mono + purple**, not green/red.
- **Editor-aware** — each prompt carries a compact `<editor-context>` block (the focused file + language, your open tabs, and the current selection, truncated) so the agent grounds on what you're looking at.
- **In-composer controls** — model, permission mode and thinking level live *in* the prompt box: an inline model picker, a mode/thinking picker, native VS Code (codicon) icons, and a context-usage pill that compacts on click. **Shift+Tab** cycles permission modes (`default` / `acceptEdits` / `plan` / `auto`).
- **In-panel Settings page** (gear icon) — edit provider / host / API key / model, sub-agent model + host + key, fallback model + host, permission mode, thinking level and context size, all live. The provider/host/key/model, sub-agent, fallback and context settings are also exposed as native VS Code settings (Settings UI → **DGC**), which override the CLI config when set.
- **Permission prompts** inline — allow once / always-allow (saves a rule) / deny.
- **Session resume & rewind** — resuming renders the full transcript; rewind restores both your code and the conversation to an earlier turn.
- **Your model, your machine** — the extension drives the local `dgc` CLI via `dgc serve` over stdio: same models, same config (`~/.dgc/config.json`), local-first. Nothing leaves your machine unless you point DGC at a cloud model.

## Commands

- **DGC: Focus Chat** — `Ctrl/Cmd+Escape`
- **DGC: Add Selection to DGC** — `Ctrl/Cmd+I`
- **DGC: Cycle Permission Mode** — `Ctrl/Cmd+Shift+M`
- **DGC: Select Model · Connect Provider · Set Mode · Set Thinking · New Session**

## Settings

- `dgc.command` — path to the `dgc` executable (default `dgc`).

Built by Mohit Kalra · [vibedgc.com](https://vibedgc.com) · PolyForm Noncommercial.
