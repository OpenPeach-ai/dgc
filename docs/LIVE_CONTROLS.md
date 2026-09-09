# Controls during a turn

CLI 0.29.2 and extension 0.16.2 add live controls without changing editor protocol v6.
Update both components for these capabilities.

Native plans, tool permissions and decision questions wait until you respond or stop the turn;
the five-minute MCP input timeout no longer applies to human review. Closing a pending question
never chooses its first option. A stopped plan remains unapproved.

Every native question includes **Other** for a custom text answer. The extension and full-screen
terminal show grouped questions in tabs; you can switch tabs and revise answers before **Submit**
sends the complete form. The classic terminal provides a question list with answer review and one
Submit action. Up to six questions and eight suggested choices per question are supported, with
custom answers bounded to 4,096 characters. Unanswered or blank custom choices cannot be submitted.
For models, `propose_options` accepts the original `question`/`options` shape or a `questions` array
whose entries contain `id`, `header`, `question`, and `options`. It returns answers keyed by question ID.
Older editor clients receive grouped questions sequentially. External subscription tools retain
their own question interface; the native question-form protocol does not alter those processes.

| Action | Extension | Terminal |
| --- | --- | --- |
| Steer a native turn | Enter or Send with a draft | Enter |
| Queue a separate turn | Alt+Enter or Queue | Tab outside menus and completion |
| Browse skills | Skills, View instructions, Use skill | `/skills`, `/skills show NAME` |
| Change permission mode | Mode selector | `/mode MODE` or the full-screen mode selector |
| Stop work | Stop, including the separate button while drafting | Esc or Ctrl+C |

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
