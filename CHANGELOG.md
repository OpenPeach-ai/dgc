# DGC CLI changelog

Release notes for the `dgc` command-line tool and `dgc serve`. The VS Code extension has its own
[changelog](editors/vscode/CHANGELOG.md), and so does the SDK ([sdk/CHANGELOG.md](sdk/CHANGELOG.md)).
Earlier releases are listed at <https://vibedgc.com/changelog>.

## Unreleased

- **Your app's code keeps its Pips (Pips API 64).** An app that uses DGC's SDK can declare its Personal Pips in code,
  each a template: a name and instructions, a model, how much it asks, the app's tools it may use, its routines (on a
  schedule or on the app's events) and the changes it may run without asking. On each deploy, `ensure_pip_template`
  (the SDK's `pips.ensure_all`) makes a Pip that doesn't exist yet and brings the others up to date, and answers what
  it did: `created`, `applied`, `waiting`, `unchanged`, the same template twice answering `unchanged`. Changes that
  only narrow or reword a Pip apply by themselves (its text and model, a tool, routine or Always allow taken away, a
  lower level, a routine's time). Anything that would let it do more (a new change tool, its own computer, a higher
  level, a new Always allow, a routine on the app's event) waits as one change on the Pip's page for a person to accept,
  unless the app passes `accept_widening`, and so takes responsibility for it. A tool that moves money is never allowed
  without asking this way. What a person changed on the Pip in DGC is kept and reported as a conflict, unless the app
  passes `overwrite_user_changes`; a paused or archived Pip stays so. `prune_pip_templates` pauses, never deletes, the
  Pips the app no longer declares. A Pip made from a template uses only the app tools its template lists; every other
  Pip keeps every registered app, as before. On a server, a template's Pip never runs on a personal Claude Code or
  Codex plan. An older DGC still opens your Pips.

- **Pips on a server.** Your app and DGC's Pips can now run on a server with no VS Code and no desktop.
  `dgc pips serve --server` is the runner without the desktop: no desktop notifications, no borrowing a signed-in
  Chrome, and one plain line per event on stdout for `docker logs` and journald (`runner_started`, each run queued,
  started, succeeded or failed with its reason, `runner_stopped`). `dgc pips service install --server` writes the same
  as this home's systemd unit; Keep Pips running keeps a server unit as it is. On a server, Pips run on an API key or
  a self-hosted model only: a Pip on your Claude Code or Codex plan is refused, its run marked with words that say why
  and how to change it, and its model is never switched by itself. `dgc pips health` exits 0 when the runner is online
  and running, and 1 with one line saying why when it isn't (Pips off, Pips stopped, no runner, a stale heartbeat, or
  state it can't read); `--json` gives the same for probes. It only reads, so every 10 seconds is fine. A second runner
  on the same home is refused, as before, and now says so on one line. `deploy/docker` has an image recipe (Debian
  slim, Python 3.12, DGC from its release archive at a pinned version, the Python SDK, the DGC home on a `/data`
  volume, `dgc pips health` as its health check) and `with-pips`, which runs your app with the runner beside it. In a
  container, Pip computers and Pulse and Patch commands now say that the container's options keep bubblewrap from
  running, instead of suggesting an Ubuntu fix.

- **Your app's events start your Pips (Pips API 63).** A Personal Pip's routine can now run when your own app sends an
  event: "when the shop app sends order.created, check the order and propose a dispatch". Add it in the Pip's
  Settings (Routines, When my app sends an event), accept the Pip's suggestion in its chat, or add it through the SDK.
  Your app's code sends the event with `trigger_app_event` (the SDK's `pips.trigger`), which needs no approval because
  it only runs routines a person already added and gives a Pip nothing new. DGC runs each event once per
  `idempotency_key` (the same order sent twice runs once, and the answer says so), queues a run of every routine
  waiting on it across your Pips, and answers, Pip by Pip, which it queued, which is busy and keeps it for its next
  check, and which is paused and won't run it; with Pips off on this computer, they run when it is back. The payload,
  JSON of at most 32 KB, reaches the Pip as untrusted data in the routine's turn, never instructions. At most 60
  events a minute per app (more are refused and queue nothing), and a Pip keeps at most 20 waiting: it says in its chat
  if it dropped older ones. `list_app_events` shows what an app sent lately. An older DGC still opens your Pips.

- **Your app hears what waits for it, and can decide it (Pips API 62).** When a Pip's change in your own app waits for
  a person, DGC tells the app at its own address, signed as its tool calls are: `approval_requested`, with the change,
  its digest, the Pip, the run, a one-line summary, when it expires and whether it moves money. The app's admin screen
  can show it, and a person there can accept or reject it through the SDK (`decide_app_approval`; what waits is
  `list_app_approvals`). DGC's own Allow card still shows it, and whichever answers first wins, once: the other side
  sees what was decided, and the change is called once and never again. When a change is accepted, rejected or
  expires, wherever that happened, the app hears `approval_resolved` and by whom: DGC, the app, the Pip's Always allow
  or its level. Decided in the app, the card in the Pip's chat settles with what the app decided; Edit in DGC
  withdraws the app's copy and runs the edited change; Don't rejects it for both. DGC's runner sends these with a
  first try and up to three more (5 seconds, 30 seconds and 2 minutes after a failure), records every try on the
  action, and never lets a failed delivery hold up or reject anything. A change that moves money still asks a person
  every time and never gets Always allow.

- **Pips for your own app: its tools become a Pip's (Pips API 61).** A developer whose business app uses DGC's SDK
  registers it once (`register_app`, an approved SDK call): a name, the address DGC calls it at, and its tools, each
  a name, a description, a JSON schema and a kind, read or change (and whether a change moves money). DGC makes a
  signing secret and gives it once, to the code that registered the app; DGC keeps its own copy where it keeps a
  plugin's key (the system keychain, or a file only you can read), never in a note, a log, a Pip's prompt or a run's
  record. The app is then one more connection, `app:<name>`, beside your connected apps, workflow connectors and
  plugins, and every rule they follow holds: a Personal Pip uses a read tool freely, or as an exact read you approve
  before each run (an `app_plan`); a change is a proposal, an Allow card you accept once (or Always allow for that
  Pip), sent exactly once and never retried, with a receipt; a tool that moves money asks every time, at every level.
  DGC POSTs each call to the app's address, signed (a timestamp, a nonce and an HMAC-SHA256 signature), waits 15
  seconds for a read and 30 for a change, reads at most 256 KB of JSON, checks TLS, follows no redirect and uses no
  proxy for this computer. What the app answers is data to the Pip, never instructions, and a failure reaches the run
  in plain words: "the shop app didn't answer", "the shop app said: ...". `update_app` replaces an app's tools:
  removing tools applies at once, anything that widens what Pips may do (a new tool, a changed one, a new address)
  waits until `accept_app_update`; `list_apps`, `remove_app` and `rotate_app_secret` complete the set. All of them work
  only on this computer.

- **Live-data Pips and Troupe checkers' shell work on a Mac.** They used to need Linux with bubblewrap, so on a Mac a
  live-data Pip said its commands couldn't run and a verifier had no shell. A Mac now has the same read-only box,
  built with Apple's `sandbox-exec`: commands write nothing but a private temporary folder of their own (`$TMPDIR`,
  removed after the run), can't read your home, the shared temporary folders or the project's credential files, reach
  no network but the local ports the lines name and the project's read-only database (which a line reaches directly
  as `$DGC_READONLY_DATABASE_URL`), and can't use the Keychain (no stored password, no prompt on your screen), the
  clipboard, Apple Events, Spotlight or another app, start launchd jobs, or signal programs outside the box. It is a
  little weaker than Linux's, and the Pip's card says so once: a command can see which other programs are running
  (not touch them), and Apple marks `sandbox-exec` as deprecated. Whatever a live-data line leaves running is stopped
  after it; here-documents fail there (macOS's bash writes them to `/var/tmp`). `dgc doctor` on a Mac has one row
  for the box. Linux is unchanged.

- **`dgc pips export-run` and `dgc pips capacity` work on a Mac.** Both refused there ("requires Linux procfs"):
  they read Pips' database read-only through its folder, pinned link by link, and only Linux could open a file
  through such a folder. On a Mac DGC opens the path macOS gives for that folder and checks afterwards that it is
  still the same folder and database, so a Quill draft or a Personal result can be saved as Markdown from the
  terminal there too.

- **A ChatDGC reply keeps running through a window reload.** ChatDGC rides on the Sessions home's `dgc serve`, which
  used to end with its window and stop the reply. For an editor that asks for it, that backend now keeps running
  while a ChatDGC reply (or deep research) is being written: a reload, a closed window or a dropped connection
  leaves the reply going, and the window that comes back gets the same backend, with the reply finished or still
  streaming and every part of it shown once. The same rules as a session: with no window it saves and stops by
  itself 2 minutes after the reply finishes, and after 12 hours at most; a reply still running in an older DGC after
  an update is saved where it is and stopped (its Continue is there). With no ChatDGC reply running, the home's
  backend ends with its window exactly as before: the Pips views, the Sessions list and Settings change nothing.
- **A chat opened mid-reply shows the reply so far.** Opening a chat while its reply is still being written (again
  in a tab, or in a window that reloaded) used to show only what came after; it now opens with everything the
  reply has written, its question cards, pictures, cards and files, and deep research's progress, and goes on from
  there.
- **Open here for a ChatDGC chat: one window writes to a chat at a time.** Two windows (two folders) could open the
  same chat and both send in it, and one save could overwrite the other's message. A chat open in another window now
  shows read-only there, as it was last saved, under the bar Work sessions use ("This chat is open in another
  window") with **Open here**. Open here moves that one chat, never the window's DGC, which also carries its Pips,
  Sessions and Settings: an idle chat opens here from disk, and the other window goes read-only with an Open here of
  its own; mid-reply, the reply carries on where it is being written and streams here from the reply so far, every
  part once, and when it ends the chat is this window's own (a message typed meanwhile goes then). A chat the other
  window closes becomes this window's by itself. While read-only, nothing that would change the chat looks usable
  (the box's controls, a card's choices, Edit, Try again, Continue), and a Work session open in another window gets the
  same; Copy, Read aloud, links and files stay. **Settings → Running sessions** gives a chat a closed window left
  answering an **Open**, which shows it live here the same way. With an older CLI, or another window's DGC that
  doesn't offer it, a chat opens as before.
- **Only one window has a ChatDGC chat, even at the same instant.** Two windows that opened the same chat, or pressed
  Open here on it, within a moment of each other could both take it and both write to it. Each window's DGC now
  holds a chat with a lock of its own (under `~/.dgc/chat/held/`), so exactly one has it: the other shows it
  read-only with Open here, and of two Open heres pressed together one wins and the other stays read-only and says
  so. A DGC that exits or is killed lets go of its chats at once, so another window can take one straight away.
  Where no lock can be made (a home folder on a filesystem without file locks), chats behave as before and
  `serve.log` says so once.
- **`dgc ps` names the ChatDGC chats a backend is answering** (`chat "…"  (answering)`), and `--json` rows carry
  `chats` and `scope`.
- Editor protocol (opt-in, old clients unchanged): command `set_detach_chatdgc {keep_running}`, offered as
  `ready.capabilities.detach.chatdgc`, opts the Sessions home's backend in with only ChatDGC's replies counting as
  work; `live_sessions` items say `scope` and `chats` (`[{conversation_id, title}]`). A client that never sends it
  gets exactly the old behaviour.
- Editor protocol (opt-in, old clients unchanged): commands `chatdgc_shown {conversation_ids}` (the chats a window's
  tabs show) and `chatdgc_open_here {request_id, conversation_id}`, and the event `chatdgc_held {conversation_id,
  state: here | elsewhere | moved, pid?, request_id?}`, offered as `ready.capabilities.detach.chatdgc_open_here`. A
  process's note names the chats it holds; another asks it for one over its owner-only socket. Until a window sends
  `chatdgc_shown` its process holds nothing, as before.

- **A Pip for live data.** A project Pulse can now keep an eye on live data instead of running tests: its job is a
  short list of exact read-only command lines you approve (up to six), such as a `SELECT` through a read-only
  database account, `df -h .` or `curl -s http://127.0.0.1:8000/health`. DGC runs only those exact lines, on its
  schedule or when you choose Run now, and its model writes two or three sentences about what they printed. It
  replaces the watcher scripts and polling loops a model would otherwise improvise: nothing it runs can change
  anything, and fixing stays your call in the chat.
  - **Only the approved lines run.** DGC runs each approved line once a run, in order, and refuses any other; the
    run stops if the job changed after it was queued. Changing the list is a reviewed job change, like any other.
  - **A read-only box.** The lines run in the project folder as it is now (not a committed copy), in the same box a
    Troupe checker's shell uses: the computer's files read only, the project's credential files hidden, a private
    `/tmp`, and no network but the local addresses the lines name (`localhost:PORT`) and the project's read-only
    database, which a line reaches as `$DGC_READONLY_DATABASE_URL` (`dgc readonly-db guide` shows how to make the
    account). Linux with bubblewrap, or a Mac (below); elsewhere the Pip says why it can't run.
  - **A safety net for writes.** A line with an obvious write is refused when it is approved and again before it
    runs: a redirection into a file, `rm`, `mv`, `tee`, `sed -i`, `git push`, `systemctl restart`, SQL that changes
    data (`INSERT`, `UPDATE`, `DELETE`, `DROP`, ...), `curl -X POST` or a request body, `$(...)`, `bash -c`,
    `sudo`, a service off this computer, or a password in the line. The approved list is the guarantee; the net
    catches the obvious ones.
  - **A grounded summary.** The model reads each line's output (up to 4 KB, credentials redacted) as data, never as
    instructions, and says whether something needs you. Every number it writes must appear in that output; a summary
    with one that doesn't is asked for once more, then left out, and DGC says what ran in its own words. A model that
    can't answer never fails the run.
  - **It speaks in its chat and reaches the Work chat.** The summary posts in the Pip's own chat, and all-clear runs
    fold into one message. A run that needs you is a report card in the chats it reports to ("needs you"), with Ask
    DGC to fix, which fixes the cause in a copy of the project and never touches live data or services.
  - Set it up from the chat ("check the orders database and the health endpoint every hour"; the chat's
    `pips_setup` takes `work_kind` `live_data` and a `live_plan`), in the Pips view (a Pulse's Plan & schedule:
    **Read-only commands on live data**), or with `dgc pips propose PIP --live-command LINE ...`. `dgc pips report`
    shows each line and what it printed, and the main chat reads a run with `pips_context`.
  - Pips API 60: `live_plan` on a Pip and in `changes`, run kind `live`, run posts of kind `live` with outcomes
    `live_clear` and `live_attention`, and the same outcomes on a `pip_report` card. No editor event gained a field.

- **The final answer is told why it must stand alone.** The Work prompt now says the one-line updates and tool calls
  may fold away once the answer arrives (the editor folds them into its "Worked for" row), so the answer has to carry
  everything you need from them.

- **Ctrl+C in `dgc setup` just cancels it.** It printed a Python traceback; now it says "Setup cancelled" and
  exits with status 130.

- **A long-running DGC no longer collects open files.** Each chat opened and closed in an editor window kept the
  project's notes database open until DGC exited: one more open file per chat, all day. Closing a chat lets it go.
  The notes store also works from every thread now: a note written from another thread than the one that opened
  it was dropped without a word.

- **A Pip's "Routine added" card goes away.** A routine the Pip suggested and you added showed "Routine added" in its
  chat for a while, but an email or calendar routine, checked every few minutes, kept it there for good: each check
  counted as a change to the routine. Checks no longer do.

- **`dgc -p` says why it is waiting on a silent pipe.** `-p` reads what is piped in to its end, as before. Over
  ssh with no terminal, through `wsl.exe` over ssh, or in some CI steps, stdin is a pipe nobody writes to or closes,
  and `-p` waited with no word. After three seconds of silence it now says once, on stderr, that it is waiting for
  piped input, and to run with `< /dev/null` if there is none.

- **"Worked for 43s" in the terminal.** A finished turn that used tools says `· Worked for 43s · 5 tools` above its
  answer, the editor's words for the same moment; the steps stay on screen above it. A reply with no tools, and a
  turn that was stopped, failed or paused, still ends with `· done · 3s` under it. `dgc --classic` keeps its line
  under the turn: it prints into your scrollback, and can't put a line above an answer it has already printed.

- **Ask DGC to fix runs in the background.** On a Pip report's card it starts a helper in the chat's own session,
  with no turn and no message from you, so the chat stays free while it works (`start_pip_fix`). It reads the whole
  report (every finding with its evidence), fixes what is real in a copy of the project and runs the project's tests
  there when it can; it never changes live data or services. When it finishes, its changes are applied as any
  helper's are: a file you changed on the same lines meanwhile is held back, a file with uncommitted work of yours is
  fixed on top of it, and every file it writes is recorded first, so Undo puts it back while it still holds what the
  fix left (a file you changed since is kept). Whether the tests ran is the helper's own word,
  and a helper that ran no command is never believed to have run them.
  - **One fix copy per project**, kept between fixes and brought up to date with the project (its commit and your
    uncommitted changes) before each one. Dependencies are installed in it once with the project's own install command
    (`npm ci`, `pnpm install`, `uv sync`, `poetry install` and others, by lock file), and again only when a lock file
    changes; the install follows your permission rules like any command. Fixes run one at a time per project, and
    another one waits its turn. A Git-ignored file a test needs (a `.env`) is asked for only then
    (`request_project_file`), copied, never linked, and copied into later fixes of that project. A copy unused for
    14 days is removed; `dgc doctor` lists the copies and their size.
  - Editor protocol: commands `start_pip_fix`, `undo_pip_fix`, `list_pip_fixes` and `get_pip_fix_change`, events
    `pip_fix`, `pip_fixes` and `pip_fix_change`, offered as `ready.capabilities.pip_fix`; a replayed report card
    carries its latest fix as `report.fix`. No existing event gained a field.

- **Every prompt of a session, for the editor's prompt rail.** `get_outline` (offered as
  `ready.capabilities.outline`) answers with `outline`: every prompt of the session, oldest first, with its first
  words (or "Image" when it is only an image) and when it was sent. The ones compaction folded away come first, then
  each one the session still holds, under the turn id its history snapshot gives it, so an editor knows which it
  already shows. A long session opens on its latest messages and its snapshot keeps only what one payload carries; the
  outline lists them all. Editor protocol: a new command and a new event; no existing event changed.

- **A command's output is a diff only when it has a diff's shape.** A script that printed section headers such as
  `--- dispatch:` was taken for a diff: its output was hidden behind an empty diff, and the editor listed each
  header as an edited file. A diff now needs its `---` and `+++` lines and a hunk.

- **vLLM, SGLang and llama.cpp: DGC uses the window the server was started with.** These servers set the context
  window when they start (vLLM `--max-model-len`, SGLang `--context-length`, llama.cpp `-c`), and DGC never read it:
  against an 8K server it planned for 32K, so a long turn overflowed, compacted and retried; against a 128K server it
  compacted at a quarter of what the server holds. DGC now reads the window from the server itself (vLLM and SGLang
  list `max_model_len`, llama.cpp `n_ctx`; an older `llama-server` says it in `/props`) and uses it from the first
  turn. A model you have not chosen a window for gets the server's whole window; a window set above it can't apply;
  a smaller one of your own only makes DGC compact sooner. A restart with another size is seen within a minute, and
  the server's own word beats a limit an earlier refusal taught. Any other OpenAI-compatible server on this computer
  or network is asked the same way, so vLLM on a port of its own is found too. The question is bounded and never
  holds up a chat; a server that doesn't answer leaves the window to DGC, as before. `/context` says "set by the
  server" and how to change it. Prompt caching on these servers stays the server's own, and `/think` works as before.
- Editor protocol (opt-in, old clients unchanged): `ready.capabilities.server_window`; command `server_window`; event
  `server_window` (`model`, `window`, `server`, `trained`), answered once and then sent as it changes. A client that
  never asks never gets one.

- **A session keeps running through a window reload.** For an editor that asks for it, `dgc serve` no longer
  ends with its window: a reload, a closed window or a dropped connection leaves the work running, and the next
  window picks the session up where it is, with nothing lost and nothing shown twice (the running reply, the
  question it waits on with the same id, the queue, sub-agents and watchers). With no window it saves and stops by
  itself: 2 minutes after its work finishes, after 1 hour waiting on an answer (reopening offers Continue), and
  after 12 hours at most. A session shown in another window is never taken from it on its own. A session still
  running in an older DGC after an update is saved, stopped and opened in the new one. A window is reached through
  a socket only your user can open (0700 directory, 0600 socket, the peer's user checked), never a network port;
  Linux and macOS.
- **`dgc ps` and `dgc stop`.** `dgc ps [--json]` lists every DGC on this computer: each window's backend, one
  running with no window and for how long, a terminal DGC, with what it is doing and its sessions. `dgc stop
  PID|SESSION|--windowless` saves and stops one (`--force` if it will not).
- **A window that stopped answering no longer holds its session.** An editor left running by a reload kept
  pinging, so its backend kept the session for as long as that editor lived (once for 25 hours). With an editor
  that keeps work running, 15 minutes with no word from the window's chat panel now leaves the session running
  as if it had no window, under the rules above; and a backend running work never stands down mid-turn when
  another DGC asks for its session.
- Editor protocol (opt-in, old clients unchanged): `ready.capabilities.detach` (`version`, `idle_exit_s`,
  `waiting_exit_s`, `max_windowless_s`, and `elsewhere` when the session asked for is shown in another window);
  `ready.capabilities.attached` on a window that reattached; commands `set_detach`, `detach`,
  `list_live_sessions` and `stop_live_session`; events `session_live`, `session_moved`, `live_sessions` and
  `turn_interrupted`. A client that never sends `set_detach` (an older editor, the SDK, ACP) gets exactly the old
  behaviour, and an SDK session is never offered `detach`.

- **Claude models read the conversation from Anthropic's prompt cache.** DGC sent Anthropic no cache marker, so
  every reply paid full price for the whole conversation again. Each request now marks where its cached part ends
  (the tool list, the system prompt, the newest message and the previous request's end), as Anthropic documents,
  and the next reply reads all of that from the cache at a tenth of the price or less. The new `prompt_cache_ttl`
  setting is how long the cache lasts: `5m` (the default) or `1h` (each write costs more; for replies usually more
  than five minutes apart). `prompt_cache: false` turns it off. An Anthropic-compatible server that refuses the
  marker gets the request again without it. ChatDGC and Pips get the same saving.
- **Every request starts the way the last one did, so caches keep working.** What one message asked for
  used to change the start of the request: asking to see a page added the page instructions to the system
  prompt and the next message took them out again, "edit only this file" removed two lines near the top, a
  cleared checklist or an approved plan switched a section on and off, and a large MCP catalog was cut
  afresh to each message's words. Each change made the provider (and a local Ollama) read the whole
  conversation again at full price. In a real five-message chat on `deepseek-v4.1-flash:cloud`, 62% of the
  prompt came from the cache before and 97% after; on a local `qwen2.5:14b` two of the messages took about 4
  seconds to re-read the conversation before, and none do after. That guidance now rides on the message
  itself, in a `<dgc-turn-notes>` block before its clock line (hidden in history and `/export`), and an MCP
  tool offered once in a chat stays offered while its budget lasts.
- **A clock for the prompt cache, in the editor's Work chat.** `dgc serve` sends a new `cache_clock` event:
  `warm` with when the cache runs out, `cold` with why (expired, compacted, or Ollama unloaded the model), or
  `unknown`. It is sent only where the provider says so itself: an Anthropic reply's own cache report and the
  lifetime its write used, counted from the start of the request, and a local Ollama's own unload time for the
  loaded model (`/api/ps`, looked at again while it runs, so an early unload shows). OpenAI, DeepSeek, Ollama
  cloud models and subscription CLIs stay `unknown`. A saved chat keeps its clock, and reopening one sends it
  with `resumed: true`. A compaction, a new chat or another model resets it.
- **The context window follows the model.** The window you choose is remembered for each model, so switching to
  another model and back restores your 1M instead of the other model's guess. A cloud model you haven't set a window
  for starts at a moderate one, its family's usual window and at least 128K (no longer the 64K DGC guessed from the
  name "deepseek"), never above the maximum the model reports; that maximum (an Ollama cloud model's 1M,
  Anthropic's) is one choice away in the context meter, because a bigger window means more input on every turn. The
  name-based guess is kept for models on your own machine, where a big window costs memory. When a provider
  refuses a request as too long and names its limit ("maximum context length is 262144"), DGC remembers that limit
  for the endpoint and model, compacts to fit, and starts every later request (and session) from it, instead of
  overflowing again. The context meter says "256k · this model's max" when the model holds less than you chose.
- **The cache lifetime and Ollama's keep-loaded time in the editor's Settings.** `dgc serve` sends both in a new
  `cache_settings` event to an editor that asks for it (get_config `fields: ["cache_settings"]`), never as new
  fields on `config`, and `set_config` takes `prompt_cache_ttl` (`5m` or `1h`) and `ollama_keep_alive` (a
  duration Ollama takes, `-1`, or empty), refusing anything else. Both apply from the next request.

- **A Personal Pip can borrow your own signed-in Chrome, with your consent each time (Pips API 59).** For one task
  that needs a site you're already signed in to in your Chrome (your bank, a hospital portal, an order history), the
  Pip asks with a card in its chat: **Let PIP use your Chrome?**, the sites and why, **Allow once** and **Not now**.
  There is no Always allow: every borrow is a new card. After Allow once, Chrome itself asks "Allow remote
  debugging?" (Cancel there and the Pip is told and carries on without it), and the one reply your Allow starts
  works in a new window of DGC's own in your Chrome: it never sees, reads or touches your other tabs, and it can
  open only the card's sites. A link, a redirect or a page sending it anywhere else is stopped inside Chrome before
  anything goes there. What a page would send goes only as the Pip's level allows (at Ask nothing, at Approve for
  me only routine steps, at Full access everything but a payment); a payment, and anything to a site not on the
  card, never goes from your Chrome. Password, card and code boxes stay hidden from it, a card number on a page is
  hidden, and it never types a password, a code or a card. Your browser rules for Work's signed-in Chrome hold for
  Pips too. While it's lent, the chat shows **Using your Chrome · SITE** with **Stop**; DGC closes the Pip's tab and
  disconnects when the Pip is done, when its reply ends, on Stop, or after 10 minutes, and the chat says **Gave your
  Chrome back**. A routine can ask but never borrow: its card waits for you, and its reply says so. This is the one
  exception to "Pips keep their own computers", for the task you allow. New requests `list_pip_borrows`,
  `allow_pip_borrow`, `decline_pip_borrow` and `stop_pip_borrow` (local only).

- **One `task` call can start several helpers at once.** Some models send one `task` call per reply even when
  they mean to run several in parallel, so their helpers ran one after another (a real Ultra session ran six
  investigations back to back). `task` now also takes `tasks`: a list of 2 to 8 helpers, each with its own
  description, prompt and agent, which start together. Without `background`, the call returns when every helper
  has ended, with each one's result under its own description, in the order listed, a failed one included. With
  `background: true` it returns at once with every helper's id. They run up to `max_parallel_tasks` at a time
  and the rest wait for a free slot; each has its own private checkout, and their changes land or are kept aside
  exactly as several task calls in one reply would. Stopping the turn stops every helper the call is waiting
  for; background helpers run on, as a single background task does, and stop from the agent map. Each helper
  is listed, shown and reopened as a sub-agent of its own. Side by side needs auto mode and a Git
  project; otherwise they run one after another and the result says why. A rule for one helper's description
  (`deny: Task(deploy*)`) holds inside a list too. Ultra now tells the lead to fan out this way. The single form
  (`description` and `prompt`) works as before, and a call that has both forms, or neither, gets a plain error
  instead of an empty helper.

- **Each web search provider keeps its own key.** Brave, Tavily and Ollama shared one saved key, and switching
  provider kept it: a Brave key could be sent to Tavily, or to ollama.com when the Ollama on this computer couldn't
  search. Now each has its own (`search_api_key_brave`, `search_api_key_tavily` and `search_api_key_ollama` in
  `~/.dgc/secrets.json`, never in `config.json`), and a search sends only the key saved for the provider in use.
  `/search <provider>`, `dgc setup` and the TUI's `/settings` → Web search read and write the selected provider's own
  key; at `/search` and `dgc setup`, Enter keeps a saved key and `-` removes it. The key you had is moved the first
  time this release starts: it becomes the key of the provider selected then. If DuckDuckGo or SearXNG was selected,
  whose it was can't be told, so it is kept as `search_api_key_unassigned` and never sent anywhere; enter it again for
  its provider. `DGC_SEARCH_API_KEY` is the key of the provider selected at start, for that launch only. For an editor,
  `ready.capabilities.search_keys` lists the providers that keep their own key and which have one saved, and
  `set_config` takes `search_api_key_brave`, `search_api_key_tavily` and `search_api_key_ollama` (`""` removes one).
  `search_api_key` from an older editor is the key of the provider that save selects, and a provider that takes no
  key keeps none.
- **Ollama web search.** Web search has a fifth provider, Ollama (`/search ollama`, `dgc setup`, the TUI's
  `/settings` → Web search, or `search_provider: ollama`). If Ollama on this computer is signed in (`ollama signin`,
  Ollama 0.18 or later), it searches with that sign-in and needs no key: DGC asks the Ollama at `OLLAMA_HOST`
  (default `http://127.0.0.1:11434`), and Ollama signs the request to ollama.com itself. Otherwise it uses an
  ollama.com API key (ollama.com → Settings → API keys), kept in `~/.dgc/secrets.json` like a Brave or Tavily key
  and never shown back. When it can't search, it says why and what to do: Ollama isn't running, is too old, isn't
  signed in or has its cloud features off, and no key is saved; or ollama.com refused the key. A rate limit or a
  server error fails as the other providers' do. Each result carries its page's text, and the start of it is the
  snippet. Ollama has no image search, so a ChatDGC reply shows no pictures with it.
- **The TUI's `/settings` has a Web search page**: the provider, the key (typed masked, never shown back; blank
  removes it) and the SearXNG address.

- **The benchmark is retired.** The harness-comparison benchmark, its scripts and its page on vibedgc.com are gone. The
  edit safety gate that lived beside it is still a release gate, now in `scripts/edit_micro.py`.
- **A Pip speaks for its runs.** The extension now draws each run in a Pip's chat as the Pip saying it, in first-person
  words made from the run's report alone, with all-clear runs in a row folded into one message. When you reply, the
  Pip's model is told you saw those runs as its own messages, so "why did you say three were serious?" gets an answer
  from it rather than "DGC posted that"; it is still told they are summaries DGC wrote, not something you said.

- **A blocked task gets ticked once it's done.** Tasks marked blocked never drew a reminder, so after you said go and DGC did the work, the Tasks row still said "BLOCKED ON YOUR APPROVAL" for days. Now, after a turn that did work, the model sees its blocked tasks once and marks any it resolved as done; one still blocked stays so.

- **New Personal Pips start at Approve for me.** Routine steps (a new site, a search, a cart, a draft) go through by themselves; orders, payments, sending to someone new, posting and deleting still ask, and payments ask at every level. A Pip made before keeps Ask until you change it on its page.

- **How much a Personal Pip asks: Ask, Approve for me or Full access (Pips API 58).** Each Personal Pip has a level
  on its page, set by you only. Every Pip, old and new, starts at **Ask**: as before, nothing changes until you choose.
  - **Approve for me**: DGC approves routine steps by itself and asks for consequential ones. Routine: a new site's
    first visit, a search, filter or sort, adding to a cart, saving a draft, an upload of a file you sent it, an email
    to someone you named or already wrote to, an event with no guests. Asked: an order or checkout, a payment, sending
    to someone new, posting, deleting, account settings or passwords, anything the page calls pay, purchase,
    subscribe, transfer or book, and anything DGC can't place. DGC decides from the request itself (method, address,
    field names) and the words of what the Pip pressed (read in DGC's own world of the page), never the model's
    say-so, and no model is asked.
  - **Full access**: no asking for sites, submits or sends (your connected apps' too), except payments.
  - **At every level, as before**: a payment asks (a card number, a payment's words or card and bank fields: a saved
    card's token too), the Pip never types a card and your own Pay on its screen is your approval, a saved login goes
    only to its own site, and careful mode asks before anything it read from your apps goes onto a website. New, also
    at every level: the **safety floor**. A command in its Terminal (or typed on its desktop) that could wipe its Files,
    like `rm -rf ~` or `find . -delete`, waits for **Allow once**, which lets exactly that command run once.
  - **What it did on its own is one click away.** A step its level let through goes at once, in the same run (no
    follow-up run), is kept on record, and its picture in **What it saw…** says so ("Approved by its level: Approve for
    me · Added to cart on shop.example"). Its page lists the newest under **What it did on its own**, right under the
    picker, with **Ask me again from now on**; a routine's are marked "nobody at the keyboard". Drafts go after the
    reply, checked again against the level when they run; a desktop notification names what was sent.
  - **Sites you gave it count as yours.** A site written out in a document you attach (a PDF's, a document's or a text
    file's text, read by DGC itself) no longer asks, as one you type never did. Photos still do: DGC has no way of its
    own to read their text.
  - **A held form no longer stalls the Pip.** A page whose submit DGC holds answers no script, and each of the two
    pictures DGC takes of a hold waited 30 s for it (and the run's end another 30 s): a hold now answers the Pip in
    about 6 s instead of over a minute.
  - Measured on deepseek-v4.1-flash:cloud with the three-asks test sites (fresh home each run, the test card typed
    by the "user" on the Pip's screen): **"pay these medical bills"** with three photos took 1 Allow tap at Ask (the
    site, printed on the photographed bill), 0 at Approve for me and 0 at Full access, with 3 card entries (your own
    Pay) at each, in 368 s, 311 s and 384 s. **"Design me my birthday shirts and order 20 of them in large size"**
    (the test shop's Add to cart now posts to the shop, as real shops do) took 2 Allow taps at Ask (the site and the
    cart), 0 at Approve for me ("Added to cart" went by itself, in the same run) and 0 at Full access, with your
    card typed once at each, in 557 s (with one retry after the model looped in the image editor), 138 s and 162 s.
    A saved card's Pay on a test electricity site was held at Full access ("It looks like a payment, so it asks at
    every level"), and nothing reached the site. At Ask, an invoice whose site you typed, and one whose site was in
    an attached PDF, were each paid with 0 Allow taps.

- **After your own Pay on a Pip's screen, it knows which bill it paid.** It was told only the address the form went
  to, so with two bills on one site it got the second ready again after you paid it, and the test "user" paid it
  twice. It is now told what the form sent (bill number and amount, never a card field), and that this one is paid.

- **Memory that learns: DGC's one memory now keeps what you say over a conversation, shows every change, and turns
  what you just did into a skill.** It is still one memory, shared by ChatDGC, Work and your Pips, written only from
  your own words.
  - **A look back after a conversation.** Once a chat has been quiet two minutes (`memory_review_idle_s`), or a turn
    ends after a paragraph or so of new words from you, DGC asks the conversation's own model once what is worth
    remembering, and keeps at most three: preferences, facts about you, decisions and outcomes, each marked as such,
    and a fact that ends on a known day (a trip, an appointment) stops being used the day after. Each must share most
    of its words, and every address, link and long number, with what you typed in those turns: never a reply, a page,
    a file in the editor, a tool's output, an email you pasted in quotes or a code block; never a secret; nothing
    already kept, even in other words; never a request's own details ("write a toast for my brother, a chef"). It
    shows once, quietly: under ChatDGC's latest reply, as a line in a Work session's chat (**Remembered: … ·
    Forget**), and under a Pip's latest reply. Memory off means no look back at all, and what you said meanwhile is
    never looked back over later; a temporary chat, a Pip's run post, a wake-up, a hello or a routine's turn is never
    looked at. A Work session learns only while an editor that shows the line is open, so an SDK session never does.
    Measured on deepseek-v4.1-flash:cloud over ten scripted conversations (four in ChatDGC, three in Work, three with a
    Pip, each with a trap: a pasted phishing email, a package.json naming someone else, a test run naming a
    maintainer, a toast's details, an email the Pip read, a long patient ID, DGC's own hello in between), three runs
    on the final prompt: 13, 14 and 14 kept, all 41 a real preference, fact, decision or outcome of the user's, and
    in all six runs nothing from a page, a file, an email or a tool (0 leaks), each look back in 0.6 to 2 seconds.
    The first prompt also kept a toast's "brother Rahul, a chef"; a fact only a request to write something says is
    now dropped, as ChatDGC's check before a reply drops it. A prompt that let the model add a worked-out date to a
    fact lost those facts to the words-and-numbers rule; a date now goes only in the expiry.
  - **History, with Undo** (Settings → Memory → History): every add, edit, forget and Delete all, and every skill
    /learn saved, with who made it (you, DGC looking back, a remember tool), where and when; **Undo** puts it back (a
    fact returns with its id, Delete all with everything it deleted, a learned skill is deleted unless you changed
    it since). The journal is `~/.dgc/memory/journal.ndjson`, the latest 300 changes, readable only by you.
  - **/learn [what]**, in Work and in a Personal Pip's chat, drafts a skill in DGC's format (a SKILL.md with a name, a
    description and its steps) from the conversation, the commands and tools that worked included, and shows it with
    **Save**, **Edit** and **Cancel**. Nothing is written until Save: Work saves to the project's `.dgc/skills` when
    the folder is trusted, else `~/.dgc/skills`; a Pip's is a personal skill in `~/.dgc/skills`. It never takes
    another skill's name, and a key the model echoed is redacted; Save refuses one that still looks like a password
    or a card. Measured: a Work session that bumped, built and packaged the extension (with a LICENSE fix on the way)
    became `release-the-vscode-extension` (steps, the LICENSE pitfall, a check), and a Pip chat that paid a hospital
    bill became `pay-apollo-hospital-bill`, each drafted in under three seconds, saved, and found as a project and a
    personal skill.
  - **A Pip's own working notes (Pips API 57).** A Personal Pip keeps notes on how it does its job ("the hospital
    portal asks for the UHID first", "bills go to Arjun Mehta") with a `working_notes` tool (add, replace or strike a
    line; 60 lines or 6 KB), and every run of it, chat or routine, starts with them; Pips on your Claude Code or Codex
    get the same tool. A line is refused if it holds a password, a code or a card or account number, or carries what
    the Pip read from your apps in the last day (careful mode's record), or an email address or a link you never gave
    it (so a page can't plant one for every later run): notes keep how the job goes, never what an email said. Its page shows them under **Working notes**, with **Edit**. Measured on deepseek-v4.1-flash:cloud: on
    day 1 a Pip kept both lines from what you told it; on day 2 its run started with them and its steps entered the
    UHID first and sent the receipt to Arjun Mehta.
  - **A Pip's daily log (Pips API 57).** DGC writes a line for each run (when, what: a chat, a routine by its title, a
    task, and how it ended), by day, for the last 30 days, and its page shows it under **Daily log**. No run is ever
    given it.
  - Protocol: `memory_history`, `memory_undo` and `memory_watch` (`ready.capabilities.memory.history` and `.learned`),
    `learn_skill` and `save_skill` (`ready.capabilities.learn`); events `memory_history`, `memory_learned`,
    `skill_draft` and `skill_saved`; a fact in `memory_state` may carry `kind`, `until`, `expired` and `source.by`.
    Pips API 57: `get_pip_working_notes`, `set_pip_working_notes`, `list_pip_daily_log`. The Pips registry is unchanged
    (the notes and the log are files beside it).

- **A Pip's browser copes with slow pages, new tabs, a page's own questions and downloads.** A Pip lost track of a
  link that opened a new tab, every "Are you sure?" a page asked was cancelled (so a download or a Remove behind one
  never happened), it couldn't wait for results that arrive after a page loads, it wasn't told what it downloaded,
  and Enter in a search box didn't search. Now a link that opens a tab moves the Pip there; a page's confirm or
  prompt waits for the Pip to answer it, and what its OK then sends still waits for your Allow; it waits for what a
  page is still loading; it checks boxes, hovers and drags by name, goes forward and reloads, lists and switches tabs,
  and can ask where it is (its tab, an open question or file picker, its downloads in Files). Every step answers
  with what it changed (Moved to…, Appeared…, Gone…, Opened a new tab…), so it needn't read the page again, and with
  any request the page's own site failed and its errors, quoted as the page's words and never as instructions. Each
  step is numbered, and its picture in **What it saw…** carries the same number, so its report says "340 g (step 4)".
  Measured on the same errand at a made-up shop with deepseek-v4.1-flash:cloud, three runs each: before, one run in
  three did all four parts (15 to 22 steps, 77 to 282 seconds, and two of them went round the browser with curl in
  the Terminal); now three in three (11 to 14 steps, 41 to 50 seconds), with each answer citing its steps, and twelve
  in fifteen over every run of this change, each miss the shop's robot check reached before its price list. Holds, careful mode,
  payments that always ask, the card rule and masking are unchanged, and a Pip still never runs a script of its own
  in a page.

- **A Pip signs in by itself with a login you saved (Pips API 56).** A Pip never saw or typed a password, so every
  sign-in, and every expired session, needed you on its screen. Now, when a Personal Pip meets a sign-in page with no
  saved login, its chat shows **Save a login for SITE so PIP can sign in itself?** with **Save login…** (the username,
  the password and, optionally, the site's authenticator key or otpauth:// link) and **Not now**. Save, and the Pip
  signs in at once: DGC finds the username, password and code boxes, types each value into the page as real input
  (and the 6-digit code it makes from the key), and sends that one sign-in to that site, which is let through; every
  other submit still waits for your Allow. The Pip is told only what was filled, never a value; every answer its
  computer gives it is scrubbed of saved secrets, and a box DGC typed a password or code into is blacked out of every
  screenshot and hidden in its page read. A later sign-in, an expired session included, needs no step from you. The
  same form is on the Pip's page under **Logins**, which lists where each login fills, its username, whether it fills
  a code (never the key) and which Pips may use it (only this one, unless you choose all), with **Remove**. Logins are
  sealed on this computer under a key of their own (`pips/logins`, files only you can read), never in the Pips
  database, an export, a shared Pip, the chat or a log, and redaction knows every saved password and key. A Pip's
  Chrome no longer offers to save passwords itself. 1Password isn't connected yet: its Python SDK is a compiled 7 MB core
  per Python version and platform, still 0.x, that every DGC install would have to carry.

- **One Pip can no longer break the Pips list.** A Personal Pip the main chat made in Pulse's role with a daily routine made every Pips list fail with "Pulse schedules require a reviewed verification plan": reading Pips back checked it as a project Pulse, which creating it rightly did not.

- **A Personal Pip can run on your own Claude Code or Codex (Pips API 55).** A Pip on "Same as DGC" couldn't run
  when DGC's default was a subscription, and a Pip couldn't be given one. Now a Personal Pip's chat box lists the
  Claude Code and Codex you're signed in to under **Your subscriptions**, and "Same as DGC" follows DGC's subscription
  default; the picker says once that its replies and routines use that plan's usage. The CLI is only its model: its
  own shell, file, web and patch tools, your MCP servers, hooks, skills and CLAUDE.md are switched off with flags
  checked against Claude Code 2.1.266 and Codex 0.153.4, and the Pip's own tools (its computer with screenshots as
  images, apps, drafts, choices, routines, notes, web search) reach it from DGC as an MCP server for that run alone,
  opened by a token minted for it. So holds, payment asks, careful mode, the card rule, masking and Allow cards are as
  before. It runs in the run's own folder with no DGC secret in its environment, and stops with the run. Kimi Code
  isn't offered (it always starts your own MCP servers), nor are Qwen Code and Copilot CLI (not checked by trying);
  project Pips keep their local or API model, with one plain line saying why. `dgc pips create --subscription codex`
  and `dgc pips propose --subscription claude` choose one from the terminal. Both SDKs refuse a subscription choice
  before API 55. A CLI that offers its choices before writing anything is asked once for its words first: Codex did,
  and the chat got an empty reply.

- **Keep Pips running works on a standard Ubuntu account.** Ubuntu's default umask (0002) made the installer leave every DGC file group-writable, and Keep Pips running then refused to start with "DGC service entry points must be trusted regular files". The installer now writes files only you can change, files writable only by your own group are accepted (as folders already were), and a group someone else is in is named with the one-line fix.

- **Pips use the whole desktop (Pips API 54).** A Personal Pip's eyes and cursor worked on its browser's page only.
  A Pip whose model can see now uses all of its computer's screen: it looks at the whole desktop, clicks, double and
  right clicks, hovers, drags with real moves, scrolls and types in any window (any character, as its key), presses
  keys and shortcuts (ctrl+s, alt+tab), lists its windows, brings one to the front and opens an app, with a file from
  its Files. Its hands are its own connection to the desktop's VNC display, never your live view, which still marks
  your input and holds it while the Pip works; its cursor shows on its screen in the computer tab and every step is in
  What it saw…. A step on the browser's window still holds what it would submit for your Allow.
- **Apps on a Pip's computer: an image editor, documents and a PDF viewer.** LibreOffice Draw, LibreOffice Writer and
  Evince, on its dock and for the Pip to open; asked to design birthday shirts, it makes the design in the image
  editor and uploads the PNG. Each app runs in a box of its own that sees only the computer's Files, online like the
  Terminal through DGC's egress proxy (public websites, never this computer, your network or cloud metadata
  addresses): an app, like the Terminal, can send to a public website without an Allow card; only the browser holds
  submits. They come from this computer when it has them; when it doesn't, the computer tab asks once, in one line
  saying what is downloaded and how big, to fetch them from the system's own package servers into DGC's folder (83 MB
  on an Ubuntu 24.04 desktop), with no password.
- **Nothing secret in a picture of the whole screen.** The browser's password, card, expiry, security-code and
  one-time-code fields are blacked out where its window is on the screen; any other browser window, and any window
  that asks for a password, are blacked out whole; a window in front stays as it is. If the browser's window can't be
  found on the screen, no picture is sent.
- **A Pip with a computer pays and orders when you ask, and you type the card.** "Pay these medical bills" got a
  perfect reading of three bills and then "I can't make payments"; birthday shirts got "I can't complete a purchase".
  A Personal Pip with a computer was still told it could never buy or pay. Now it fills in everything but the card
  (asking once for what it lacks, such as an address) and says in one line to open its computer, type the card into
  the payment form and press Pay. Your own Pay on its screen is your approval: sent at once, and the Pip is told and
  goes on to the next bill. A Pip without a computer still says it can't.
- **An address's PIN code is not a secret.** A delivery form's "PIN code" (an Indian postal code) was blacked out on
  the Pip's screen like a card PIN, and the Pip told the user it "looks masked". A field named or marked as a postal
  code is shown now; a PIN on its own still counts as secret.
- **Card numbers stay out of a Pip's chat.** Cards follow the password rule: a message with a card number (13 to 19
  digits passing the card check, spaces or dashes allowed; bill, UHID, phone and account numbers don't count) is
  refused, in the editor before it is sent and in DGC (`card_in_chat`, the SDKs included): nothing of it is kept or
  sent to a model, and one line says to type it on the Pip's screen, with **Open its computer**. A Pip never asks for
  a card or types one; its Pay on an empty card form is dropped and it is told to hand over.
- **The main chat makes a Pip that pays.** Asked for "a Pip that pays my bills for me", it offered a read-only Gmail
  bill tracker ("No payments are ever made") after asking to run Composio's connection tool. It now knows a Personal
  Pip's own computer pays, orders and books on websites with your Allow, and sets that up with no payment app. For a
  Pip that looks after your mail it no longer runs Composio's tools itself (two raw "Run COMPOSIO_…" permissions and
  a failed app plan): the Pip asks to connect Gmail with a Connect card in its own chat.
- **Reject tells the Pip.** After you reject what its computer holds (a payment, an order, a new site), the Pip says in
  its chat what wasn't done and goes on with the rest of what you asked (the second and third bill) without asking
  whether to. Before, it went quiet. Only once, only while the chat still ends at that reply, and only for a Reject in the last ten minutes.
- **The turn after an Allow still sees your photos.** When a Pip carries on after you allow a site or a submit, connect
  an app or finish a robot check, the photos your ask brought come with it again, and so does your next message (the
  card it asked for). It had said "I don't have the bill photos" right after you allowed the hospital's site, and "I
  couldn't find the UHID" after you gave it the card.
- **Allowing a site sends the Pip back to its page.** After "Allow this site" the Pip was told the site's name
  ("pip-test.example") and opened that bare name, which didn't load; it is now told the exact page it wanted.
- **After a Reject, the page comes back.** A rejected submit left Chrome's "This page has been blocked by Chrome" on
  the Pip's screen; its browser now goes back to the page that made it.
- **A Pip no longer denies its own cards.** Told "never say a card is there unless connect_app said so", a Pip said
  "I can't tell you a card is waiting below. Should I press Pay again?" right above its held payment. That rule now
  names the Connect and plugin cards only, and a Pip is told its computer's holds show as cards.
- **One decision per hold.** A reply that leaves something waiting on its computer shows only that card's buttons: a
  Pip's own "Allow the site, go ahead" beside it only sent words, and the site asked again. A held site is named to
  the Pip, so it no longer writes about one site while the card asks about another.
- **A held payment says what it pays.** The Needs attention row is "Pay on <site>?" with what the form sends (a bill
  number and amount, never a card field); the computer tab's card shows the same line.
- **Email drafts are whole.** A draft that leaves a blank for you ("[SIGN OFF / HOLD - your call]", "[date]") is not
  made, since Send would mail it as written: the Pip asks you first, then drafts it. "Catch my mails" becomes a routine
  on new mail rather than a daily check.

- **A Pip's lines while it works read as sentences.** Each line a Pip writes before a step on its computer now streams as its own paragraph; back to back they ran together ("on my computer.I'll select all").

- **No "Save card?" on a Pip's computer.** Chrome's offers to keep a card or an address are off in a Pip's browser, so they no longer cover its screen after a checkout or keep a card in its profile.

- **Steer a queued message into the running turn.** New editor command `steer_queued {request_ids}` (offered as `ready.capabilities.steer_queued`): the user's queued prompts move, in queue order, into the running turn as steering; each is announced as `prompt_accepted` "steered", and none moving is `command_rejected` "not_steerable" with the reason.

- **Sign in with GitHub works out of the box.** DGC ships its registered GitHub app (OAuth App "DGC", device sign-in, no secret): the GitHub plugin page offers Sign in with GitHub — DGC shows a short code and opens github.com/login/device — beside the token field.

- **A Pip report is never lost to its summary.** A summary over 4,000 characters is cut at its last sentence that fits and marked, and a missing one is written from the findings, each with a note in the report's limitations. Before, "report summary must be text between 1 and 4000 characters" failed the whole run, and even the one format repair never ran (three failed runs in a row on a real project).

### Pips: eyes and a cursor (Pips API 53)

- **A Pip whose model can see uses its computer by sight too.** Besides the page's text and refs, it can `look` at its
  browser (a JPEG of at most 1280 × 800) and `click_at`, `double_click_at`, `right_click_at`, `hover_at`, `drag` and
  `scroll_at` where it points, each answered with a new screenshot that marks the mouse with a red ring. A drag moves
  in real steps, so canvas and drag-and-drop editors register it (an HTML drag the page starts is finished with drag
  events). `type` with no ref types into what has focus. Only a run whose own model lists `vision` is offered the
  position steps. Measured on 23 targets: deepseek-v4.1-flash:cloud 21/23 (0.8 s a click), qwen3.8:27b 23/23
  (8.7 s), qwen3-vl:8b 11/23 (109 s; it thinks before every answer).
- **Each model is asked for points in its own scale.** Qwen3's vision models answer on 0-1000 across the image even
  when asked for pixels (qwen3.8 hit 0/23 read as pixels, 23/23 as 0-1000); DGC tells each model its scale and catches
  an answer that can only be the other one.
- **Passwords and payment cards are blacked out of every screenshot a model sees**: password, card, expiry, CVC and
  one-time-code fields in the page and in every frame (including another site's, asked through its own session),
  and the whole of a payment provider's frame. The mask is drawn in DGC's own isolated world, never on the page, and
  a screen it can't mask is not sent.
- **`upload`** puts a file from the Pip's Files into a page's file field or the button that opens its file chooser;
  the chat's photos are in Files › From chat. Choosing sends nothing; the page's upload is held for the user.
- **A text-only Pip says so in one line, with a card.** Asked to look, or sent photos, a Pip whose model can't see
  replies "**glm-5.3:cloud can't see images.**" with three choices: use a model that can see for that (the vision
  relay, which answers in words and names points), switch the Pip to it, or not now. DGC picks the model from the
  user's own, the same kind first; the answer is kept per Pip (`get_pip_eyes`, `set_pip_eyes`). One that works
  around a canvas from the text, or says it couldn't see, gets the same line and card after its reply.
- **You see where it clicks.** `use_pip_computer_view` frames carry `pointer`, op `pointer` returns it without a frame,
  and `list_pip_computer_frames` takes `pointers`, so the live view and "What it saw" draw the Pip's cursor.
- **A payment is never Always allow.** A held submit that carries a card number now refuses Always allow
  (`asks_every_time`), and no grant for that site sends one; before, the browser's payments could be always allowed.
- **A long run no longer forgets what it was asked.** Compaction counted each step's screenshot (and every
  `<tool_results>` and `<system-reminder>` message) as the user speaking, so the brief's "user's own messages" filled
  with screen captions until the ask no longer fit, and a later compaction quoted only what was said since the last
  one. DGC's own messages are no longer the user's, and each brief quotes the words earlier briefs quoted too (the
  newest win when they don't all fit). Measured before: two
  180-step T-shirt runs ended "I don't have a stated request for this design yet".

### Pips: phone photos and bigger files in a Pip's chat (Pips API 52)

- **A Pip's chat takes what the Work chat takes.** Photos and files no longer ride inside the request, where the
  4 MiB command frame capped them at four images and 2 MB in all (one phone photo of a medical bill could be over
  that). `send_pip_message` now also takes `spooled_images` and `spooled_files`, files the editor put in the
  backend's image spool, as the Work chat's prompt does: 8 MB a photo and 32 MB of photos a message with no
  four-photo cap (64 at most), and up to 16 files (a document 16 MB, a text or code file 1 MB, 32 MB in all).
  Only this computer's own editor and SDKs can name spool files, every name is a bare file name, and what a send
  brought is removed from the spool whether it succeeds or not. Inline `images` and `files` still work for an
  older editor. `get_pip_message_image` takes `as_file` and answers with where the photo is kept, so the editor
  can show an 8 MB original no frame carries.
- **iPhone photos (HEIC/HEIF) become JPEG automatically**, in a Pip's chat and the Work chat (pasted, dragged in, or
  `@IMG_1234.HEIC` in the terminal). DGC uses what the computer has: `sips` on macOS; on Linux Pillow with
  pillow-heif, libvips, ImageMagick, libheif's `heif-convert`, or the GNOME image loader Ubuntu's desktop ships
  with (`ready.capabilities.heic_images`). With none, the message is not sent and says in one sentence to install
  `libheif-examples` or send the photo as a JPEG.
- **Large photos go to the model at 2,500 pixels.** A photo over 2,500 pixels on its long side is sent to the model
  as a quality-90 JPEG at 2,500 pixels (a PNG stays a PNG), turned upright and lightly sharpened, so small print stays
  readable and the request stays a size every provider takes. Measured on five phone photos of a bill in one message
  (`deepseek-v4.1-flash:cloud`, 24 runs): a 6.5-point claim reference read right 24/24 from the sharpened copy, and
  as little as 14/24 from a plain shrink. Nothing is upscaled; the chat keeps the original. With no converter,
  the model gets the original, as before.
- **Dragged-in images in the Work chat** are bounded like pasted ones: 8 MB each and 32 MB in all, instead of
  2 MB in total, since DGC reads the file itself.
- The registry schema stays 46: a registry made before this release has its chat images and files tables
  rebuilt with the new bounds, rows kept, the first time a message needs them.

### Pips: a Pip's runs in its own chat (Pips API 51)

- **Each run posts its result in the Pip's own chat**, as Grok Bots and OpenAI Dots post a scheduled run: a
  review's findings (how many, the worst severity, the top three with file and line), Pulse checks, a Quill draft,
  a Personal Pip's scheduled result, and a failure of any of them in plain words, with when it runs next. It is
  written when the run finishes, by the runner, so it is there once per run even if no editor was open. It says
  what the Work chat's report card says (one builder makes both).
- **Not a turn, not your words.** A post never starts a reply. The Pip's next reply reads its five latest posts as
  reference data, marked as written by DGC, beside its last report.
- `list_pip_run_posts {pip_id, before_id?, limit?}` reads them; `get_pip` has `report_session`, the chat Ask DGC to
  fix goes to. The registry schema stays 46 (the posts' table is made on first use).

### Pips: scheduled Pips run with VS Code closed

- **Keep Pips running turns itself on** the first time a Pip gets a schedule, a commit trigger or a routine
  (setup cards, the chat's setup, the Pips view and `dgc pips accept`), the same way its switch does: a systemd user
  service on Linux (and lingering where the system allows it), a LaunchAgent on macOS, a Windows sign-in entry for
  WSL. The result says it plainly: "Your scheduled Pips now run even when VS Code is closed. Turn this off in the Pips
  view, under Controls (Keep Pips running), or with dgc pips keep-running off." The chat that set the Pip up is told
  the same sentence.
- **Your off stays off.** Turning the switch off (or on) is now recorded as your choice, and an off from before this
  release is recognised by what it left behind (a Linux unit installed but not enabled, a macOS agent launchd lists
  as disabled). DGC then says the schedule runs only while Pips are running.
- **When it can't, it says what to do**, such as `sudo loginctl enable-linger USER` to keep running while logged out,
  or turning it on in the Pips view. The Pip is created either way.

### Pips: a big project no longer fails every run (source rules safe_source_v2, Pips API 50)

A Pip on a working project (an ERP with uploads, media, screenshots and a vendored template: 3,405 committed files,
85.3 MiB, three 6.9 MiB copies of one video) failed every run with "Snapshot exceeds 10,000 entries, 4 MiB per file
or 64 MiB total", because one file over 4 MiB or more than 64 MiB of committed code stopped the copy.

- **New source rules, `safe_source_v2`.** Files DGC can't copy are left out and listed instead of failing the run:
  files over 4 MiB, symbolic links, submodules, and (current files) hard links, special files, other filesystems,
  folders nested deeper than 32, names it can't copy safely and files holding one of your configured secrets. A run
  copies up to 256 MiB (was 64 MiB); 10,000 copied files and folders as before, and files a rule leaves out no longer
  count toward that.
- **Your project's ignore rules, for leaving things out only.** A `.dgcignore` file (the `.gitignore` format, in any
  folder) and a Pip's own **Excluded folders** leave things out. A Pip on your current files also follows the
  project's `.gitignore` files and `.git/info/exclude`. They are read as plain data by DGC itself, never by running
  Git, and only ever leave things out: a `!` line can't bring back `.env`, keys or anything else DGC's fixed rules
  leave out. Committed source reads the `.dgcignore` files in the commit; `.gitignore` doesn't apply there, since Git
  itself ignores it for files you committed.
- **The Pip is told.** Its run starts with the list of what its copy left out and why, so it doesn't report those
  files as missing. Each run keeps the list (`get_pip_run_source`, `dgc pips report`).
- **Said before a run fails, and said plainly.** `dgc pips source PIP` and the Pip page's **Check size** say whether
  the source fits (`check_pip_source`); setting up a Pip in the chat says so in the result, and `run_pip_now` refuses
  a source that can't fit instead of queuing a run that will fail. When it still doesn't fit, the message gives the
  size, the limit, the five biggest folders and how much to leave out, and names `.dgcignore` and Excluded folders.
- **Existing Pips keep their rules** (`safe_source_v1`) and behave as before, except that the failure now names the
  big files and folders and says how to switch. Moving a Pip to the current rules is a reviewed source change, once:
  on its page under Source (Save), `dgc pips propose PIP --expected-version N --source-rules v2 [--exclude uploads/]`
  then `dgc pips accept`, or the chat's `pips_propose` with `source_exclude`. New Reviewer and Quill Pips start on the
  current rules; Patch and Pulse keep an exact committed copy. The first report after a change of rules or Excluded
  folders isn't compared with the one before; a new committed Pip's first report counts every finding as new.
- **Faster current-file copies.** Capturing your current files no longer flushes every file to disk (each copy is
  checked by its digest before and after the run): 2,048 small files took 6.3 s and now take 0.5 s.

### Monitors come back when their chat does

- **A monitor DGC's stopping ended starts again when the chat is opened again.** A window reload, a lost
  connection or a killed backend stopped every monitor, and reopening the chat left them gone. Now DGC writes each
  monitor down beside its session (`<session>.monitors`), and when that session is opened again — `dgc serve`
  resuming it for the editor, or `dgc --resume` and `/resume` in the terminal — it starts each one that was still
  running when DGC stopped, once, with the same command, folder, sandbox and permissions, within the time it had left
  (counted from its first start; `persistent` has no limit). The chat shows one line, "Monitor "ERP sync" restarted
  after DGC reopened this chat; nothing was watched between 10:02 and 10:05", and the model reads the same at its next
  turn. Nothing watches while DGC is closed.
- Not restarted: a monitor stopped by you or the model, one that timed out or exited, one a rewind took back, one whose
  time ran out while DGC was closed (the line says so), one whose command carried a credential, and one another DGC
  still runs. One the permissions in force now forbid (plan mode, a deny rule, a hook) or that would now need an
  approval it did not need is shown as stopped, with Restart; in the terminal `/monitors restart ID`. A failed start
  is reported once and not retried. See [docs/MONITORS.md](docs/MONITORS.md).
- **Editor protocol:** `ready.capabilities.monitor_restart`; a new event `monitor_restart` (one per monitor after a
  resume's other events, and the answer to the new command `restart_monitor {key}`); history replays it as
  `{role: "monitor_restart"}`. No existing event changed.
- **Keyed on the DGC that ran it having ended.** A monitor another DGC process still runs (a window that kept the
  session, a chat switched away in the same process) is never restarted by another opening; a reopen that finds the
  previous DGC still exiting waits up to 30 seconds for it.
- **The rest of the background work a restart stopped.** Background commands and sub-agents that were running are
  shown as stopped by a restart, never run again on their own: Run again (the same command in the same folder, the
  same task from scratch) and, for a sub-agent, Resume (a new one told what the stopped one had done and where its
  unmerged work was kept). Troupes resume once from their journal, unfinished agents only, or are offered as Resume
  when the permissions now would not start them. The model is told which stopped. Written in `<session>.tasks`.
  Protocol: `ready.capabilities.task_interrupted`, event `task_interrupted` (history `{role: "task_interrupted"}`),
  command `rerun_task {key, how}`; `background_shells` may list a stopped command as `{state: "stopped", rerun}`.

### Editor protocol: the agent map

For the editor's agent map. Older clients are unaffected: everything new is a new event, a new command, or a key in
`ready.capabilities`.

- **`ready.capabilities.background_tasks: {"version": 1}`**: the backend sends `background_shells` (every background
  command of this chat: id, redacted label, `running|exited|killed`, start and end, exit code, the sub-agent that
  started it) once a client has asked with `list_background_shells`, and again whenever one starts or ends.
  `stop_background_shell {id}` stops one, as `kill_shell` does. `get_background_output {id, max_bytes?}` answers
  with `background_output`: the latest output of a background command or a monitor, redacted, at most `max_bytes`.
- **`ready.capabilities.agent_control_foreground: true`**: `agent_control {action: "close", id}` also stops a
  foreground sub-agent, without ending the turn. Its parent is told the user stopped it and carries on; its siblings
  are untouched.

### `dgc -p` in scripts

- **A pipe or a file gets the answer and nothing else.** `answer=$(dgc -p …)`, `dgc -p … > out.txt` and
  `dgc -p … | next-tool` used to receive the model's thinking ("· thinking (raw)…"), its tool steps and DGC's notices
  along with the answer. When standard output isn't a terminal, those now go to standard error, which a terminal still
  shows, and standard output holds only the final answer (the text `--output FILE` saves), as `codex exec` does. In a
  terminal nothing changes. `--output-format json` is unchanged. A `--mode plan` run's result is the plan it reported
  (to standard output and `--output` alike), not the sentence the model ended on.
- **The prompt stays off DGC's own command line.** `dgc -p "<prompt>"` restarts itself at once (same process, same
  terminal and pipes) with a placeholder where the prompt was; the prompt crosses in a temporary file with no name on
  disk, read and closed before anything else, so no command DGC runs inherits it. A model running
  `pkill -f <a word of the prompt>` used to stop DGC itself mid-task (found running Terminal-Bench), and anyone on the
  machine could read the prompt with `ps`. On Linux the process is also named `dgc`, so `pkill python` passes it by.
  `-p -` (stdin) and Windows are unchanged.

### Short updates while the agent works

- **Work tells you what it is about to do, and what it found, as it goes.** Before its first tool call the agent now
  says in one sentence what it will do, and while it works it adds a one-line update when it finds something that
  matters, changes approach, hits a blocker or starts editing, and never leaves you more than about a minute without
  one. One line covers a batch of related calls; it does not narrate each call or repeat the plan. The old
  instruction asked for a line before every group of calls and was often skipped at the start: measured on five
  coding tasks with `deepseek-v4.1-flash:cloud` and `glm-5.3:cloud` (two runs each), the opening line went from 14
  of 20 turns to 20 of 20, and tool calls and success rates did not change.
- **About a minute, by the clock.** A model cannot see a clock, so when a tool round ends a minute or more after the
  last thing you read from the agent, DGC adds one line to that round's reminders ("It has been 75s since the user
  last heard from you. Add a one-line update with your next tool call."), once per silence. A sub-agent and a Pip
  never get it: nobody watches their text live. Measured on 48 turns, including eight with a 25-second test run after
  every change: the longest a tool round ended into a silence went from 67.6s to 32.9s, so the note had nothing to
  do (it would have fired once before the change, and fired zero times after). The long silences left are single
  replies spent thinking (up to 149s on GLM), which a note between tool rounds cannot interrupt.
- **A detailed message when it matters, and an answer that stands alone.** When you should read something in full
  before the agent goes on, such as a diagnosis or its plan for a large change, it may write it out with formatting in
  the message with its next tool call and keep working; other updates stay a sentence or two. The final answer must
  stand on its own, since you may not have read the updates.
- **Sub-agents no longer narrate.** Their text between tool calls was never shown, since only a sub-agent's final
  message comes back as its result, so they are told to skip updates and put what matters in that message.

### Security

- **urllib3 2.8.0** (was 2.7.0) in the runtime lock: CVE-2026-97689 and CVE-2026-97688 (a malicious or broken server
  streaming a chunked or compressed response could make DGC buffer without bound or loop), and CVE-2026-97687 (TLS
  settings for an HTTPS proxy and the target server not kept apart). DGC streams every model response.
- A sub-agent record's SHA-1 id says it is not a security use (`usedforsecurity=False`), as the code scan asked.
- **Plugin sign-ins are kept in your system keychain**, as Codex and Claude Code keep theirs: the macOS Keychain, or
  the desktop keyring on Linux (`secret-tool`). Where there is none DGC can use (a Mac over SSH keeps its keychain
  locked; Linux without `secret-tool`), an owner-only file, `~/.dgc/plugin-auth/<server>/credentials.json`.
  `plugin_credentials_store` (`auto`, `keyring` or `file`) chooses. Each entry belongs to one DGC home, so a test or an
  isolated session never reads or deletes yours.
- **DGC connects to hosted plugins itself, with no Node.js.** Its own client replaces the `mcp-remote` bridge:
  Streamable HTTP (JSON or SSE answers, sessions, the GET stream) and the older HTTP+SSE transport, with OAuth 2.1
  sign-in (PKCE, resource metadata, the resource indicator, registration as "DGC", your own app's client), refresh
  before a token expires, and one sign-in at a time across windows and Pips. A tool that needs more access says so,
  and the next Connect asks for it. Saved plugins keep working unchanged.
- **DGC's client metadata document.** Where a service takes OAuth client metadata documents (Notion, Linear, Sentry,
  Granola, Airtable, Canva, Adapter and others), DGC names itself by `https://vibedgc.com/oauth/dgc-client.json`
  instead of registering a new client each time, as MCP now prefers. Only once that document is published and says
  what DGC expects; until then DGC registers itself as before. Sign-ins also check the issuer the service returns
  (RFC 9207), and a service that answers without a token with `403` (Docusign) is signed in to like any other.
- **Removing a plugin signs you out of it.** Removing the server (`/mcp remove`, the editor, or uninstalling its plugin)
  asks the service to revoke DGC's token (RFC 7009, at the address saved at sign-in or found through the service's
  OAuth metadata), then deletes the sign-in, and says which happened. Before, the token stayed on disk in the bridge's
  shared `~/.mcp-auth`, which DGC never touches (other apps use it). A remote server you had already signed in to
  asks you to sign in once more.

### Fixed

- **Changes in this chat no longer lists files nobody touched as deleted.** In a large project the scan behind it
  stops reading at 64 MiB or 5 seconds, but it still compared every file it had listed, so a file one scan read and
  the other didn't reach counted as deleted (or created). A long session in a ~104 MiB repository showed
  "+1 −82173": 497 "deleted" files that were all still on disk, 85 of them counted twice, and the 500-file limit
  left room for only 3 of the real edits. Now:
  - A file is compared only when both scans know it: they read it, Git says it is unmodified (the content it holds
    is then known without reading it), or one of DGC's file tools wrote it. A file only one scan reached is left
    out, and the journal says it is partial.
  - A file is recorded as deleted only after checking it is gone. A file that became ignored or untracked is not
    deleted.
  - The scan reads first what this run's tools wrote and what the chat already changed, then what Git reports as
    changed, then the rest. In a Git repository the files it doesn't reach are ones Git vouches for, so the result
    is usually complete there now; a shell edit or a commit of a file past the cut-off is still recorded.
  - Sessions saved before this fix are repaired when they open: a "deleted" file still on disk exactly as it was
    is dropped, and so is a deletion counted twice. Edits the old scan never recorded can't be recovered, so such
    a session stays marked partial.

### ChatDGC

- **Deep research goes deeper, and says how.** It used to stop after three rounds and 20 pages, about two minutes with
  `deepseek-v4.1-flash:cloud`, and the model never saw what was missing. Now each round starts with a review of the
  notes so far against the plan: which steps are covered, what's still missing, and where sources disagree. The next
  searches go after those. Every result found joins one pool, and the model picks what to read from titles and
  snippets, primary sources first, at most four pages from one site. A page linked twice, redirected to one already
  read, or copied from one is read once. Notes are longer and keep each page's date. It can't call the research done
  before three rounds and half its pages. A failed search is asked again once. How deep it goes is set for you
  (Standard: up to 40 pages in up to 15 minutes); **Edit → How deep** picks Quick (15 pages, 5 minutes) or Thorough
  (80 pages, 30 minutes) for one run, and `chatdgc_research_depth` in the config sets the default. On three test
  questions a Standard run took about ten minutes, searched 30 to 34 times, found 136 to 158 sources, read 35 to 40
  pages and cited 27 to 33 of them; before, it took two minutes, searched 13 to 15 times, read 19 pages and cited 13
  to 19. The card shows the round and pages read out of the budget and the sources found, says what's still missing,
  and ticks each covered step in the plan. Under the report, one line says how it was researched (rounds, searches,
  sources found and read, minutes, citations that hold up), and an export ends with it. The report no longer talks
  about "the notes" or leaves "per ," and "Source:." where citation marks were taken out, and a table's "Source"
  column of marks, which read as empty cells, gives them to the fact beside it. **Keep researching** after
  a spent budget adds 10 pages and five minutes. `chatdgc_research` carries `depth`, `budget`, `found`, `opened`,
  `whole`, `searches`, `seconds`, `covered`, `gaps`, `conflicts` and `how` in its open `research` object; no event or
  command changed shape.
- **Deep research goes as deep as the model allows.** Standard's budget follows the model's window: 40 pages at
  32k, 60 at 64k, 80 at 128k or more (Thorough doubles each), so the report, written from every note at once, never
  gets a note cut shorter than at 32k. A model that runs elsewhere (a `:cloud` model, or a provider) researches in up
  to 128k of its own window, since that takes none of your memory; a model on your machine keeps the chat's window.
  Each step is now sent that window too (a local model used to get DGC's general one). The plan's card, **How deep**,
  the progress and the line under the report show the real numbers. With `deepseek-v4.1-flash:cloud` a Standard
  run now reads about 75 pages in six to seven minutes. **Edit → How deep** and `chatdgc_research_depth` still decide.
- **Deep research checks each citation against its own source, and repairs what none backs.** A claim keeps the
  sources that give all of it and drops the others. One none backs gets a second look at the page itself (kept
  beside the chat as it was read, deleted with it): the passage with its figures and names. If still nothing backs it,
  it goes back to the model once, in one call, to be corrected to what the sources say, with their citations, or
  deleted; corrections are checked again, and a fact still not backed is removed. Before, such a claim stayed in the
  report without its citation, looking like fact. The report's own judgement or advice stays, uncited; a table row
  is checked cell by cell and keeps its place, with "not given" in a cell no source gives, so a comparison never
  loses a model. Each verdict gives its reason first, and one whose reason says the claim is backed doesn't remove
  it. Sentences that cite nothing are left alone. A table row is checked under its table's heads ("Model: …;
  Licence: …"), and the writer cites every note a claim draws on. The line under the report says what it did ("1
  corrected, 2 removed: no source backed them"), and a click on it lists each claim, what it said and why.
  On the coding-models and home-loan questions, 86% and 84% of cited claims held up at the first check, 8 and 7
  were corrected, 1 each removed, and the check took 30 to 40 seconds.
- **Deep research's citation check looks at the figures themselves, and corrects before it removes.** A hand check of
  two reports found a kept claim whose figure was on none of its pages (the note it was judged by was wrong), and
  both removals wrong. Now every number in a claim that's kept must be on one of its cited pages as read, in any
  form (8.00% is 8%, 1,000 is 1000, ₹70 lakh is 70,00,000); one that isn't sends the claim to the page check and the
  repair, with no model needed to spot it. The report's own arithmetic (an EMI, 80% of a price) on figures its pages
  give is kept, uncited, rather than swapped for another example. A verdict that holds but doubts itself ("hmm",
  "but") is looked at again, and one whose sources back the claim with nothing missing can't remove it. A repair
  that would remove a claim part of which is sourced gets a second, stricter try (fix the figure, or say who claims
  it); removal is left for claims no source gives at all, or with a figure no page has. Corrections are asked for as
  one plain sentence, and checked against the page as well as the note. The question's own figures (₹70 lakh) count
  as given, and a page whose ₹ was decoded wrongly still gives its figures. On the coding-models and home-loan
  questions, the guard caught 3 and 8 claims whose figures their pages don't have, 6 and 4 were corrected, none was
  removed, and the check took about 30 seconds.
- **A flaky web search no longer stretches deep research.** A round waits 30 seconds for its searches at most (a
  keyless search that kept failing made one run take 26 minutes), four run at once, and the line under the report
  says how many searches failed, and plainly when many did.
- **A chat's outline, whatever is on screen.** `chatdgc_outline` (offered as `ready.capabilities.chatdgc.outline`)
  answers with every prompt of a chat, oldest first: its first words (or what it attached), when it was sent, and the
  widgets the replies to it made (deleted ones marked). A long chat opens on its latest pages, so the editor's Widgets
  list and prompt rail read the rest from here. It is a new command and a new event; no existing event changed.
- **Exports read as the chat does: no citation marks.** A chat exported as Markdown, and a deep research report, leave
  out the "[1]" marks the model cites with, with the space before them; each reply's sources are still listed after
  it. The JSON export keeps the chat as stored, marks and all, and the saved reply keeps them so its sources can still
  say which were cited.
- **Pictures of something else are dropped, not shown above a reply.** An image search sometimes answers with pictures
  of something else entirely (asked for "Lisbon Portugal cityscape", DuckDuckGo returned four portraits from Kannada
  news sites). A picture is kept only when a word of the search, without case or accents, is in its title, its page's
  address or its own; no pictures beat wrong ones.
- **Saving a file you asked for works on Python 3.10 and 3.11** (the spreadsheet writer used syntax only 3.12 allows).
- **One memory, written everywhere.** Work sessions and Pips now add to the memory ChatDGC keeps, under the same
  rules: only what you typed (never a file, a page or a tool's output), facts not a task's details, at most three a
  turn.
  - **In a Work session:** `remember` and `forget` (no approval card; a rule can still deny them). They aren't
    offered to sub-agents, or when memory is off.
  - **In a Pip's chat:** a Pip's note goes into the shared memory, tagged with the Pip and the reply. Its page and
    the reply show it, and Forget there forgets it everywhere. With memory off, a note stays the Pip's own.
  - **Pips API 46:** `list_pip_notes`, `add_pip_note` and `forget_pip_note` take `shared: true`, so a page can list
    and forget the shared facts too. A page that doesn't ask never sees a `mem_` id.
- **Spoken replies:** in voice mode, a message sent by voice asks for an answer that sounds like speech: a few short
  sentences, no tables or headings, with an offer to go into detail. Without this, a long Markdown plan took five
  minutes to read aloud. `chatdgc_send` takes `voice`, offered as `ready.capabilities.chatdgc.voice_replies`.
  - **Nothing to look at, as ChatGPT's voice mode:** a spoken turn isn't offered `ask_user`, `make_file`,
    `show_widget` or the canvas tools, nor told about them or about charts; one called anyway is refused. Typing
    again brings them back.
- **Which plugin a reply used, with its logo:** a reply that read from a plugin shows **Used [logo] Aave** under it
  once it's finished, in ChatDGC and in a Pip's chat, as ChatGPT names the apps it used: numbers from a live plugin no
  longer look like the model's memory. A card that waits, a listing, or a read that came back as an error is not a
  use. ChatDGC keeps them on the message as `plugins: [{plugin, name}]`. A Pip's controller records them per run
  (never the worker's word for it), and `list_pip_messages` returns them as the reply's `plugins`. The editor reads
  each logo once, from the plugin's package or the logos DGC ships, and shows a plug for one with none.
- **Compact now, then Edit at once:** "compacted" was said while the chat was still busy recounting its window, so
  editing the new summary straight away was refused as "still answering". It's said once the chat is free.
- **A card of several questions:** `ask_user` takes `questions` (up to four, each with its options) and `submit`, the
  button's words, as ChatGPT's form does. The card is kept on the reply with its first question as `question` /
  `options` too, so an older screen shows that one. `chatdgc_answer` takes `choices`, one per question, offered as
  `ready.capabilities.chatdgc.question_forms`; the message sent is the model's own with each question and its
  answer under it.
- **Bytes, fixed in `dgc serve`'s redaction:** speech, screenshots, images fetched later and a Pip computer's screen
  travel as base64, and about once a megabyte that holds a run the AWS-key pattern (case-insensitive) redacted. The
  audio arrived corrupt and never played; an image or the screen stream could break the same way. Base64 bytes now
  pass intact, in the standalone backend too; everything else is redacted as before.
- **Voice offered at setup:** `dgc setup` ends by offering voice: a one-time download of about 229 MB (Moonshine for
  dictation, Kitten for reading aloud), run on this computer. It's asked only at a terminal, and only when no voice
  model is installed yet.
- **Voice models on your own computer.** `dgc serve` installs and runs speech models for dictation (Moonshine Base,
  English, 111 MB; NVIDIA Nemotron 3.5, many languages, 475 MB) and for reading replies aloud (Kitten, Pocket TTS).
  - **What it uses:** sherpa-onnx, in an environment of its own under `~/.dgc/voice`.
  - **Downloads are checked:** each model is checked against the release's published SHA-256 before it is unpacked.
  - **Nothing is sent anywhere:** recordings are written down on your machine.
  - **New protocol commands:** `voice_models`, `voice_install`, `voice_cancel`, `voice_remove`, `voice_use`,
    `voice_transcribe` and `voice_speak`/`voice_stop`. A backend that has them says so in
    `ready.capabilities.voice`.
- **Memory keeps only what you tell it about yourself.** The check before a reply says where each fact comes from
  (you told it, you asked to keep it, a task's material, a question's background) and only the first two are kept;
  a request to write or do something keeps only what you ask it to remember. Measured on deepseek-v4.1-flash, a
  task's or a question's details were saved in 21 of 38 runs and now in none of 57, with every stated fact still
  kept; on glm-5.3, 8 of 38 to 1 of 38.
- **`dgc chat`: ChatDGC in the terminal.** `dgc chat` opens a chat you type into (`/new`, `/list`, `/open`,
  `/title`, `/export`, `/help`; Ctrl-C stops a reply); `dgc chat "question"` (or piped text) answers once and exits.
  Replies stream as they're written and end with their numbered sources. `--list [QUERY]`, `--resume ID`,
  `--export ID [-o FILE]`, `--model`, `--think`, `--search off|auto|on`, `--temporary`, `--file PATH` (up to ten)
  and `--json`. The same chats as the editor's Chat tab; the service runs inside `dgc`, with no backend to start.
- **A chat app inside DGC.** `dgc serve` answers a new `chatdgc_*` family of commands. Your chats have
  their own engine and store (`~/.dgc/chat/`), separate from Work sessions and Pips, and they are the
  same whatever folder DGC runs in. A reply is as long as your model allows; one cut at the model's limit,
  or stopped, carries on with **Continue** in the same message. Each chat keeps its model and thinking
  level (off to extra high; no ultra). A new chat is written only with its first message, and after its
  first reply your model names it. Temporary chats are never written. Rename, pin, archive and delete
  are kept even when done mid-reply. Advertised as `ready.capabilities.chatdgc = {version: 1}`; see
  [docs/CHATDGC.md](docs/CHATDGC.md).
- **ChatDGC searches the web.** `chatdgc_send` takes `search`:
  - `off`;
  - `auto`: the model decides;
  - `on`: it searches before it answers.

  A reply makes up to five searches with the one search set in Settings. Its pages are numbered across its
  searches and cited as [n], and the reply keeps `sources` and `searches`. `chatdgc_activity` says what it
  is searching for.
- **Settings sets the shared web search.**
  - `set_config` takes `search_url` (http or https only) and `search_api_key`. The key is kept in
    `secrets.json`, where the CLI and the Pips runner read it.
  - `get_config` `fields` can ask for `search_url` and `search_api_key_set`. The key itself never crosses
    the wire.
- **Files, images and long pastes in ChatDGC.** `chatdgc_send` takes `attachments`, up to 10:
  - a picked file, by its `path`;
  - a pasted image, as a `data:` URI;
  - pasted text.

  Documents are read with DGC's document reader, other files only as UTF-8 text, and images only by their
  own bytes. The chat keeps its own copy, owner-only, deleted with the chat. The model reads each one in
  DGC's attachment frame, which no file can close, and sees the newest eight images as images. A model
  that can't see images is told so before anything is kept.
- **A chat whose model can't see images gets one that can to look first.** ChatDGC tries the sub-agent model,
  then the main model, then a model installed on the same Ollama that says it sees. The look is one request,
  and the message keeps what it saw as `vision`. `chatdgc_activity` has a `looking` kind. `chatdgc_file` shows
  an image the chat keeps, as a `data:` URI up to 2.5 MB.
- **Versions.** `chatdgc_edit` changes a message you sent, and `chatdgc_regenerate` tries a reply again,
  optionally with another model or thinking level. Each makes a new version from that point, and the old
  one is kept. `chatdgc_version` switches between them. A message with other versions carries `versions`.
- **Export.** `chatdgc_export` writes a chat to a path the user chose: as Markdown (the conversation as
  shown, with sources) or as JSON (the whole chat, every version).
- **Custom instructions and personality.** `set_config` takes `chatdgc_about` and `chatdgc_style` (up to 1,500
  characters each) and `chatdgc_personality` (`default`, `concise`, `warm`, `candid`, `nerdy`). `get_config`
  `fields` reads them back. Every chat follows them from its next reply.
- **Search finds what was said.** `chatdgc_list` `query` searches every chat's name and conversation, with
  FTS5 or plain matching without it. A chat found by its words carries `match`, the words around them.
- **ChatDGC sources carry a snippet** (`sources[].snippet`): a search result's own words, or a research note's
  first point, for the reply's source cards.
- **Web search is always there in ChatDGC.** `search` defaults to `auto`, and an `auto` reply first asks the
  model (one small structured call on the message) whether it needs the web; if so it searches and answers from
  the numbered results. The config key `chatdgc_web` (Settings → Web search) turns it off everywhere.
- **Follow-ups in ChatDGC.** After a reply ends, one small structured call suggests up to three next messages
  (`FOLLOW_UP`), kept on the reply as `followups` and sent as `chatdgc_followups`; none after a question card, a
  waiting card, research, or when the model sees nothing natural (a greeting, thanks). Config `chatdgc_followups`
  (Settings → ChatDGC) turns them off. With deepseek-v4.1-flash: relevant ones for 4 real questions, none after
  "Hi" or "thanks, that's all", and none after a reply that asked the user something.
- **Branch in new chat.** `chatdgc_branch` {conversation_id, message_id} makes a new chat from a reply: the
  visible conversation up to it, its files copied, its summary when all of what was summarized came along,
  and `branched` {from, title, at, created_at} on the new chat's conversation; answered by its `chatdgc_opened`.
- **ChatDGC projects.** `~/.dgc/chat/projects.json` and `project-files/<project>/`; a chat's `project`. New:
  `chatdgc_projects`, `chatdgc_project` (create, update, delete with or without its chats, add_files,
  remove_file), `chatdgc_move`; `chatdgc_open` and `chatdgc_list` take `project` (a list without one is the
  chats in none; a search covers all, each saying its project); `chatdgc_opened` carries the chat's `project`.
  A project chat's model reads the project's instructions, its files (a quarter of the window at most) and what
  its other chats are about; project-only memory reads and writes no shared memory. The chat index gains a
  `project` column (added safely when two processes open an older index at once) and a `files` table.
- **Plugins in ChatDGC** (`dgc/chatdgc/plugins.py`). Every plugin turned on (`pip_plugins.installed`) is the
  chat's: `plugin_tools` and `call_plugin`, decided as a Pip's are (`pip_plugins.asks`, `read_only`, each plugin's
  level). A change that asks becomes a card on the reply (`actions`; new event `chatdgc_action`, sent as it's put
  there), decided with `chatdgc_action` (`run` with the user's edited `arguments`, `dismiss`, or `hand` to a
  Personal Pip from `chatdgc_pips`, by `send_pip_message`). A send re-checks the plugin is on, its server's
  fingerprint and the tool's schema, holds the chat's turn slot, and is kept with its answer; later turns read
  what came of each card. The careful check (`pip_careful.Taint`, per chat) forces a card for a change that
  carries what the chat read from apps, and refuses a web search that would. `chatdgc_activity` gains `plugin`.
  - **No made-up wallet addresses**, as Pips have it: a 0x address in `call_plugin` must be one the user gave or
    a plugin answered with, or the call is refused before any card. Plugin answers (`pip_plugins.cleaned`, for
    Pips too) now keep a field holding a public 0x address (40 hex digits): redaction blanked any key ending in
    "token", so Aave's `underlyingToken` never reached the model and the guard refused USDC's real contract
    (live run). A key named like a credential, or a saved credential, is still blanked.
  - **The card is the confirmation.** The plugin instructions now say so: with deepseek-v4.1-flash, "supply 100
    USDC from my wallet 0x…" made the card in 1 of 3 runs (the others asked the user to confirm the address
    first); with the sentence, 3 of 3.
- **What fills the context window, part by part** (founder, from Claude's Usage sheet; phase 1 of
  CONTEXT_BREAKDOWN_PLAN.md: ChatDGC; main DGC, the SDKs and Pips follow). `dgc/context_breakdown.py` puts any
  surface's parts in one shape: `{window, used, source, compact_at, categories: [{id, label, tokens, items?}], buffer,
  free, deferred?}`, biggest first, scaled to the model's own count where it reported one, with the room kept before
  compaction and the free space never below zero. ChatDGC's engine counts its parts as its meter does: the
  conversation and its files (each), its own instructions, the user's (about, style, personality) and memory (the
  same prompt with and without each, at one moment), the project, canvas, data and summary, and the tools a reply
  starts with, each, plugins' included (read from what's installed: nothing connects). Its meter's estimate now
  counts those tools too (the model's count always had them). New `chatdgc_context_breakdown` command, answered on a
  thread by a new `context_breakdown` event (an existing event never gains a field); offered as
  `ready.capabilities.chatdgc.context_breakdown`; in the TypeScript SDK's known events. The screen draws it with
  `media/breakdown.js` (shared, for main DGC and Pips next) in the meter's details, header from the same count.
  - **Main DGC and the SDKs** (phase 2). `Agent.context_breakdown(window, compact_at)` splits a session's window
    into messages and tool results (each message counted as the client counts it), the system prompt by its
    sections (memory, with each file named; skills, each; installed plugins; the rest), built-in tools and MCP tools
    (`server · tool`), each, and the MCP schemas kept back until a search finds them (`deferred`), scaled to the
    meter's own estimate. New `context_breakdown` command answered by the `context_breakdown` event, offered as
    `ready.capabilities.context_breakdown`; `Session.context_breakdown()` (Python, `ContextBreakdown`) and
    `session.contextBreakdown()` (TypeScript) raise unsupported against an older CLI. The side bar's context menu
    draws it.
  - **Pips** (phase 3). A Personal Pip's reply is built by its worker from what was pinned at queue time, so the
    worker measures the parts that stay from one reply to the next as that reply sends them (its instructions,
    each tool, its job, its memory with notices, its skills, its apps note, the rest of its references) and returns
    them as the reply's `context` (`dgc/pip_chat_breakdown.py`, validated where the reply is saved; a measure that
    can't be made leaves it out, never the reply). `get_pip_chat_context` adds `breakdown`: those parts from the
    newest reply, then the brief and the recent messages as the next reply sends them; `used_tokens` now counts
    them all (it counted the brief and the messages only). A Pip that hasn't replied since, or replied on an older
    DGC, shows the brief and the messages alone. The Pip's context menu draws it (the side bar and the Pips tab).
- **A welcome for the time of day.** "What can I help with?" gives way to ChatDGC's mark, its slashes drawn in one
  by one (still, with reduced motion), and a line for the hour (three each for morning, afternoon, evening and night;
  a temporary chat: "Off the record. Nothing here is kept."), chosen once a chat and kept in place across renders.
- **ChatDGC's box, as main DGC's** (founder: the purple ring off, the model and thinking pickers and the context
  meter as main DGC has them, thinking "something creative": he chose a dial). The box keeps its border on focus with
  main DGC's shadow; the tools are borderless. The two native selects stay as what a send reads, hidden behind one
  pill (the model's name, a 16px arc for the level) opening a menu: the models (menuitemradio) and a dial (an SVG
  `role="slider"`: five marks on a half circle, a needle, click, drag or arrow keys, Home and End), each level with a
  plain line of what it costs. The meter is main DGC's pie icon and percentage, and its details use main DGC's own
  context classes, now with **Window size**: `chatdgc_window` takes 8k, 16k, 32k, 64k, 128k, 256k, 512k, 1m or max
  (window.py's list, which the config check now reads), advertised as `ready.capabilities.chatdgc.windows` so the
  screen and Settings offer only what the backend takes; choosing one sets it for every chat and asks for the chat's
  meter again with a new `chatdgc_context` command. Two bugs the new tests caught before they shipped: choosing a
  model closed the menu (the redrawn row was gone when the outside-click check ran: it now reads the event's path),
  and the size picker stayed live while a reply was written.
- **Maths in ChatDGC's replies.** The prompt always asked for LaTeX and nothing drew it, so every formula showed as
  raw `$E = P \cdot r…$`. `src/markdown.ts` gains an opt-in (`setMath`, off for main DGC's chat): `$…$`/`\(…\)`
  inline and `$$…$$`/`\[…\]` display become placeholders holding the TeX (pandoc's rule keeps "$5 and $10" text;
  never inside code; an escaped `\$` stays a dollar; at most 4,000 characters), drawn by KaTeX 0.16.47
  (`dist/katex/`: script, stylesheet and WOFF2 fonts only, ~590 KB, loaded the first time a formula shows, as
  mermaid is) with `trust: false`, `maxSize` and `maxExpand` bounded, and MathML for screen readers. A copied reply
  carries the TeX as written. KaTeX is now a direct, exact dev dependency (it was already locked through mermaid),
  with its license in `licenses/KATEX-LICENSE.txt`.
- **The VSIX allowlist caught up.** `scripts/check-extension-vsix.py`'s reviewed member list (and its mirror in
  `tests/run_tests.py`) lacked 16 files this branch ships (ChatDGC's page, charts and Library, the tab marks, Pips'
  bundles and art, noVNC's licenses), so a release VSIX would have failed it; they're listed now, with ChatDGC's own
  marks and KaTeX's files (154 members; each passes the credential scan, none needs an exemption, ~10 MB of the
  16 MB ceiling).
- **Interactive answers in ChatDGC** (Phase 8, part 5). A `show_widget` tool ({title, html}, once a reply) keeps a
  small self-contained HTML page on the reply (`widgets`, new event `chatdgc_widget`); the extension opens it in a
  webview tab of its own beside the chat (the chat keeps focus), one tab a widget, and the card under the reply has
  **Open** and **Show code**. Not inline: VS Code serves nothing to a frame inside a webview (checked live), and a
  `srcdoc`/`data:`/`blob:` frame runs no script there. The widget's webview has scripts but no local resource roots;
  its page policy loads nothing (`default-src 'none'`, inline script and style only), and
  network and peer-connection APIs are removed before its code runs. The chat page's own policy is unchanged. The
  editor's colours win over a page's own (`!important` theme variables, and `color-scheme` from VS Code's theme kind:
  in a webview `prefers-color-scheme` is the system's, so a model's light-by-default page came out white on a dark
  editor), and an uncaught error shows as a bar in the widget, so a broken one doesn't just sit showing dashes. Each
  widget the real model wrote was then run in Chromium in that page: before telling it the variables are already set
  and that every element its script uses must exist, 1 of 2 live widgets threw on every input and 1 of 2 brought its
  own light colours; after, 9 of 9 ran, changed when used, and used the editor's colours.
  **Checked, fixed once, kept.** Once a widget's tab is open, DGC's part of its page (which takes the page's only VS
  Code handle before the widget's code runs) reports its fields as set and what it shows, with any error it threw
  (`chatdgc_widget_report`, offered as `ready.capabilities.chatdgc.widget_report`; a screen says it reports with
  `chatdgc_open.widget_reports` and answers `shown: false` at once for a chat no tab shows; the reply waits up to 6 s).
  An error goes back to the reply; otherwise a call of its own, never streamed, checks the figures (asked in the
  reply, the model wrote its working there, "Check: r = 0.085/12 …", in 5 of 10 replies even when told not to), and
  only a wrong one goes back. Either way the model may call show_widget once more, replacing the widget in its tab.
  Without the fields' values the check read a widget set to monthly compounding as yearly. A reply that says a widget
  is beside the chat and made none (1 of 7 compound-interest replies) is told once to make it. Measured with
  deepseek-v4.1-flash on 14 asks (EMI, compound interest, prepayment, SIP), each widget run in Chromium in the real
  page: every widget ended working (one threw at first and was fixed in the same reply), every EMI, prepayment and SIP
  figure matched its formula (9 of 9), no reply mentioned the check, and the check flagged 3 of 13 clean widgets, one
  a real mislabelled total and two wrongly (each cost one rewrite, still right). Its fields are kept as you type (the
  60 newest widgets, in VS Code's storage) and put back when it opens again, so its own code reruns on them.
  **In the Library, and back after a restart.** The Library has a **Widgets** tab: `chatdgc_widgets` lists every
  widget a reply made (`op: "list"`, newest first, by name; index version 5 adds a `widgets` table, filled in once
  for an older index), gets one with its page (`get`) or deletes one (`remove`: its page goes, the reply keeps its
  name marked `removed`, is sent again as `chatdgc_message`, and the model reads that the user deleted it; refused
  mid-reply). Offered as `ready.capabilities.chatdgc.widget_library`. A widget's tab names its widget and chat in
  its webview state, so VS Code keeps it across a restart; a serializer for `dgc.chatdgcWidget` asks for its page
  once the backend is up (a deleted one closes).
  Without tools, a ` ```widget ` block becomes the same card, and opens on **Open**. With deepseek-v4.1-flash, as
  a fenced block an EMI calculator or stopwatch went into a canvas or a file 5 of 6 times; as a tool, a widget 9 of 9
  (self-contained and themed), none for a plain question.
- **Data analysis and charts in ChatDGC** (Phase 8, part 4). `dgc/chatdgc/data.py` loads the chat's spreadsheets
  (attached, made, or in its project; CSV, TSV, each Excel sheet) into an in-memory SQLite database; a `query_data`
  tool runs one read-only SELECT (an authorizer allows reading and functions only; 5 seconds; 200 rows) with
  `median`, `stdev`, `variance`, `corr` and math functions added. The tables (columns, types, first rows) are in the
  model's instructions; the reply keeps its `queries` ({sql, columns, rows, count, more | error}), shown as
  "Analyzed the data". Charts are ` ```chart ` JSON blocks ({type: bar | line | area | pie | scatter, title, x,
  series, unit, stacked, horizontal}) the screen draws (`media/chart.js`, SVG, no library). `chatdgc_activity` gains
  `analyzing`. With deepseek-v4.1-flash on a 69-row expense sheet: the right SQL every time, monthly and category
  charts holding the queried numbers 4 of 4, and exact figures in the reply once results were shown in full (6
  significant digits had turned 44,662.76 into 44,662.8).
- **ChatDGC memory saves less, and keeps itself current.** The check before a reply now sees what's remembered (ids
  and facts) and returns `forget` for facts a message outdates, removed with the reply's `memory` op `forgot`; its
  rules leave out a task's details (an email's recipient, date or flat), plans and guesses. It runs whenever memory
  is on, web search off too (then with no search and no pictures), and the model's own `remember` is for "remember
  that…" only. With deepseek-v4.1-flash, 11 cases twice: a landlord email saved 2–3 facts, now none; a birthday
  message duplicated a sister, now nothing; a weather question guessed a city once, now never; "not vegetarian
  anymore" left the old fact 2 of 2, now replaces it 2 of 2; real facts (diet, health, family, a new job) still saved.
- **Canvas in ChatDGC** (`dgc/chatdgc/canvas.py`), as ChatGPT has it: tools `canvas_create` and `canvas_edit` (exact
  find-and-replace edits, each found once, or a rewrite); the canvas is a file under `~/.dgc/chat/canvas/<chat>/<id>/`
  that the editor opens beside the chat, read fresh every turn (the user's edits become a version of theirs first),
  with versions in `.versions/`. New event `chatdgc_canvas` (as a reply makes or changes one), command
  `chatdgc_canvas` (get, restore, export through made.py), `chatdgc_send` `canvas_selection` (a part of a canvas the
  message is about; kept as `canvas` on the message), the reply's `canvases` cards, `chatdgc_activity` `canvas`.
  Branches copy a chat's canvases; deleting a chat deletes them.
- **The formatted canvas (Canvas option B)**: a document canvas opens in a custom text editor
  (`dgc.chatdgcCanvasDoc`, `src/canvasDoc.ts`) over the same `.md` TextDocument, so save, versions, the model's
  edits and the title-bar commands are unchanged. ProseMirror (`src/canvasEditor.ts`, `dist/canvas.js`) edits it;
  `src/canvasMarkdown.ts` reads the file block by block and writes it back with every untouched top-level block (and
  what followed it: blank lines, link definitions) byte for byte, so the model's exact find-and-replace still finds
  its text; tables and display maths stay their own Markdown, drawn. Typing goes to the host as the one range that
  changed and is saved after a 1.2 s pause; the model's change is posted to the page and flashes as a decoration; Ask
  on a selection sends its lines in the file (`canvasAskAbout`). The maths rules moved to `src/markdownMath.ts` so
  the canvas bundle doesn't carry the code highlighter. Licenses in `licenses/PROSEMIRROR-LICENSES.txt`.
- **Tables, maths and checklists edited in the formatted canvas** (they had opened in Markdown). A top-level GitHub
  table is a prosemirror-tables table (1.8.5; cells hold a line of inline text; alignment per cell, written per
  column), written back as `| … |` with its alignment row and pipes in cells escaped; Tab/Enter move between cells,
  and a second toolbar row (shown in a table) adds and deletes rows and columns, aligns a column and deletes the
  table, keeping the cursor in the table after a delete. Display maths is a `math_block` node (`$$`/`\[` kept,
  written as fenced lines when changed); inline and display maths open a TeX box with the result drawn by KaTeX as
  you type; input rules make `$…$` a formula (only with a letter or a TeX sign in it: `$5 and $10` stays text) and
  `$$ ` an equation. GitHub task lists (`- [ ]`, `- [x]`) are list items with `checked`, read by a token pass that
  takes the box off the item's text; a box ticks them; Enter splits a ticked item into an unticked one. A table or
  display maths inside a list or quote stays a kept block (its lines carry the container's indent).
- **Writing blocks in ChatDGC**, as ChatGPT has them: the prompt (`DRAFTS`) puts a draft the user will send as it is
  in its own ` ```email ` (Subject:, To:) or ` ```draft ` block; `chatdgc_draft` {conversation_id, message_id, original,
  text} edits one in place (answered by `chatdgc_message`; refused mid-turn, or when the block's words changed
  since). Real model (deepseek-v4.1-flash): emails 4 of 4 in their block with a subject and plain text, revisions
  rewrite the whole block, other drafts 5 of 6 labelled (the screen also reads a label on the line after the
  backticks), no block for a plain question. And main DGC's no-emoji rule: none in 12 replies that didn't ask; a
  caption "with emojis" still gets them.
- **Study mode in ChatDGC**, as ChatGPT's "Study and learn": `chatdgc_send` takes `study` (true on, false off,
  left out unchanged); the chat keeps it (`study` on the conversation) and its system prompt then adds `STUDY`
  (`dgc/chatdgc/prompt.py`): find the level first, one step at a time, end with something to try, hints before
  solutions, a quiz every few steps through `ask_user` (exactly one right option; the choice comes back as the
  next message), and the answer when asked for it.
- **Files ChatDGC makes** (`dgc/chatdgc/made.py`), as ChatGPT hands you a report: a `make_file` tool (up to 3 a
  reply) takes `name`, `format` (docx, pdf, xlsx, pptx, csv, md) and `content` (Markdown) or `sheets` (rows) or
  `slides` (titles, bullets, tables), and DGC lays the file out with the standard library and markdown-it-py
  (already rich's): Word with title, headings, lists, tables and links; Excel with numbers as numbers, formulas
  computed on open and a frozen header row; PowerPoint 16:9 with a title slide, bullets and tables. A PDF is
  printed by the user's Chrome or Edge (`dgc.browser`, `Page.printToPDF`, DGC's own page with every load
  blocked), or, without one, by a built-in Helvetica writer whose `note` says what it couldn't draw. Each file
  is kept like an attachment (a temporary chat's in memory), shown live by a new event `chatdgc_made`, carried
  on the reply as `files`, opened or saved with `chatdgc_library_file`, read back by later turns (its source,
  up to 12,000 characters), listed in exports, copied by a branch, and in the Library as `made`
  (`chatdgc_library` takes `origin`: `made` or `uploaded`, and answers `origins`; index version 4).
  `chatdgc_activity` gains `making`.
- **The ChatDGC Library.** `chatdgc_library` lists every attached file (chats, archived ones too, and
  projects), newest first, by `kind` and name, with `counts` per kind; `chatdgc_library_file` saves one where
  the user chose, removes one (its chat keeps the attachment marked `removed`), or copies one into a project. A
  send's `attachments` take `{kind: "library", conversation_id | project_id, attachment_id}`, copied into the
  chat; the extension forwards only files picked for that tab.
- **Pictures from the web, where seeing helps.** The same check (for `auto` and `on`) names an image search
  when pictures are part of the answer (a place, a dish, an animal, a product, a style), and none otherwise.
  The backend runs it with the search set in Settings (`dgc/search.py` `images()`: DuckDuckGo through `ddgs`,
  Brave, Tavily, SearXNG), fetches the first four small copies that are really pictures (public https, 400 KB
  each), and keeps them with the chat like attached images. A new event, `chatdgc_images`, shows them while
  the reply streams; the reply carries them as `images` {query, items: [{id, kind, mime, title, url, site,
  image, width?, height?}]}, and `chatdgc_file` serves each by id. The model is told they're shown and that it
  hasn't seen them; a later turn reads that they were.
- **Shared memory.** One memory about the user (`dgc/shared_memory.py`, `~/.dgc/memory/facts.json`), read by
  ChatDGC, Work sessions (under `# Memory`) and Personal Pips (pinned into each run), and written by ChatDGC's
  `remember` and `forget` tools only when the user said it (the Pip-notes rule), never a secret, at most three
  a reply. Your projects come from your Work sessions' index. `memory_list`, `memory_add`, `memory_edit`,
  `memory_forget`, `memory_clear` and `memory_project` are answered by `memory_state`; the config key `memory`
  turns it off everywhere. Pip notes now match a fact at the end of a sentence ("vegetarian." is
  "vegetarian"). The look-up check before a reply also lists, in `remember`, the lasting facts the user states
  about themselves; they're kept as the tool keeps them (deepseek-v4.1-flash, told to call the tool, missed 2 of
  7; with the check 7 of 7, nothing kept from 7 messages that state none, and at most one or two from a question
  that carries some of their life, on two runs: 16 and 17 of 17).
- **Deep research.** `chatdgc_research` makes a plan; `chatdgc_research_start` runs it as edited (or writes from
  what a stopped run found); `chatdgc_research_steer` adds to it while it runs; `chatdgc_research` reports
  progress. Up to three rounds of searching and reading (about 20 pages, PDFs included), a note per useful
  page, one report from the notes, and every citation checked against its note. `chatdgc_export` takes
  `format: "report"`. Pages are read through the same public-only fetch as `web_fetch`, which now also returns a
  PDF's bytes to research.
- **Questions in an answer.** A reply can ask the user one multiple-choice question as it goes (the `ask_user`
  tool, which doesn't wait). `chatdgc_question` carries it as it's asked, and the reply keeps it in
  `questions`. `chatdgc_answer` sends the message the model wrote for it, with the choice in, and that message
  carries `answers`. A model that can't take tools now answers without them, where web search used to fail it.
- **The context window.**
  - Each chat uses the model's real window, capped by `chatdgc_window` (`8k`, `32k`, `128k` or `max`),
    and sends it with every request.
  - Before a reply would fill more than 75% of the window, the older turns become a rolling summary and the
    recent ones stay word for word. This is reported with `chatdgc_activity` `compacting`, then
    `chatdgc_compacted`. If the summary can't be written, the reply still goes. A summary grows by
    parts: what was summarized stays word for word and only the new stretch is added, so nothing earlier is lost
    to a rewrite; one past 15% of the window is shortened once.
  - `chatdgc_compact` compacts now, `chatdgc_summary` edits the summary, and `chatdgc_carry` continues in a
    new chat with a summary.
  - One attachment takes at most 40% of the window.
  - `chatdgc_context` reports what a chat takes after every turn and when it opens: the model's count of
    the reply's last request, or an estimate before any reply and after Compact now or an edited summary.
    `compactable` says whether Compact now has more than the last exchange to summarize.

### Troupes: many sub-agents on one work order

- **A troupe, under Ultra.** For a job too big for one agent to do reliably (review forty files and check every
  finding, research a list of questions, make the same change in many places, compare options), the model writes a
  work order and DGC runs it exactly as written, in the background: every item gets its own agent, every finding its
  checkers, nothing skipped. The chat stays free and wakes with the results. Four templates (review, research,
  change, compare) or up to four stages of its own, each with a prompt per item, a JSON shape every agent ends with,
  and optionally votes (several agents independently), keep (only what enough of them agree on), split (a list in
  each result becomes the next stage's items) and over-all (one agent sees everything). A work order is data, not a
  program: local models write it reliably and there is no script runtime to confine.
- **Auto mode just runs it**; other modes ask first with the plan in words ("Start a troupe?"); plan mode never
  starts one. `Troupe` is a rule name (`Troupe(review)` allows review troupes; `"deny": ["Troupe"]` turns them off).
- **Its agents:** explorer, researcher, critic and verifier read only (web included) and run beside your files; a
  worker writes in an isolated checkout of its own and its change is merged back as a sub-task's is. They never
  ask; a step that would is refused. One at a time on a model served on this machine, up to 8 at a time on a remote
  or cloud model. The turn's token cap counts them all; a troupe starts at most 400 agents.
- **Seeing and stopping it:** in the editor, a row above the prompt box with each stage's progress and Stop (events
  `troupe_started`,
  `troupe_progress`, `troupe_finished`; commands `list_troupes`, `stop_troupe`; `ready.capabilities.troupe`). In the
  terminal, a line per finished stage and `/troupes [stop ID|all]`. A one-shot `dgc -p` run waits for it inside the
  call.
- **A journal per run** in `~/.dgc/troupes/<id>/` (work order, every agent's result as it lands, the last stage's
  results, the report), so a stopped troupe resumes with `resume: <id>` and redoes only what had not finished.
- Live, with deepseek-v4.1-flash:cloud: "review every Python file in app/ for security problems and double-check each
  finding" started a review troupe on its own (4 explorers, 9 verifiers, 76 s for the whole turn): it kept exactly
  the three planted problems, each confirmed 3 of 3, and left the constant-time token check and the clean file alone.

- **A troupe on a schedule, as a Pip routine.** "Every Monday at 9, review last week's changes and double-check what
  you find" makes the troupe a routine of your Primary Pip (or the Pip you name) instead of running it now: the
  `troupe` tool takes `routine` (`every` day, weekday, week or hours, `at`, `day`, which `items` each time: changed
  since it last ran, matching a pattern, or a list, and which `pip`). Outside auto mode the card asks "Schedule a
  troupe?", and Always allow saves `Troupe(routine)`, separate from running one. When due, it runs as a job of its
  own (`python -m dgc.troupe_job`) with your model on a snapshot of the project's committed code, one at a time, for
  at most an hour; then the Pip tells you what it found in its chat, the report handed to it as data. Its tokens
  count in the Pip's usage; "changed" remembers the last commit it reviewed. Read-only troupes only: a change
  template or a worker stage is refused. Pips registry schema 45 (`pip_routines.troupe`).
- **A verifier for ordinary sub-agents too.** `task`'s roster gains `verifier` beside explorer, researcher, critic and
  worker: it tries to prove a claim or a change wrong, reads and runs the tests or commands that would show it (in
  its own checkout, which has your uncommitted edits), edits nothing, and starts its answer with CONFIRMED, REFUTED
  or UNSURE. A troupe's verifier answers in JSON, with its own read-only box (below). A `~/.dgc/agents/verifier.md` of your own
  still replaces it.
- **A misplaced `split` says where it goes.** "stages[1].split must name a list field in returns" cost a model two
  attempts: it had put split on the verify stage instead of the audit stage that returns the list. The refusal now
  names the stage's fields, says split goes on the stage that produces the list, and suggests the fix (`Did you mean
  "split": 'findings' on stages[0] ('audit')?`).
- **A troupe's size counts its splits.** It said "about 32 agents" for 8 areas checked by 3 verifiers per finding,
  then started 107 (33 findings) and ran for two hours. It now says "8 agents to start, then 3 per item of audit's
  findings (verify); at most 400 in all", and the number it reports (`agents_planned`, the editor's "About N
  agents") becomes the real one as soon as the split's stage ends; the terminal says it once ("107 agents in all,
  now that each split is known").
- **Troupe checkers say what they couldn't check, and that isn't a no.** The `troupe` tool said only "read only" about
  explorer, researcher, critic and verifier, so a model told its verifiers to re-run SQL. They have no shell; they said
  "bash/docker was refused" and voted "not real", and `keep` dropped findings nobody had checked. Now:
  - The tool's description and each agent's role say exactly what each kind can do: explorer, researcher and critic
    read files and the web with no shell (no commands, tests or database queries); a verifier has its read-only box
    (below) where this computer can run one; a worker has a shell and writes in its own checkout. The start message
    says it per stage.
  - A reading stage with `keep` asks each agent, when it can't check something with its tools, to add
    `"unsure": true` instead of guessing. Such a vote counts neither way: the votes that did check decide (most of
    them, or `at_least` of them as far as there are any), and an item no one could check is kept with
    `"unchecked": true`. The report counts them ("2 kept (1 of them unchecked)") and marks each one
    ("UNCHECKED: none of 3 could check it", "1 of 1 agreed, 2 could not check").
- **Troupe verifiers get a read-only shell in a sealed box, and a project can give them a read-only database
  account** (the founder's decision). A `verifier` now has bash, every command run in DGC's bubblewrap box: the
  project read only (at `/mnt` and its own path), a private `/tmp` the one writable place, credential files hidden
  as from a Pip snapshot (`.env*`, keys, `.git`, `.ssh`, cloud configs; dependency and build folders stay so tests
  run), homes and `/run` (Docker's socket, D-Bus) empty, no capabilities, and no network. Its bash needs no approval
  (it is the box), yet your own deny and ask rules for Bash still come first. A refused write says it was the box
  working, not a fault.
  - **`dgc readonly-db set|show|clear|guide`**: one `postgresql://` address per project for a role you made read
    only (`guide` prints the SQL; DGC never creates or changes a role). It is kept as a plugin's sign-in is (system
    keychain, or an owner-only file), read from the terminal or a pipe and never from the command line, and must be
    a database on this computer. A verifier's box reaches it through one forwarded port and nothing else, as
    `$DGC_READONLY_DATABASE_URL`; a worker gets the same variable as the connection to prefer for reads. Its
    password is redacted from the agents' tool output and replies.
  - Where the box can't run (stock Ubuntu 23.10+ AppArmor, no bubblewrap, macOS), a verifier has no shell and is
    told why, and to answer unsure rather than "not real". The `troupe` tool's description says exactly what each
    kind can do on this computer and in this project (box or not, database or not).
  - Live, on this machine: through a throwaway Postgres in Docker and the read-only role from `guide`, a verifier's
    box ran `select count(*)` (3 rows), was refused an UPDATE ("cannot execute UPDATE in a read-only transaction"),
    and could reach neither the machine's other Postgres on port 5432 nor the internet.
- **The model can read a running troupe's status.** Asked twice for an update, the model was told `list_tasks` was "not
  offered on this request" and parsed the troupe's `results.jsonl` with its own Python. `list_tasks` and `wait_tasks`
  are now offered whenever a troupe this chat started is running (state, never wording; `message_task` and
  `close_task` still only for sub-agents). `list_tasks` lists the chat's troupes after its sub-agents: state, minutes,
  size, each stage's agents done of total, what the votes say so far ("so far 12 said yes, 6 no, 2 could not
  check"), what each finished stage kept, and where the results are. `wait_tasks` takes a troupe's id and returns its
  report when it ends.

### Windows: the editor runs DGC in a WSL distro of its own

- **VS Code or Cursor on Windows, folders on `C:\`, nothing else to install.** The extension starts `dgc serve`
  through `wsl.exe` in a distro DGC owns (`DGC`, Ubuntu 24.04, its own user), with no shell between them
  (`wsl.exe -d DGC --cd <folder> --exec ~/.local/bin/dgc serve`), and translates every path in the protocol that
  names a file on either side, both ways, by field (never free text, tool arguments, rules or paths inside a Pip's
  computer). Setting it up is dialogs in the editor: turn on WSL (administrator, then a restart), then download
  Ubuntu with `--web-download`, prepare it as root from fixed text, and run the installer as DGC's user.
- **A model on Windows' own localhost** (Ollama or LM Studio installed on Windows): WSL's default NAT networking keeps
  it out of reach (curl exit 7 from the distro). In DGC's own distro (marked `/etc/dgc-distro` at setup), a model URL
  on a loopback port that answers nothing there but answers on Windows gets a listener there, for the process's
  life, whose every connection Windows PowerShell carries; one relay waits connected, so a request costs 0.01 s
  instead of the 1.2 s a PowerShell takes to start. Never in a distro of your own, where the port stays yours.
- **Keep Pips running in WSL now starts at sign-in.** The Run list handed `wslg.exe` a `--exec`, which only `wsl.exe`
  has: Windows showed wslg's usage in a dialog at every sign-in and started nothing. It is now
  `-d <distro> --shell-type none -- /bin/sh <script>`; across two reboots the runner was online with no dialog.
- **What a real Windows 11 (build 26300, WSL 3.0.3) taught it:** the inbox `wsl.exe` writes UTF-16 even with
  `WSL_UTF8=1`, and says "not installed" on every command (exit 1, or 50 for `--status`); WSL 3 writes "There is no
  distribution with the supplied name" on stdout, not stderr, and exits -1; a distro installed through the Store
  from an editor sat at 0% CPU for 15 minutes, while `--web-download` took a minute. All of it is in the tests,
  with the bytes Windows wrote.

### Windows: DGC inside WSL

A Windows user's DGC is a Linux install inside WSL (the installer is a shell script, and VS Code and Cursor connect to
it there). DGC now notices it is in WSL and handles the four ways WSL differs.

- **Keep Pips running works in WSL.** WSL stops a distro soon after the last Windows program attached to it exits,
  systemd services included, so the systemd unit kept nothing running once the editor closed. In WSL the switch now
  adds the runner to your own Windows Run list (no admin rights), through `wslg.exe`, WSL's launcher that opens no
  window: Windows starts it when you sign in, and while it runs WSL keeps the distro running. A failed runner
  restarts after 30 seconds; Pips off or stopped ends it; turning the switch off removes it. It needs a current WSL
  and interop, and says so when either is missing.
- **Your signed-in Chrome from WSL is the one on Windows.** DGC finds its profile on the Windows drive and connects
  straight to it when WSL shares Windows' network (mirrored networking). Otherwise Windows PowerShell connects on the
  Windows side and passes the bytes along, as nothing else in WSL can reach Windows' loopback. Chrome asks you as
  always. Measured with PowerShell 7.6 on Linux: the exact relay script carried a 3 MB round trip byte for byte and a
  whole Chromium DevTools session.
- **Pip notifications show as Windows notifications** (WSL has no notification service).
- **WSL 1 says what it can't do:** it has no Linux kernel of its own, so Pips can't box commands or have a
  computer there. The Pip's page and `dgc pips execution` say `wsl --set-version <distro> 2`.
- **Native Windows (experimental):** Pips point you to WSL, and Work's browser finds Microsoft Edge (in every
  Windows 10 and 11) or Chrome wherever Windows installed them, including Chrome installed for one user.

### Models

- **Ollama failing inside a reply, before anything was shown, is retried.** Ollama can answer 200 and then send
  `{"error": "Internal Server Error"}` as the stream's first line. That ended the turn, where the same error before the
  stream is retried; now it is retried too, from the same four tries. Once text, thinking or a tool call has been
  shown, it still stops, since sending the request again would show it twice.
- **An image the provider can't read no longer ends the turn.** A 400 such as "illegal base64 data at input byte 4" for
  an attached image or a screenshot the model asked to see: the request goes again without the image, and the model
  is told the provider couldn't read it. The model is still treated as able to read images.
- **Ollama cloud replies stream.** Ollama's cloud labels its line-by-line stream `application/json`, and
  DGC read that body whole, so a `:cloud` model's reply reached the screen all at once when it ended, in
  Work, in Pips and in ChatDGC. Each part now arrives as the model writes it. A reply that really is one
  object is still read whole.

### Sessions

- **The time line on each message has the day and date** (`Local time: Sunday 2026-10-18 16:40 (Asia/Kolkata)`; it
  was the time of day only). Twelve days into one chat, the model wrote the last date it had seen in the transcript
  into a Troupe title and a Pip's reason, though the session prompt had the right one. The line rides with the newest
  message, so prompt caching is unchanged.
- **Each prompt and reply records when it was written** (`_dgc_at` in the session file; never sent to a model), so a
  reopened chat in the editor shows its times and how long each finished turn worked. Sessions saved before keep no
  times.
- **The token cap per turn is in Settings → General.** `turn_token_budget` (tokens one turn may spend, sub-agents
  included; 0, the default, is no cap) could only be set in `config.json`. When it is reached, no new sub-agent
  starts and the turn wraps up, keeping its work. The `config` event carries it only to an editor that asks for it
  (`get_config` `fields`).
- **A Work session brings its own Chrome, so it can check the pages it builds.** With no Chrome or Chromium on the
  computer, the browser tool used to stop at "No Chrome found", and a web page was shipped unchecked (in the
  overnight battle, one only worked from a server, not from the file it was opened as). Now DGC fetches one, once,
  and the first browser call waits for it (a minute or so), then says so:
  - **Linux:** the same Google Chrome DGC downloads for Pip computers: Google's package, checked against Google's
    signing key, with no admin password. Work runs it as a separate browser with a throwaway profile, so it never
    shares a Pip's browser, cookies or tabs.
  - **macOS:** Google's own installer, opened read-only, its app kept under `~/.dgc/browser` only when `codesign`
    says it is intact and signed by Google LLC as Google Chrome, and re-checked weekly. (Google's "Chrome for
    Testing" carries no Google signature on a Mac, so it isn't used.)
  - A Chrome you have still comes first (on a Mac, `~/Applications` too), and a wrong `browser_path` is reported,
    never replaced by a download. A download that failed is tried again after an hour, not on every call (one
    DGC quit in the middle of, at once), and none starts where the Chrome couldn't run: user namespaces restricted
    and no bubblewrap allowed to lend them (a stock Ubuntu 24.04; DGC tries a box rather than trusting that
    bubblewrap is installed). There it says to install Google Chrome, whose package brings the AppArmor profile.
- **Your own Chrome, signed in, for the tasks that need your logins.** The browser tool takes `signed_in: true`:
  DGC opens a window of its own in the Chrome you're running and works in that one tab, as Claude Code's and
  Codex's Chrome extensions do, with no extension: Chrome 144+ lets you allow remote debugging of your browser
  (`chrome://inspect/#remote-debugging`), asks you each time DGC connects, and shows its automation banner. DGC finds
  it by the `DevToolsActivePort` file in its profile folder (Chrome, Beta, Edge, Brave, Chromium; Linux, macOS,
  Windows). It never touches your other tabs, their events, cookies or storage, and closes only its own tab.
  - Opening a site asks you, in every mode, auto included ("Use your signed-in Chrome on mail.google.com?"), however
    the call is spelled and whatever operation carries an address. Always allow saves `Browser(signed-in:https://site)`,
    that site alone. A rule for the throwaway browser never covers it; a deny does, checked where the tab is
    (`Browser(signed-in:*)` turns it off), and an ask rule makes clicks there ask. Plan mode never uses it.
  - Reading and acting happen only on an allowed site: a redirect, a click or a script that takes the tab elsewhere
    stops before anything of that site is read. An address Python and Chrome would read as different sites (a
    backslash, a user name) is refused. Password, card and one-time-code values are never read out (in the
    throwaway browser too), and tabs DGC's page opened close with its own. A closed window or a restarted Chrome
    reconnects on the next call (Chrome asks again).
- **On a stock Ubuntu, the model asks you to install Chrome once, and never works around it.** Ubuntu 23.10+ keeps
  the namespaces a browser's sandbox needs for programs an admin installed, and its bubblewrap has no profile that
  lends them. DGC downloads Google Chrome's package (from Google's repository alone; apt checks it against Google's
  signing key) and the browser tells the model to ask for `sudo apt install <that package>`: Chrome then lives where
  Ubuntu's own AppArmor profile lets it sandbox itself, and apt updates it. An installed Google Chrome comes before
  Playwright's there. The model is told not to work around it (no `--no-sandbox`, no `browser_allow_unsandboxed`).
- **A Pip's computer says when bubblewrap can't build its box, and how to fix it.** It used to check only that
  bubblewrap was installed, so on a stock Ubuntu every computer failed to start. DGC now tries a box with the
  computer's own isolation, downloads nothing when it can't, and the Pip's page and Settings give Ubuntu's own fix,
  once: turning on its shipped `bwrap-userns-restrict` profile (as OpenAI's Codex documents).
- **A Chrome that can't build its own sandbox gets the help it needs from bubblewrap.** On Ubuntu 23.10+, only a
  Chrome with an AppArmor profile gets the user namespaces its sandbox needs, so Playwright's Chromium and DGC's own
  download refused to start unless you set `browser_allow_unsandboxed`. Such a Chrome now starts in a bubblewrap
  box that lends them: Chrome's own sandbox runs inside and keeps every page contained (`chrome://sandbox`:
  "adequately sandboxed", checked by a live test). The box also keeps your home folder and DGC's environment
  variables (keys, tokens) out of Chrome's sight, bubblewrap's own process included, keeps proxy settings off the
  command line other users can read, and ends with DGC, a crash included. ChatDGC's PDFs, printed by the
  same browser, now get full typography there instead of the plain fallback.

- **A hangup no longer half-stops DGC that was started with hangups ignored** (under `nohup`, or from an editor
  launched that way). DGC took SIGHUP over anyway: the CLI handed its colors back and carried on, and `dgc serve`
  stopped every turn. A signal ignored when DGC starts now stays ignored.
- **The Sessions list holds thousands and searches them.** Listing read every session file in full on
  every refresh; a per-project index (`<sessions>/<project>/.index.sqlite`) now keeps what the list
  shows and a full-text copy of what was said, and reads a file again only when it changed. A broken
  index never hides a session: the list reads the files. `list_sessions` takes `limit` (1–5000),
  `offset` and `query` (a session's name, first message or anything said; FTS5, or plain matching
  without it); a session found by what was said carries `match`, the words around it. The
  `session_paging` capability says a backend takes them.

### Plugins

- **You choose what Sign in with GitHub may do.** The sign-in asks GitHub for exactly the permissions chosen on
  GitHub's page (or with `dgc plugin sign-in github --scopes notifications,gist`), not every scope GitHub's MCP server
  lists: code, issues and pull requests (`repo`), your organisations (`read:org`) and your profile and email
  (`read:user user:email`) always; Notifications, Gists, Projects and Packages (read, write) only when turned on. The
  choice is kept with the plugin in `installed.json`. A sign-in already made keeps what it has until you sign in
  again, since GitHub asks you to approve a change; `dgc plugin sign-in` signs in again when the choice changed, and a
  sign-in again that is cancelled keeps the one there was. `dgc plugin show github` lists the permissions, which are
  on, and what the sign-in has.
- **A GitHub tool that needs a permission you didn't choose says which one,** in plain words, and where to turn it on
  ("GitHub needs your permission for Notifications to do this. Turn it on under “What DGC may do on GitHub” …"). It no
  longer widens the sign-in by itself or holds the next connection for it; GitHub's page marks the permission a tool
  asked for. A sign-in DGC has to make again in a later chat asks for the chosen permissions too.
- Editor protocol: new command `set_plugin_sign_in_scopes {request_id, name, scopes, sign_in_again?}` (capability
  `plugin_sign_in_scopes`); the plugin list's keys carry `sign_in_scopes` (each permission: `chosen`, `held`,
  `asked`) and `signed_in`.
- **A cancelled sign-in says so.** A plugin whose sign-in you cancelled or declined now reads "Sign-in cancelled.
  Connect again when you're ready." on its card and in `/mcp`, and any other connection you stop reads "Connection
  cancelled.", instead of the raw "initialize failed: cancelled by user".
- **GitHub, Brevo and Arize take their key on their own page.** Connect on GitHub said "Configure GITHUB_PAT_TOKEN in
  MCP server settings before connecting." Now Settings → Plugins → GitHub has a field for your personal access token,
  with a link to make one and the permissions it needs; Save keeps it where DGC keeps sign-ins (the system keychain,
  else an owner-only file), the page shows Saved (never the token), and Remove forgets it. Connect then needs no
  environment variable; `GITHUB_PAT_TOKEN` in the environment still works, and a saved key is used before it. A key is
  only ever sent to the address it was saved for, uninstalling the plugin deletes it, and a key the service refuses
  says so plainly ("GitHub didn't accept this personal access token (HTTP 401) …"). A plugin with no key yet
  says "Needs a GitHub personal access token. Save it on GitHub's page in Settings → Plugins, or with: dgc plugin key
  github." — also when a new chat starts, which used to say "header refers to GITHUB_PAT_TOKEN, which isn't set".
- **`dgc plugin key NAME [--remove]`** saves a plugin's key from a terminal: typed at a hidden prompt, or piped in,
  never an argument other users could read from the process list. Then it connects.
- **Sign in with GitHub, ready for DGC's app.** GitHub's sign-in server lets no app register itself and wants an app's
  secret for a browser sign-in, so DGC uses GitHub's device sign-in, which needs only a public client id: a short
  code, copied for you, entered at github.com/login/device. DGC's own client runs it and refreshes the sign-in with no
  secret. It turns on once OpenPeach's GitHub app id is in the catalog (or `github_sign_in_client_id` is set in
  `~/.dgc/config.json`); until then the token field is the way in.
- **Editor protocol:** `ready.capabilities.plugin_keys: true` offers `set_plugin_key {name, key, server?}` and
  `remove_plugin_key {name, server?}`, answered with `plugin_operation` and `plugin_catalog`; plugin list items carry
  `keys` (`server`, `env`, `saved`, `from_environment`, `sign_in`, and how to label and make the key), never a key.
- **Asana and Docusign**, set up the way both vendors document for coding tools: you create an app for DGC in your
  own account, and **Settings → Plugins → Apps → Connect** walks you through it: each step, the exact redirect URL
  to register (with Copy), and the ID and secret it gives you. The secret stays in the editor's secret storage.
  Docusign works with a developer account at once; a production account needs Docusign's Go-Live review and your
  admin's MCP approval, which the setup says.
- **Zoom**, the same way: Zoom's MCP server (`mcp.zoom.us/mcp/zoom/streamable`: meetings, summaries, recordings,
  search and Docs) admits only apps registered with Zoom, so you build a General app for DGC in your own Zoom account
  and paste its ID. Zoom's public client has no secret, so there is none to copy, store or send: DGC signs in with
  PKCE alone. The app is registered on `http://127.0.0.1:3336/oauth/callback`, because Zoom asks for `127.0.0.1`
  there, not `localhost`. DGC asks for no scopes of its own, so the ones you add to the app decide what it can do.
  A registered app's own redirect address and scope (RFC 7591 client information) now steer DGC's sign-in; Asana
  and Docusign are unchanged.
- **The vendors' own plugins.** Settings → Plugins (and `dgc plugin list`) offers 41 more plugins
  published by the services themselves, each pinned to a reviewed commit of the vendor's package:
  Airtable, Coda, Craft, Read AI, Granola, Adobe App Builder, Mobbin, Refero, Mural, Intercom,
  Plain, ActiveCampaign, AgentMail, Ando, Brevo, Adspirer, Amplemarket, Apollo.io, Attio,
  Amplitude, Antimetal, Apify, Astronomer, Ahrefs, Context.dev, Crustdata, Harmonic, Algolia,
  Aleph, AWS Core, AWS Amplify, Amazon Location Service, Appwrite, Atlan, Arize AX, Artie,
  Agent Compatibility, 1inch, Aave, Airwallex AgentOS and Airwallex Developer. Every connection
  is the vendor's hosted server (no local app). Each was probed with DGC's own connection code:
  it registers and its sign-in link opens the vendor's login page, or it lists its tools with no
  account (Aave, 1inch); each plugin's page says what was checked. Payment plugins say that
  money moves and DGC asks before each write.
- DGC reads Cursor packages (`.cursor-plugin/plugin.json`, `mcp.json`) and the open Agent Plugins
  standard (`plugin.json` at the root) as well as Claude and Codex packages. A manifest that names
  the same skill folder twice installs it once (Adobe's App Builder failed with "duplicate skill
  names"). A curated entry can set a package's servers (a per-account placeholder URL, a pasted key
  where sign-in works) and the sign-in scope a server needs (Plain).
- A remote MCP sign-in link longer than 2,048 characters is shown instead of failing as "could not
  be completed": Airwallex's lists every scope it supports.
- AWS's hosted MCP server is accepted: its address ends in `?oauth=initialize`, which DGC's
  credential check read as a secret. A server address argument is judged as a URL; the flag
  before it still counts.
- **A plugin waiting for sign-in no longer stops new chats from opening.** Found in real VS Code:
  with Granola installed but not signed in, every new chat said "DGC is reconnecting to this
  chat" for good. Startup connected each hosted server in turn, and one waiting for a sign-in
  nobody could give held the chat past the editor's 10-second session request. Hosted servers now
  connect on a background thread (MCP servers show "connecting"), a turn waits up to 20 seconds
  for them so a first question still sees their tools, and a server that asks for sign-in at
  startup stops at once and says "Needs sign-in. Connect it in Settings → Plugins."
### Pips

- **One Pip's news can be dismissed (Pips API 48).** `mark_pip_news_seen {pip_ids, until}` (1–50 Pips, `until` the
  digest's own `until`, local only) marks those Pips' failed runs and new findings seen up to then: they leave
  `get_pip_digest` everywhere (the side bar's home, the chat's Pips bar, desktop notifications, `dgc pips digest`),
  and a Pip comes back only with a run that ends later. The rest of the digest is not marked seen; waiting reviews are
  not news and stay. It never moves backwards. Pips registry schema 46 (`pip_news_seen`).
- **Pip reports reach the chat.** A finished Pip run now appears in the chats it reports to (the chat it was set
  up in, any chat it is attached to, and the chat that ran it) as a card in the transcript: the Pip, "finished · 5
  findings (2 high, 3 medium)" or "failed:" and why in plain words, the worst findings with file and line, and
  **Ask DGC to fix** / **Open report** / **Dismiss**. It never starts a turn and never reaches the model by itself:
  Ask DGC to fix puts a prompt naming the run in the message box, and you send it. Said when something changes: a
  clean run after a clean one, or the same findings or failure again, is not repeated. A chat that was closed gets
  them when it opens, once. The terminal shows one line per report in the open chat. The tool descriptions now say
  reports arrive by themselves, so a model has no reason to build a polling monitor, and that a report is not a
  request to change anything. Editor protocol: the new event `pip_report {report}`, the history marker
  `{role: "pip_report", report}`, the commands `watch_pip_reports` (a client that draws them asks; an older client is
  sent none and none is taken) and `pip_report_dismiss {run_id}`, and `ready.capabilities.pip_reports: 1`;
  `get_pip` gives `pip.report_chats`. See [docs/PIPS.md](docs/PIPS.md#reports-reach-the-chat).
- **A Pip's run list says why a run failed.** `dgc pips runs` (and `--json`, and `list_pip_runs`) showed `"error":
  null` for failed runs, so a model that wanted the reason opened the SQLite registry itself. Each failed row now has
  its error's code and message (the message up to 600 characters), as `dgc pips report` does.
- **One bad quote no longer throws away a Pip's report.** A finding whose excerpt didn't match its line failed the
  whole run (`unverified_report`) and every verified finding with it. Now that finding is left out and named in the
  report's limitations ("DGC left out 1 finding whose evidence it could not verify against the committed code: 5
  'Title' (backend/app/admin_overview.py, line 287): its quoted code isn't at that line"), the same for a path outside
  the snapshot or a file that isn't in it; the rejected excerpt is never repeated. Evidence stays exactly as strict:
  only a finding whose excerpt is at its line is reported. The report keeps its format (at most 12 limitations of
  500 characters). The audit instructions say so, and that anything with no source line (a data problem, a plan, a
  count) belongs in the summary or limitations, never in an extra field.
- **A report DGC can't read gets one repair with the exact reason.** Broken JSON or a field the format doesn't allow
  (`severity_note`) gets one tool-free request that says what was wrong ("Finding 1 has invalid fields: unexpected
  severity_note"). That request had at most 4,096 output tokens and 30 seconds, too little to rewrite a report of more
  than 10 KB, which is the likely reason a broken report ("column 10898") stayed broken; it now gets room for the whole
  draft (up to 16,384 tokens, within the context window) and the time to write it (up to 10 minutes). When the repair
  fails too, the run's error says how ("the repair was cut off at its output limit").
- **A heartbeat Pulse runs on stock Ubuntu 24.04.** A Pulse of local page checks only (`dgc-http-check`, e.g.
  `/auth/me` answers 401 and `/` answers 200) was accepted on a computer where the command sandbox can't start, then
  put off every 30 seconds, 43 times in 21 minutes, without a word, while the model said it was working. DGC's own
  checker runs no project code and was never run inside the sandbox, so such a plan no longer needs it: it is
  accepted, scheduled and run anywhere Pips run, with the same limits, on DGC's own Python, and copies no source.
  Every other command, and every Patch, still runs only in the sandbox.
- **When commands can't run here, DGC says so, why, and how to fix it.** On Ubuntu 23.10 and later, where AppArmor lets
  only programs with a profile make user namespaces, the reason names that and the one-time fix (Ubuntu's own
  `bwrap-userns-restrict` profile, as DGC already suggests for a Pip's computer):
  - **`dgc pips execution --fix`** prints the exact commands and, in a terminal, asks and runs them with your own sudo
    password, then checks again. DGC never runs sudo by itself; without a terminal it only prints them, and neither a
    chat nor the model's shell can run it. `dgc doctor` and the end of `dgc setup` mention it once.
  - A Pulse's setup card says "It can't run on this computer yet: …" before Create Pip, and the `pips_setup` result
    tells the model to say so (`cannot_run_here`).
  - Its status says it too: `cannot_run_here` and `schedule_deferred` (failures, since when, next try) in what the chat
    reads (`pips_context`), and lines in `dgc pips list` and `show`.
  - A due run that keeps failing to start is tried again after 30 s, then twice as long each time, up to an hour, not
    every 30 seconds forever. From the third failure it is an alert, once: the Pips digest says it in its headline and
    is due, and a desktop notification is shown. A run that starts ends the episode. A failed sandbox check is tried
    again after a minute, so a fixed computer doesn't need Pips restarted.
  - Pips API 49 (additive).
- **No more `&amp;` in a Pip's name.** Some providers send a tool call's text HTML-escaped (deepseek through Ollama
  did), and two Pips were saved as "ERP daily audit — data &amp; Tally integrity". `pips_setup` (name, goal, reason)
  and `pips_propose` (name, goal) now decode standard entities (`&amp;`, `&lt;`, `&#8212;`, …) when every `&` in
  the text starts one; a goal that is about escaping, with a plain `&` in it too, is kept as written.
- **`dgc pips types` says what Core is:** the main chat's character, which your Primary Pip (the Personal Pip named
  Core) uses too, and why it can't be a project Pip. It said only that Core "cannot be created as a background Pip"
  while the Pips page showed one named Core.
- **A Pip's run list works on Python 3.10** (Ubuntu 22.04's default). Listing runs read rows while a rollback ran,
  which Python 3.10's sqlite3 refuses: `dgc pip runs`, the Pips page and scheduled checks failed with "Cursor needed
  to be reset because of commit/rollback".
- **A Pip run keeps going.** No step limit, no time limit and no 4,096-token answer cap: a run uses DGC's own output
  budget per response, in the Pip's own context window, compacts as a DGC chat does when it fills, and ends when its
  work is done, when you press Stop, or when it repeats itself without progress. A Patch with reviewed specialists
  (helpers) too: they share its lifetime with no limit on model requests, tool calls, output or time (their policy is
  version 2; saved version-1 runs, which had 5 minutes, 12 requests, 64 tool calls and 4,096 tokens, still read), and a
  helper's long answer is shortened in its summary instead of failing the run. The reviewed number of helper calls
  (1–3) stays. Reviewed tests get their own five minutes from when they start.
- **A Pip's context window and thinking are its own,** set in its message box as in DGC's own chat (they were for one
  reply, and its other runs were held to 32K): saved as you change them (`set_pip_chat_options`, Pips API 47) or by a
  message sent with them, and used by its replies and everything it does on its own. A new Pip starts with DGC's
  context window.
- **Several Pips run at once:** up to four by default (`pips_parallel_runs`, 1 to 32), each one run at a time, so a
  long run no longer holds up every other Pip; stopping the runner cancels every run it owns.
- **The loop guard knows a page can change:** a read after a click (a Pip's computer, Work's browser) is a new look,
  and a click whose next read shows a different page made progress; a click that never changes anything is still a
  loop. A long computer session was refused its fourth identical read after clicks, and stopped at the seventh.

- **No daily token limits.** A Pip runs until its work is done; nothing stops it for what it spent today. Usage stays
  (today, 30 days, the Settings breakdown) to see, never to stop. A Pip the chat creates no longer starts with a
  200,000-token limit, `dgc pips usage` has no `--daily-limit`, and a limit an older DGC stored is ignored. For older
  editors and SDKs `get_pip_usage` keeps `daily_cap` (always null) and `capped_today` (always false), and
  `set_pip_daily_cap` refuses a number.

- **What Pips say back, in plain words.** A project setup card's notices ("Once you accept, it's on, with the
  schedule shown…", "Its schedule runs only while Pips are running on this computer. Accepting this doesn't start
  Pips."), Pulse's scope, the Pip type descriptions, the note shown beside a Pip chat's summary (the model's own
  notice is unchanged) and the refusals the Pips view shows: "Pips are stopped on this computer. Resume Pips (or run
  dgc pips resume), then try again." instead of "on this runner", and "Raise or remove the limit in its Settings."
  instead of "in its Job tab", which no longer exists. Error codes, fields and stored values are unchanged.
- **A fenced Pip draft is read, not refused.** A Quill run failed outright when the model wrapped its JSON in a code
  fence or a sentence ("Draft JSON rejected ... line 1, column 1"). The one object inside is now taken out and parsed
  just as strictly, every citation checked against the source again; no model rewrites it, so a citation that doesn't
  hold can't be dropped to get through. A lone surrogate in a report or draft is refused as before, not a codec error.
- **Needs attention: one list of everything your Personal Pips wait on you for.** `list_pip_attention`
  (`limit` 1–100, local only) reads every card across all your Personal Pips, newest first: emails,
  calendar events and plugin actions to Allow, prepared app actions, Connect cards, plugin requests,
  setup cards, submits a Pip's computer holds, robot checks and suggested routines. Each item names its
  Pip and the card (`kind`, `card`, `title`, `detail`); `counts` per kind and `by_pip` stay exact when the
  items are cut at the limit. Reading it never expires or changes anything (one rolled-back snapshot).
- **What a Personal Pip remembers about you is yours to see and forget.** As it replies to your own
  message, a Personal Pip may keep a short note of something you told it (a new `remember` tool, three a
  reply at most): your name, who people are, what you like. A note that shares nothing with your message
  is refused unless at least half its words, and any address or number in it, are the user's own, so an
  email or a page it read can't plant one; the tool isn't offered in a routine's run or a turn DGC wrote
  (DGC's hello included), and the supervisor checks each note again. Notes reach a run only as it starts
  and are never saved with it, so Forget leaves no copy. `list_pip_notes`, `add_pip_note` (`text`, up to 300 characters, no
  credentials) and `forget_pip_note` (`note_id`, or `all: true`) are local only; Forget deletes the note.
  Its later chats and tasks get the newest notes as reference, redacted again at queue time; a Pip keeps
  60. Registry schema 44 (`pip_notes`). A Personal Pip's chat no longer pins an empty exceptions memory,
  whose notice told it not to keep notes.
- **Careful mode, for a Personal Pip with a computer, on unless you turn it off.** The first time its
  browser goes to a site (its registrable domain), the run is held with a card ("Let Ava visit
  amazon.in?"); Allow adds the site for good. Sites you named in your own messages, the computer's home
  page and sites you open on its screen never ask, and a frame inside a page never does. Text it types,
  an option it picks, an address it opens and a Terminal command are checked against what it read from
  your apps in the last day (emails, events, plugin answers); carrying any of it out waits for your
  Allow, once. A routine, schedule or event run of a Pip that can read your apps runs without its
  computer, and a careful run's Terminal reaches only the Pip's sites. The home page is allowed as its exact
  host only (`www.google.com`, never `script.google.com`); hosts on shared hosting and user-content hosts
  are each their own site. What it read is remembered per Pip, as hashed features on disk, across a closed
  computer or a restart. A held text shows all of what Allow lets through. `list_pip_sites`,
  `set_pip_careful` (`on`) and `forget_pip_site` (`site`) are local only; Always allow is refused for both
  kinds of hold. All checks run in the supervisor.
- **Editable drafts.** Nothing changes on the CLI side: `prepare_pip_message_draft`,
  `prepare_pip_calendar_draft` and `prepare_pip_connector_draft` already prepare the content you send
  (see the extension's notes).
- **Plugins:** `list_pip_plugin_uses` reads the newest card per Pip and plugin in SQL (it read 400 rows
  and could miss Pips), lists the first 50 Pips per plugin by name with a `count`, and adds `installed`:
  the plugins a Pip could ask for.
- **How many Pips you can have is yours to choose.** 100 unless you set another number (1 to 100,000)
  with `set_pips_limit` (Pips settings); archived Pips no longer count. Every place that stopped at
  100 reads it: creating a Pip, accepting a setup card, and the @-Pip picker, which failed with
  "This workspace exceeds its 100-Pip bound." `list_pips` pages: `limit` (1–100), `offset`, `query`
  (name, title, instructions or chat, any case; a Pip found by its instructions or chat carries `match`:
  where, and the words around it) and `order` (`recent` puts Core first, then the most recently changed);
  it returns `total` and `next_offset`. Without them it returns the first 100, as before. Pips API 44.
  The chat search uses a full-text index over every Pip's chat (registry schema 43; plain matching
  where SQLite has no FTS5); DGC's own turns in a chat never match.
- **A Pip whose chat began before it had app tools no longer repeats that it has none.** Asked again
  "what about using Composio connector?", the founder's Test Pip still said "I don't have a Composio
  connector": its chat held its own earlier replies, and "Nothing is connected yet" read as "Composio
  is not connected". A Pip is now told whether your Composio is set up, that connect_app and read_app
  are its app tools, and, beside your message, that earlier replies saying otherwise are out of date;
  "No app is connected to you yet" names only its own apps. Over that same history, 6 of 6 replies on
  the default model corrected themselves (3 put up the Connect card; 3 asked first), against 3 of 4,
  one of them claiming a card it never made, without the note.
- **Asked about an app or Composio, a Pip offers to connect it.** Asked "can you use Figma tools?"
  and then about Composio, a Personal Pip said it had no tools and that Composio was out of reach.
  It is now told that its apps connect through your Composio (any app Composio supports, Figma
  included) and to show the Connect card. The workflow-connector tools (Zapier, Arcade, Make, n8n)
  are offered only when one of those is set up: offered with none, they misled it.
- Sending a message to a Personal Pip no longer waits for every workflow connector to list its
  tools: the list is kept for five minutes (one after a connector did not answer), and an action
  still checks its tool before it runs.
- A Personal Pip's reply reports what it is doing: thinking (DGC used to drop it), writing, and each tool
  it uses, one event per change; its text is sent every quarter second instead of every 256
  characters. `list_pip_reply_stats` (Pips API 44) says what each reply took: its time, tokens and
  model requests.
- `get_pip_chat_context` (Pips API 44) estimates how much of the context window a Personal Pip's
  chat takes in its next reply, for the prompt box's meter.
- **Plugins in Pips: each Pip asks first.** A Personal Pip can use the plugins you added to DGC,
  as Grok's bots use connectors: when it needs one it asks (`use_plugin`), and its chat shows
  "Let Ava use Airtable?". **Allow** lets that one Pip use it, with no second sign-in; the plugin's
  sign-in in Settings → Plugins is used. The Pip lists the plugin's tools (`plugin_tools`) and
  calls one (`call_plugin`) through the Pips controller; the Pip's own process never connects to a
  server. A tool its vendor marks read-only runs at once and comes back as untrusted data; any other
  tool, including one the vendor left unmarked, becomes an Allow card and runs only on your
  **Allow**, or on **Always allow** for that tool. After it runs, the Pip reads what the plugin
  answered by making the same call again (which does not run it a second time) and carries on in
  its chat. A plugin that can move money (1inch, Aave, Airwallex) never gets Always allow: it asks
  every time. Only the vendor's hosted server, as the plugin registered it and turned on in DGC,
  is used. The Pip's page lists its plugins, each with **Take back**. Pips API 44: `list_pip_plugins`,
  `allow_pip_plugin`, `decline_pip_plugin`, `list_pip_plugin_uses`. Registry schema 42.
- A plugin added in Settings while Pips are running reaches the Pips at once: they read the saved
  settings, not the ones the runner started with.
- **Routines (app triggers).** A Personal Pip does things on its own, as Grok's bots do: each
  routine has a name, what to do, and when (a time, a new email matching a Gmail search, or a set
  time before each calendar event). You add them on its page, or the Pip suggests one with a new
  `add_routine` tool and you choose **Add routine** on the card under its reply. A due routine is a
  turn DGC writes in the Pip's chat; an email routine's first look only notes what is there, then
  each new email starts one run and is never handled twice, and emails and events reach the model
  as untrusted data. At most ten per Pip; a busy Pip makes a routine wait, a paused or capped one
  skips it. New control commands `list_pip_routines`, `add_pip_routine`, `update_pip_routine`,
  `delete_pip_routine` and `decide_pip_routine` (local only); registry schema 40.
- **A Personal Pip's page.** Its look (one of the eight faces and a colour), a short title, and a
  Notifications switch are kept per Pip (`set_pip_profile`, schema 41); `get_pip` and `list_pips`
  include `profile`. `list_pip_shared` lists the links, images and files shared in its chat.
- **Notifications** say when a Personal Pip finished a routine on its own ("Ava: Good morning!…")
  or needs you (a routine or an app to say yes to, a robot check on its computer), unless that
  Pip's switch is off.
- **Pips settings.** `get_pip_computers` (whether the computers' programs are up to date, the disk
  each computer and the shared programs use, the free space), `update_pip_computers` (check for
  newer Chrome and desktop programs now) and `reset_pip_computer` (a fresh computer: signed out, no
  history, its Files kept; done by the runner after it closes that browser, at once when the runner
  is off; refused while the Pip works). `list_pip_apps` lists every app account your Pips use and
  which Pips use it.
- An app card for an account another of your Pips already uses says so (`known_label`): the user
  is asked to let this Pip use it, and Connect reuses it without a sign-in.
- A Pip's app cards are listed newest first even when it asked for two apps in the same millisecond;
  they came back in a random order on a fast Mac.
- A schedule in an old zone name, such as `Asia/Calcutta` (VS Code's Chromium still reports it on an
  Indian computer), is accepted and saved as its current name (`Asia/Kolkata`). Ubuntu 24.04 installs
  the old names only with `tzdata-legacy`, so every daily schedule or routine set from such an editor
  was refused with "Timezone unavailable". Found by the battle test.
- A Personal Pip knows the user's local time and time zone in its chat, so "in two minutes" and
  "every day at 8" are right.
- A Pip that makes a card (a routine, a change, a draft) and then writes nothing keeps the card, with
  a short line saying it is below; before, the empty reply failed the turn and the card was lost. A
  model that sends back nothing at all says "The model sent back an empty reply. Send your message
  again." under the message, not "Conversation reply exceeds its text limit or is empty".
- A Pip computer given while DGC was still fetching Chrome gets its browser: the box looks for Chrome
  when the browser starts, not once when the computer was made. Before, its browser never started
  until DGC restarted (the dock's Browser icon did nothing, and the Pip fell back on curl). A browser
  that cannot start no longer keeps the computer's screen from opening: the Terminal and Files work,
  and the dock or the Pip's next browser step tries again.
- A Personal Pip's setup card says what it can do in plain words ("It sees only what you share with it
  and any reads listed here. You can give it a computer or connect apps later...", "It works while Pips
  are running on this computer."), not "Personal scope. No project files, shell or browsing". A Pip
  no longer tells you about "web reads the controller passes me", and at a robot check it asks you to
  finish the check on its screen, not to "sign in".
- **Pip computers on macOS.** On Apple silicon with macOS 26 or later, each computer is a small Linux
  VM made with Apple's `container` tool (`dgc/pip_container.py`): the same desktop, Google Chrome (with
  its own sandbox) and Terminal, no network of its own, and the way out through DGC's egress proxy on
  the Mac (`dgc/pip_boxd.py` in the VM, idle connections from the Mac, a channel per browser and
  Terminal so each command's sites are still recorded). DGC builds the image the first time ("Setting
  up your Pip…"); the Mac needs only Apple's tool installed. Verified on a Mac Studio (macOS 26.5.1,
  container 1.5.0): image in under a minute from cache, screen in 1.3 s, the Terminal reaches
  example.com and is refused 192.168.1.1, the dock's Browser click arrives, and closing deletes the VM.
  Each VM names the DGC folder it belongs to, and DGC cleans up only its own: a second DGC on the same
  Mac (an app's own isolated DGC, with `DGC_HOME`) deleted the computers the first one was using, as
  VMs left behind. `DGC_CONTAINER_CLI` points DGC at Apple's tool when it is installed somewhere else;
  set but empty, DGC uses no VMs at all (the test suite runs that way).
- A Pip computer's DevTools pipe never blocks on a read. A second reader of the pipe (a test that
  drove the browser without taking the computer's lock) took the data `select()` had announced, and the
  blocking read then held the lock forever; a non-blocking read just waits out its deadline.
- A Pip's computer browses more like Chrome on Grok's bots: its Chrome is not marked as automated
  (`navigator.webdriver` is false), runs as a window on the computer's screen whenever this machine can
  show one (headless Chrome names itself HeadlessChrome), keeps the user's time zone (the boxes ran in
  UTC), tells pages it is online (its isolated network made Chrome report offline while it loaded
  them), and a new window opens on Google. Google can still ask for a robot check on some networks;
  the Pip then stops and the chat says it needs you.
- A page's own traffic no longer waits for approval: telemetry (`sendBeacon`, link pings, CSP reports)
  always goes out, and a page's background requests (XHR, fetch) go out unless they follow the Pip's
  (or your) click, typing, key or choice within 5 seconds on that page. Form submissions always wait.
  Before, every held POST became an approval: Google's results page alone made 18.
- A Pip with its own computer gets 30 steps per task or message instead of 12 (`pips.COMPUTER_STEPS`;
  a Google search through its browser ran out at 12).
- In auto mode the main chat creates a Pip that reads connected accounts directly, like any other
  Pip (its sends still wait for Allow); only a project Pulse that runs commands keeps its card.
- A Pip can propose its own web reads and its own computer from its chat: `draft_pip_change` takes
  `web_plan` (up to four public pages or searches DGC reads before each run) and `computer_plan`
  `{schema_version: 1}`, saved as a change the user accepts like any other; it cannot remove a
  computer. Asked for a weekday tech-news brief, a Pip without them said it "can't fetch the
  headlines" and needed "a search connection set up on your side".
- A Pip's reply ends when it offers its choices: no further model request. Told to "end your turn
  now", deepseek-v4.1-flash wrote a new Pip's hello again with new choices, twice, and the chat saved
  all three hellos as one message.
- A failed chat turn says why under the message (`list_pip_messages` adds `error`, one line, to a
  failed user message): "It stopped after 12 steps without finishing. Say “continue” and it carries
  on." instead of "No completed reply was recorded".
- While DGC is still fetching a Pip computer's Chrome, its status says "Setting up its computer. This
  happens once." (or why the setup failed) instead of "No usable Chromium was found. Run: npx playwright
  install chromium".
- A Pip's email or calendar draft shows as its card, and the Pip says in a sentence what it drafted
  instead of repeating the whole email in the chat.
- A new Pip introduces itself by the name you gave it, not its character's (a Pip named Gmail said
  "Hi, I'm Scout").
- A Pip computer's Terminal is online, like Grok's bots: commands (the Terminal tab's, the Pip's own and
  the desktop's Terminal app) reach public websites on ports 80 and 443 through the same egress proxy
  as its browser, via an in-box relay and the standard proxy variables (curl, pip, npm, git over
  https); the CA certificates are bound in. Nothing on this computer or the local network is reachable,
  and the box still has no network of its own. Each command's history entry lists the hosts it
  `reached` and any DGC `blocked`. (Was: "No internet in the Terminal".)
- A robot check stops a Pip: when a page it reads is Google's "unusual traffic" page, reCAPTCHA,
  hCaptcha or Cloudflare's check, the computer tool tells it not to try and to ask the user, and
  `get_pip_computer` reports `needs_you {host, at}` until a later page is past it.
  `finish_pip_computer_check {pip_id}` (local only) clears it and queues the Pip's next turn
  (reserved key `check_`), so it looks again and carries on.
- A connected app card (`list_pip_app_links`) names its `server` and `account`, as the account picker
  already did, so the editor can prepare a send from the Pip's own account.
- A Pip's chat reply can offer 2 to 4 choices, like Grok's A/B cards ("Yes, connect Gmail" / "Not
  yet"): the new `offer_choices` tool (chat runs only) saves them with the reply (registry schema 39,
  `pip_chat_choices`), `list_pip_messages` returns them as the reply's `choices`, and a new Pip's
  hello ends with its question's answers as choices. A chat reply is now everything the Pip said after
  the user's message, in order (text before a tool call was lost: only the last text was saved), and
  it ends where the Pip offered its choices.
- A Personal Pip connects your apps from its own chat, like Grok's connectors. It asks with the new
  `connect_app` tool (the call records a card; registry schema 38 adds `pip_app_links`); the user's
  Connect makes DGC call Composio's `COMPOSIO_MANAGE_CONNECTIONS` over their Composio connection
  ("list" first, so an account Composio already has is used; then "add"), and the editor opens the
  sign-in link from that reply. Once Composio lists an ACTIVE account it is the Pip's: `read_app`
  reads it through DGC with the closed read vocabulary and the same checks as reviewed app reads;
  sends stay drafts that wait for Allow. The model never touches MCP, credentials or the link (both
  tools reach DGC over a per-run socket only that run's token opens). New Pips commands (API 43,
  unreleased): `list_pip_app_links`, `start_pip_app_link`, `check_pip_app_link`,
  `decline_pip_app_link`, `disconnect_pip_app_link`; the Pip is told when an app connects.
- A Pip with a computer may also read connected apps (the founder chose Grok's model: one Pip can
  browse and read your mail; what it would send or change still waits for Allow).
- Outside auto mode, a Pip the main chat proposes is no longer an "Allow this tool?" prompt: the
  `pips_setup` call only saves its card, which the editor docks above the chat box, and the user's
  **Create Pip** there is the approval. Auto mode, an allow rule or the user's Allow on an ask rule
  still creates it at once (the agent marks such a call `_dgc_create_now`; one the model sends is
  dropped). The tool's reply tells the model which happened.
- After **Create Pip** on a Personal Pip proposed from a project's chat, the chat is told again
  ("Setup not found in this workspace." before): the notification finds the setup in your personal
  Pips as well as the project's, still only for the chat that proposed it.
- Typing on a Pip computer's screen no longer closes it ("The computer's screen closed"). The editor's
  viewer sends keys as QEMU extended key events once the desktop offers them, and DGC's input filter
  did not know that message; it also knows noVNC's extended pointer event (mouse buttons 8 and up)
  now, and had the xvp and SetDesktopSize message numbers the wrong way round.
- When DGC is updated while the Pips runner is running, the runner starts itself again on the new
  version instead of stopping with "The local Pips controller stopped (RegistryError)". If it cannot
  (the database is newer than any DGC on disk), it stops and says DGC was updated, so you start it
  again after updating.
- A Pip computer's desktop shows DGC's own wallpaper.
- A Pip computer's desktop needs no admin password: on Linux with apt, DGC downloads the desktop's
  programs and Google Chrome itself (`pip_screen_setup`) into `~/.dgc/desktop`, unpacked rather than
  installed, checked by apt against the sources' signing keys (Google's key fingerprint pinned), and
  checks for a newer Chrome once a day. `get_pip_computer_desktop` reports it as `setup`.
- Token usage by model for Pips: `pip_usage_report` carries `by_model` (the Pips' requests in the
  range, from the ledger) and each Pip's `models` (recorded per run as it is imported).
- Meet your Pips (API 43): a Personal Pip needs only a name, Core can be your Primary Pip, and
  a new Pip introduces itself in its chat (`introduce_pip`).
- Send images and files to a Personal Pip, like in the main chat: images, text and code files,
  PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV and TSV, up to 4 of each and 2 MB in all
  per message, with or without text. They are checked, kept once on your machine and shown in
  the chat. Files are read the main chat's way (documents to text, known credentials redacted),
  and a Pip with a computer also finds them in its Files, under From chat (`send_pip_message`
  `images` and `files`, `get_pip_message_image`). Registry schema 37 (36 adds `pip_chat_images`,
  37 `pip_chat_files`): an older `dgc` can't open the Pips registry once this one has.
- A Pip's computer is a real desktop, like Grok's bots, when the desktop programs are installed
  (`sudo apt install tigervnc-standalone-server openbox tint2 xterm pcmanfm`): Google Chrome (or
  Chromium) in a window, a file manager and a terminal, on a dock, streamed to the editor. The
  desktop has no network; the browser keeps its proxy and holds; the Pip's own commands never see
  the screen. While a run uses it, your input waits. New: `get_pip_computer_desktop`, the
  `pip_desktop` command and `pip_desktop_data`/`pip_desktop_closed` events (capability
  `pips_desktop`).
- Pip computers use Google Chrome when it is installed, and Chromium otherwise.
- With no run using a computer, a submit counts as yours only within three seconds of your own
  click or key; anything else a page sends waits for your approval.
- Personal Pips use your DGC skills that fit everyday work: your own and plugin skills, and the
  built-in deep-research, dataviz and plan. A Pip lists them and loads one with the skill tool;
  skills you turn off are off for Pips too. A skill never grants a tool or access.
- A Pip's computer has Files and a Terminal beside its browser, like Grok's bots. Browser
  downloads land in its Files. The Terminal runs one command at a time with no network, only the
  computer's Files as its home, and a 60-second limit. The Pip uses both through its computer
  tool, and now also from its chat, so you can watch it work; a submit it holds there continues
  in the chat once you send it. New commands: `list_pip_computer_files`,
  `read_pip_computer_file`, `add_pip_computer_file`, `remove_pip_computer_file`,
  `run_pip_computer_command`, `list_pip_computer_terminal`.
- The live screen of a busy page shows again: frames over 700 KB are retaken at lower quality,
  and the editor accepts full-size frames.
- A chat's own shell always runs the `dgc` of the build the chat is running, so the rule that a
  chat can't create or approve Pips from its shell holds even when an older `dgc` is on your PATH
  (Linux and macOS).
Pips are standing agents that work beside the main chat, and they are on for everyone. A Project
Pip reviews, tests or drafts for one project, on a schedule or when commits land; a Personal Pip
handles your own tasks across projects. You decide what they do: the chat sets Pips up through your
permission mode, and anything that sends, books or runs on your behalf waits for your approval. See
[docs/PIPS.md](docs/PIPS.md).

- Setting up a Pip from the chat is a tool call like any other: the default mode asks, showing the
  Pip, its job, what it reads and when it runs; auto mode allows it; Always allow saves a rule. Once
  allowed it is created and on, with a 200,000-token daily limit you can change. A Pip that reads
  your connected accounts or a Pulse that runs commands still waits for you on a setup card.
- `dgc pips` creates, runs, reviews and stops Pips from the terminal; `dgc pips serve` runs the
  local runner that schedules need.
- Starter Pips cover three common jobs: review each new commit, a nightly security review, and a
  weekday morning brief from pages and searches you choose. `dgc pips starters` lists them and
  `dgc pips starter NAME` shows the exact job and creates it once you confirm. In the Pips view a
  starter becomes a setup card you approve like any other.
- A setup card from the chat or a starter can run a new project reviewer after each new commit
  instead of on a schedule.
- Fewer, better messages. `dgc pips digest` (and `/pips`, now in the full-screen terminal too)
  shows what your Pips found since you last looked: new findings at each Pip's threshold, failed
  runs, reviews waiting and earlier findings that went away after their file changed. The welcome
  screen's tip says when there is something new. A new finding at a Pip's alert level brings the
  digest back straight away; otherwise it is due once a day.
- `dgc pips notify PIP` sets which new findings reach the digest (default medium or worse) and
  which bring it back early (default high or worse). These are display settings, not part of the
  job, so they need no review and no model can change them.
- A scheduled or commit-triggered review is skipped when nothing changed since its last report:
  the same commit, job, model and workspace context could only repeat it. Manual runs always run.
- `dgc pips outcomes PIP` shows what became of a Pip's findings: accepted, dismissed, still
  reported, or gone after their file changed.
- Project reviewers and Quill can read from GitHub before each run: open issues, open pull
  requests, the CI checks for the commit under review, and recent failed workflow runs. DGC makes
  the reads with your own `gh` login or `GH_TOKEN`, GET only; the model never picks a read and
  never sees the credential. Add them with `dgc pips propose --github-issues --github-checks …`
  or in the Pips view; like every job change, they wait for your review.
- Pip computers (Linux). A Personal Pip can have its own computer: a browser and files in a
  sandbox, separate from yours. It reads public websites on its own. Anything it would submit
  waits for your approval with a screenshot of the page, and is sent exactly once when you
  approve; the Pip then carries on from the result. You sign in to sites yourself in its
  browser, so it never sees your passwords. It can't reach your home network, makes
  a payment only with your approval (or an Always allow) and can't also have app reads. `dgc pips computer give PIP` gives one;
  `status`, `pending`, `approve`, `reject`, `stop` and `frames` cover the rest, and the digest
  says straight away when something is waiting. Needs bubblewrap and a Chromium build. Pips
  API 42, registry schema 35.
- The main chat carries one small `use_pips` tool and loads the Pips tools only when a task needs
  them, so an ordinary request costs about 115 more prompt tokens, not the 6,500 the full set
  would. A message that references a Pip with `@` loads them directly. `deny: UsePips` keeps them
  out of the main chat.
- Share a Pip: `dgc pips export PIP --output FILE` saves its job (no accounts, memory, history or
  findings; the file says what it left out) and `dgc pips import FILE` shows the job and creates it
  after you confirm.
- The main chat offers to make recurring work a Pip: when you ask for something that repeats, and
  when you start a chat with work you have started chats with before (once per chat; it does not
  ask again if you say no). It also knows that no Pip buys, sells, trades or pays, and that
  Personal Pips can read pages, searches and connected apps you approve.
- Windows says plainly that Pips are not available there yet: the editor shows that instead of
  "update the CLI", the main chat offers no Pips tools and `dgc pips` explains, so no Pip is
  created that could never run. The Pips guide has a platform table.
- Five more Personal starters, each reading only the pages and searches you name: Watch a page for
  changes, Market brief (news with sources before the market opens; it never trades or advises),
  Weekly research digest, Release watch and News on a topic. A Personal task now sees its own
  previous result, so a watch says what changed and a digest doesn't repeat itself.
- Rate a Pip's result: `dgc pips feedback RUN_ID up|down --note "…"`. Its later runs read your
  five newest ratings and notes as guidance; a rating never changes the job.
- Always allow: approving a Pip's email, calendar event or connector action can also let that Pip
  do the same kind of action again without asking, with the same connection, account and tool.
  Its scheduled runs can now draft actions too; one you always allow runs after the run and you
  are told after, anything else waits for you. `dgc pips app-action accept … --always`,
  `dgc pips allowed PIP [--revoke GRANT_ID]`.
- Token usage by Pip for the editor's Settings → Token usage (`get_pip_usage_report`): each
  Pip's tokens and runs for a range, as a part of everything DGC counted.
- `dgc pips usage PIP` shows what a Pip's runs cost in tokens, today and over 30 days, counting
  failed and timed-out runs too. `--daily-limit 200k` skips its schedules and triggers for the rest of
  the day once it reaches that many tokens; runs you start still run. The limit is your setting, not part
  of the job.
- The runner shows a desktop notification for a new alert or a review waiting for you, even with
  the editor closed: once per item, at most one a minute, never a backlog. `dgc pips
  desktop-notifications off` (or the switch in the Pips view) turns it off; a computer with no
  notification service says so instead of failing.
- **Keep Pips running**: `dgc pips keep-running on` (or the switch in the Pips view) starts the
  runner when you log in and after a restart, and restarts it if it fails. Linux uses a systemd
  user service and, where allowed, keeps running while you are logged out; macOS uses a
  LaunchAgent. Off stops it starting on its own and never stops the runner running now. The
  service unit now restarts on failure; `pips serve --service` exits cleanly when Pips are off,
  stopped or already running, so it never loops. A group-writable `~/.config` whose group is only
  you (Ubuntu's default) no longer blocks the service.
- A chat can no longer approve its own Pips by running `dgc pips` in its shell (the CLI acts as you,
  and auto mode approves every shell command). In a chat's shell the CLI only reads and can make
  the emergency stop; changes are refused and the chat prepares a setup card for you instead. The
  same holds for a DGC, or an SDK script, started from that shell, and for a chat run by Claude
  Code or Codex through your subscription.
- A profile that has never used Pips gets no Pips state: per-turn Pips bookkeeping starts the
  first time a chat or command uses them.
- Personal Pips can use reviewed reads from connected apps (Gmail, Google Calendar, Google
  Drive, Notion and Google Contacts through Composio) and reviewed web reads: up to four exact
  https pages or fixed searches that DGC reads before each run. They draft emails, calendar
  events and connector actions; each one is sent or created only after its own exact review.
  Pips never buy, pay or book anything.
- Patch and Pulse now run on macOS too, confined by Seatbelt (`sandbox-exec`): the copy is
  read-only, there is no network, homes and DGC state are hidden, and CPU, file-size and open-file
  limits are hard. Memory, process count and scratch space are sampled about every 50 ms rather
  than enforced by the kernel, and system folders stay readable; the Pips view states these
  limits. Linux keeps its stronger bubblewrap confinement.
- A finished run removes its private source copy, worktree and worker home, keeping its report,
  artifacts and history, so a busy Pip's runs no longer fill the disk. A profile now keeps up to
  20,000 project runs, 20,000 Personal runs and 20,000 audit checkpoints.
- Set `pips_enabled` to `false` to turn Pips off.

### Goals

- `/goal` typed while a turn runs in the full-screen terminal now changes the goal at the turn's
  next step instead of waiting for the turn to end. Replacing a running goal asks first;
  `/goal budget NUMBER|off` edits the running goal's budget in place; with no goal, the running
  turn adopts the new one. A change the turn cannot take puts your text back in the composer.
- `/goal budget NUMBER|off` changes an existing goal's token budget without replacing it.
- A goal that reaches its token budget now pauses instead of failing; resume it when you are
  ready.
- An objective too long for the session is refused before you are asked to replace the current
  goal with it.

## 0.47.2 — 2026-10-02

- Absolute paths at the start of a prompt, such as `/workspace/project`, are sent to the model as
  ordinary text instead of being refused as unknown slash commands. This applies in the full-screen
  terminal, classic terminal and editor, including prompts sent while a turn is running.
- Changing the native model or thinking level during a turn now says that it applies from the next
  model request. A delegated subscription CLI says that the change applies when its next turn
  starts, since the already-running external CLI keeps the settings it launched with. Native model
  handoff coverage also verifies that the new model receives the retained prompt and tool context.
- An interactive Ultra fan-out returns control to the parent after launching independent sub-agents,
  so mid-turn steering is read without waiting for the slowest child. An explicit foreground task
  still waits when the parent's next step depends on its result.

## 0.47.1 — 2026-10-02

- A new turn waits until the previous session lease has fully released. A rename finishing just
  before a prompt could otherwise intermittently refuse that prompt as if another process held
  the session, especially on macOS. The release-to-idle transition is now atomic.
- This is the first published build of the 0.47 line; the 0.47.0 source tag was held by the
  release gate when it exposed this race. The multi-chat features below are included.

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
- Closing a chat also stops background shells, Python kernels, browsers and monitors started by
  its sub-agents, including sub-tasks that have already finished. Other chats keep their processes.
- Renaming a chat just before a background turn starts no longer refuses that turn. Ctrl+C during
  a sub-agent's integration stops the terminal's turn as well as the waiting sub-agent.
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
