# Controls during a turn

CLI 0.29.2 and extension 0.16.2 add live controls without changing editor protocol v6.
Update both components for these capabilities.

Native plans, tool permissions and decision questions wait until you respond or stop the turn;
the five-minute MCP input timeout no longer applies to human review. Closing a pending question
never chooses its first option. A stopped plan remains unapproved.

Questions (CLI 0.40.0, extension 0.25.0, editor protocol v14). A model asks with `propose_options`:
1-4 separate decisions, each with 2-6 options (2-4 advised). The option it recommends comes first with
its label ending "(Recommended)", and every option carries a one-sentence description. DGC turns the
marker into data (also when a model writes it into the description instead) and never reorders the list. A client always adds free text ("Something else…"), so an
"Other" option a model adds is dropped. Custom answers are bounded to 4,096 characters.

- **Extension.** The question docks inside the composer frame in place of the text box; Stop, the mode
  and model pickers and the context meter stay, and the unsent draft comes back when the question closes.
  Each option is its own stacked card with a radio. The recommended option shows a quiet "Recommended"
  badge and is preselected: it is checked and holds the highlight and the focus, so Enter, a click on it
  or Continue takes it, and Skip sits beside Continue as its own button. Nothing is sent without your
  action. A pick advances to the next question and the answers are sent once every question is answered
  or skipped; Skip is explicit.
  Keys that arrive within 400 ms of the question opening are ignored, and the question takes focus only
  when the composer is empty or unfocused (otherwise it says "Press Tab to answer").
- **Full-screen terminal.** One line per option, the focused option's description under the question, the
  cursor on the recommended option; digits pick, Space toggles a multi-select option, "Skip this question"
  skips, ←/→ or Tab change question.
- **Classic terminal.** An arrow menu per question starting on the recommended option, with "Something
  else…" and "Skip this question" rows; multi-select takes comma-separated numbers; several questions get
  a review list whose Submit skips anything unanswered.
- **ACP clients.** One permission request per question; the recommended option is named
  "(recommended)" and descriptions travel in the tool call's content.

Closing a question (× or Esc) is its own outcome: DGC saves the batch's results (calls after the question
in the same batch do not run), ends the turn with no
further model request, keeps queued prompts and monitors, and pauses an active goal with "You closed a
question the goal needs answered". Stop keeps its meaning. Answered questions stay in the transcript as
"Asked 2 questions" (or "Asked · SQLite file") inside the step, the same after a reload or resume.
Sub-agents and `dgc -p` are no longer offered the tool: a sub-agent returns the decision to the main
agent with its recommendation. External subscription tools retain their own question interface.

Full-auto auto-approves tool calls; it does not hide the options picker. It leaves `propose_options`
out of ordinary coding turns, except on a turn where you explicitly ask to choose ("propose me options
to select from", "let me choose", "ask me to pick", "show me a test option picker"). That turn gets
the native picker in every permission mode — the model must call `propose_options`, not mock it in
Markdown. In full-auto it is withdrawn again once one round of questions has been asked, so the rest
of the turn (a whole goal run) goes on unattended. Only text you type counts: attached files and
editor context never ask, a goal's objective never re-opens the picker on later cycles or turns, and
a sentence that describes software ("the dropdown should let me choose a region", "write tests for
propose_options") is not an ask. Offering the picker never forces it: DGC does not parse a negated or
withdrawn ask ("... actually, never mind, you pick"), the model reads your whole message and decides
whether to call it.

Some turns still have nobody to answer: a turn DGC starts on a background event, a `dgc -p` run, a
sub-agent, and a subscription CLI turn. When you ask on one of these, the model is told why the
picker is missing, so it lists the choices as a numbered list instead of claiming the picker does not
exist. Once you have answered a round of questions, or a background turn has listed the choices,
later background turns are not told again. If a model in a `dgc -p` run calls the picker anyway, a
script still receives the structured `options_request` event (with `decision: null`); the model is
then told that nobody can answer and gives the options in its final answer.

| Action | Extension | Terminal |
| --- | --- | --- |
| Steer a native turn | Enter or Send with a draft | Enter |
| Queue a separate turn | Alt+Enter or Queue | Tab outside menus and completion |
| Browse skills | Skills, View instructions, Use skill | `/skills`, `/skills show NAME` |
| Change permission mode | Mode selector | `/mode MODE` or the full-screen mode selector |
| Change model | Model picker | `/model NAME` or the full-screen model selector |
| Stop work | Stop, including the separate button while drafting or while a question is open | Esc or Ctrl+C (Ctrl+C on an open question) |
| Close a question | × or Esc (with its text field empty) | Esc |

Steering is consumed at the next model/tool boundary. It does not interrupt a tool already
executing or cancel an in-flight model response. If the native turn has already claimed its final
boundary, the message queues for the next turn. Skill selection, images and editor context accompany
editor steering. The editor distinguishes accepted steering from applied steering and restores
unconsumed input after cancellation or failure. A draft already being edited is preserved; use
**Restore unsent message** to recover another input. Terminal follow-ups remain queued after an
interruption and resume after a new prompt.

External subscription CLIs currently receive a one-shot prompt. Their follow-ups queue, and a mode
change applies when DGC launches the next subscription turn. The active external process keeps its
launch permissions. The editor displays this limitation instead of claiming live steering.

Native permission changes affect upcoming decisions and recheck a pending tool approval. Explicit
deny and ask rules take precedence over Auto. Workspace trust and the existing Auto confirmation
remain required. An action already dispatched may finish under its previously granted permission.
Mode changes update permission state immediately; the turn worker refreshes its model instructions
before the next request, avoiding concurrent transcript writes.

From CLI 0.40.3 and extension 0.25.3, the model picker works while a turn runs. The in-flight
generation keeps its client; the next model round uses the new one. The chat records
`Switched to <model>`. Viewed images still appear as a clickable chip on the tool step even when
the current model cannot see them.

Skills browsing uses the current catalog during a turn. Installation, deletion, enablement and
reload remain unavailable until the turn finishes. Viewing the library never sends `/skills` to
the model as a steering instruction.

The extension uses capability negotiation for live steering and mode changes. Older backends keep
their existing queue behavior. Legacy protocol v6 clients keep their existing acknowledgements.

Regression coverage includes concurrent native steering with selected skills and images, live
catalog reads, pending approval transitions, explicit policy precedence, trust, failed preparation,
cancellation recovery, legacy and delegated delivery, real-terminal Unicode input, and rendered
composer actions. Browser inspection also checks that Settings Save uses the same corner radius
as other action buttons.
