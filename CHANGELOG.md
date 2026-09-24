# DGC CLI changelog

Release notes for the `dgc` command-line tool and `dgc serve`. The VS Code extension has its own
[changelog](editors/vscode/CHANGELOG.md), and so does the SDK ([sdk/CHANGELOG.md](sdk/CHANGELOG.md)).
Earlier releases are listed at <https://vibedgc.com/changelog>.

## 0.44.1 — 2026-09-24

Eight fixes, nearly all of them found by USING 0.44.0 rather than by testing it.

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
