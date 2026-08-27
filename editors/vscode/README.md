# DGC for VS Code & Cursor

Run the **DGC** coding agent inside your editor — a docked chat panel, native menus, streaming tool calls and diffs — driven by **your own model**: Ollama, llama.cpp, LM Studio, vLLM, Anthropic, OpenAI, or another compatible endpoint. Your code stays on your machine unless you choose a cloud provider.

> Requires the DGC CLI **v0.4.0+** on your PATH. Install it with
> `curl -fsSL https://vibedgc.com/install.sh | bash`, then `dgc setup`.

## What it does

- **Chat panel** in the activity bar — streaming responses, aligned Markdown tables, streaming-safe fenced code with exact-source copy, a live *thinking* indicator, collapsible tool cards, and inline diffs. The panel matches the DGC CLI's look: a mono, near-black surface with a single purple accent — tool cards lead with the CLI's glyphs (`→` read · `✎` edit · `$` shell · `✱` search · `▸` other), and diffs render **mono + purple**, not green/red.
- **Editor-aware** — each prompt carries bounded typed resources for the focused file, open tabs, diagnostics, explicit mentions, and the current selection. Editor content stays in an untrusted data channel instead of being concatenated into the user's instructions.
- **In-composer controls** — model, permission mode and thinking level live *in* the prompt box: an inline model picker, a mode/thinking picker, native VS Code (codicon) icons, and a context-usage pill that compacts on click. **Shift+Tab** cycles permission modes (`default` / `acceptEdits` / `plan` / `auto`).
- **In-panel Settings page** (gear icon) — edit provider / host / API key / model, sub-agent and fallback routes, permission mode, thinking level and context size, all live. Credentials stay in endpoint-scoped VS Code SecretStorage; non-secret route settings can also be set in Settings UI → **DGC**.
- **Keyboard and assistive access** — semantic buttons, menus, live status, non-color tool outcomes, dialog focus trapping, reduced-motion and forced-colors behavior, WCAG text-palette checks, and keyboard navigation cover the composer, tool/reasoning disclosures, approvals, attachments, and settings.
- **Permission prompts** inline — allow once / always-allow (saves a rule) / deny. Permission, plan, option, and MCP cards are request-correlated and single-use; Stop/expiry/backend exit disables them immediately, and decision traffic stays ahead of queued prompts under transport pressure.
- **Session resume & rewind** — resuming renders the full transcript; rewind restores both your code and the conversation to an earlier turn.
- **Your model, your machine** — the extension drives the local `dgc` CLI via `dgc serve` over stdio: same models, same config (`~/.dgc/config.json`), local-first. Nothing leaves your machine unless you point DGC at a cloud model.

## Commands

- **DGC: Focus Chat** — `Ctrl/Cmd+Escape`
- **DGC: Add Selection to DGC** — `Ctrl/Cmd+I`
- **DGC: Cycle Permission Mode** — `Ctrl/Cmd+Shift+M`
- **DGC: Select Model · Connect Provider · Set Mode · Set Thinking · New Session**

## Settings

- `dgc.command` — path to the `dgc` executable (default `dgc`).

## Local verification

```bash
npm test                 # transport + webview interaction/accessibility checks
npm run compile          # TypeScript + development bundle
npm run test:host        # installed VS Code: activate, handshake, roots/secrets, permission + plan
```

`test:host` never downloads or installs VS Code and opens only disposable test workspaces. Set
`DGC_VSCODE_EXECUTABLE` to the editor's real Electron executable when it is not available at
`/usr/share/code/code`.

Built by Mohit Kalra · [vibedgc.com](https://vibedgc.com) · PolyForm Noncommercial.
