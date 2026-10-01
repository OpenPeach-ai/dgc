# DGC CLI changelog

Release notes for the `dgc` command-line tool and `dgc serve`. The VS Code extension has its own
[changelog](editors/vscode/CHANGELOG.md), and so does the SDK ([sdk/CHANGELOG.md](sdk/CHANGELOG.md)).
Earlier releases are listed at <https://vibedgc.com/changelog>.

## 0.47.0 — 2026-10-02

### Several chats, several folders, one backend

`dgc serve` can now hold several chats at once, the way Codex runs its threads: one process, and
each chat with its own project, trust, MCP servers, skills, permission rules and mode, in the same
folder or another one. A client opens one with `open_chat {cwd}` and closes it with `close_chat`; from the first
`open_chat` every chat-scoped event and command carries `chat_id`, and a client that never opts in
sees exactly the wire it saw before. `ready.capabilities.chats` says how many a process will hold.

What one chat does no longer reaches into another:

- An approval card belongs to the chat that asked. A Stop or a new chat in one chat used to expire
  every other chat's open cards, and those turns carried on as if you had said no.
- Each chat's commands run in order on its own thread, so one chat's compact, rewind or MCP reload
  never freezes another chat's Stop or approvals. Answers to a request a turn is waiting on are
  handled the moment they arrive.
- A change that is yours rather than a chat's — a permission rule, a trusted folder, an MCP server
  added or removed — reaches every open chat at once, not at that chat's next save. A server that
  did not change is never restarted under a turn that may be using it.
- The shared wire redacts every open chat's secrets, the process stays alive while any chat is
  working, and shutting down gives every chat the whole grace window.
- Another DGC asking whether a session is free finds it under whichever chat holds it, and a
  takeover ask for any of them is answered.

### The terminal opens agents in other folders

`/new DIR` opens an agent in another folder beside the ones you have, the way the editor opens a
chat in another folder: that folder's project, with its own trust, permission rules, named agents,
skills, `DGC.md`, MCP servers and saved chats. `~`, quotes and relative paths work, and the
dashboard's **+ Agent in another folder…** does the same.

- A folder you have not trusted asks first — **Trust it and open** or **Cancel** — and nothing from
  it runs before you answer: no agent, MCP server, hook or git command.
- The first agent in a folder works in it directly. Another one in a checkout an agent already
  works in gets its own worktree, as Ctrl+N does; agents sharing a non-Git folder are told about
  each other.
- `/resume` in that agent lists the folder's chats, and closing it says how to get back to them.
- A bare `/new`, Ctrl+N and **+ New agent** still open an agent in the project you launched in.
  `/new DIR` also works while a turn runs.
- The header's branch follows the agent on screen at once, and a `/files` or `/diff` pane closes
  when you switch to an agent of another project.
- The classic terminal answers `/new DIR` by saying where it works, instead of starting a new chat
  and ignoring the folder.

### What you can do while a turn runs

- **Rename the chat.** It was refused mid-turn; the turn's own later save keeps the new name.
- **Open a saved session.** It opens in a chat of its own beside the running one, instead of being
  refused.
- **Install or remove a plugin.** Its tools and skills reach the running turn at its next model
  request. Stop no longer aborts an install, and an install no longer waits for the turn. Cancel
  on a plugin's browser sign-in stops that install and leaves a running turn alone.

### A chat comes back in the mode it ran in

Mode belongs to the conversation now: reopening a chat restores its mode, when that mode asks no
less than the one you are in — a chat that was planning comes back planning, and a chat that ran
in `auto` comes back in `auto` when `auto` is your mode. It is re-checked, not trusted from the
file: `acceptEdits` and `auto` only while the folder is still trusted. A mode you name for the run
wins: `dgc --mode plan --continue` runs in `plan` whatever the session ran in. Reopening never
changes your default, and a new chat after it starts in the mode the reopened chat replaced;
choosing a mode afterwards changes your default, as before.

### Permissions, trust and mode: fixes, several of which failed open in 0.46.4

- A trusted project's `.dgc/permissions.json` deny stopped applying after any unrelated settings
  change. **Fails open.** The rules now stay live for the whole session.
- The first save on a new install wrote a trusted project's rules into your user config, so every
  other project — untrusted ones included — inherited its allow rules. They stay with the project.
- An SDK session whose policy strips your stored allow rules had them re-armed by its own first
  "always" answer. **Fails open.**
- The TUI's `/worktree` and fleet agents ran in a checkout without the project's rules while
  keeping a stored `auto`: the project's denies did not apply there. **Fails open.** They take the
  launch project's trust and rules now.
- A second `/worktree`, or a `/worktree` run in a fleet agent, still lost the project's rules while
  keeping a stored `auto`. **Fails open.** It keeps them now.
- Fleet and `/worktree` agents of a trusted project dropped to `default` when a plan was approved
  into `auto` or a chat reopened in `auto`, saying the folder was not trusted. They answer for the
  project's trust now, and `/trust` in one of them names the project, not its private checkout.
- New terminal agents lost the run's `--sandbox`: Ctrl+N after `dgc --sandbox read-only` opened an
  agent that could write files and run unconfined commands. **Fails open.** Every agent the run
  opens keeps the sandbox and the tools it denies, and the `--api-key-env` key its requests went
  out without. The run's `--allow-tool` and `--add-dir` grants stay with the launch project.
- A permission rule or a trusted folder saved in one terminal agent reaches the others at once,
  instead of at their next save of something else.
- Approving a plan into `auto` in an untrusted folder ran it in `auto` with no trust prompt. It runs
  in `default` now, and says why.
- Opening one untrusted folder reset your global `auto` to `default` everywhere, at the next save of
  anything. A revoked folder could also come back as trusted from another window's save.
- A rule you added that matched a project's rule could not be saved, so a deny you meant for every
  project applied only inside that one.

### Two windows no longer overwrite each other

With two sessions open, a model or mode switch in one moved the other's running conversation to it
at its next unrelated save, mid-turn and without a word. A running conversation's own settings --
mode, model route and its credentials, sampling — are never adopted from disk now; the change is
still saved as the default the next session starts from. `secrets.json` is merged the way
`config.json` is, so one window switching endpoint and key no longer has its new key wiped by the
other's next save.

### The changes bar shows the turn's own edits, however large the folder

The bar compared a bounded scan of the whole workspace: a non-Git folder past 4,096 files recorded
nothing, and an edit the scan did not reach was invisible while the model made it in front of you.
DGC's file tools now tell the bar what they write, so their edits always show, mid-turn too. A shell
command's edits still rely on the scan, which still says when it was partial.

### A background sub-task's work reaches your files when the turn is waiting on it

`wait_tasks` on a background sub-task could end with "integration failed: could not capture rewind
checkpoint" and the work kept in a worktree: the child tried to save the session while the parent's
turn held it. The child's work is now integrated by whichever thread holds the session.

### A rule in the middle of a long DGC.md is never dropped

An over-long instruction file kept its start and end and dropped the middle — a rule written there
was simply absent. Blocks headed `## Rule: …` / `## Rules`, or marked `<!-- dgc:rule -->`, are now
kept whole and placed first; if the rules alone do not fit, the ones left out are named so you can
consolidate the file. A file within the limit is unchanged.

### Sub-agents working at once never wear the same face

The editor gave each sub-agent one of its eight faces by hashing the agent's id, so two running at
once matched one time in eight, and three at once a third of the time. Each starting agent now gets
the lowest face no working agent of the chat holds (a turn's later agents take a new one), keeps it
for life, and keeps it in the saved chat. `dgc serve` sends `face_slot` only to a client that asked
for it with `set_workspace_roots.agent_faces` (advertised as `capabilities.agent_faces`); every other
client's frames are unchanged.

### A message to a sub-agent names the agent

Steering a running sub-agent read "Used tool · message task" in the editor and a bare
`message_task` in the terminal. It now reads "Sent message to <what that agent was asked to do>"
in the editor, also when the chat is reopened, and in the terminal UI as it happens.

### A background sub-task no longer tells the model not to wait

In `dgc -p`, starting one answered "do not wait for it: carry on, and check on it later", even when
you had asked for the wait and `wait_tasks` was offered — in a run that has no later. Every surface
now names the `wait_tasks` call that gets the result now; `dgc -p` says its run ends with the turn,
and stops a sub-task still running then instead of letting the process kill it mid-step, keeping
the work in its own checkout for `/tasks`. A result a notice already delivered (a wake, or a fold
between tool calls) counts as read, so `wait_tasks` never hands it over a second time.

### A background sub-task's step keeps its command when your turn ends

The full-screen terminal stopped every running step at the end of a turn, including the step a
background sub-task was still in the middle of: the command read "Ran" while it ran, and its result
then arrived in a second block with no command ("$ Ran · 2 lines"). That step now stays running and
its result lands on it, and a step a hook blocked closes instead of reading "Running".

### The terminal's spinner never shares a row with what comes after it

`dgc -p` printed a `wait_tasks` result straight after "… esc to stop", on the spinner's own row. A
result after another result, image rows, hook rows, a `-p` plan, and what the classic REPL prints
while a turn runs did the same. Each wipes the spinner first, and no late spinner frame can land
after that wipe.

## 0.46.4 — 2026-09-30

### A cut-off reply no longer loses the space where it was cut

A reply that hits the length limit is continued by a second request, and the two halves are joined
to make one answer. The continuation is a fresh generation, and a fresh generation does not begin
with a leading space — so a cut that fell between two words ran them together. "install it in the
backend image" arrived as "backendimage". It is fixed where it is caused: the continuation prompt
now says the reply is appended with nothing between it and the cut-off text, and to begin with a
space when the cut fell between words. The join stays literal on purpose — it cannot tell a cut
between words from a cut inside one, so repairing this there would turn a cut after "back" into
"back end", which is DGC inventing text you never wrote.

### Undo takes back a pasted attachment

A paste large enough to fold into a chip, or a pasted image, could not be taken back with Ctrl+Z or
Cmd+Z: those two paths change no text, so the browser had nothing to undo and the only way out was
to find the chip's remove button. Undo now takes the chip back and redo returns it. Typing after a
paste is undone first, a run at a time, and a chip you removed by hand is not resurrected.

### With the sandbox on, a delegated sub-agent can run git on macOS

Completing what 0.46.2 fixed on Linux. Re-exposing the repository was not enough to reach it: `bwrap`
masks your home so the path components are absent and git treats them as "nothing there", while
`sandbox-exec` denies them and git treats that as fatal before it ever reaches the repository. The
path components a resolver walks now carry the metadata it needs — existence and `stat`, nothing
else, no contents and no listing — for both the checkout and the repository it points at. What the
sandbox hides stays hidden: your ignored files, your other work, your keys.

### A command the sandbox refused says so

`Operation not permitted` reads as a broken machine, and a model that reads it that way goes looking
for a fault that is not there. A refusal is now named as a policy result, with what to do instead.

## 0.46.3 — 2026-09-30

### An interrupt during integration no longer leaves a half-applied checkout

When a sub-task's changes are applied to your files, each file lands atomically but the sequence
does not, so DGC rolls back if anything fails partway. `except Exception` does not catch Ctrl-C, so
an interrupt between two files skipped that rollback entirely and left some files carrying the
sub-agent's bytes and the rest untouched. Both apply paths now roll back on an interrupt as well,
record what happened, and re-raise.

The `/tasks apply` retry also leaves a breadcrumb while it runs, as the live path already did. It is
the path you drive by hand after something has already gone wrong once, so a failure there was the
one most likely to be mistaken for the original.

### A `git pull` during a delegation is no longer reported as your own edit

Pulling, checking out or rebasing while a sub-agent works moves every file the sub-agent touched,
and from the file state alone that cannot be told apart from you editing them. DGC said "someone
outside this task edited them" about files nobody had touched. It now names the branch move.

### `message_task` can add work instead of only correcting it

A message to a running sub-task was a correction by construction — "fold it in if it applies" reads
as "what you are doing may be wrong". Passing `adds_work` sends the same message under an envelope
that says the opposite: what the child is already doing still stands, and this is added to it.

### A sub-agent is told what to do with a decision it cannot make

It has no way to ask anyone — its result is the only thing that comes back. It is now told to do
the parts that do not depend on the decision, then stop and return the question with the options it
was choosing between, rather than guessing silently.

## 0.46.2 — 2026-09-29

### Opening a package to read it no longer waits for the model

Clicking "Connect Composio" while DGC was working answered "Wait for the current turn or plugin
operation before changing packages." That button opens the review that shows what the package
contains, before anything is installed — you had changed nothing and asked to change nothing.
Reading a package now works while DGC works. Installing one, removing one, and adding or refreshing
a marketplace still wait, because those change what DGC can run while it is running.

### A question the model asks you no longer disappears while you are reading it

An open question — the kind DGC asks without stopping the turn — was closed the instant the model
stopped talking. Its card, with every option and the line describing each one, collapsed to a single
"Not answered" line that could not be reopened. Reported by someone who was hovering over the option
they meant to pick. The question outlives the turn now: the card stays where it is, and answering it
a minute later works, starting a new turn with the question quoted above your answer, exactly as it
reads when you answer mid-turn. It closes when you move on — the next message you send that is not
an answer — and the question and its options stay in the transcript as the record of what was
offered.

A click that crossed the turn boundary used to be refused, and the option you chose was discarded.
It becomes an ordinary prompt now.

The reply that goes with such a question lists the options too. It recommended one and pointed at the
card for the rest, which was exactly what DGC asked it to do; it now restates every option with the
line that tells them apart, so the choice survives in a reopened session where no card is drawn.

The note DGC leaves for the model when a question goes unanswered no longer says you did not answer
it. That note rides in front of your next message, and your next message is very often the answer,
typed into the box because the card had gone.

### A sub-agent is told what its checkout does not have

A delegated sub-agent works in its own Git worktree, which holds tracked files only — so the
project's ignored dependency and build directories are simply not there. It used to find out by
running the project's own command and reading the failure. It is now told, before it runs anything,
which directories are missing and that it should install what it needs inside its own checkout.

`subagent_link_paths` (empty by default) shares named Git-ignored directories with sub-agents
instead, for a project where that install is expensive enough to trade the isolation for it. Only
ignored paths can be shared.

### A per-turn cost cap, counted in tokens

`turn_token_budget` (0 by default, meaning no cap) bounds what one turn spends, including every
sub-agent it starts, however deep and whether or not it is still running in the background. A
sub-agent that outlives the turn that started it is charged to that turn, not to whichever turn is
running when it finally reports. At 70% and 85% the model is told to converge; past 100% no new
sub-task is started and the turn stops asking for model output. Nothing is rolled back: unlike the
wall-clock limit, the tokens are already spent and the edits they bought are on disk.

### `/tasks` shows work a sub-agent's own sub-agent left behind

When a sub-agent delegated again and that grandchild's work was retained, its checkout and its
branch were created in your repository but `/tasks` showed nothing — and once the parent's checkout
was cleaned up, which is how a delegation normally ends, there was no way to see the work, apply it
or delete it. Such work is now listed against the repository that owns the branch, for reading and
for dropping.

### With the sandbox on, a sub-agent can run git again (Linux)

A task worktree's `.git` is a pointer into your repository, and the sandbox masks your home — so
every git command in a delegated sub-agent failed with "not a git repository". The repository
directory is re-exposed read-only, and `.git` only: the ignored files its worktree deliberately does
not have stay out of reach, and so does your own uncommitted work. It follows that a sandboxed
sub-agent cannot commit, which is intended — DGC integrates a sub-task by reading its working tree.

**Correction, 2026-09-30: this shipped as Linux-only and was not said so at the time.** The `.git`
re-exposure is in both sandbox backends and works in both, but on macOS a sandboxed sub-agent still
cannot run git, for a different reason found after release. `bwrap` masks the home with a tmpfs, so
everything under it is *absent* and git treats a missing global config — and a missing parent — as
"nothing configured". `sandbox-exec` *denies* them instead, and git treats the resulting
`Operation not permitted` as fatal before it ever reaches the repository. Absent is fine; forbidden
is fatal: git cannot walk up to its own checkout, because the worktree sits inside the denied home.
The symptom is `fatal: Invalid path '/Users/<you>': Operation not permitted`, usually preceded by
`git: error: couldn't create cache file '/var/folders/.../xcrun_db-...'` from Apple's xcrun shim.
The sandbox is off by default, so this affects a macOS user who has turned it on and delegates to a
sub-agent. Tracked for a fix in its own release.

### Delegation is refused where two tracked paths are one file on disk

On a case-insensitive filesystem (macOS and Windows by default), a project tracking both `README.md`
and `readme.md` has one file. An isolated checkout reports them as changed before anything touches
them, and integrating its result would write one file's content over the other's. DGC names both
paths and suggests `git mv` rather than losing one.

## 0.46.1 — 2026-09-28

### On macOS, signing in to a remote MCP server could open a browser before you were asked

DGC replaces the environment's `BROWSER` with a no-op binary while the `mcp-remote` bridge starts,
so the bridge cannot open a sign-in page on its own; the editor or the CLI opens that URL only
after you agree to it. The replacement was the literal `/bin/true`, and macOS does not ship one --
`true` lives in `/usr/bin` there. So on macOS the guard returned the environment untouched and
your own opener was handed to the bridge. It failed silently, because returning the environment
unchanged is also how the guard opts out on a platform it does not support. It now uses the first
no-op executable the system actually has. Linux is unchanged.

## 0.46.0 — 2026-09-28

0.45.0 was built and tested on one machine and never published. Auditing that build found 27
defects, and a first real session with it found twelve more; those fixes and this release's new
work are all here, under one version number.

### Sub-agents you can watch, and a fan-out that happens where you put it

- **The model can now ask what its background children are doing.** A foreground `task` blocks
  until the child finishes and a `background: true` one returns at once, but between the two the
  model was blind: it had started something detached and had no way to ask about it. `list_tasks`
  reports every sub-agent of the chat -- id, state, how long it has run, its tool count, a finished
  one's summary, and which results nobody has read -- and `wait_tasks` blocks for a background
  child's full result, the same text a foreground call would have returned. Both are read-only, and
  neither is offered unless there is something to act on, so a pointless wait is not expressible.
  A wait ends early when you say something, so the model reads you before it reads the child.

  Neither name appears in `ready.tools`, and that is deliberate rather than an oversight: an already
  installed `dgc-sdk` whose `RuntimePolicy` sets `allow_tools` raises on any runtime tool its own
  table does not know, so publishing a new name there would end every such embedder's session on
  the day the CLI updated. A session whose host set that allowlist is not offered the pair at all.

- **One small edit beside four sub-agents no longer runs them one at a time.** The fan-out refused
  any batch that was not entirely `task` and `todo`, so a single `bash` call or a one-line edit next
  to four children cost the whole batch its parallelism -- about 26 minutes of one measured session.
  The children now fan out where the model put them: a run of `task` calls that ENDS the response
  goes out together, once everything before it has actually run, so the checkout they snapshot is
  the one the model described. A call placed after them keeps the batch serial, because hoisting it
  past children that are already working would be the same bug from the other side. The tool
  description and the Ultra prompt both say so, so the model can use the rule rather than discover
  it.

- **Ultra now actually runs wider.** Ultra is not a token-saving mode, and its prose already
  promised the whole range; the executor still ran four at a time. Both clamps now come from one
  function, so the width the prompt promises is the width the pool runs. A width you chose yourself
  is honoured exactly, including 1 -- the rate-limit advice tells you to lower that number, and an
  unconditional override would have made that advice a lie. The ceiling is unchanged at 8.

- **The parent can talk to a running child, and stop one.** `message_task(id, text)` puts the
  parent's words into a background child's next round; `close_task(id)` stops one and says what
  became of its work -- retained as a `/tasks` row when the child had an isolated checkout, or
  still in your files when it did not, which is the truth for a child that ran in the parent tree.
  Both read the handle Stage 1 already published, so a message that arrives before the child is
  constructed answers `delivered: false` rather than raising.

  `interrupt_task` is deliberately absent. Codex's `interrupt_agent` promises the agent "remains
  available for messages and follow-up tasks", which needs a child that survives its turn with a
  mailbox. A DGC child is one turn; when it ends its worktree is integrated or retained and the
  agent is dropped. Ours would be a synonym for `close_task` or a promise that fails.

### A held session, decided on whether a window exists

- **A reloaded window gets its session back in about two minutes, not fifteen.** This is the bug
  the founder hit twice. Reloading an editor window leaves its extension host running, and nothing
  in the editor API tells that host it was orphaned -- so it goes on saying "I am alive", truthfully
  and uselessly, on a timer. Every one of those was read as "the window is fine", which is how a
  session stayed stranded for 25 hours. The chat panel's own webview now says it is on screen every
  twenty seconds, and that is the clock a takeover is decided on: a reloaded window takes its panel
  with it and cannot fake one. An extension that knows nothing about this is judged exactly as it
  shipped, so upgrading the CLI alone changes nothing for it.

- **A refusal now says the true thing.** Asking for a session held by a window that is genuinely on
  screen used to print a countdown and promise "send this again and it will be handed over" -- for
  two minutes at a stretch, about a window you were looking at. A live panel is now refused with
  "its editor window is on screen" and no deadline. A holder that AGREED to hand over and is still
  saving used to be described with the fifteen-minute self-heal figure, which was about a backend
  ending itself; it now says it agreed and to send again in a few seconds.

- **A granted handover actually completes inside the asking window's budget.** Standing down ended
  the command read by closing the stream, which cannot work: closing a stream another thread is
  blocked reading takes the lock that reader holds, so the closer blocked too and the reader woke
  only when the next byte happened to arrive -- around 30 seconds on average against the 25 the
  asker waits. So a granted takeover usually reported a refusal anyway. The read is now interrupted
  by a signal the process sends itself, and a handover's shutdown grace is bounded by the asker's
  budget rather than exceeding it. `~/.dgc/logs/serve.log` names a handover as a handover; in
  13,417 lines of history it had never once contained that line.

- **A liveness ping is no longer treated as something you did.** Every ping told the monitor policy
  a user command had just landed, which restarts the background-wake delay. Any
  `monitor_wake_delay_s` at or above the ping interval therefore held monitor wakes off forever.

### A paste can carry instructions the person pasting it cannot see

- **Invisible characters in a draft are counted and named.** Bidirectional overrides reorder how
  text displays without changing its bytes; tag characters encode a whole line of ASCII in
  something that renders as nothing; zero-width characters pad text invisibly. DGC hands your draft
  to a model and then acts on it, so this is a way in. The editor raises a bar over the composer --
  **Remove 3 invisible characters**, and "can carry a hidden instruction" only for the two classes
  that actually can -- with **Keep** beside it. Nothing is altered unless you click Remove.
  Arabic, Persian and Hebrew directional marks, every multi-person emoji, and the three subdivision
  flags do not raise it: a notice that fires on ordinary text teaches you to dismiss it.

### Everything from the 0.45.0 build

- **`propose_options` no longer parks a turn forever.** The picker blocked with no deadline and
  nothing to reap it, because the abandonment watchdog reads a parked turn as a running one, so a
  window that vanished mid-question left the backend waiting and holding the session. The bound is
  positive evidence of abandonment -- two missed editor liveness pings -- not a clock, so a present
  user may take as long as they like. Only the editor frontend is affected; the terminal, classic
  CLI and ACP waits are unchanged.

- **A `dgc serve` shutdown test no longer depends on the machine being quiet.** It waited on the
  child without draining its stdout and stderr, so under load the child could block inside a flush
  and the wait expired. With the pipes drained, shutdown measures at 0.12s under load, and the
  test now allows about a second rather than a minute -- strictly stricter than what it replaces.

## 0.44.1 — 2026-09-24

Nine fixes. Most were found by USING 0.44.0 rather than by testing it; the last was found by the
release gate itself, and matters more than the rest.

- **A streamed API key could be published in clear.** DGC redacts credentials as they stream, and
  holds back a tail that might be the start of one so a secret split across two provider chunks is
  still caught. That hold-back looked only at the final characters, so when another known secret
  began with them the cut fell INSIDE a credential already complete in the same buffer — the
  leading part then matched nothing and went to the panel in clear. Nothing exotic triggers it: it
  needs only a few credentials in the environment, which is the normal state of a working machine.
  The cut now moves to the end of any complete secret it would split. This is a disclosure
  boundary, so it is worth being precise about the blast radius: the transcript saved to disk and
  the text sent to the provider were both redacted correctly throughout; only the stream rendered
  to the panel was affected.

- **Taking a held session back no longer means waiting fifteen minutes.** 0.44.0 judged a takeover
  request with the same threshold a backend uses to end ITSELF — 15 minutes of editor silence. So
  the case the feature exists for still failed: a window reloads after a network drop, the old
  backend keeps the session, and the new window is told "its editor window is still connected"
  because the old editor had been quiet for seconds. Handing over to a window that is asking is a
  different question from ending yourself with nobody waiting, and now has its own threshold: two
  missed 60-second pings. The refusal names the cause and tells you to send the message again.

- **A parallel sub-agent's page shows its work while it works.** Parallel children buffer their
  trace so the parent transcript can replay each one atomically instead of interleaving several;
  that is right for the parent and wrong for the child's own page, which shows one agent and sat
  empty behind a running timer for as long as the child ran. Steps now stream to that page.

- **A file chip opens when you click it.** It called `openTextDocument`, which refuses a binary
  file, and the error was swallowed as "may not exist" — so clicking a produced PNG did nothing at
  all. Also repairs clicking a binary file named in an answer.

- **File-kind marks are the icons they claim to be.** Six of the ten codepoints drew something
  else: an image drew an RSS feed, a document drew an arrow, Python drew a folder. The table had
  never rendered — a duplicate rule of equal specificity won every cascade — so its comments were
  the only description of it and they were wrong. The marks now come from Seti (MIT, the font VS
  Code ships), every codepoint read from the font's own metadata and checked by a test.

- **Go, Rust, Java, Kotlin, Swift, Ruby, PHP, C, C++ and C# have their own marks**, instead of one
  glyph shared by eleven languages. `.tsx` and `.svg` too.

- **Two delegated agents keep their places.** Each agent's row was moved to sit after its newest
  tool call, so two working agents traded places under the reader for the whole turn.

- **A produced-file chip is a chip, not a white box**, and its mark is legible on a light theme:
  three of the icon hues scored under 3:1 there and were darkened.

- **A session another window advanced now says what to do about it.** After a reload the backend
  being replaced often finishes its turn and saves, leaving the new window holding the older copy;
  the next message was refused with "Resume the latest generation or start a new session", which
  names no control a person can find and reads as "start over and lose the conversation". The turn
  still stops — an Agent whose session moved under it must fail closed rather than absorb another
  instance's history mid-turn — but it now names the resume picker, the `dgc --resume` equivalent,
  and the fact that the conversation is intact.

## 0.44.0 — 2026-09-23

- **A refusal to take a session now names who is holding it, and can ask for it back.** A window
  whose editor closed mid-turn held its session's lease indefinitely: the watchdog that ends an
  abandoned backend counts "a turn is running" as work worth keeping alive, so every new window was
  told only that "another DGC process has an active turn". DGC now consults the peer registry, says
  which window holds it and whether it is idle or working, and — when that holder is one of ours
  whose own editor has gone — asks it to stand down and takes the session. The holder always
  decides: nothing forces a lock, signals a process or deletes a lease, a terminal DGC never hands
  a session over, and the 15-minute self-heal remains the floor. A DGC running in a terminal also
  announces itself now, so it can be named instead of being invisible.

- **`show_file`: the agent shows you a file it made.** Ask for a recording, a screenshot or an
  export and it appears as a chip under the step that produced it; click it and the file opens in
  the editor. The chip carries a path rather than the file, so a 300 MB recording costs what a
  one-line report costs and never enters the model's context. At most eight per step, and
  `show_file` refuses — with a reason the agent can act on — for a path that is missing, names a
  directory, or sits outside the workspace.

- **Links wear the site's own favicon**, in prompts you type and in the agent's answers alike. The
  icon is fetched by origin only, so a URL's path and query never leave the machine; set
  `dgc.linkFavicons` to `false` to use bundled marks and make no request at all.

- **Fixed: a file named in an answer never showed its kind.** A duplicate stylesheet rule of equal
  specificity sat later in the file and won every cascade, so a `.py`, a `.sh` and a `.json` all
  drew the same grey glyph and the whole per-kind table was dead code. The classification had
  always been correct, which is why no test saw it.

- **Fixed: link text failed contrast on both themes.** The accent used for links scored 4.08:1 on
  the dark panel and 4.09:1 on the light one, under the 4.5:1 minimum for body text. Links now take
  a theme-aware tone — 6.5:1 on dark, 5.3:1 on light — and the system's own link colour under
  forced colours. The permanent underline is gone; it appears on hover and on keyboard focus.

## 0.43.4 — 2026-09-23

- **A killed DGC no longer reads as a live peer on macOS.** 0.43.3 fixed the pid-identity check
  there and missed its neighbour: `_is_zombie` also read `/proc`, which macOS does not have, so a
  process that had exited but not been reaped — which still answers `kill(pid, 0)` — was reported
  as a live peer, the exact confusion that check exists to prevent. Both now ask `ps` where there
  is no `/proc`, using the same `DGC_NO_PROCFS` convention `dgc.monitors` and `dgc.install_layout`
  already used, so the path macOS takes is exercised on every Linux test run rather than mocked.

## 0.43.3 — 2026-09-22

- **Peer awareness works on macOS.** DGC tells a live peer from a dead one by checking that the
  process behind a recorded pid is still the process that wrote the note — it read that identity
  from `/proc/<pid>/stat`, which macOS does not have. So on a Mac the read always failed, every
  peer's liveness came back `unknown`, and a note left by a dead session was indistinguishable
  from a live one's. It asks `ps` for the start time there now, with a timeout so a wedged `ps`
  cannot stall a peer check, and that child's stdin is closed rather than inherited: under
  `dgc serve` this process's stdin is the editor protocol pipe.

## 0.43.2 — 2026-09-22

- **The release pipeline is green again.** 0.43.1's own dependency-lock guard imported `tomllib`,
  which is standard library only from Python 3.11 — so on the 3.10 job it failed to import and took
  the whole suite down, replacing one CI failure with another. It reads the dependency list without
  `tomllib` now, and therefore runs on every interpreter rather than skipping on the oldest one.

## 0.43.1 — 2026-09-22

- **Installing DGC no longer leaves a broken dependency set.** `pypdf` has been a declared
  dependency since the Documents module shipped in 0.42.0, but it was never added to
  `requirements.lock` — which is what CI, the installer and the documented install path actually
  install. `python -m pip check` reported `dgc requires pypdf, which is not installed` on every
  machine that followed those instructions, and on every CI job, which is why tagged releases
  stopped getting a GitHub Release. A test now compares the lock against the project's declared
  dependencies, so a dependency can no longer be added to one and not the other.

## 0.43.0 — 2026-09-22

- **As many chats at once as you want.** The **+** beside the model name opens another chat with its own
  `dgc serve`, its own model context and its own session file, so the chat you switch away from
  keeps working. A rail above the transcript shows them all: a pulsing dot while one is mid-turn, an
  amber square when it is waiting on a decision, a count of what it has said since you last looked.
  Switching rebuilds the incoming chat from its own backend's snapshot — taken under that
  backend's turn lock, and followed by a fresh announcement of whatever approval or question it is
  blocked on — so a chat you left mid-turn comes back where it is now, not where it was. There is
  no built-in ceiling: a backend is about 9 MB and cross-chat writes are already serialised by the
  workspace write lease, so the limit is your machine and your model budget. Set `dgc.maxLiveChats`
  if you want one anyway. *DGC: Open a Second Chat* and *DGC: Switch Chat* do the same from the
  command palette.
- **Background work belongs to the chat that started it.** A `task` with `background: true` used to
  outlive `/new` and `/clear`: it kept writing files, and folded its worktree back in against
  whatever chat the agent held by then — giving a brand-new conversation a recovery point for edits
  nobody made there, and putting the previous chat's files inside the reach of the new chat's
  `/rewind`. A new chat now stops them and says how many. A child that finishes anyway integrates
  into the chat that asked for it. Switching between two open chats stops nothing.
- **A background sub-task now tells the terminal it finished.** `task` with `background: true`
  reported its result only to the editor, which has a callback for it. The terminal had none, so
  its model was told "I will continue when it finishes" and then nothing ever woke it: it either
  waited for a result that could not arrive, or reported delegated work whose outcome it had never
  seen. Results now arrive the way a background command's exit already does — the session wakes on
  them, the band reads *sub-task · woke on its result*, and the notice calls it a sub-task's report
  rather than command output. With `monitor_wake: false` nothing starts a turn on its own and the
  model is told so plainly; the result still reaches it with your next message.
- **How deep sub-agents may nest is a setting, not a turn of phrase.** Two rules disagreed about
  this. The executor enforced a hard-coded depth of 3, while the tool catalog offered a child
  `task` only when its brief happened to contain the word "delegate", "sub-agent" or "fleet" — so
  "delegate the search to a sub-agent" could nest and "split this across helpers" could not, and
  the shape of the agent tree came down to the parent's choice of words — and the hard-coded 3 was
  unreachable, because the catalog gate was the binding one. `max_subagent_depth` now decides it in
  one place, for every tool profile. It defaults to 1, which is the flat tree that actually
  shipped, and under DGC Ultra it is what stops an aggressive lead fanning out recursively. Depth
  is counted from the real parent chain, so a sub-agent cannot claim to be shallower than it is:
  past the limit `task` is withheld, and a call to it is refused naming the depth it is at and the
  setting to change. Raise it to 2 for one nested level; 0 turns delegation off.
- **A collapsed paste belongs to the chat you pasted it in.** `[Pasted text #1 +40 lines]` chips
  were shared across every chat in the fleet, so sending in one chat cleared the store another
  chat's unsent draft still pointed at — and switching back sent the model the literal placeholder,
  with the pasted text silently dropped.
- The editor's permission surface marks a rule that is not valid, instead of listing it as though
  it were in force.
- `dgc doctor`'s documented exit codes match what it returns.

## 0.42.0 — 2026-09-21

- **Attach a document.** `@path` takes a `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, `.rtf`
  or `.pdf`, and `read_file` opens one too — so the model can read a report you point it at
  instead of refusing it as binary or shelling out to unzip it. The text is extracted locally:
  nothing is uploaded, no office application is launched, no macro runs, and the file is never
  written back. What arrives is labelled as an extraction, because layout, images and embedded
  objects are not in it. PDFs use `pypdf`, which now installs with DGC.
- **A question that does not stop the turn.** A model can ask you something and carry on working
  while it waits, instead of stopping the turn to ask. Your answer reaches it mid-turn, and a
  question nobody answers is reported to the model rather than left hanging.
- **Two DGCs no longer overwrite each other's settings.** Every DGC on a machine shares
  `~/.dgc/config.json`, and a save used to write one process's whole copy of it. A model chosen in
  one window and a thinking level chosen in another both survive now. This mattered most for
  permission rules: a **deny** added in one window was erased by an unrelated settings change in
  another.
- **Images are handed over as files.** Up to 32 MB per prompt with no limit on how many, in place
  of four images and 2 MB. The old ceilings came from the size of one protocol message, not from
  anything a model cannot accept.
- **The model knows what time it is.** The time zone travels with the prompt and the clock rides
  each turn.

## 0.41.9 — 2026-09-20

- **A model that goes quiet is reported, not a traceback.** When a model opens a stream and then
  sends nothing, DGC's stall watcher closes the request and reports *No response from the model*,
  then tries again. On a chunked response — which is what real streaming endpoints send — that
  close landed inside the HTTP client while a read was still in flight, and the read raised
  `AttributeError: 'NoneType' object has no attribute 'read'` instead. The watcher's own message
  and its retry were lost behind it. Both of DGC's body readers now end the stream the way
  end-of-file ends it when the watcher is what closed it; a genuine transport fault still raises.
  Only the non-chunked reader was guarded before, so this had been reachable since the stall
  watcher shipped in 0.39.0.
- **The response style rule is documented.** 0.41.8 told the model to write plain professional
  text with no emoji or decorative symbols unless you ask for them; that reached the changelog but
  not `/docs`. It is now in **Getting started**.

## 0.41.8 — 2026-09-20

- **The model knows what time it is.** DGC told it the date and nothing else, so a model with no
  clock and no timezone wrote "what I completed tonight" in the middle of the afternoon, guessed
  at deadlines, and dated files a day out. The session prompt now carries the zone alongside the
  date — `Date: 2026-09-20 (Asia/Kolkata, UTC+05:30)`, read from this machine's own settings, with
  the offset alone or `UTC` when it records no name, and nothing looked up online. The time of day
  goes on each message you send instead: `Local time: 14:32 (Asia/Kolkata)`. Keeping it off the
  session prompt is what lets two questions a minute apart still send a byte-identical prompt, so
  the second one is still billed at cached-input rates. Sub-agents are told the same; a session
  running past midnight is told the new date on your next message; resumed chats and `/export`
  show what you typed, without it.
- **Extra high and Ultra can reason deeply.** The reasoning watchdog stopped every level after
  8,000 tokens of thinking with no answer, which is less than DGC itself asks Claude to think at
  High (16,384) or Extra high (24,576). `think_budget_tokens` now defaults to `auto`, which scales
  with the level: 8,000 tokens at Off and Low, 16,000 at Medium, 32,000 at High and 64,000 at
  Extra high and Ultra. A number still applies to every level, and `0` still turns it off. A
  stored `8000`, the old default that every config file carried, now reads as `auto`.
- **The output cap makes room for that reasoning.** Providers count reasoning against the
  output cap, so the 16,384-token `max_tokens` ended an Extra high phase long before 64,000. A
  request that asks for reasoning now sends `max_tokens` plus the level's allowance, never more
  than the model's reported output limit or half the context window (a 32K window keeps 16,384).
  Claude's legacy extended thinking gets its full Extra high budget (24,576, was 12,288).
- **Prompt words no longer change a thinking level you chose.** "think", "think hard",
  "think harder" and "ultrathink" in a prompt turn thinking on for that turn only when it is Off.
  Low through Extra high, Ultra and a sub-agent's own effort stay as set. "I think…" still turns
  on Low when thinking is Off.
- **Every tool, every turn.** DGC used to decide which tools the model could even see from the
  wording of your prompt: delegation, the background monitor, web search, image reading and the
  rest appeared only when a pattern matched. A request phrased another way was answered "that tool
  does not exist" — the same failure behind the missing options picker and the missing watcher
  below. The default `tool_profile` is now `standard`: every product tool is offered on every
  request and the model chooses, while a tool with nothing to act on (no skills installed, no
  background process, no active goal) still stays out. That is about 3,300 tokens of schema, which
  providers cache between turns. The old catalog remains as `tool_profile: adaptive` for a small
  local context window (about 1,500 tokens), chosen with `/set tool_profile adaptive` or in the
  editor's settings and kept from then on. Upgrading rewrites a stored `adaptive` once, because
  every config carried it as the old default rather than as a choice.
- **The options picker survives a typo.** In full-auto, DGC only kept `propose_options` in the
  model's tools when it recognised the exact words of an ask, so "propse options … so i can select"
  removed the picker and the model wrote the choices in chat instead. Any mention of choosing,
  addressed to you, now keeps the tool available; the model still decides whether to ask, and a
  full-auto run whose prompt never mentions a choice still never stops to ask.
- **No emoji in answers.** Models are told to write plain professional text, with no emoji or
  decorative symbols in headings, lists or status marks, unless you ask for them or the file
  already uses them, so an option label is plain text and the picker marks its own recommendation.
- **Web search keeps working when DuckDuckGo blocks one door.** The keyless default now tries
  three ways in order: the `ddgs` client DGC now ships with (it presents itself as a browser, so
  it is not refused the way a plain scrape is), then DuckDuckGo's HTML endpoint, then its lite
  endpoint. An error now names what failed and what to switch to. DGC's install grows by about
  27 MB for it, and its two binary components are listed in the release SBOM.
- **"Set a watcher" now reaches the watcher.** `monitor` is DGC's background watch: every line the
  watched command prints reaches the model between tool calls and wakes it when the turn has
  ended. It was only offered for a few phrasings, so "set a watcher", "poll it", "check back every
  30 minutes" and "wake up when it ends" left the model writing shell scripts that could log
  progress but never wake it. Those phrasings are recognised now, the tool explains how to check
  on something every few minutes, and models are told to start a long job detached instead of
  holding a turn open in sleep loops.

## 0.41.7 — 2026-09-19

Editor protocol remains v14. Pair with extension 0.26.7 and dgc-sdk 0.5.3.

- **0.41.6, released.** The v0.41.6 tag's macOS test jobs failed (two paths spelled `/var` against
  `/private/var`), so no GitHub Release was made for it and it never reached vibedgc.com. 0.41.7
  is that release with the fix: a screenshot handed to a vision model is named relative to the
  project on macOS too. Everything listed under 0.41.6 below ships in 0.41.7.

## 0.41.6 — 2026-09-19 (tagged, not released)

Editor protocol remains v14. Pair with extension 0.26.7 and dgc-sdk 0.5.3.

### For everyone

- **Ultra delegates where it saves time.** Measured on six realistic multi-part tasks: the parts
  of a task that change different files now go to sub-agents together in one parallel batch, and
  the lead does single-part work itself; a critic runs when you ask for a review or no test can
  check the change. (Splitting everything and always adding a critic was 2-6x slower at the same
  quality.) Sub-agents stay one level deep, briefs carry project-relative paths, the roster lists
  your own named agents, and a `todo` update beside the `task` calls no longer serialises the batch.
- **Sub-agents get their own context window.** `subagent_context_size` (0 uses the main window), a
  named agent's `context_size:` frontmatter, `/subagent context 64k`, and Settings → Agents.
- **The sub-agent route can change mid-turn**, as the main model can: model, host, transport, key
  and window apply from the next sub-agent.
- **Changing the model mid-turn no longer hangs.** A request that had not started answering is sent
  again to the new model at once, instead of waiting out the old one (up to 15 minutes on Ollama
  Cloud, which DGC also mistook for a model still loading).
- **Thinking levels reach the model.** On Ollama, Low, Medium and High are sent as those levels and
  Extra high as `max` (they all used to be plain "think on"); a level changed mid-turn applies from
  the next request; GLM-5's Off no longer leaks its reasoning into the answer.
- **Eyes for a model without vision.** When the chat's model cannot see images, an attached or
  produced image is shown to a vision-capable model (the sub-agent model, or a named agent with
  vision) and its report goes to the chat's model. The card names the model that looked.
- **Parallel sub-agents no longer lose work to shared caches.** `__pycache__`, `*.pyc` and test
  runner caches are not counted as a child's changes.
- **`repo_map` sees plain job folders.** A workspace that is not a git repository and holds only
  notes, CSV or other text files is no longer reported as 0 files. The map is rebuilt from disk on
  every call, so files added during a session show up the next time the agent maps the folder.
- **The sandbox also hides your real home directory.** With the OS sandbox on, shell commands
  could not read `$HOME`; they now also cannot read the account's home directory when `HOME`
  points somewhere else (as it does for SDK sessions), nor the SDK client's whole state directory
  (audit and usage logs, not just its isolated home).
- **The sandbox is checked, not assumed.** DGC now verifies that bubblewrap actually confines
  (unprivileged user namespaces can be disabled, or the binary can be too old) before reporting a
  sandbox available, so a "required" sandbox cannot pass on a host where every `bwrap` invocation
  fails.
- **Provider keys stay out of tool subprocesses.** DGC no longer hands `DGC_API_KEY` (or the
  other `DGC_*_API_KEY` values it consumes) to the environment of a `bash`, `python`, `monitor`
  or hook subprocess, in any mode, so `printf %s "$DGC_API_KEY" | rev` in an unsandboxed shell no
  longer recovers the key. The model client still uses it.
- **Release builds are green again.** The v0.41.4 and v0.41.5 tag builds failed (an SDK socket
  path too long on macOS, and the extension's tests), so those versions have no GitHub Release.
  Both causes are fixed for 0.41.6. Every GitHub Action in the release, CI and CodeQL workflows
  is pinned to a commit.

### For applications that embed DGC (dgc-sdk 0.5.3 needs these)

- **Session policy.** `dgc serve` accepts a per-process policy from the program that starts it,
  in the `DGC_SESSION_POLICY` environment variable: deny and ask rules, auto-mode-only denies, and
  sandbox settings. The rules hold in every permission mode, `auto` included, cannot be removed by
  a command or a mode switch, and are never written to any config file. A policy that does not
  parse denies every tool. The `ready` handshake reports the policy it read
  (`capabilities.session_policy`), so the launcher can confirm it took effect.
- **Unattended shell only in the sandbox.** A session policy can require that, in `auto` mode,
  `bash` and `monitor` run only inside the OS sandbox and that the `python` tool (which is never
  sandboxed) is refused. In the other modes each shell command stays a permission request.
- **Workspace rules cannot pre-approve commands for an SDK policy.** When the launcher's policy
  says so (`project_allow: false`), the workspace's own `.dgc/permissions.json` may add ask and
  deny rules but its allow rules are not loaded — and neither are the user's own stored allow
  rules — so a cloned repository, or an inherited `~/.dgc`, cannot approve its own shell commands.
- **Workspace agent definitions are gated too.** A new `project_agents: false` in the session
  policy stops `dgc serve` from loading a workspace's `.dgc/agents/*.md`, which can choose a model
  endpoint and a credential env var. When the launcher does allow them, a project definition
  contributes only its persona: its `base_url`, `api_key_env`, `api_mode` and `model` are dropped,
  and no agent definition (project or personal) may read a `DGC_*_API_KEY`.
- **Searches respect denied paths.** A session policy's ask on search tools reaches the launcher
  in `plan` mode too, so a search over a tree that contains a denied path can be refused; the
  refusal is attributed to the application's policy, not to the user.
- **A launcher can hand a key through a file.** `dgc serve` reads a provider key from
  `DGC_<NAME>_API_KEY_FILE` (a 0600 file) and deletes the file before any tool runs, so the key
  never sits in the child's environment block.
