# Changelog

## 0.22.1 — 2026-09-12

- **Saving a setting mid-run no longer fails on one you did not touch.** The settings form posts every field, so `base_url`, `api_key` and `model` arrived on every Save whether or not you changed them — and DGC asked to move the model route each time, which the CLI rightly refuses while a turn is running. Raising the context window during a run reported a model error and looked like it had not applied. The route is now only re-sent when it actually differs.
- **A selected control is a filled pill, with nothing under it.** The active settings tab and the Ultra model control each drew an accent line beneath an already-tinted background, which reads as a second, heavier element rather than as emphasis.
- **Coming back to the other copy of the chat works.** Opening DGC in the secondary side bar left the activity-bar copy showing "DGC is open in the secondary side bar" permanently — VS Code keeps both alive and resolves a view only once, so that notice never cleared, even when it was the only chat on screen. Whichever copy you look at now becomes the live chat.
- Pairs with DGC CLI 0.37.0; editor protocol v11 is unchanged, so this is not a lockstep upgrade.

## 0.22.0 — 2026-09-12

- **Diagrams render.** A ```mermaid fence in an answer becomes the diagram it describes, drawn in the panel's own colours and type, with the source kept underneath behind **Show source** so Copy still gives you the markup. A diagram the parser rejects keeps its code block instead of being replaced by an error graphic — a diagram that will not draw must not delete the text the model wrote. The renderer is fetched the first time a diagram appears, so a panel that never shows one never loads it.
- **The mode menu is no longer cut off.** Every picker menu was anchored to the button that opened it, and the mode and context triggers sit about 100px from the left edge — so their 310px cards grew straight off the side of the panel. At a 460px sidebar the permission menu started 44px past the left edge. Menus now anchor to the composer, so the panel's own gutters bound them at every width.
- **Removed lines are red again.** Auto mode's colour moved to olive and diff polarity was riding on the same token, so every deletion count — the `−12` on a changed file, the `-` gutter in a diff — turned green, the one colour that means the opposite of what it is saying. Deletions now have their own colour, independent of what error and auto mode look like.
- Long code fences fold past 24 lines, headings follow a real type scale rather than three sizes of bold, and rating an answer now tells a screen reader whether the rating is applied and that pressing again removes it.
- Editor protocol v11 — requires DGC CLI 0.37.0. An older CLI is refused at connect with the version to update to.

## 0.19.0 — 2026-09-11

- **A finished answer now ends with what it changed.** The files this turn touched, each with its additions and deletions and its own diff, and two actions: **Review** opens every change this chat has made, and **Undo** puts those files back as they were before the turn and rewinds the conversation with them. Undo identifies the turn by the prompt that opened its recovery point and refuses rather than guessing, because an undo that guesses loses work you did not ask it to.
- Under it: **copy** the answer as Markdown, **rate** it (kept in this workspace and sent nowhere), **branch into a new chat** from that point, **run the prompt again**, or **edit and resend** it. Branching is a real branch — the conversation comes with you and the chat you came from keeps everything it had. Requires CLI 0.34.0; editor protocol v8.
- **Reading back through a run no longer strands you.** Scrolling up mid-turn used to throw the view to the top: the transcript is a column flex layout, so a block whose rendering the browser skipped collapsed to nothing and the page got shorter under the scrollbar. An eight-turn chat reported 2,140px of scroll height for 5,169px of content. Blocks now hold their measured height, and a **Latest** pill floats over the end of the transcript while you are away from it, turning purple and reading **New** once something has arrived that you have not seen.
- **Every control says what it is.** One hover label in the panel's own type and surfaces, up in about a third of a second and shown on keyboard focus too, replacing the operating system's tooltip — which was slow, unstyled, and missing entirely on twenty buttons including all five settings tabs.
- **One design language.** The panel had grown 13 font sizes with half-pixels, seven weights, 17 corner radii, and monospace used as decoration in chrome that is not code. It is now five sizes, four weights, one 4px spacing unit and one 28px control height, with monospace kept for code, diffs, paths and numerals. Settings are rows — what it is on the left, the control on the right, the explanation beneath — instead of a column of full-width dropdowns.
- Fixed: the composer carried a permanently visible **Queue** and **Stop** button, because `hidden` does nothing on an element whose own rule sets `display`. The approval card printed the command twice and its optional denial note took four lines before you had written in it. A turn started anywhere but the composer — a slash command, an editor action, a queued follow-up — showed no prompt at all, so the chat read as answers to questions nobody asked. An edit printed its diff twice, once unreadably. A step that took no measurable time reported "0.0s".

## 0.18.1 — 2026-09-10

- **DGC: Show Context Notes** — what this project has already learned, across sessions: the failures, edits and passing tests DGC recorded as the work happened. The agent searches the same trace itself, so after a compaction it can see which fixes already failed instead of trying them again. Needs CLI 0.33.0; editor protocol v7 is unchanged, so this is not a lockstep upgrade.
- The chat is offered in the secondary side bar as well as the activity bar — open it in either and the same conversation follows.
- An older CLI now offers the fix instead of only naming it: **Update DGC CLI**, then **Restart Backend**.

## 0.18.0 — 2026-09-10

- Approve against the change: the permission card shows the step's summary and, for an edit, the diff it would apply, instead of raw JSON; **Deny** can carry a note the model reads as the reason. Editor protocol v7 — requires DGC CLI 0.32.0 (an older CLI is refused at connect with the version to update to).
- The agent sees the errors it made: each prompt carries diagnostics for every file this chat touched, not just the focused one. **DGC: Add File to Chat** from the explorer and tab context menus, or drag a file into the chat; palette entries that need a running backend appear once it is connected.
- No more first-run dead ends: Add Selection waits for the panel instead of dropping the selection when the view was never opened (and says so when nothing is selected); changing `dgc.command` restarts the backend; the install prompt offers Retry and a restart earns a fresh prompt instead of latching every command to a no-op after one dismissal.

## 0.17.2 — 2026-09-10

- Keep the autonomous gate and every model route under the user's control: **DGC: Autonomous Gate**, **DGC: Base Url**, **DGC: Subagent Base Url** and **DGC: Fallback Base Url** are now machine-scoped settings, so a cloned repository's `.vscode/settings.json` can no longer point the panel's model traffic at its own server or disable the gate. A workspace value for any of them is ignored and the user setting (or the default) is used.
- Stop fighting VS Code's own keys: focus the panel with Ctrl/Cmd+Alt+D (was Ctrl+Escape, the terminal toggle), add the selection with Ctrl/Cmd+Alt+I (was Ctrl+I, inline chat) and cycle the mode with Ctrl/Cmd+Alt+M (was Ctrl+Shift+M, the Problems panel). The bindings stay out of the terminal, so a shell keeps its shortcuts.
- Pairs with CLI 0.31.0; editor protocol v6 is unchanged, so CLI 0.30.0 and newer keep working exactly as before.

## 0.17.1 — 2026-09-09

- Update the packaging toolchain for a js-yaml advisory (GHSA-2883-xcg3-v3hh). It is a development-only dependency of the packager, so no shipped extension code changed.
- Recommend CLI 0.30.2, which stops the `/files` explorer from trashing the project root; protocol v6 compatibility is retained.
- No change to the panel, the turn ETA chip, or **DGC: Notify On Turn End**. This release exists so the published package and the reviewed source agree byte for byte.

## 0.17.0 — 2026-09-09

- Show the turn ETA beside the elapsed timer while a native turn runs: a calibrated range such as `~2–4 min left · 3/5 tasks`, sent by CLI 0.30.0 as the additive `turn_eta` protocol-v6 event and hidden on older CLIs.
- Add **DGC: Notify On Turn End** — a notification with a Show action when a turn longer than 20 seconds finishes while the DGC panel is not visible.
- Recommend CLI 0.30.0; protocol v6 compatibility is retained.

## 0.16.2 — 2026-09-08

- Keep native plan, permission and question cards pending until you respond or stop. Dismissing a question no longer silently selects its first option.
- Add an Other text answer to every question, plus separate question tabs, retained answers and one Submit action for grouped decisions.
- Browse and select skills while a turn runs. Skill installation, enablement and reload wait until it finishes.
- Send follow-ups into an active native-model turn with Enter or Send; use Alt+Enter or Queue for a later turn. Keep Stop available while drafting. Subscription CLI follow-ups queue for the next turn.
- Acknowledge steering delivery and restore unapplied inputs after cancellation or failure, including images and selected context.
- Change permission mode during a run and recheck pending approvals without bypassing explicit ask/deny rules or workspace trust. Delegated CLI permissions change on the next turn.
- Match the Settings Save button to the standard action-button style. Use CLI 0.29.2 for live controls; retain protocol v6 compatibility.

## 0.16.1 — 2026-09-07

- Fix new chats showing pre-existing Git changes as chat work. The composer card now shows changes recorded during this chat's runs; **Workspace changes** opens the separate repository review.
- Compare edits against actual pre-run file contents, including already modified files. Preserve saved previews across reloads, exclude edits made between runs, and clear the card on a new chat.
- Support live inspection, native and subscription runs, cancelled/error turns, and rewind. Chat snapshots remain private and are never supplied to the model.
- Recommend CLI 0.29.1; retain protocol v6 and gate chat inspection by capability. Older sessions have no retroactive chat baseline. Concurrent external edits during a run may be included; tracking covers the primary project folder.

## 0.16.0 — 2026-09-06

- Use `/` and `$` anywhere at a word boundary to choose commands, skills and prompt templates while preserving the draft. Add shared plan, review and project-guide workflows.
- Attach exact skill instructions and MCP resource/prompt snapshots to native, subscription and goal requests. Include 22 bundled skills, portable package discovery, create/install, and enable/disable controls.
- Preserve per-chat drafts, attachments and selected context across panel reloads and backend restarts, with recovery for rejected or uncertain delivery.
- Add per-server MCP reconnect/enablement, bounded context browsing and cancellable OAuth sign-in with desktop remote callback forwarding.
- Inspect workspace changes through the CLI without running repository filters; handle sparse checkouts, staged-only changes, duplicate folder labels and partial results.
- Fix subscription startup hanging on the editor input pipe, early native success after tests, interrupted-turn success and completed command pipe retention.
- Recommend CLI 0.29.0 for every feature; keep protocol v6 with additive capability checks. See the upgrade guide for editor auto-update and VSIX pinning.

## 0.15.0 — 2026-09-06

- Render complete CommonMark with syntax-highlighted code, exact-source copy and safe file/source links. Group tool activity and separate successful final responses from commentary, failures and cancellation.
- Run durable goals across native and subscription routes with pause, resume, edit, delete, evidence review and optional token budgets. Preserve work time and restore saved active goals as paused.
- Refine the model menu and reasoning slider with DGC purple accents and host theme colors.
- Review initial staged files and workspace diffs safely; disclose large or failed change scans.
- Preserve rejected prompts and attachments, page saved history, restore tool details and batch streaming renders.
- Require CLI 0.28.0 / editor protocol v6. Harden file navigation, worker acknowledgements, subscription output and legacy effort settings.

## 0.14.1 — 2026-09-06

- Added the Codex-style `objective /goal` composer action: selecting or submitting the suffix now preserves the full objective, tags it as a goal, persists it, and starts the turn with one Enter.
- Kept `/goal <objective>` and goal-state commands intact while ensuring an inline `/goal` mentioned inside ordinary prose is never misclassified.
- Replaced the extension's fixed black shell with Cursor/VS Code theme tokens for the sidebar, transcript, composer, controls, text, and overlays, with DGC color retained for focused product accents.
- Verified the goal and pinned-composer flow in a real VS Code host at wide and narrow widths across both dark and light host themes.

## 0.14.0 — 2026-09-06

- Added a composer-attached changed-files rail backed by live Git state, with addition/deletion totals and one-click native VS Code side-by-side review.
- Rebuilt the standing-goal surface as a timed composer rail with direct pause/resume, edit, and clear controls; `/goal <objective>` remains a tagged action that starts that exact objective.
- Matched the current Codex editor hierarchy for compact tools, readable diffs, transcript cadence, and the model/reasoning composer while keeping DGC purple to restrained identity and focus accents.
- Made active-turn goal pause/clear cancellation-safe, bounded change review for binary, oversized, and symlinked files, and verified the complete UI at wide and narrow Cursor/VS Code panel widths.

## 0.13.0 — 2026-09-06

- Added DGC Ultra, the combined model/reasoning control, and a Codex-inspired live activity row that follows the newest response instead of floating above a scrolled transcript.
- Made `/goal <objective>` persist a visible timed goal and immediately run that exact objective; pause, resume, edit, and clear remain available above the composer.
- Added the current thread title to the header with automatic first-prompt naming and click-to-rename behavior across new and resumed sessions.
- Made Artifact Stop a single acknowledgement-driven action with an explicit stopping/error state, eliminating white disabled controls and double-click shutdowns.
- Bounded hidden-reasoning exhaustion so every turn ends with a visible answer or an explicit saved-progress error instead of appearing to stop silently.

## 0.12.1 — 2026-09-04

- Rebuilt the protocol-v5 editor against the corrected DGC 0.26.2 cross-platform baseline.
- Kept settings and MCP changes acknowledgement-driven, rollback-safe, and identity-bound.
- Retained the polished goal controls, streaming status, tool cards, diffs, and long-running chat behavior.

## 0.12.0 — 2026-09-04

- Moved the CLI/editor contract to protocol v5 with explicit route state and complete reasoning-effort support.
- Made settings and MCP changes acknowledgement-driven, rollback-safe, and honest about partial failures.
- Bound remote MCP credentials to an exact server identity and tightened persisted command and URL validation.
- Polished goal controls, streaming status, tool cards, diffs, and long-running chat behavior.

## 0.11.0 — 2026-09-02

- Added standing-goal controls and plan feedback above the editor transcript.
- Refined structured tool cards, readable diffs, and correlated lifecycle status.
- Moved the CLI/editor contract to protocol v4 with stricter decision and cancellation handling.

## 0.10.0 — 2026-08-31

- **Subscription delegation in the editor.** Selecting a subscription (Claude Code / Codex / Qwen / Kimi /
  Copilot) now delegates editor chat turns to that vendor's own CLI — streaming thinking, tool cards, diffs,
  and the final answer into the panel, with exact per-session resume and correct cancellation.
- Hardening from an independent audit: delegated turns now honor DGC's permission mode (plan/default no
  longer run full-auto), vendor stream schemas are normalized so a broken run fails visibly instead of
  returning an empty success, cancellation kills the whole vendor process group, and sign-in status
  distinguishes missing / signed-out / CLI-managed keychain auth.

## 0.9.0 — 2026-08-30

- **Bring your own subscription.** A new Subscription section in Settings → Models lets you run each
  turn through your own Claude Code, Codex/ChatGPT, Qwen, Kimi, or GitHub Copilot plan via its
  official CLI — with an optional model and reasoning-effort override, and a live sign-in status.
  DGC never handles the vendor's tokens; it launches the official CLI, which owns auth and terms.
- Added dedicated searchable Skills and Documentation browsers, including loaded source precedence,
  instruction detail, explicit skill reload, and one-click `$skill` insertion without transcript
  pollution.
- Added a SecretStorage-backed MCP manager for local STDIO and remote bridge servers, with safe
  metadata persistence, status/tool inspection, edit/remove/reload flows, and typed protocol-v4
  management commands.
- Expanded editor parity with dedicated Permissions, Memory, Hooks, Plan, Artifact, Goal, Handoff,
  Retained Tasks, session naming, compaction, and command-menu palette entries.
- Reorganized in-panel settings into General, Models, Agents, Security, and Extensions, adding
  reasoning display, suggestions, sandbox/network, plan/artifact, tool-profile, and parallel-task
  controls while retaining the existing DGC mono/black/purple design.
- Added protocol, backend, webview, accessibility, and feature-manager regression coverage.
- Hardening pass before ship: the MCP subsystem-error notice renders as inert text instead of
  raw HTML; persisted MCP specs now reject inline-secret arguments (`--api-key`, `--token`,
  `-H`/`--header`, …) as well as env/URL credentials; and pausing a standing goal interrupts any
  in-flight turn rather than only relabeling it. Covered by new Python and webview tests.

## 0.8.1 — 2026-08-21

- Rides the **v0.20.0 harness**: far more robust editing (a tiered matcher that forgives a local model's near-misses, plus a `multi_edit` batch tool), a **universal thinking switch** that actually turns reasoning off on any provider, an over-thinking watchdog, and loop guards. Same panel — pointed at a smarter backend. Run `dgc update` (or reinstall) to get it.
- Docs polish.

## 0.8.0 — 2026-08-19

- **Artifacts in the panel.** When the agent serves a localhost preview with the new `artifact` tool, DGC now shows an **"Artifact ready"** card with the URL and an **Open in browser** button (plus **Stop** to shut the preview down and free its port). Powered by the CLI's `artifact` tool + `dgc-design` skill, so previews look intentional by default.

## 0.7.3 — 2026-08-19

- **Readable, wrapping option prompts.** When the agent asks you to choose, options now render as a stacked list of full-width rows that **wrap** (long options no longer overflow the card), each numbered, with the recommended one marked by an accent bar instead of an unreadable solid-purple fill.
- **Polished task list.** Todos now use `□` pending · `▶` in-progress (gold, bold) · `✓` done (green, struck through) · `✗` cancelled (red), under a `Tasks n/N` header.

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

- **In-composer controls** — model, permission mode and thinking level now live in the prompt box: inline model menu, mode/thinking picker, native VS Code (codicon) icons, and a context-usage pill that compacts on click. **Shift+Tab** cycles permission modes.
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
