# Chat change attribution — CLI 0.29.1 / extension 0.16.1

Previously, a fresh chat could display “6 files changed +778 −2” before receiving a prompt.
The composer used the repository's pending Git changes, including work done before the chat.

The composer now displays **Changes in this chat**. Each native or subscription work cycle captures
the actual file state before execution and records the resulting changes. An already modified file
is compared with its pre-run contents. Opening a chat and completing a read-only run produce no
change card. **Workspace changes** opens a separate review against the last Git commit.

Snapshots are private session data, persisted with the existing atomic session generation and
credential redaction. They are never inserted into model messages. Completed reviews are frozen:
editing a file later does not rewrite the saved review. Contiguous edits merge, including reverts;
intervening external changes start another before/after pair and are excluded from its line totals.
New chats start empty. Resuming a saved chat restores its recorded review. Older sessions have no
retroactive baseline and are never populated from Git HEAD.

Live inspection runs in bounded workers, away from the editor control stream. Cancelled or failed
runs retain observed partial edits. Rewind updates the review under the existing workspace lease
and rolls the review back if session persistence fails. Inspection replies carry session identity;
the extension drops stale results and refuses cross-chat diff requests.

Tracking covers the primary project folder. Other folders remain available in workspace review.
Concurrent external edits during an active run may be included; the review labels this limitation.
Binary/oversized files have no invented text counts. File, byte, time, and history limits bound
inspection; symlink parents are never followed. A process crash before the final snapshot can leave
that unfinished cycle without durable change evidence. Existing checkpoint/rewind behavior is
independent of this owner-facing review.

Regression coverage includes dirty/staged/untracked work at chat creation, a read-only run, an edit
to an already modified file, intervening manual edits, contiguous reverts, creation/deletion,
binary and oversized files, hostile saved paths and symlinks, live projections, cancelled runs,
native/subscription persistence, resume/reset, session-bound inspection, browser-rendered controls,
and actual VS Code host routing. Release checks and public artifact manifests provide publication
evidence.
