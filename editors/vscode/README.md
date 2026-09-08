# DGC for VS Code & Cursor

Run the **DGC** coding agent inside your editor — a docked chat panel, native menus, streaming tool calls and diffs — driven by **your own model**: Ollama, llama.cpp, LM Studio, vLLM, Anthropic, OpenAI, or another compatible endpoint. Your code stays on your machine unless you choose a cloud provider.

> Use DGC CLI 0.29.2 or newer for all features; the connection requires editor protocol v6. Run `dgc setup`, then use
> **DGC: Restart Backend** after changing the executable or its configuration.

## What it does

- **Chat panel** — CommonMark responses with headings, lists, quotes, tables, safe file/source links, syntax-highlighted code and exact-source copy. Reasoning and tool batches collapse into compact rows, with visible failures and a separate final response. Surfaces follow your Cursor/VS Code theme with DGC purple accents.
- **Live controls** — browse skills and change permission mode during a turn. Enter steers native-model work at the next boundary; Alt+Enter or Queue submits a later turn. A separate Stop button remains available while drafting. Subscription CLI follow-ups queue, and their mode changes apply on the next turn. Unapplied steering can be restored after interruption.
- **Goals** — start an objective with `/goal <objective>` or `<objective> /goal`. The card supports pause, resume, edit, delete and review of evidence, work time, cycles and reported tokens. Native and subscription routes continue until completion, pause or a blocker. Optional token budgets are checked between requests or vendor turns.
- **Changed files** — the composer card shows changes recorded during the current chat, using actual pre-run file contents. **Workspace changes** opens the separate Git review. Saved chat previews exclude pre-existing edits and later manual changes; native diffs run through bounded inspection workers without executing repository filters.
- **Editor-aware** — each prompt carries bounded typed resources for the focused file, open tabs, diagnostics, explicit mentions, and the current selection. Editor content stays in an untrusted data channel instead of being concatenated into the user's instructions.
- **In-composer controls** — model, permission mode and thinking level live *in* the prompt box: a compact model picker with a reasoning slider, a permission-mode picker, native VS Code (codicon) icons, and a context-usage pill that compacts on click. Model/thinking controls follow the active native or subscription route; subscription pickers use vendor hints or a free-form vendor model id without querying the native endpoint. **Shift+Tab** cycles permission modes (`default` / `acceptEdits` / `plan` / `auto`).
- **Composer commands and skills** — type `/` or `$` after a word boundary anywhere in the draft. Pick commands, skills and templates without losing surrounding text. `/plan`, `/review` and `/init` prepare shared CLI/editor workflows. Select up to eight skills/templates, including 22 bundled skills, and attach the same inputs to a goal.
- **Draft recovery** — per-chat drafts and attachments survive panel reloads and backend restarts. Rejected or uncertain deliveries stay available for review; recovered prompts are never sent automatically.
- **Feature browsers instead of transcript dumps** — `/skills`, `/docs`, `/mcp`, `/permissions`, `/memory`, and `/hooks` open searchable, keyboard-accessible surfaces. Skills show their winning project/user/bundled source and instructions; documentation renders in place; none of these catalogs pollutes chat history.
- **MCP manager** — add, edit, remove, enable, disable and reconnect local STDIO or remote servers. Browse resources, templates and prompts, preview text, and attach bounded snapshots to a draft or goal. Safe server metadata is persisted in DGC configuration while environment values and remote bearer tokens stay in VS Code SecretStorage and never enter the webview again.
- **Categorized Settings page** (gear icon) — General, Models, Agents, Security, and Extensions cover provider routes, reasoning display, suggestions, permission/sandbox/network scope, plan/artifact behavior, tool profile, parallelism, and feature-manager shortcuts. Model credentials stay in endpoint-scoped VS Code SecretStorage; non-secret provider defaults can also be set in Settings UI → **DGC**.
- **Keyboard and assistive access** — semantic buttons, menus, live status, non-color tool outcomes, dialog focus trapping, reduced-motion and forced-colors behavior, WCAG text-palette checks, and keyboard navigation cover the composer, tool/reasoning disclosures, approvals, attachments, and settings.
- **Permission prompts** inline — allow once / always-allow (saves a rule) / deny. Permission, plan, option, and MCP cards are request-correlated and single-use; Stop/expiry/backend exit disables them immediately, and decision traffic stays ahead of queued prompts under transport pressure.
- **Session resume & rewind** — resuming pages through saved context with expandable tool arguments/results; long messages and very large histories have explicit display limits. Rewind restores your code and conversation to an earlier checkpoint.
- **Your model, your machine** — the extension drives the local `dgc` CLI via `dgc serve` over stdio: same models, same config (`~/.dgc/config.json`), local-first. Model requests follow your selected local, cloud or subscription route. Enabled web tools and MCP servers can also contact their configured services.

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
  current bridge uses `npx -y mcp-remote@0.8.3`; Node/npm must therefore be available for remote entries.
  The token is expanded from a process-local environment variable rather than placed in argv.

Removing a server removes its extension-managed secrets. Disable preserves its definition;
Reconnect refreshes one server or all enabled servers. A server with SecretStorage-only credentials waits for editor setup
instead of starting once without its secrets; use a `KEY` ambient reference when the same server
must also start in the standalone CLI. Tool execution still passes through DGC's permission boundary.

Use **Resources**, **Resource templates**, or **Prompts** to preview and attach server text. Browser
sign-in is cancellable. Remote desktop editors request callback forwarding before opening the browser;
if the mapping changes its port or origin, DGC explains same-port forwarding and reconnect. See the
[MCP guide](https://github.com/OpenPeach-ai/dgc/blob/main/docs/MCP_CONTEXT.md) for provider and remote-editor limits.

## Updating

Keep the CLI and extension current. `dgc update` updates the CLI; the editor gallery updates the
extension. Check DGC's own **Auto Update** setting in its extension menu, especially after installing
a VSIX manually. Cursor's catalog can lag a public registry. After an update, reload the editor if
it still runs the old extension, and use **DGC: Restart Backend** after updating the CLI. See the
[upgrade guide](https://github.com/OpenPeach-ai/dgc/blob/main/docs/UPGRADING.md) for protocol mismatches.

## Settings

- `dgc.command` — path to the `dgc` executable (default `dgc`).
- Native DGC settings provide provider-route defaults. The in-panel page owns live agent behavior,
  sandbox, artifact, and extension-manager settings exposed by protocol v6.

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

### File changes in a chat

A fresh chat starts without a changed-file card. **Changes in this chat** records the deltas observed
while that chat runs, using actual pre-run contents even when files were already modified. Saved
reviews survive reloads; later manual edits do not change the saved preview. **Workspace changes**
opens the separate Git review, including work that predates the chat. Tracking covers the primary
project folder; concurrent external edits during a run may be included. Older chats have no
retroactive baseline.
