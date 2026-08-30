# DGC for VS Code & Cursor

Run the **DGC** coding agent inside your editor — a docked chat panel, native menus, streaming tool calls and diffs — driven by **your own model**: Ollama, llama.cpp, LM Studio, vLLM, Anthropic, OpenAI, or another compatible endpoint. Your code stays on your machine unless you choose a cloud provider.

> Requires the matching DGC CLI build (editor protocol v4) on your PATH. Run `dgc setup`, then use
> **DGC: Restart Backend** after changing the executable or its configuration.

## What it does

- **Chat panel** in the activity bar — streaming responses, aligned Markdown tables, streaming-safe fenced code with exact-source copy, a live *thinking* indicator, collapsible tool cards, and inline diffs. The panel matches the DGC CLI's look: a mono, near-black surface with a single purple accent — tool cards lead with the CLI's glyphs (`→` read · `✎` edit · `$` shell · `✱` search · `▸` other), and diffs render **mono + purple**, not green/red.
- **Editor-aware** — each prompt carries bounded typed resources for the focused file, open tabs, diagnostics, explicit mentions, and the current selection. Editor content stays in an untrusted data channel instead of being concatenated into the user's instructions.
- **In-composer controls** — model, permission mode and thinking level live *in* the prompt box: an inline model picker, a mode/thinking picker, native VS Code (codicon) icons, and a context-usage pill that compacts on click. **Shift+Tab** cycles permission modes (`default` / `acceptEdits` / `plan` / `auto`).
- **Feature browsers instead of transcript dumps** — `/skills`, `/docs`, `/mcp`, `/permissions`, `/memory`, and `/hooks` open searchable, keyboard-accessible surfaces. Skills show their winning project/user/bundled source and instructions; documentation renders in place; none of these catalogs pollutes chat history.
- **MCP manager** — add, edit, remove, inspect, and reload local STDIO or remote servers from the panel. Safe server metadata is persisted in DGC configuration while environment values and remote bearer tokens stay in VS Code SecretStorage and never enter the webview again.
- **Categorized Settings page** (gear icon) — General, Models, Agents, Security, and Extensions cover provider routes, reasoning display, suggestions, permission/sandbox/network scope, plan/artifact behavior, tool profile, parallelism, and feature-manager shortcuts. Model credentials stay in endpoint-scoped VS Code SecretStorage; non-secret provider defaults can also be set in Settings UI → **DGC**.
- **Keyboard and assistive access** — semantic buttons, menus, live status, non-color tool outcomes, dialog focus trapping, reduced-motion and forced-colors behavior, WCAG text-palette checks, and keyboard navigation cover the composer, tool/reasoning disclosures, approvals, attachments, and settings.
- **Permission prompts** inline — allow once / always-allow (saves a rule) / deny. Permission, plan, option, and MCP cards are request-correlated and single-use; Stop/expiry/backend exit disables them immediately, and decision traffic stays ahead of queued prompts under transport pressure.
- **Session resume & rewind** — resuming renders the full transcript; rewind restores both your code and the conversation to an earlier turn.
- **Your model, your machine** — the extension drives the local `dgc` CLI via `dgc serve` over stdio: same models, same config (`~/.dgc/config.json`), local-first. Nothing leaves your machine unless you point DGC at a cloud model.

## Commands

- **Chat:** Focus Chat (`Ctrl/Cmd+Escape`), Open Command Menu, Add Selection (`Ctrl/Cmd+I`).
- **Runtime:** Select Model, Connect Provider, Set/Cycle Permission Mode, Set Thinking, Restart Backend.
- **Sessions:** New, Resume, Rewind, Name, Compact, Generate Handoff.
- **Work:** View Saved Plan, Artifact Previews, Show Goal, Retained Sub-agent Tasks.
- **Extensibility:** Skills, MCP Servers, Documentation, Permission Rules, Memory, Lifecycle Hooks.
- **Maintenance:** Settings, Update CLI to Latest.

The in-composer `/` menu is generated from the CLI's canonical editor command registry. Commands
that need structured editor state are routed through protocol frames rather than sent to the model.

## MCP setup

Open **DGC: MCP Servers** or run `/mcp`:

- Local STDIO: executable, one argument per line, optional environment variable names and secret
  values. Existing ambient variables may be referenced by name without copying their values.
- Remote: HTTPS URL (or loopback HTTP for local development) and an optional bearer token. The
  current bridge uses `npx -y mcp-remote`; Node/npm must therefore be available for remote entries.
  The token is expanded from a process-local environment variable rather than placed in argv.

Removing a server removes its extension-managed secrets. Reload reconnects every configured server
and refreshes the tool catalog. A server with SecretStorage-only credentials waits for editor setup
instead of starting once without its secrets; use a `KEY` ambient reference when the same server
must also start in the standalone CLI. Tool execution still passes through DGC's permission boundary.

## Settings

- `dgc.command` — path to the `dgc` executable (default `dgc`).
- Native DGC settings provide provider-route defaults. The in-panel page owns live agent behavior,
  sandbox, artifact, and extension-manager settings exposed by protocol v4.

## Local verification

```bash
npm test                 # transport + webview interaction/accessibility checks
npm run check-types      # TypeScript contract check without writing output
npm run compile          # TypeScript + development bundle
npm run test:host        # installed VS Code: activation, commands, handshake, roots/secrets, decisions
```

`test:host` never downloads or installs VS Code and opens only disposable test workspaces. Set
`DGC_VSCODE_EXECUTABLE` to the editor's real Electron executable when it is not available at
`/usr/share/code/code`.

Built by Mohit Kalra · [vibedgc.com](https://vibedgc.com) · PolyForm Noncommercial.
