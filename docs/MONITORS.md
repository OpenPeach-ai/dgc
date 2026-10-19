# Background monitors

A monitor is a shell command DGC watches for the model while it keeps working: a log tail, a build
watcher, a periodic check. The model starts one with the `monitor` tool (same permissions and sandbox as
`bash`). Each line the command prints to stdout reaches the model as an event, between its tool calls
during a turn, or by starting a turn on its own when the chat is idle (the editor and the full-screen
terminal). stderr is kept for `bash_output` and never becomes an event.

A monitor ends when its command exits, when its time limit (`timeout_ms`, 5 minutes by default, at most an
hour) runs out, when you or the model stop it, or when its chat ends: a new chat, `/clear`, resuming
another session, a rewind, or DGC itself stopping. Nothing watches while DGC is closed.

- **Editor:** running monitors are on the row above the prompt box and in the agent map's background
  tasks, each with Stop.
- **Terminal:** `/monitors` lists them; `/monitors stop ID|all`, `/monitors show ID`,
  `/monitors wake on|off`.

## When the chat comes back

A window reload, a lost connection, a closed editor or a killed backend stops DGC, and with it every
monitor. When that chat is opened again — the editor reconnecting or reloading, or `dgc --resume` in a
terminal — DGC starts each monitor that was still running when it stopped, once, with the same command,
folder, sandbox and permissions. The chat says so, and so does the model's context at its next turn:

> Monitor "ERP sync" restarted after DGC reopened this chat; nothing was watched between 10:02 and 10:05.

The restarted monitor is on the monitors row and in the agent map as usual, with Stop. The model is told
the same gap, so it does not assume nothing happened while DGC was closed.

What comes back, and what does not:

- **Only monitors DGC's stopping ended.** One you or the model stopped, one that timed out or exited on its
  own, and one a rewind took back never come back.
- **Only within its time limit.** The limit is counted from the monitor's first start, on the clock: a
  5-minute monitor started at 10:00 ends at 10:05 however long DGC was closed. If it ran out while DGC was
  closed, the chat says so instead. A `persistent` monitor has no limit.
- **Only under the permissions in force now.** If the chat now forbids it (plan mode, a deny rule, a
  session policy, a PreToolUse hook), or the command would now need your approval when it did not need it
  before (it was allowed by auto mode, and the chat reopened in default mode), it is not started. The note
  reads "Stopped when DGC restarted" with **Restart**; pressing it is your approval (a deny still wins). In
  the terminal, `/monitors restart ID`. A command you approved stays approved for the rest of its time.
- **Once.** Each opening of the chat restarts it at most once. If it fails to start, the chat says why and
  DGC does not try again; Restart is there if you want to.
- **Not one that carried a credential.** DGC does not write a command holding a key it knows to disk, so it
  cannot restart it; the note says so.
- **Only once the DGC that ran it has ended.** If another DGC process still has the chat open and its monitor
  running, it is left alone. A reopen that finds the previous DGC still exiting (the window reloaded a moment
  before) waits for it, up to 30 seconds, and then brings the monitor back.

DGC writes each monitor down in a small file beside the session (`<session>.monitors`, at most eight
records, private to you), and removes it with the session.

## Other background work a restart stopped

The same opening of the chat says what happened to the rest of the work that was running in the background:

- **Background commands** (a dev server, a long build started with `background: true`) are shown as "stopped by a
  restart" with **Run again**: the same command in the same folder. They are never run again on their own, because a
  command may not be safe to repeat. The agent map lists them too, with Run again on their card, until you run them
  again.
- **Sub-agents** that had not reported are shown as stopped by a restart, here and in the agent map, with **Resume**
  (a new sub-agent with the same task and what the stopped one had done: its steps, and its unmerged work when DGC
  kept it as a retained task) and **Run again** (the same task from scratch). Never run again on their own.
- **Troupes** pick up where they stopped, once, when the chat is opened again: every agent that had finished keeps
  its result, and only the unfinished ones run again. When the permissions in force now would not start it (plan
  mode, or an approval auto mode had given), it is shown stopped with **Resume** instead.

Your press is the approval; a deny rule or plan mode still wins. The model is told which ones stopped, and what was
run again. These are written beside the session in `<session>.tasks`, under the same rules: only work whose DGC has
ended, never work another live DGC still runs.
