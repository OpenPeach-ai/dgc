# Changelog

## Unreleased

- **Conversation text one step larger.** Prompts and answers are 13px (code 12px): 12px read too small. Prompts keep the answers' line spacing.

## 0.26.7 — 2026-09-19

- Requires CLI 0.41.6; editor protocol remains v14.
- **Set the context window from the prompt box.** The context meter's menu has a Window size row (8K to 1M, or Custom), and says when the model holds less than you picked.
- **Settings lists the models a host offers.** Pick the Ollama preset, or type a host, on the Models or Agents tab and the model field suggests that host's models (Ollama's list, or `/v1/models`).
- **Sub-agents get their own context window** (Settings → Agents), and the sub-agent model can change while a turn runs, as the main model can.
- **The token count no longer reads 0.** A turn made only of tool calls (glm-5.3 working without narrating) counts the arguments the model wrote.
- **Quieter conversation text.** Prompts and answers are 12px (code 11px), and a prompt uses the answers' line spacing.
- **Truthful thinking note.** The reasoning note says which levels the current model actually honours, and follows a model switch.
- **Every error line is shown again.** 0.26.6 hid an error whose text matched the previous error, so the backend-exit reason vanished after a reconnect replayed the chat, and a repeated failure on the next turn or in a new chat showed no reason. The skipped-event notice is still shown once per event type by the backend connection.

## 0.26.6 — 2026-09-18

- Requires CLI 0.41.5; editor protocol remains v14.
- Unknown backend events (for example `remote_status` from a remote-capable CLI) are skipped once. The connection stays up instead of reconnect-spamming the chat.

## 0.26.5 — 2026-09-18

- Requires CLI 0.41.5; editor protocol remains v14.
- Same Tasks-row behaviour as 0.26.4. Layout tests load bundled DejaVu fonts from the extension tree.

## 0.26.4 — 2026-09-18

- Built, not published to the registries; 0.26.5 shipped the same change.
- Requires CLI 0.41.4; editor protocol remains v14.
- **Tasks row matches the terminal.** When every item is done and the turn is idle, the Tasks list above the composer hides. A new prompt's checklist replaces a finished one instead of sitting at 4/4.

## 0.26.3 — 2026-09-17

- Requires CLI 0.41.3; editor protocol remains v14.
- **Sub-agent marks keep the same face.** A working agent no longer swaps to the colour-swirl file. The chip in the parent chat and that agent's page share the still identity mark; a live ring pulses while it works.

## 0.26.2 — 2026-09-17

- Requires CLI 0.41.3; editor protocol remains v14.
- **Sent attachments are chips.** Images, pastes, files and skills sit above the typed prompt in the sent bubble. Click a chip to open it. They are no longer shown as `[📷 image]` in the sentence.

## 0.26.1 — 2026-09-17

- Requires CLI 0.41.2; editor protocol remains v14.
- **Restored sub-agents stay with their spawn.** Compaction still summarises the model window. The human log keeps the `task` cards after that summary, and identity chips pin there instead of dumping under the last answer. A chip without a spawn card is not drawn. Opening a chip shows the child's saved tool steps when DGC kept them.
- **Thinking is one dial.** Settings → General → Thinking is the composer control. You can change it while a turn runs; the round already on the wire keeps its budget, and the next model round uses the new level.

## 0.26.0 — 2026-09-17

- Requires CLI 0.41.0; editor protocol remains v14.
- **Identity chips.** Each sub-agent is a coloured mark in the thread. The mark moves while it works and stills when it finishes. Click the chip, or its row in the agents list, for that agent's page: duration, answer, and files. Child greps and edits stay on that page, not in the parent chat.
- **Background specialists.** A task started with `background: true` keeps going after the turn ends. The composer stays free and the agents pill remains until it finishes. When it lands, DGC starts a wake turn with the child's summary.
- **Auto-mode outline.** The composer in auto mode uses a DGC lavender outline; the fill stays the normal surface.

## 0.25.3 — 2026-09-16

- Requires CLI 0.40.3; editor protocol remains v14.
- **Stacked option cards.** Each choice is its own rounded tile with a radio, a quiet Recommended tag, and Continue instead of Submit. Keyboard 1–4, Skip and free text stay.
- **Agents pill lasts the turn.** Finished, failed and stopped agents stay visible in the composer until the turn ends, then the pill clears. Transcript history is unchanged.
- **Switch models mid-turn.** The picker is no longer blocked while a turn runs. The in-flight generation keeps its client; the next model round uses the new one. A "Switched to …" line lands in the chat.
- **Viewed images stay on the tool card** even when the model cannot see them. Click the chip to open the image. After switching to a vision model, the next turn can send the pixels.

## 0.25.2 — 2026-09-16

- Requires CLI 0.40.2; editor protocol remains v14. Includes direct verified extension recovery, paired CLI recovery, checklist reminders and persisted approval cards from 0.25.1.
- The composer counts active agents rather than every agent ever started in the chat. Successful agents disappear immediately; failed or stopped agents remain for 30 seconds. Historical tool steps remain in the transcript; failed steps keep their failed status.
- CLI updates show progress, reconnect on success and retain the installer’s actual failure in Output → DGC update. Supported Python discovery handles Finder-launched editor environments.
- Option cards recognize recommendations containing a rationale. Browser documents have a named tool step. Reasoning controls explain the selected model’s native tiers and what Ultra changes.
- Token Usage consistently explains local counts, missing reports, subscription CLI accounting and retention, and identifies its top-100 model table.

## 0.25.1 — 2026-09-15

- **Requires CLI 0.40.1; editor protocol stays v14.** Automatic CLI recovery targets the release
  required by this extension instead of the latest potentially incompatible CLI. Compatibility
  shutdowns show connection guidance instead of a second misleading crash message.
- **Check for Extension Updates.** The command and daily optional checks work for every install
  channel. If a catalog lags, install a checksum-verified official VSIX after selecting Install
  Update, then reload when ready. A newer CLI offers the same extension recovery.
- **Permission decisions survive chat reopen.** Saved tool approvals return as read-only cards with
  Allowed once, the actual saved allow-rule, or Denied and its note. Denied tool results keep their
  denied label, including older histories whose result already recorded the denial.
- With CLI 0.40.1, printed todo JSON triggers a bounded request for an actual todo call, and work
  after a checklist update still prompts the model to record progress. Printed JSON alone never
  modifies the checklist; exhausted reminders are reported honestly.

## 0.25.0 — 2026-09-15

- **Editor protocol v14; requires DGC CLI 0.40.0.** Adds the agents list, model reconnect lines,
  question cards with a recommended option, thinking labelled by source, and the images the model
  looked at. A mismatched pair says which side to update.
- **Agents pill.** A pill under the prompt shows how many sub-agents the chat has started and
  whether any is working: `● 2 agents`, `◆` when one needs you, `○` when none is working any more.
  Hover it for how many are working; click it for the list, with a summary, one row per agent
  (state, task, what it is doing, run time, tool calls and tokens) updated as it works, and
  **Sub-agent settings**. Click a row to jump to that agent's step. The list comes back when the
  chat is reopened.
- **Reconnect lines.** A failed model request shows a muted line in the turn that changes in place:
  `Reconnecting 1/3 · connection refused by 127.0.0.1:11434`, `Server is busy, retrying 2/3`, then
  `Reconnected after 1 retry` or `Gave up after 3 retries`. Click it for the cause, model, endpoint,
  HTTP status, each attempt and a hint, with **Copy details**. When DGC gives up, the error leads
  with what failed and shows the hint underneath. Restarting DGC's own backend reads
  `Restarting the DGC backend`, so it is never mistaken for a model reconnect.
- **Questions dock in the prompt box.** When a choice is yours, the model's questions replace the
  text box while Stop and the pickers stay put. The recommended option carries a **Recommended**
  badge and starts checked, options show their descriptions, and **Something else…** takes your own
  words. Arrow keys move, digits and Enter pick, **Skip** leaves a question unanswered, and **×**
  closes the card without answering, which ends the turn. Nothing is sent until you act, what you
  had typed comes back, and answered questions stay in their step, after a reload too.
- **Thinking is labelled by source:** `Thought for 4s · raw`, `· summarized by Anthropic`,
  `· hidden by OpenAI`, or no label when DGC cannot tell, with a hover label that explains each.
  Short provider summaries between tool calls read inline and muted. Settings → General → **Show
  model thinking** offers inline, collapsed or hidden.
- **Images the model looked at.** A step that produced images (a browser screenshot, a workspace
  image, an MCP tool's image) shows a count; open it for thumbnails, and click one for a viewer with
  the image's name, size and source, ←/→ and Home/End between images, Z for actual size,
  **Open file** for DGC's stored copy, and **Stop** while a turn runs. If DGC needs you while it is
  open, the viewer says so and **Show** takes you there. Images come back after a reload or when the
  chat is reopened.
- **Queued messages are no longer lost.** After **DGC: Restart Backend**, a window reload or a
  backend exit, messages that were waiting behind a turn, and steering the backend had not applied
  yet, come back as not sent, ready to restore. Reloading only the DGC panel keeps them waiting.
- **Reloading the panel mid-turn keeps the turn running**, with Stop, one card per open permission,
  plan or question, and a streaming answer continuing in the same turn.
- A steered turn reopens as the finished turn it was, with one bubble per steering message.
- An answered permission, plan or MCP card ends with what was decided (Allowed once, Always allowed
  with its rule, Denied with your note, Approved · acceptEdits mode, Kept planning, Declined) and
  drops its note box.
- A refused artifact preview shows as a failed step; in a narrow panel the goal row leaves out an
  objective it has no room for.

## 0.24.0 — 2026-09-15

- **Editor protocol v13; requires DGC CLI 0.39.0.** Adds background monitors, token usage reports
  and resuming a turn the backend was interrupted in. A mismatched pair says which side to update.
- **The backend no longer stops a turn on its own.** A command the agent ran could leave the
  backend's input pipe non-blocking, and the backend took the next empty read for the editor closing
  and ended the turn as Stopped. That is fixed in DGC CLI 0.39.0. If the backend does exit, the
  panel now says why and offers **Continue**.
- **Tasks sit in the bar above the prompt, like the goal.** Collapsed, the row reads `Tasks 2/5`
  with the step in progress; expand it for the full list. The choice is remembered per chat, and
  **Clear** works while a turn runs.
- **A running command is shown once**, on its card. The group header and the activity row no
  longer repeat it.
- **Settings → Token Usage** shows input, output and cached tokens by model and by day, counted on
  this machine. Pick Today, 7 days, 30 days, This month or All time.
- **Background monitors.** When the agent watches a long-running command, each event is a card in
  the transcript and running monitors sit in a row above the prompt with a Stop button. A turn a
  monitor started is marked as such, never as something you typed. Turn wake-ups off with
  Settings → **Wake on monitor events**.
- **A quiet model request shows as waiting** on the activity row instead of looking frozen.
- **Undo in the prompt box.** Cmd/Ctrl+Z brings back a message you just sent, text you deleted, or
  a completion you did not mean to insert.
- The prompt box keeps its size when you come back to DGC from another view after a turn stopped.
- Queued messages survive slash commands, and a restart DGC holds until the turn ends.
- The editor tabs and activity bar show the DGC mark instead of a terminal glyph.
- An automatic CLI update runs `dgc update` in the installation it belongs to, and an older CLI's
  failed update is reported instead of passing silently.
- **Chat history keeps its shape.** A chat rebuilt after a backend restart, a window reload or a
  resume lost the space between prompts and answers. Queued messages were drawn twice and out of
  order, and the view jumped after the panel was resized. All fixed.
- **Stop never drops queued messages.** Messages waiting behind the stopped turn come back as not
  sent, ready to restore.
- **Continue survives a killed backend.** A running turn is saved at each step, so a backend that is
  killed or crashes still offers Continue for the turn it was on.
- **Security:** the artifact server never publishes dot-files, secret files or a project's source. A
  page at a project root publishes only what it links, and the server answers only to this machine's
  own addresses.
- In full-auto, asking to choose between options opens the options picker.
- Browser screenshots and images attached by @-mention, drag or Add File to Chat reach the model.
- Undo works on whole typing runs; drafts keep pasted-text chips across a reload; `/usage` opens
  Token Usage; the Update CLI terminal stays open with the installer's output; the prompt box shows
  no scrollbar beside one line on HiDPI screens; command titles no longer read "DGC: DGC:".

## 0.23.1 — 2026-09-14

- When the CLI is older than this extension, DGC now updates it and reconnects on its own, with a
  progress notification you can cancel, instead of asking you to run a command in a terminal.
  Editors update extensions by themselves, so the old behaviour told you your CLI was out of date
  because of a change you never made. Turn it off with `dgc.autoUpdateCli`.
- A CLI you chose yourself with `dgc.command` is never reinstalled over; that case still asks.
- Cancelling an update now stops the installer and everything it started, not just the process the
  extension spawned.
- The installer refuses to extract a release over a git checkout, so an automatic update can no
  longer revert uncommitted work in a contributor's tree. Override with `DGC_FORCE_OVERWRITE=1`.

## 0.23.0 — 2026-09-13

- **Editor protocol v12; requires DGC CLI 0.38.1.** The `history` snapshot now carries the session checklist and there is a `clear_todos` command, so the extension and the CLI move together — a mismatched pair says which side to update at the handshake.
- **One checklist for the session, above the composer.** Tasks used to be a card appended to the transcript on every turn, so a long piece of work left a trail of stale cards showing earlier states. There is now a single list in a fixed slot between the transcript and the composer, with a **Clear** button for a list the model left behind, and updating it never moves your scroll position. No more per-turn task cards.
- **A step can be blocked.** `blocked` is a first-class task status, drawn distinctly and excluded from the finish gate, so a model that cannot complete a step can say so instead of leaving it pending forever.
- **The checklist survives resume and reload.** Reopening a chat, or reloading the panel, restores the list as it stood; a new or cleared chat starts with none.

## 0.22.4 — 2026-09-13

- **A finished goal stops being a pinned goal.** A completed objective stayed on the rail with a play button, so the obvious next click resumed work that was already done — and did exactly that to a real goal. Paused and blocked goals still offer Resume; completed ones unpin, and the transcript keeps the record.
- **The backend's log survives even when nobody is watching.** An output channel only reaches disk once somebody opens one, which is never the case for an unattended run. `dgc serve`'s stderr and exit reason are now also appended, timestamped, to `backend.log` in the extension's log directory, bounded at 4MB.
- Pairs with DGC CLI 0.37.3; editor protocol v11 unchanged.

## 0.22.3 — 2026-09-12

- **When the backend dies, you can now find out why.** The extension forwarded `dgc serve`'s stderr to a webview message type that nothing handled, so every Python traceback it ever wrote was silently discarded — a backend could die repeatedly and leave no evidence anywhere. It goes to a **DGC Backend** output channel now, alongside the exit reason.
- **A killed backend is told apart from one that stopped cleanly.** The exit line collapsed both, because exit code `0` is falsy in JavaScript and the signal was thrown away entirely. It now names the code or the signal.
- **The goal clock stops when the backend does**, instead of counting wall-clock time against a dead process.
- **A sharper icon:** the tile was a 128×128 raster of the full lockup — the smallest size the marketplace accepts, upscaled and soft on every high-DPI screen, with a wordmark unreadable at the ~40px extension lists actually render. It is now the DGC mark alone, from the vector source at 512×512.
- Pairs with DGC CLI 0.37.2; editor protocol v11 unchanged.

## 0.22.3 — 2026-09-12

- **A sharper icon.** The tile was a 128×128 raster of the full DGC lockup — the smallest size the marketplace accepts, so it was upscaled and soft on every high-DPI screen, and the wordmark inside it was unreadable at the ~40px the extension lists actually render. It is now the DGC mark alone, drawn from the vector source at 512×512.

## 0.22.2 — 2026-09-12

- **DGC is now open source under the Apache License 2.0**, replacing PolyForm Noncommercial. Use it commercially, inside a company, on client work, with no separate agreement — and with an explicit grant of the patent rights contributors hold in the work.
- **The panel comes back on its own when its backend dies.** `dgc serve` is a plain child of the extension host, so an extension update, a window reload or a host crash takes it down with them — and the panel kept pointing at the dead process, so every later command wrote to a closed pipe and the only way out was finding **DGC: Restart Backend**. DGC now clears the dead backend and starts a replacement itself, bounded to three restarts in two minutes so a backend that genuinely cannot start is not respawned forever.
- **A goal interrupted that way picks itself back up.** A restored goal is deliberately paused — right when you deliberately reopen an old chat, wrong when the runner was killed under it seconds ago. DGC now tells those apart and continues the work, while a goal you paused yourself is never revived behind your back.
- In auto mode the model pill takes the auto colour too, instead of staying purple inside an olive composer.
- Pairs with DGC CLI 0.37.1; editor protocol v11 is unchanged.

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
