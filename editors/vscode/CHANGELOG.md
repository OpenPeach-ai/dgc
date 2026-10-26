# Changelog

## Unreleased

- **One DGC writes to a session at a time, idle or not** (with a DGC CLI that has it, 0.48). A session a terminal (or
  another DGC this window can't take over) has open shows read-only with Open here, and the bar says "Open in the
  terminal · ~/toni-erp · idle 2 min."; Open here takes it from the terminal, which says so. When Open here in a
  terminal takes a session this window shows, the window turns read-only with the same bar, and its Open here takes it
  back. The window tells the CLI it shows such sessions read-only (`watch_session_owner`).

- **Run in background** (with a DGC CLI that has it, 0.48). When the turn waits on a helper, its line in the chat has a
  **Run in background** button, and so does its card in the agent map; a running command's row has one too, once the
  command has run a moment. The turn stops waiting and carries on, and the work keeps going: the helper becomes a
  background helper (the pill counts it, and its report comes back when it ends), the command a background command in
  the agent map's list, whose exit wakes the chat. The command's row then reads **Moved to the background**. A batch
  line with several helpers waiting asks which, each by name, or **All**. Once moved, Stop on the turn leaves it
  running; stop it from its own card. With an older CLI the button never shows.

- **Ask a finished helper to do more** (with a DGC CLI that has it, 0.48). A finished helper's card in the agent map, and
  its report line in the chat once opened, have a box: type what it should do now and press Continue (or Enter). The
  same helper carries on in the background with its memory, in a fresh copy of your project, and reports back like
  any background helper. Its row keeps its place and says **Continued · 2 runs**; its transcript shows each run after
  a divider, "Continued 18:42 · asked by you", with what the run before reported and what it was asked. An older CLI
  shows no box.

- **The agent map shows what matters now; the rest is one click away.** In a long chat it used to list every helper
  the chat ever ran. It now opens on the agents working, the ones your latest turn that started any started (a short
  follow-up that starts none leaves them in view), and any older one whose changes were held back, its row saying
  **Held back**, each with the agents that started it. The subtitle counts them: "2 working · 3 this turn · 14
  earlier". The rest is one row, **Earlier in this chat · 14 agents**, that opens to them grouped under the prompt
  that started them, newest first; each opens its card as before, and the map remembers per chat whether Earlier is
  open. **Open in agent map** on an agent's report opens Earlier when that agent is in it. Which turn started an
  agent comes from what the chat already has (the step that started it, or the turn the CLI named), so it works with
  any DGC CLI; a chat whose agents carry neither lists every agent, as before.

- **Opened, a group of Pip reports lists them one under another.** Two or more reports fold into one line ("2 Pip
  reports · 2 clear"); opened, the second row was drawn on top of the first. Each is now its own row, with a line
  between them.

- **"Open here" says where the chat is open and what runs there** (with a DGC CLI that has it, 0.48). The read-only
  bar of a Work session another window holds now says "**Open in Cursor · ~/toni-erp · idle 6 min.** 2 monitors and
  1 background helper run there. Open here moves them to this window." instead of "This session is open in another
  window.": "working now" while a turn runs there, "Kept running by DGC with no window open" when no window has it,
  and each thing that runs or waits there named only when there is one (monitors, background helpers, background
  commands, queued prompts, questions waiting for an answer). The editor's name comes from the window (VS Code,
  Cursor, Windsurf...), and the folder is shown with `~` for your home folder, never as a full path. It is asked
  again every 30 seconds while the bar shows. After Open here, the window it came from says the same about the new
  one, asked of the side bar's DGC. A ChatDGC chat's bar says it too ("writing a reply now"). With an older CLI, or
  when DGC can't tell, the bar says what it always did.

- **Undo never loses your work** (with a DGC CLI that has it, 0.48):
  - When files you or another program changed after DGC wrote them stop an Undo, DGC names them and asks: "These
    files changed after DGC wrote them, by you or another program: a.py, b.py. Undo anyway puts back the version from
    before this turn and loses those changes." **Keep my changes** is the default; **Undo anyway** goes ahead for
    exactly those files.
  - An Undo that stops for any other reason says why, in the same words as the chat: "Undo stopped: couldn't write
    ro/b.py (Permission denied). Nothing was changed, and the recovery point was kept."
  - **Your saves are yours.** DGC hears the files you save in the chat's folders (a new `user_saved` command, sent
    only to a CLI that offers it), so a file you save while one of DGC's commands runs, a long test run say, is never
    taken for the command's change: Undo leaves your edit as it is.
  - **Your uncommitted work comes back.** A model's `git checkout .`, `git reset --hard`, `git clean -fd`, `git stash`
    or `rm` over files you had not committed is undone, and Undo's question names those files. When a command moved
    Git itself, the question and the line after say "Your files are put back; Git's commits, branches, stashes and
    staging are left as they are." A file DGC could not copy first says why in its row's tooltip (over 5 MB, past
    500 files in one command, or the session's room for copies used up).
  - **Nothing is put back unseen.** Undo's question names the files it puts back from Git because a command changed
    them: "Also puts back 2 files a command changed: rates.py, README.md." (five at most, then "and N more").
  - The Edited card marks a file one of the turn's commands changed that Undo can't put back as **Changed by a
    command — Undo leaves it**, Undo's question leaves it out of its count, and the line after an Undo says how many:
    "↩ Undone; DGC restored 2 files. 1 file changed by a command was left as it is." A clean file a command changed or
    deleted is restored like any other and listed like any other.
  - With an older CLI, Undo works as before.

- **The Edited card and Undo, four more cases** (with a DGC CLI that has them, 0.48):
  - A helper that finished in the background while the chat was idle is counted in the changes bar, and its row on
    the card opens its real diff, also in a reopened chat.
  - **Undo on an older turn's card** says how many later turns it takes back too and how many files it really
    restores across all of them: "Undo this turn and the 2 turns after it? DGC restores 5 files and rewinds the
    conversation to just before this prompt." With an older CLI it gives an upper bound ("up to 6 files"), never
    fewer. The newest turn's question is unchanged.
  - A reopened card marks a file outside the project that Undo can no longer put back (DGC keeps its earlier version
    only while the session that changed it runs) with **Can't undo**, and Undo's question leaves it out of its count.
  - A card redraws in place when a helper lands in its turn's recovery point after the window was reloaded.

- **A background command's card folds with the rest of the work once DGC has answered.** A command DGC ran in the
  background (a Docker build, a test run) that finished while it worked drew a card with up to 40 lines of its output,
  and the card stayed open under the answer after everything else had folded into "Worked for …". It now folds with
  the work, one click away on that row, live and after a reload. A monitor's card folds the same way, and a turn a
  background command woke keeps its "Woke on background command" line.

- **A background helper's report, one line in the chat.** When a helper you sent to work in the background finishes,
  the Work chat used to say only "Woke on agent · Review billing.py", and the helper's report was on its page in the
  agent map. Now that note is a quiet line per finished helper, folded, with a › at its end. Click it (or press Enter
  or Space) and it opens to the helper's whole report, drawn as its page draws it: what became of its changes
  ("completed and integrated", "partly integrated", or "NOT integrated" with where its worktree is kept, in the
  chat's own colour when work was held back), what it said, the files it named, and **Open in agent map**, which opens
  the map at that helper's card. A reload, or a window reload that reopens the chat, draws the same lines with the
  same reports. Needs a DGC CLI that offers `agent_reports` (0.48); with an older one the note stays as it was.

- **The Edited card lists every file Undo puts back, with true line counts.** A file a helper changed without DGC's
  own edit tools (a worker that fixed `billing.py` with a shell command in its own copy of the project) was restored
  by Undo but missing from the card, so the card said "Edited 1 file" while Undo put back two. With a DGC CLI that
  counts the card itself (0.48), the card shows exactly the files the turn's recovery point restores, with the lines
  added and removed as the CLI counted them: New for a new file, Deleted for a deleted one, Changed for a binary or
  very large one, and nothing for a file edited and then put back as it was. Undo's question names the same number
  of files, finds the right recovery point for a turn DGC started itself (a helper's result, a resumed goal), and a
  click on a row a helper changed still opens its diff. When a background helper finishes later and lands in an
  earlier turn's recovery point, that turn's card is redrawn in place. A reopened chat shows the same card. With an
  older CLI the card counts the edits as before.

- **A message you send while DGC is working shows its time**, under its bubble like every other prompt: a steered
  message, and a queued one you steer in with Steer now. A reopened chat shows each one's own time too.

- **Settings → Models → Advanced: Wait for the first word, and Wait between words.** How long DGC waits on a model,
  in plain words. **Wait for the first word** is Auto (as long as a model on this computer or your network is working
  on your request, which DGC asks its server; 5 minutes for a cloud model), a number of minutes, or Never. **Wait
  between words** is minutes of quiet once a model has started answering. A local model that is still working is
  never cut off either way. Needs a DGC CLI that answers `model_wait_settings` (0.48); with an older one the two rows
  are off and say to update the CLI. Save sends them only when you changed them.

- **The main chat's Pip model changes ask in plain words.** The permission card for changing a Pip lists its new
  **Model** ("glm-5.3:cloud", or "Claude Code, on your own plan") and **Context window** ("64K tokens") instead of
  "model choice [object Object]", says the change starts no work and leaves what the Pip may do as it is, and the line
  above it names the Pip. Changing the model every Pip on Default uses asks as **Change the Pips default model**, and a
  new Pip's card from the chat shows the window it starts with.

- **A Pip's context window changed from the main chat shows on its page.** The main chat can now change a Pip's model
  and context window (with a CLI on Pips API 66). The Pip's prompt box kept the window it first read while the view was
  open, showed that, and sent it with the next message, which saved it back over the chat's change. It now shows the
  window DGC keeps for the Pip at its next read (at most 4 seconds while its chat is open), except while it is saving
  a choice of your own. No protocol change.

- **A running Pip is seen while it runs.**
  - **In its own chat:** from the moment a run starts, the Pip's chat has one post for it: its face at work, what it
    is doing now ("Reading billing.py", "Waiting for the model"), a clock, **Stop**, and how it started ("Started by
    you", "On schedule · 9:00 AM", "From a new commit", "Asked by DGC", "First run"). When the run ends, that same
    post becomes its report, in the same place. It covers Run now, a schedule, an event, a DGC chat's `run_pip_now`
    and a setup card's first run, for Project and Personal Pips; a Personal Pip's routine runs as one too, and its
    reply takes its place. A window reload while it runs draws it again. A run you stop posts nothing, and the chat
    says so.
  - **In a Work chat:** while a Pip that reports to this chat runs, a chip above the box says so: "Billing audit
    running · 0:42", or "2 Pips running". A click opens that Pip's chat on the Pips page, at the run (with two or
    more, a list to pick from). It goes when the run ends, and the report card arrives as before. Pips that report to
    other chats show nothing. Needs a DGC CLI that offers it; an older one shows no chip.
  - **In the agent map:** the row for a Pip run this chat started stays live: what the Pip is doing, its clock, and
    Stop on its card (before, it said "Working" with no time and had no Stop).

- **Settings, redesigned on every page, and in your VS Code theme.** Every page and the side list now follow the VS
  Code theme, light and high contrast included; Settings was always dark before. Each page is a short title and one
  line, then a few groups of rows. A row's hint is one line; the rest is behind a small **?** beside its name, and a
  page's longer introduction is behind the **?** after its first line. Advanced settings fold away (Models: Transport,
  Responses state, Recheck refused features; General: Tool profile; an MCP server: your own sign-in app and what it
  logs). There is one **Save all** at the foot of every settings page, which saves every page's changes and says which
  pages have them ("Unsaved changes on Models and Agents"). In a narrow tab the side list becomes a page picker with
  every page's name. Pages, in short:
  - General: Turns (Permission mode, Thinking, DGC Ultra, Token cap per turn, Context window), What you see.
  - Models: Connection (Host with its Presets beside it, API key, Model), Subscription (Run turns on; its model and
    effort only when one is on), Cache.
  - Agents: Sub-agents (Model, **Run at once**, which moved here from General's Parallel sub-agents, Context window,
    and Another host), Fallback, Pips. A blank box says what blank means ("Same as the main model", "None").
  - Security: Sandbox (Run commands in a sandbox; its network switch works only with the sandbox on) and Previews,
    in plain words.
  - Web search keeps the search; **Search the web** for ChatDGC moved to the ChatDGC page, beside its other replies'
    settings.
  - MCP servers: plain words ("A command on this computer", "A URL", "NAME=value is kept privately"); **Forget saved
    sign-in** and **Remove server** sit in a "Can't be undone" area and each asks first. The "Clear stored credentials"
    checkbox beside everyday fields is gone. The Plugins page no longer has an MCPs tab: MCP servers has one page.
  - Plugins: the install review and a plugin's page no longer show DGC's own test notes; a plugin's details hide what
    its package doesn't provide; directory cards drop the package jargon.
  - Memory, Voice, Running sessions and Token usage: one line under each title, the rest behind **?**.
- **Every Model box in Settings lists the models at its own host.** Models → Connection, and Agents → Sub-agents and
  Fallback: open the box (or press Down) for the models that card's host has, a local Ollama's `:cloud` models
  included, or keep typing any name: a host that can't list, or a model it doesn't list, still works. It lists again a
  moment after you change that card's Host URL, Transport or API key, before you save, and a provider preset lists the
  host it fills in. When it can't, it says why under the box ("Couldn't list the models at this host: it needs an API
  key (HTTP 401)."). A saved key is only ever sent to the host it was saved for: type another host and it is asked
  with no key, or with the key you type beside it. The Subscription model stays a text box. Needs a DGC CLI that
  offers it (0.48); with an older one the boxes stay as they were.
- **Settings → Agents: the sub-agents' context window.** The Sub-agents card has **Context size**: how many tokens
  each sub-agent holds before it compacts. Blank (or 0) reads **Same as the main model** and keeps the main model's
  window; otherwise 2,048 to 16,777,216 tokens, checked as the main Context size is. Save writes it, which it could
  not before. Needs DGC CLI 0.41.6 or later; with an older one the box says to update.
- **New Pip: a big face with a list beside it.** The grid of seven character tiles is gone. **New Pip** shows the
  character's face on the left and a dropdown beside it, and the face changes as soon as you pick. For a Project Pip
  the dropdown asks **What should it do?** and lists the jobs in plain words, with the character's name beside each:
  Map out the project (Scout), Answer a question about the code (Lens), Fix files you approve (Patch), Review the code
  for bugs (Rook), Run tests you approve (Pulse), Look for security problems (Lock), Draft documentation (Quill). For
  a Personal Pip it is **Character**, the names. Each row has its small face, and a kind your DGC can't make yet stays
  in the list, greyed, with the reason. It works from the keyboard and with a screen reader: the arrow keys, Home and
  End move, typing a job's or a name's first letters goes to it, Enter or Space picks, Esc closes the list, Tab moves
  on. The list opens downward inside the dialog, or upward when there is more room above. The Pip it makes is the
  same as before. A Personal Pip's **Edit** face page picks its face with the same list.
- **A Project Pip has the Personal Pips page.** A project's Pips are the same list as your Personal ones, with a
  search, **New Pip**, and a **…** beside it for the project's context and notifications; new Pips the DGC chat set up
  wait above it. A Project Pip opens in its chat under the same top bar: back, its face and name with what its last run
  found, **Run now** (the play button: an audit, a draft, or the commands it runs; **Running…** while it works, which
  opens the run in History) and a **…** menu with History, Settings, Schedule, Handoffs, Changes, Memory, Context and
  Notifications. A change waiting for you stays in its chat and above each section, and new Pips waiting for you stay
  under the top bar. **New Pip** is the character picker, where a Project Pip's character is its kind of work, then
  its job, branch or commit and model; it makes the same Pip the old form did. Describing the job to DGC, a common
  job and **Import a shared Pip…** are one click from there. Needs a DGC CLI with Pips API 51 or later; with an older
  one, and in the remote view, a Project Pip keeps the earlier page.
- **A Project Pip's chat is the same as a Personal Pip's.** It looks and answers the same way: the Pip at work with its
  face, its name, what it is doing and its clock; its reply written into short bubbles as it comes, instead of typing
  dots and a "Still writing" block; time marks between messages; your message on the accent colour; the buttons under a
  message when you point at it; the same box ("Ask Billing audit"), with a line above it when Pips aren't running. Its
  page keeps what only a Project Pip has: History, Settings, and its runs with Ask DGC to fix, now in the same chat.
  Which code it reads is under What this Pip can do. A remote view keeps the chat it had.
- **Ask DGC to fix, followed in the Pip's own chat.** Once DGC is fixing a run, its message in the Pip's chat says
  **DGC is fixing this**; when it is done, **Fixed · 3 files**, and a click opens the Work chat it ran in, at its card,
  where Review and Undo are. A fix that didn't finish says so and offers **Ask DGC to fix again**; one that was undone
  offers Ask DGC to fix again. It updates while you look and says the same after a reload. Needs a DGC CLI with Pips
  API 65; with an older one, the message says Asked DGC, as before.
- **A finished Pip fix is one line.** "Fixed · 6 files changed +314 −13", its time, and Review, Undo and Watch. Its
  files, tests and summary open under that line with a click, and stay open while the card updates.
- **No thick accent bar down a card's left edge.** Pip report cards, monitor events and artifact cards lost theirs;
  their border and their own words say what they are.

- **Pips your code keeps.** A Personal Pip that your own app's code keeps from a template says so at the top of its
  page: **From your code**, "Your app keeps Dunning from its template, dunning. What you change here stays as you set
  it." When the app's new code would let the Pip do more (use a new change tool, ask less, run a change without asking,
  a routine on the app's event), the same place shows one card, **Your code asks to let Dunning do more**, each thing
  in plain words, with **Accept** and **Not now**. Nothing of it applies until you accept it. Needs a DGC CLI with Pips
  API 64; with an older one, nothing changes.

- **A routine on your own app's event.** In a Personal Pip's Settings, Routines, choose **When my app sends an
  event**, pick your app, and type the event or pick one it sent lately: "When the shop app sends order.created". The
  Pip runs it once for each event, with what the app sent. The choice shows when you have an app registered through
  DGC's SDK. Needs a DGC CLI with Pips API 63; with an older one, nothing changes.

- **A change your own app decided settles its card.** Your app can now accept or reject a Pip's change on its own
  screen. When it does before you, the Allow card in the Pip's chat is replaced by one quiet line: **Shop app accepted
  create_dispatch**, decided in Shop app, it ran once (or declined it, and nothing ran). An Allow pressed a moment late
  says the app had already decided and runs nothing more. Needs a DGC CLI with Pips API 62; with an older one, nothing
  changes.

- **Your own apps in the Pips view.** An app your code connected with DGC's SDK shows on Pips settings → Apps like
  any connection: **Shop app**, with 2 read tools, 1 change tool and its address. An update to it that would let
  your Pips do more waits there, in a line, with **Accept**. A change a Pip proposes in it is the Allow card you know
  from plugins, in plain words: **Run create_dispatch in Shop app?**, with Allow, Always allow (never for a tool that
  moves money), Edit and Don't. The app's secret is never shown. Needs a DGC CLI with Pips API 61; with an older one,
  nothing changes.

- **One line above the box with a Pip fix.** A Pip fix's chip now counts like the checklist: beside this chat's changes,
  the changes fold into a chip too, so the space above the prompt box stays one line instead of a chip line over a
  full row. When the fix's chip goes, the changes get their full row back.

- **A ChatDGC reply keeps running through a window reload.** Reload the window, close it, or reconnect after a
  dropped Remote SSH connection while ChatDGC is writing a reply: the reply carries on, and its tab, when the window
  comes back, shows it finished or still streaming, with nothing lost or shown twice. Its queued messages are still
  there. With no window it saves by itself once the reply is done. Needs a DGC CLI with the same feature; with an
  older one, nothing changes.
- **Closing a ChatDGC tab mid-reply asks once**, as a session's tab does: keep the reply running in the background,
  or stop it (what it wrote is saved), with **Remember my choice**. The same setting, `dgc.closingAWorkingTab`.
- **Settings → Running sessions** lists a ChatDGC chat that a closed window left answering, as a ChatDGC chat, for
  how long, with **Open** and **Stop**. Open shows it in a ChatDGC tab here, still writing.
- **Open here for a ChatDGC chat.** A chat open in another VS Code window shows read-only, as it was last saved,
  under the same bar as a Work session open elsewhere: "This chat is open in another window", with **Open here**.
  Open here brings that chat to this window, and only that chat: the other window's Pips, Sessions and Settings stay
  where they are. If its reply is still being written, it carries on and streams here, every line once; a message
  you type meanwhile waits and goes when the reply finishes. The other window goes read-only with an Open here of
  its own, and a chat it closes is yours by itself. Needs a DGC CLI with the same feature; with an older one, a chat
  opens as before.
- **Read-only means read-only.** While a chat or a Work session is open in another window, nothing that would change
  it looks usable: Send, attach, Deep research, Study, the model and the mic in the box, and in the transcript a
  card's choices, Edit, Try again, Continue, follow-ups, ratings, an approval's buttons and a widget's Delete are all
  shown off (and said to be off to a screen reader). Copy, Read aloud, links and files stay usable, and everything
  comes back once it is this window's again.

- **A new Pip's card shows the Pip once.** When a Pip is created with a first run, the run used to appear as a second
  card inside the first, the Pip's face and name again. Its first run is now the card's own status line ("First run:
  working", then "First run: report ready").

- **DOMPurify 3.4.17** for Mermaid's diagram rendering (GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr,
  GHSA-c6gr-qvv4-5v3f).

- **A Pip for live data.** A Pulse's **Plan & schedule** now asks what it runs: tests or page checks on a copy of the
  code, or **read-only commands on live data**, one a line (up to six), with what they can reach one click away. DGC
  runs only those exact commands, read-only, and the Pip's model sums up what they print. Saving them is a reviewed
  change, and a command that writes is refused with the reason. A setup card from the chat shows "3 read-only
  commands" and "Changes nothing", and Details lists each command. **Run now** on its History runs it; a run's page
  shows the summary, then each command, how it ended and what it printed. The summary posts in the Pip's chat, and
  all-clear runs fold into one message ("✓ All clear 12 times since Monday"); one that needs you has its output and
  **Ask DGC to fix** under it. On the Work chat's report card it reads "needs you" with the summary, or "finished ·
  all clear". Needs DGC CLI with Pips API 60; an older CLI shows a Pulse as before.

- **A finished turn folds its work into "Worked for 43s".** Once a turn has its answer, the one-line updates
  between tool calls, the tool rows, thinking and finished sub-agents fold into the turn's **Worked for** row, which
  moves to the top of the turn, so a turn reads as your prompt, one line and the answer. Click the row (or press
  Enter) to see the work again in place, under it; it folds again once your next prompt has its answer. A detailed
  message (a diagnosis, a plan), a message you sent mid-turn, question and approval cards, notices, a Pip's report,
  a sub-agent still working and the answer with its **Edited N files** card stay on screen. A stopped or failed turn
  does not fold, and a reload, a reattached session or a resumed chat draws the same fold as the live turn.

- **Ask DGC to fix, in the background.** On a Pip report's card, **Ask DGC to fix** (or **Fix**) no longer sends a
  message: DGC fixes the report in the background, in a copy of the project, and you keep chatting. The card becomes
  the fix's status, on a line of its own under its two: "Getting the fix copy ready", "Fixing · Running npm test",
  with how long it has worked, **Watch** (the helper's own page) and **Stop**. A permission it needs (installing the
  project's dependencies in the copy, copying a `.env` a test needs) is asked on the card, and the agents pill says an
  agent needs you. When it ends: "Fixed · 2 files changed +12 −3", the files (each opens its diff), whether the tests
  ran in the fix copy, and **Review** and **Undo** (Undo asks first, and keeps a file you have changed since). A file
  you changed on the same lines while it worked is held back, and the card says so. Stopped or failed, it says that
  nothing in your project changed, with **Try again**.
  - A **Pip fixes** chip on the chip line above the message box (never a new row) shows only Pip fixes while one works
    or until you've seen how it ended; it turns amber when one needs you and lists them, each going to its card.
  - A card with a fix leaves a folded group of reports, so a running fix stays in sight. After a reload, or a window
    reload with the session kept running, the card draws the fix as it is. From a Pip's own chat, **Ask DGC to fix**
    starts the same fix in the chat the Pip reports to.
  - Needs a DGC CLI with the same feature; with an older one, Ask DGC to fix sends its one message as before.

- **The prompt rail in Work chats,** out of sight until you want it (bring the pointer to the transcript's right edge, or
  press Alt+↑/↓), then as ChatDGC has it: in a session of five prompts or more, a short tick for each
  prompt sits in the transcript's right margin, centred, and the one you're reading is bright.
  - **Hover it** (or Tab to it) for a card of every prompt with its time under day headings, the one you're reading
    tinted. Click one to go there: the view eases to it (at once for a reader who asked for less motion), it rests
    where a pinned prompt rests, and it's outlined for a moment.
  - **Keys:** Alt+↑ and Alt+↓ go to the prompt before or after, from anywhere in the chat, the message box included;
    in the card, ↑ ↓, Home, End and Enter, and Esc closes it.
  - **Long sessions** open on their latest messages and still list every prompt, the ones folded away by compaction
    too; going to an early one draws the messages before it first. After a window reload, a session picked up where
    it was running, or a resume, the rail is right again. Needs a DGC CLI with the same feature; with an older one,
    the rail lists the prompts on screen and its card offers to load the earlier messages.
  - It belongs to the chat's own transcript: it isn't shown over Pips, an agent's page or the Sessions list.

- **A pasted image's chip shows its file name,** cut to fit, as Claude Code's does; its type, size and
  dimensions are on hover. A screenshot copied straight to the clipboard has no name of its own and still
  reads like "PNG · 1920×1080". The sent prompt's chip reads the same.

- **Edited files lists only files that were edited.** The card at the end of a turn listed a script's printed
  headers as files (+0 −0, with an Undo), and a `git diff` a command printed as if the turn had made those
  changes. It now lists what DGC's file tools, or a subscription engine's own edit tools, changed; other
  diffs are still drawn where they appear.

- **vLLM, SGLang and llama.cpp: the context meter shows the window the server was started with.** In the meter's
  details, Window size reads **Set by the server: 32K** with one line on how to change it there (restart vLLM with
  `--max-model-len`, SGLang with `--context-length`, `llama-server` with `-c`), instead of offering sizes that can't
  apply. A smaller window of your own still decides when DGC compacts, and the line says so. **Settings → General →
  Context size** says the same. Needs a DGC CLI with the same feature; with an older one, nothing changes.

- **A session keeps running through a window reload.** Reload the window, close it, or reconnect after a dropped
  Remote SSH connection: a session that was working carries on, and its tab picks it up where it is when the window
  comes back, with nothing lost or shown twice. With no window it saves and stops by itself, 2 minutes after its
  work finishes, after 1 hour waiting on your answer (the question and **Continue** are there when you reopen it),
  or after 12 hours at most. Needs a DGC CLI with the same feature; with an older one, nothing changes.
- **One window at a time, never taken by itself.** A session shown in another window opens read-only here with
  **Open here**; Open here moves it, the work never stops, and the other window shows it read-only with its own
  Open here.
- **Closing a working tab asks once:** keep the session running in the background, or stop it, with **Remember my
  choice** (`dgc.closingAWorkingTab`). Closing a tab with nothing running ends it, as before.
- **Settings → Running sessions** lists each session running with no window, what it is doing and for how long, with
  **Open** and **Stop**; the Sessions list marks it **Running, no window**.

- **A clock for the prompt cache, after the context meter (Work chat only).** As Claude Code shows it: a small
  clock and the whole minutes left (**4m**) while the provider keeps this conversation cached, changing once a
  minute; the clock alone in the error colour once the cache has gone, with why in its tooltip (idle too long,
  the conversation was compacted, or Ollama unloaded the model). It appears only for Anthropic and a local
  Ollama, and only after a reply used the cache; everywhere else there is no clock. Reopening a chat whose cache
  has gone adds one line: "Idle 2h 5m. The prompt cache has likely expired, so your next message will re-cache
  about 180k tokens." ChatDGC and Pips don't show it.

- **The context meter says when the model holds less than you chose.** Its menu and tooltip read, for example,
  **256k · this model's max** when the window in use is the model's own maximum, below the one you picked. With a
  DGC CLI that remembers the window per model, switching back to a model shows the window you chose for it.

- **Settings → Models: Cache lifetime and Keep the model loaded.** **Cache lifetime** (5 minutes or 1 hour) is how
  long Anthropic keeps the conversation cached between replies; 1 hour costs more per write and suits replies that
  are further apart. For a local Ollama, **Keep the model loaded** says how long Ollama keeps the model in memory
  after the last reply (5 minutes to 24 hours, until Ollama stops, or Ollama's own default), so the next reply
  starts at once. Both need a DGC CLI that has them; with an older one they are shown but can't be changed.

- **Lend a Personal Pip your own Chrome, once (Pips API 59).** When a Pip asks to borrow your signed-in Chrome, its
  chat shows **Let PIP use your Chrome?** with the sites, why and the time limit, and **Allow once** or **Not now**
  (both wait until its reply is done; there is no Always allow). If DGC can't reach your Chrome yet, the card says how
  to turn on remote debugging. While it's lent: **Using your Chrome · SITE** with **Stop**. When it's over, one line:
  **Gave your Chrome back** (and why, if you stopped it or the time ran out), or that it didn't use your Chrome because
  you chose Cancel when Chrome asked. The host refuses the four requests to an older CLI, which shows no card.

- **Settings → Web search keeps a key for each provider, and can remove one.** With a DGC CLI that keeps one key per
  provider, the key field shows the chosen provider's own: "Saved", or empty, never the key itself, so switching to
  Ollama shows Ollama's, not the Brave key you saved. **Remove** beside it clears that provider's key at once, and only
  that one. A key typed for one provider is cleared when you choose another, so it is never saved as another
  provider's. With an older CLI the field works as before.
- **Settings → Web search offers Ollama.** Pick **Ollama (sign-in or key)**: if Ollama on this computer is signed in,
  there is nothing to add; otherwise paste an ollama.com API key (ollama.com → Settings → API keys) in the key field,
  which saves it where Brave and Tavily keys go and never shows it back. It is offered only by a DGC CLI that has it;
  an older CLI would refuse the whole save.
- **You can see the question card move on, and Submit sends your answers.** When DGC asks several questions at once,
  a pick used to jump to the next question in 150 ms, too fast to notice. Now your pick stays marked for a moment,
  then the next question streams in a word at a time and its options appear one after another. For a moment after the
  card moves on, a second click in the same spot, or a held-down Enter or number key, can't answer the new question by
  accident. Answering the last question no longer sends: the card stays put, reads "all answered" and focuses
  **Submit**, so you can page back and check or change any answer first. A single question still sends on one click.
  With reduced motion on, the next question simply appears.
- **Settings: Web search and ChatDGC have their own icons.** Both fell back to the Plugins icon, so three rows of the side menu looked alike. Web search is a globe; ChatDGC is a chat bubble with its three slashes.
- **The Pip speaks: its runs read like a chat with it, not a log.** Each finished run is a message from the Pip in its
  own chat (its face, name and the time) in short first-person words: "I found 4 issues, 3 of them serious. The worst
  is in billing.py: the GST total skips cess on every invoice.", "1 of 2 checks failed: GET …/api/invoices → 200.",
  "I couldn't finish this run. I ran out of time. Nothing in your project was changed. I'll try again tomorrow at
  9:00 AM." The words are made from the run's report alone, so every number, file and title the Pip says is the
  report's; a few wordings per kind of run keep a week of them from reading the same. The detail is a small
  attachment under the message, one click away: **Report · 4 findings ›** opens the top findings and **Open full
  report**; beside it **Ask DGC to fix** (as before), **See what happened** and **Run again now** for a run that
  stopped, **Open run** for one that found nothing.
  - **All-clear runs fold into one message that updates itself.** Checks that passed (or audits that found nothing)
    one after another are ONE message, "Both checks passed again. Nothing for you to do.", with **✓ Passed 12 times
    since Monday ›**, which opens to each time it ran, by day. A new pass updates that message where it is; a failure
    or a run that found something breaks the fold and gets its own message, and a message from you starts a new one.
    It replaces the quiet "✓ 9:29 PM · Checks: all 2 checks passed" lines and the day-old "N earlier runs" fold.
  - **A Personal Pip's result and a routine's reply** are its own words, starting short with **Show all**; a routine's
    reply says which routine it was.
  - A Pulse's own command-plan runs no longer add a **Test results** card each under the chat: their messages say it.

- **Personal | Project tabs on the Pips page.** The dropdown that listed your Personal Pips and every project DGC
  knows is two tabs now, the same as the Sessions home's **Chat | Work**: the same look, and the arrow keys, Home and
  End move between them. **Project** is the folder open in this window and nothing else: another project's Pips are
  never listed there, and one opened from a link says "NAME is another project's Pip. Open that project's folder to
  see it." With no folder open, the Project tab says "Open a project folder to see its Pips." The tab you chose last
  is the one the page opens on, in each window. A remote view, and a CLI without Personal Pips, have one workspace
  and no tabs, as before.

- **How much it asks, on a Personal Pip's page (Pips API 58).** A picker with **Ask**, **Approve for me** and **Full
  access**, the chosen level's one plain line under it ("Opens new sites, searches, adds to carts and saves drafts by
  itself. Asks before it orders, pays, sends to someone new, posts, deletes or changes an account."), said once more
  as the notice when you choose one. Once its level lets something through, **What it did on its own** lists the
  newest five right under the picker (with "nobody at the keyboard" for a routine) and **Ask me again from now on**.
  A card under a reply says why its level still asks ("It looks like a payment, so it asks at every level."), and the
  safety floor's card reads **Let PIP run this in its Terminal?** with **Allow once**. The host refuses both requests
  to an older CLI, which shows no picker.

- **Memory that learns, on screen.** A Work session's chat shows what DGC kept from it, once, as a quiet
  **Remembered: … · Forget** line (the panel asks for it with `memory_watch`, only from a CLI that offers it).
  **/learn [what]** in Work and in a Personal Pip's chat shows the drafted skill with **Save**, **Edit** and
  **Cancel**, and nothing is written until Save; a Pip's /learn is never sent to the Pip as a message. Settings →
  Memory says each fact's kind, where it was learned and the day it stops being used, and **History** lists every
  change with who made it and when, with **Undo** (an older CLI shows no history, and Delete all still says it can't
  be undone). A Personal Pip's page shows its **Working notes**, with **Edit**, and its **Daily log**, by day (Pips
  API 57; the host refuses both to an older CLI).

- **Save a login so a Pip signs in by itself (Pips API 56).** When a Pip meets a sign-in page it has no login for,
  its chat shows **Save a login for SITE so PIP can sign in itself?** with **Save login…** and **Not now**. The form
  takes the username, the password and an optional authenticator key, sends them to DGC once and keeps nothing: not
  in the chat, its draft or the view's saved state. A Pip's page shows **Logins**: each login it may use, with **All
  Pips** and **Remove**, and the ones saved for your other Pips with **Let PIP use it**. The host refuses all four
  login requests to a CLI below API 56.
- **follow-redirects 1.16.1** for the Open VSX publishing tool (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c: credential headers kept across a cross-origin redirect). It is a build tool, not part of the extension.
- **markdown-it 15.0.3.** A security fix in the Markdown parser (GHSA-r7fv-28h4-cvq7: unmatched closing quotes with smart quotes took quadratic time).
- **A Pip's computer has apps (Pips API 54).** Its dock adds an image editor, Documents and a PDF viewer when the
  computer has them; when it doesn't, the computer tab asks once, in one line saying what and how big, with
  **Download** and **Not now**. A Pip that can see uses the whole desktop, and you see its cursor there as before.
- **A detailed message mid-turn reads like an answer.** When the model stops to write out something you should read in
  full before it goes on, such as a diagnosis or its plan for a large change, that message now has the room an answer
  has above and below it and uses the full width, instead of sitting 4px under a tool line like a one-line update. It
  stays in the chat after the turn ends. A message counts as detailed when it has a heading, a list, code, a table or
  a quote, two or more paragraphs, or more than about 320 characters; a one-line update is unchanged. A mid-turn line's
  Copy is also there while the turn runs; the last render used to remove it until the turn ended.
- **Card numbers stay out of the chat.** A card number typed in a Pip's chat is not sent and not kept (not even as a
  draft or in undo): one line says to type it on the Pip's screen, with **Open its computer**. DGC's own chat warns
  once ("whatever you send here goes to the model"); Enter again sends it as it is. Bill, UHID, phone and account
  numbers are not mistaken for cards.
- **What its computer holds shows in the Pip's chat.** A new site to allow (Allow this site / Not now) and a held form
  or payment (what it pays, Review… / Reject) now wait under the Pip's reply, not only in its computer tab: a reply
  said "Starting with the hospital bill on its pay page" while the Allow it needed sat in a tab the user hadn't opened.
  A payment is never sent from the chat in one tap; Review… shows the page and every field first.
- **A held payment says what it pays.** On a Pip's computer tab, a waiting payment reads "Pay on <site>" with what the
  form sends (a bill number and an amount, an order's sizes); a hidden card field never shows. It said only "Send a
  form to <site>".
- **See where a Pip clicks.** With DGC CLI on Pips API 53, a Pip's computer tab shows its cursor (an arrow with its name) where it last clicked, dragged or scrolled, over its browser or on its full screen, while it works. "What it saw…" draws each step's cursor, and a drag's path, on its screenshot.
- **Seeing, on a Personal Pip's page.** Its model sees its screen and your photos, or it can't: then the row says how it sees (it asks you, a model that can see looks for it, or not at all), changes it in one choice, and offers Switch to the model that can see.
- **A payment never offers Always allow**, in the Pips view or the computer tab; it asks every time.

- **Even gaps around progress lines.** Each line the model writes between steps kept an empty row under it for its hover Copy button, so every tool line had 44px above it and 8px below. The Copy button now sits at the end of the line itself, and a line sits just above the work it introduces.
- **One line per stretch of work.** Everything the model does between two of its sentences is one line now, such as "Ran 6 commands · thought 13s ›", folded once it is done. Thinking no longer splits that line: a model that thinks before every command drew "Thought for 2s · raw" and "Ran 1 command" six times over (twelve rows); it is one line, and opened it lists the six steps. Each thought sits on the step it led to as a small "thought 2s" mark that opens the same thought text as before. A thought just before a sentence, with no step around it, stays its own row; one that ends a stretch is the line's last row and counts on the line. A hidden ("withheld") thought is a mark with nothing to open. A sentence, a summarized note, a delegation and an approval still stand on their own, and an approval is never folded away.
- **The step running now, under the line.** While a stretch works, one row under its line says what it is doing: "Running npm test 2.1s" with a spinner, "Thinking… 3s" between steps, or the last step done until the next one starts. It changes in place, steps aside when the line is opened (the steps show themselves) and goes when the stretch ends. A chat reopened mid-stretch draws it again.

- **Pip report cards are two lines.** Line one: the Pip, what it found ("5 findings · 2 high", "failed", "nothing found") and when; line two: the worst finding or why it failed, with Fix · Open · ✕. A clean run is one line. A click (or Enter) opens the whole card. Cards that arrive together sit 4px apart instead of a block apart, and two or more fold into one line ("3 Pip reports · 1 failed · 5 findings · 1 clear"). Two quiet cards went from 134px to about 56px. The Pip's face on a card is alive, as in Pips: it breathes, blinks and looks at the pointer (still under reduced motion).

- **Steer now, Steer all.** A queued message ("you · queued", from Alt+Enter or a Pip report's Ask DGC to fix) has Steer now: it goes into the running turn the way Enter-while-working does, and the model reads it at its next step instead of after the turn. Steer all, beside "N queued", sends every one. A turn that can't take it says so and the message stays queued.

- **"Show more" on a long prompt no longer sits on its text.** It has a strip of its own under the first three lines; over the faded last line, the words ran into it.

- **A Pip's status opens its latest run.** "Report ready", "Last run failed" and the like under a Pip's name read like a link and did nothing; they open that run on the Runs tab now, scrolled to its report.

- **Ask DGC to fix sends, once.** On a Pip report card it sends DGC one message naming the run (queued behind a turn that is running) and becomes "Asked DGC", also after the chat is reopened. Before, it only filled the box, and a second click pasted the prompt again. A draft in the box is left alone.
- **The chip line's colours are the rows' colours again.** Blocked tasks and a blocked goal show their icon and "N blocked" in the olive error colour, waiting monitors and a Pips alert in amber, with no dot and no outline. Error text in light themes is a darker olive, readable on white.

### Phone photos in a Pip's chat (needs DGC with Pips API 52)

- **Send a Pip real photos.** A photo can be up to 8 MB and a message up to 32 MB of photos, with no four-photo
  cap; files can be up to 16 (a document up to 16 MB, a text or code file up to 1 MB, 32 MB in all). The extension
  hands them to DGC through its spool, as the Work chat does, so a phone photo of a bill goes as it is. With an
  older DGC the old limit stays (4 images and 4 files, 2 MB in all).
- **iPhone photos (HEIC) just work**, in a Pip's chat and the Work chat: add or paste one and DGC turns it into a
  JPEG. Its chip shows its name until it is sent, since VS Code can't draw HEIC. A computer that can't convert one
  says what to install in one sentence, and nothing is sent.
- **The chat keeps your original.** Every photo a message brought shows as a thumbnail (drawn small, so a chat of
  phone photos stays light), and clicking one opens the original at full size in an editor tab ("Photo 1.jpg").
  The model is sent a large photo at 2,500 pixels, which keeps small print readable.

### A Pip's runs in its own chat (needs DGC with Pips API 51)

- **Each run is a message from the Pip in its chat**, where you can ask about it: its face and name, "Today's
  audit found 5 things, 2 of them high", the top three findings with severity and file:line, **Open full report**
  and **Ask DGC to fix**. A failed run says what stopped it in plain words, that nothing in your project was
  changed and when it runs again, with **See what happened** and **Run again now**. A clean run is one quiet line.
  A Personal Pip's scheduled result is its message, with **Open full result**. A reload draws the same.
- **Runs is now History** (Results, for a Personal Pip). Each row says what the run found ("5 findings · 2 high",
  "Nothing found", "Didn't finish · …") instead of "Report ready", and Open full report lands there at that run.
- **The status under a Pip's name says what its last run found** ("Today's audit: 5 findings") and goes to that
  post in the chat.
- **Ask DGC to fix, from the Pip's chat**, sends the Work chat card's prompt to the chat the Pip reports to, in its
  tab (a new chat when it reports to none), once; the button then reads "Asked DGC".
- Runs nobody replied to that are more than a day old fold into one line ("4 earlier runs"), so a week of nightly
  runs doesn't bury the chat; History keeps every one.

### Pips: scheduled Pips run with VS Code closed

- Creating a Pip with a schedule, a commit trigger or a routine, or giving one a schedule, turns **Keep Pips running**
  on when it is off and you haven't turned it off yourself, and the Pips view says so: "Your scheduled Pips now run
  even when VS Code is closed. Turn this off in the Pips view, under Controls (Keep Pips running)…". A setup card
  with a schedule says so before you accept it.

### Monitors after a reload

- **A reload no longer loses the chat's monitors.** When the chat comes back after a window reload or a lost
  connection, each monitor that was running starts again with the same command, folder and sandbox, and the chat
  says what was missed: "Monitor "ERP sync" restarted after DGC reopened this chat; nothing was watched between 10:02
  and 10:05." It is on the monitors row and in the agent map with Stop, as before.
- One the chat's permissions no longer allow (plan mode, or an approval it did not need before) reads "stopped when
  DGC restarted" with **Restart**; your press is the approval. The same lines come back when the chat is reopened
  later, without the button. Needs a CLI with `monitor_restart`.
- **Commands, sub-agents and Troupes after a restart.** A background command or sub-agent that was running reads
  "stopped by a restart" in the chat, with **Run again** (and **Resume** for a sub-agent); nothing runs again until you
  press it. The agent map lists such a command with Run again on its card, apart from what is running. A Troupe picks
  up where it stopped, once. Needs a CLI with `task_interrupted`.

### Pip reports in the chat

- **A finished Pip run appears in the chat it reports to,** as a card in the transcript where it arrived (after
  the turn that was running, which carries on), not as another row above the message box: the Pip's face and name,
  what it found or why it failed, its worst findings with file and line, and **Ask DGC to fix** (puts a prompt
  naming the run in the message box after your draft; nothing is sent), **Open report** (the Pips view at that run)
  and **Dismiss** (saved with the chat). A clean run is one quiet line. It is saved with the chat, so a closed chat
  shows it when you open it, and a reload draws the same card. A Pip's Runs page says where its reports go, or how
  to attach it to a chat.

### Pips: Excluded folders and a size check (needs DGC with Pips API 50)

- **Source, on a Pip's page (Advanced):** a list of **Excluded folders** (add one, remove one; `uploads/`,
  `docs/screenshots/` or `*.mp4`, written as in `.gitignore`), saved with the current source rules. A Pip on the
  older rules says so: one file over 4 MiB or more than 64 MiB of code fails its every run, and Save moves it to the
  rules that leave such files out and list them. Saving the list keeps the Pip's schedule; only switching to your
  current files still turns it off.
- **Check size** checks the choice before you save it: whether it fits a run, what each run leaves out, and the
  biggest folders when it doesn't.
- **A run's report lists what its copy left out** (skipped files and why, and what your ignore files and Excluded
  folders left out).

### Agent map

- **The agents pill opens the agent map**, as in Claude Code, and so does `/agents`. The pill counts the agents
  working now and stays after the turn once the chat has had one.
  - **The map:** the chat as the root and every agent it started, in columns by depth (stacked in a narrow side bar):
    its face (swirling while it works), what it was asked, and its time and tokens, ticking. Failed agents are red,
    finished ones grey.
  - **Background tasks below it:** commands running in the background, monitors, Troupes, Pip runs started from this
    chat and artifact previews, each with Stop (or Open).
  - **An agent's card:** state, type, model, background or foreground, who started it, time and tokens, what it is
    doing or its result, its prompt, its tool calls, **Stop agent** and **Open transcript**: the agent's whole
    conversation, live, in a large window.
  - **Going back:** ←, Esc, or a click on the empty space around the window each go back one level: transcript, card,
    map, closed.
  - **Stop agent** stops one sub-agent without ending the turn (with a CLI that says it can); the main agent is told
    and carries on. A command's card shows its output, updated every second.
- **The pill counts the background tasks too.** Two commands running in the background read "2 tasks" (it said
  "0 agents" while the map listed them), beside an agent "1 agent · 2 tasks". It counts the map's own list, so the
  two always agree, and changes as each task starts and ends. A chat with no agent shows it while a task runs.
  - **Its label says it in words:** "1 agent working and 2 background tasks running". The dot is blue while an agent
    needs you, green while anything runs.
  - **A narrow footer** keeps the dot and the number of things running ("3"). Where the footer is only short of
    room, the model name truncates instead of running under Queue.

### ChatDGC

- **Thinking is collapsed by default**, while the model thinks and once it has answered, in new replies and in chats
  you open again. Click "Thinking" (or press Enter on it) to read it; what you choose stays for that reply while it
  streams and after.
- **"Thinking" no longer flickers.** Each streamed part drew the whole reply again, taking the thinking box out of the
  page and putting it back, so the label lost the pointer's hover with every part and the working line's pulse
  restarted. Now what a part doesn't change stays where it is. While the model works, "Thinking" and lines like
  "Searching the web for…" show Work's status mark: DGC's three slashes lighting in turn beside words that hold still
  (still too for a reader who asked for less motion).
- **An open thinking box scrolls on its own**, with the wheel, a trackpad or the keys (Tab reaches it; the arrows,
  Page Up and Down, Home and End move it). It follows the model's words while it's at its end; scroll it back and it
  stays where you put it while the reply goes on, and the chat stops pulling it away as the answer streams below. At
  its end, the wheel goes on to scroll the chat. The reply finishing keeps your place in it.
- **Sources only at the end of a reply.** The source chips in the middle of a reply's words are gone, and so are their
  hover cards; a reply that used the web ends with its sources ("Sources · 4" and their icons), which open beside the
  chat as before. The "[1]" marks the model cites with are taken out of what you read, with the space before them, so
  "Paris [1]." reads "Paris.". They stay in code, in a reply with no sources, and where a number names none of its
  sources ("array[0]"). Copy, a deep research report (in the chat, its reader and its Copy) and chats you open again
  read the same way.
- **No Search switch in the prompt box.** ChatDGC already looks things up whenever an answer depends on it, so the box's
  Search (which only made it search first) is gone; Deep research and Study stay. Web search is on unless you turn it
  off, in one place: **Settings → Web search → Search in ChatDGC**.
- **Widgets in a chat, from its header.** While a chat has widgets, its header shows **Widgets N** (the mark and the
  count in a narrow editor), styled as Work's header buttons. It opens "Widgets in this chat": each widget's name,
  when it was made and the prompt that asked for it, with:
  - **Open**, beside the chat (its page fetched when its reply isn't on screen);
  - **→**, which scrolls to its card and outlines it, loading the chat's earlier messages first when needed;
  - **Delete**, asked in the row ("Delete it?"), then deleted as the Library does: its card stays, marked deleted.
  The list's footer opens the Library on its Widgets tab. Esc closes the list, Tab and Enter work it, and a long chat
  opened on its latest messages still lists every widget (with a CLI that sends a chat's outline). The side bar's
  Library button now says it holds widgets too.
- **The prompt rail**, as ChatGPT's table of contents: in a chat of five prompts or more, a short tick for each prompt
  sits in the right margin, centred, and the one you're reading is bright.
  - **Hover it** (or Tab to it) for a card of every prompt with its time under day headings (Today, Yesterday, the
    weekday), the widget each reply made, and the one you're reading tinted. Click a prompt to go there: the view
    eases to it (at once for a reader who asked for less motion) and outlines it for a moment.
  - **Keys:** Alt+↑ and Alt+↓ go to the prompt before or after, from anywhere in the chat, the message box included;
    in the card, ↑ ↓, Home, End and Enter, and Esc closes it.
  - **Long chats:** the ticks close up to 4px apart, then show a window around where you are, faded at both ends;
    they're shorter at side-bar width.
  - **Chats opened on their latest messages** still list every prompt (with a CLI that sends a chat's outline), and
    going to an early one loads the messages before it first. ChatGPT's rail broke in exactly that case.
- **A chat's header opens on DGC's wordmark**, as a Work session's does: ChatDGC's mark (the chat bubble with the three
  slashes inside it), "DGC" and the blinking cursor. The slashes in the bubble breathe in turn as Work's do, and stand
  still for a reader who asked for less motion.
- **Each prompt and reply says when it was sent or written**, in DGC's chat, ChatDGC and Pips: the time today,
  Yesterday or the weekday this week, then the date; the whole date on hover. A reopened chat shows its times too, and
  how long each finished turn worked.
- **Answered questions stay in the chat**, as Claude Code keeps them: "Questions · Answered · 2 questions", every
  question with every option and its description, your picks marked (a filled circle for one choice, ticked boxes for
  several, "Your words" for an answer you typed). It no longer folds away inside "Used 1 tool".
- **A working agent's face swirls**, everywhere it is drawn, chips included; still once it ends, and still for a reader
  who asked for less motion.
- **An agent running in parallel says what each step worked on** ("Read README.md"), on its page and in the map,
  where it read a bare "Read".
- **Dictation, in every box.** DGC's chat, ChatDGC and Pips each have a microphone beside Send. While you speak, the
  box's bottom row becomes the voice bar, as Codex shows it:
  - **The bar:** ✕ Cancel, a live waveform with the time, ■ Stop and ↑ Send. Stop puts what you said in the box at
    the caret; Send puts it in and sends it.
  - **The waveform is your microphone:** DGC Voice measures how loud it is about every 50 ms, and each bar is
    200 ms of that. If the line stays flat for three seconds, the bar says "Not hearing anything — check your
    microphone".
  - **One box records at a time.** Esc cancels, and the first press with no model opens **Settings → Voice**.
  - **Settings → Voice:** lists each model with its download size and licence. **Install** downloads it with a
    progress bar you can cancel, then **Use** picks it and **Remove** deletes it.
  - **DGC Voice:** a small extension that records on the computer you're at, even in a Remote SSH window. It uses
    the recorder the system already has: AVAudioRecorder on macOS, the Windows audio API, or `arecord`,
    `pw-record` or `parecord` on Linux.
  - **Silent recordings:** a recording that is digitally silent is reported as a microphone the system withheld
    (macOS records zeros without permission), never sent as speech.
- **Read aloud.** A speaker under every reply, in DGC's chat, ChatDGC and Pips. The reply's voice plays as each
  sentence is made, and the speaker shows Stop while it reads. One reply is read at a time.
- **Voice mode, in ChatDGC and Pips.** While the box is empty, voice mode sits where Send is, as in ChatGPT. It
  listens with a live waveform, and when you stop talking it writes it down and sends it. It reads the reply
  aloud, then listens again.
  - **When your turn ends:** after about 1.2 seconds of quiet, measured against the room's own hum.
  - **Its buttons:** Done ends your turn early, Stop cuts the reply short, and ✕ (or Esc) ends voice mode.
  - **What it needs:** a dictation model and a voice; without them it opens Settings → Voice. Nothing records
    while it speaks.
- **Voice offered once:** the first time DGC starts with voice available and nothing installed, a notification
  offers to set it up.
- **Voice mode has nothing to look at**, as ChatGPT's: a spoken reply makes no canvas, file, widget or question
  card. Typing again brings them back.
- **Send while it answers, as Codex queues it.** In ChatDGC a message sent while a reply is being written (or while
  it summarizes) waits above the box and goes by itself when the reply finishes, one a reply, in order. Edit or ✕
  on each; ↑ in an empty box takes back the last. Stop, or a reply that fails, sends none of them: they come back
  to the box.
- **Used [logo] Aave:** a reply that read from a plugin says which under it, with the plugin's logo, once it's
  finished, in ChatDGC and in a Pip's chat.
- **Several questions in one card.** When the model needs a few things to go on, ChatDGC asks up to four questions
  in one card, numbered, the first answer of each chosen until you change it, and one button in the model's words
  (**Build my plan**) sends them all.
- **A Pip's page shows what it keeps in your one memory** (Pips API 46), and Forget there forgets it everywhere.
- **Chat, above Work.** The side bar lists your chats above this project's sessions (now **Work**), with
  one search over both. **New chat** (or **DGC: New Chat (ChatDGC)**) opens a chat in an editor tab of
  its own. Replies stream as Markdown, with code, tables and links that open only when you click them.
  You pick the model and how much it thinks; **Thought** shows what it thought. **Stop** keeps what was
  written, and **Continue** carries on. **Temporary** chats are never saved. The **⋯** menu renames,
  pins, archives or deletes a chat. Chats come back in their tabs after a window reload. Needs the DGC
  CLI with this release; with an older CLI the home shows no Chat list.
- **Web search in ChatDGC**, with numbered citations that open their page and a **Sources** list under the
  reply. Choose **Web: auto, always or off** in the box.
- **Settings → Web search** picks the one search Work, ChatDGC and your Pips share: DuckDuckGo, Brave,
  Tavily or your own SearXNG. A saved key is never shown back.
- **Attach files, paste images and long text** in ChatDGC: the paperclip opens VS Code's file picker; a
  pasted image is scaled to fit; a paste over 5,000 characters becomes an attachment. Chips show what
  goes with the message and stay on it once sent. Only files you picked can be sent.
- **Thumbnails** for images you sent (click to enlarge).
- **Drag files onto a chat**, from VS Code's Explorer or your file manager.
- **Seen by:** when the chat's model can't see, another model looks at the image, and **Seen by** under your
  message shows which one and what it saw.
- **Edit** a message you sent, or **Try again** on a reply. The old version stays: **‹ 2 / 3 ›** steps
  between them.
- **⋯ → Export…** saves a chat as Markdown or JSON.
- **Settings → ChatDGC:** what ChatDGC should know about you, how it should respond, and its personality.
- **Search finds a chat by anything said in it**, and shows the words around what it found.
- **Keyboard shortcuts**, as ChatGPT has them:
  - new chat: Ctrl/⌘+Shift+O;
  - copy the last reply: Ctrl/⌘+Shift+C;
  - copy the last code block: Ctrl/⌘+Shift+;;
  - focus the box: Shift+Esc;
  - the list of shortcuts: Ctrl/⌘+/.
- **Sources, as ChatGPT shows them.** A fact a reply took from the web carries a pill with the site's favicon
  and name; point at it for the page's title and what it says. **Sources** under the reply opens every page it
  cited, and the other results it found, in a panel beside the chat. A site's icon sits on a white disc, so
  a dark logo still shows on a dark theme.
- **Follow-ups.** Under the latest reply, a few next messages you might send; click one to send it.
  **Settings → ChatDGC → Suggest follow-ups** turns them off.
- **Branch in new chat.** The branch button under a reply opens a new chat with the conversation up to there,
  in a tab of its own, marked where it branched (with a link back). The original stays as it was.
- **Projects**, as ChatGPT has them: chats, files and instructions together. They sit above your chats in the
  side bar; drag a chat onto one, or use **Move to project…**. A project's page shows its instructions, files,
  memory setting and chats, and its box starts a chat in it. Every chat in it reads its instructions and files,
  and a project can keep its memory to itself.
- **Plugins in chat.** Every plugin you turned on is ChatDGC's too. A read runs at once; a change shows a card
  under the reply with what it would do: **Send it now** (edit its inputs first if you like), **Hand it to a
  Pip** (offered first for something recurring), or **Don't**. A plugin that can move money always asks, and
  what the chat read from your apps never goes to a web search or out in a change without its card.
- **The Library.** **Library** in the side bar shows every file you attached in ChatDGC, by kind, searchable by
  name. Open where a file is, start a new chat with it, save a copy, add it to a project, or delete it. The
  paperclip lists your newest files before Upload.
- **ChatDGC has its own mark:** DGC's three slashes in a speech bubble, on its chat tabs, its project pages, the
  Library and the New Chat (ChatDGC) and Ask ChatDGC buttons, so a ChatDGC tab is never taken for a DGC session.
- **What fills the window.** ChatDGC's meter details show it as Claude's Usage sheet does: a bar a colour a part,
  each part's tokens and share, every tool listed with its own, the room kept for summarizing and the free space.
  The parts fold under **Details** at first, with the bar and what's free shown at a glance. Main DGC's and a Pip's
  context menus fold the same way, and what you open stays open as the meter updates.
- **A welcome for the time of day.** A new chat greets you under ChatDGC's mark with a line that fits the hour.
- **ChatDGC's box, as main DGC's.** No purple ring around it; Search, Deep research and Study are plain buttons;
  the context meter is main DGC's (its details laid out the same, with **Window size** from 8K to 1M); and one
  button by Send names the model and opens a menu of the models with a **dial** for thinking: click a mark, drag,
  or use the arrow keys.
- **Maths in replies.** Formulas show typeset (KaTeX, loaded the first time one appears), not as raw `$…$`;
  dollar amounts and code are left alone, and Copy keeps the formula as written.
- **Interactive answers.** A calculator, converter, timer or quiz to use right away: it opens in a tab beside the
  chat, locked down (no network, no access to your chats or VS Code), in the editor's colours. ChatDGC checks what it
  shows once it's open and fixes it if it's wrong; if its code still fails, it says so. It opens again as you left it,
  and a widget open when VS Code closed comes back. A card under the reply has **Open** and **Show code**, and the
  Library's **Widgets** tab lists them all, to open again or delete.
- **Data analysis and charts.** Attach a spreadsheet and ask about it: answers come from exact queries (open
  **Analyzed the data** to see them). Replies can draw bar, line, area, pie and scatter charts: hover for values,
  click the legend, **Data**, **Copy data** and **Save image**.
- **Canvas.** A longer piece you'll work on together (an essay, a plan, a program) opens in an editor beside the
  chat. Edit it yourself; ChatDGC reads your version and changes it with small edits you can undo. Select a part and
  choose **Ask ChatDGC About This**; the title bar has shortcuts, **Canvas Versions…** (compare or bring back) and
  **Download Canvas…** (Word, PDF, Markdown, or the code file).
- **A canvas document opens formatted**, as ChatGPT shows it: a page with headings, lists, tables and maths drawn, and
  a toolbar (style, bold, italic, strikethrough, code, link, lists, quote, divider, **Ask ChatDGC** on a selection,
  shortcuts). Type Markdown shortcuts as you would (`# `, `- `, `> `). It saves itself when you pause, and what
  ChatDGC changes lights up as it lands. **Open Canvas as Markdown** shows the same file as text, and **Open Canvas
  Formatted** brings the page back; only the parts you changed are rewritten. Code canvases open in the code editor.
- **Tables, maths and checklists in the formatted canvas.** Type in a table's cells (Tab to the next, Enter to the
  one below), and add or delete rows and columns or align a column from the table's own tools. Click a formula to edit
  it with its result drawn as you type; `$…$` becomes one as you type it, `$$` starts an equation. Checklist items
  have a box to tick; **Checklist** makes one.
- **Writing blocks.** A drafted email, message, letter or post comes in its own box: **Copy** (just the text, no
  stars or hashes), **Open in mail app** (address, subject and text filled in), and **Edit** in place, which the
  chat then works from. A reply's **Copy** now copies it as it reads: formatted in a mail app or document, clean
  text elsewhere.
- **Study mode.** **Study** in the box makes the chat a tutor until you turn it off: it asks what you know,
  teaches a step at a time, has you try, and checks with quick quizzes you answer with a click.
- **Files ChatDGC makes.** Ask for a document, PDF, spreadsheet or slides and the reply comes with a card:
  the file's kind, size and pages, **Open** (in its own app; Markdown and CSV in an editor tab) and **Save a
  copy…**. "Making Budget…" shows while it's laid out. The Library marks these files, and once ChatDGC has made
  one, shows **Uploaded** and **Made by ChatDGC** filters. Needs the DGC CLI with this release.
- **Pictures from the web, where seeing helps.** Ask what a place, a dish, an animal or a style looks like and
  a strip of up to four pictures shows above the answer as it's written, each with the site it's from. Click
  one to see it larger, with its title and **Open page**; the arrow keys step through them. A rules, prices or
  code question gets none. The pictures are fetched by DGC and kept with the chat: the chat screen never asks
  an image site itself.
- **Web search is always on in ChatDGC**, as in ChatGPT: a question about facts that could be wrong or out
  of date (rules, rates, prices, news, people) is looked up before it's answered, with sources. The box's
  **Web** picker is gone; **Search** makes it search first for one message, and **Settings → Web search** can
  turn it off.
- **Memory**, as ChatGPT has it. ChatDGC remembers what you tell it about yourself, says so under the reply
  (with **Forget**), and knows your projects from your Work sessions. The same memory reaches your Work
  sessions and Pips. **Settings → Memory** shows it all: edit, delete, add, keep a project out, delete all,
  or turn it off.
- **Chat and Work are tabs** in the side bar, so a long list of chats no longer pushes your sessions out of
  sight. The search covers both, and each tab shows what it found.
- **Deep research**, as ChatGPT has it. Press **Deep research** in the box: a plan first (it starts in 15
  seconds unless you edit it), then its searching and reading as it happens, with a box to add to it, then a
  report whose every citation was checked against its source. **Open report** shows it full screen with
  contents and sources, and **Export…** saves it. If it finishes out of sight, VS Code tells you.
- **Questions in an answer**, as ChatGPT asks them. When what comes next depends on something only you know, a
  reply can put a question to you as a card right where it asks: pick an answer, or type your own, and
  **Continue** sends the follow-up the model wrote for it. The reply goes on below the card.
- **A context meter** in the box (amber at 70%, red at 85%), with **Compact now** and **Continue in a new chat**.
  Near the limit, older messages are summarized. You see when it happens, the summary sits behind an
  **Earlier messages summarized** divider, and you can read it (as formatted text) and edit it. When
  everything before your last exchange is already summarized, the meter's details say so.
- **Settings → ChatDGC → Window:** 8k, 32k, 128k, or the model's maximum.

### Questions

- The Questions card's free-text hint fits its field: beside Skip and Continue in a side bar it says
  "Something else…" instead of a sentence cut off mid-word, and an empty field stays one line.

### Sessions

- **Thousands of sessions, and a search.** The Sessions list has **Search sessions**: it finds a
  session by its name, its first message or anything said in it, and shows the words it found. The
  list shows 200 at a time with **Load more** (it stopped at 500 before), and lists quickly however
  many there are. Needs the DGC CLI with this release.
- DGC opens on your project's **Sessions**: the side bar lists this project's sessions, newest
  first, with when each was last used and how many messages it has. **Open in Editor**, a
  double-click or Enter opens a session in an editor tab of its own, as in Claude Code; **New
  session** opens a new one in a tab. The Pips stay in the side bar.
- Each tab is a full chat with its own DGC process. It is named by its session's name, else its
  first prompt. A session open in a tab is marked **Open in a tab**, and opening it again brings that
  tab forward. Tabs come back on their sessions after a window reload.
- **DGC: New Session** and **+** open a new session's tab; `/new` in a chat still starts afresh in
  place. **DGC: Resume** shows the Sessions list.
- Palette commands (Add Selection, Add File, model, mode, Restart Backend and the rest) act on the
  tab you last used, and the status bar shows that tab's model and mode. Add Selection and Add File
  read what is in front of you first, then open a new session's tab if none is open.
- Deleting a session from the list asks first, and waits until its tab is closed.
- Your Pips sit above your sessions: the ones that need you, each with its face, what is waiting
  and a count, or a quiet row of faces when nothing is. A click opens that Pip. The Pips bell no
  longer appears above a session's composer.
- Token usage → Pips shows which models the Pips used (By model), and each Pip's own models.

### Fixed

- **Session and ChatDGC tabs keep their logo after a reload.** After Reload Window in a Remote SSH window (Cursor's
  too), or after installing a new DGC version, these editor tabs came back blank. VS Code redraws a saved tab's icon
  before DGC revives the tab, and a tab behind another is revived only when you show it. The icon was a link to
  DGC's file, which could not be fetched until the remote connection was up, or pointed at the old version's
  folder. Now the tab carries the picture itself, so it shows from the first moment, in the light and dark themes.
  A tab saved by an older version gets the fix the first time you show it.
- **A partial count says it is a floor.** When DGC can't check every file, the bar above the prompt box reads
  "At least 12 files changed in this chat", and its tooltip says the real totals may be higher. It used to put
  "partial scan" beside numbers that read as totals, and the totals themselves were wrong ("+1 −82173"); that part
  is fixed in DGC itself.
- **Install DGC Voice installs it.** DGC Voice isn't on the Marketplace or Open VSX yet, so the button opened the
  Extensions view on a search for `@id:vibedgc.dgc-voice` that found nothing. DGC now carries DGC Voice inside its
  own package and installs it from there (from the Marketplace instead, once it's there and not older), on the
  computer you're at even in a Remote SSH window. It starts at once, with no reload, and the box that asked says
  it's ready. If it can't install, it says why and where the file is, with **Install from VSIX…**.
- **Cmd+Z and Ctrl+Z in the prompt box undo what you did, in the order you did it**, as in Codex's box. The box
  keeps its own history now; the browser's did not keep up with it, and in VS Code it was what the keys reached:
  - A paste, dictated words, a picked completion and a message put back are each one step. They were undone
    together with everything typed before them; typing pauses for half a second end a step too.
  - Undoing and redoing a picked skill or @file brings back what it stands for, not just the pill, and a pill
    removed with Backspace comes back with Cmd+Z.
  - Cmd+Shift+Z and Cmd+Y redo (Ctrl+Shift+Z and Ctrl+Y on Windows and Linux), and the keys no longer also reach
    VS Code's own Undo, which ran the browser's history a second time.
  - A paste in VS Code no longer turns the pills already in the box into nothing.
  - Copying a selection with pills copies their words: `$skill`, `@file`, `/command` and a link's address
    (Chromium's copy left them out). Pasted back into the box, they are pills again.
  - Cmd+B and Cmd+I no longer make words bold or italic in a box that sends plain text.
- **Undo works in ChatDGC's box and a Pip's box too.** Words dictated into ChatDGC's box, a sent message, a queued
  message given back and a long paste folded into a chip can be undone; a Pip's box no longer forgets its undo
  history each time the page redraws around it (whenever a reply streams in).
- **Dictation over Remote SSH explains itself.** In Cursor or VS Code connected to another machine, the microphone
  said "Dictation records on the computer you're at" and nothing else. It now says DGC Voice must be installed in
  that editor on this computer while DGC runs on the remote host, and offers to install it.
- **A link to a file with its line is a link.** A Markdown link to `README.md:1` in a reply showed as raw text: a bare file
  name followed by a colon looked like a web address's scheme. The line comes off first now, so it opens README.md
  at line 1; `javascript:`, `command:` and the like are still refused, digits or not.
- **A Pip's plugin action shows its Allow card again.** Since every plugin turned on became every Pip's, what a
  Pip wanted to do in a plugin showed only as an "App action for you to check" row: the chat no longer knew
  which plugin the action's server belonged to. It finds it by the server now, with Allow, Always allow
  (never for a plugin that can move money), Edit and Don't.
- The Pips header no longer breaks when the runner reports an error: the error has its own row,
  and "Pips", "Start runner" and "Controls" keep their words on one line.
- A Pip's computer sets its desktop up itself the first time you open it: DGC downloads the desktop
  and Google Chrome into its own folder, with no password and nothing installed on your system, and
  the tab shows the progress, then the screen.
- A Pip's computer tab shows the Pip's face again (it showed a broken-image picture), keeps what
  you type in its browser's address bar while the screen refreshes, opens on an empty desktop with
  DGC's own wallpaper, and its Terminal says plainly that it is offline on purpose.
- A session's editor tab shows the DGC mark in white on dark themes (it was black).
- An image you send shows in your prompt as the same small chip it was in the composer (a tile
  beside its type and size; click to open it), not as a large picture. A prompt with an image
  now stays pinned at the top while you read its answer, like any other prompt: the large picture
  had made it too tall to pin.
- While background sub-agents work, the main model's long thought no longer streams as dozens
  of "Thought · raw" rows: a sub-agent's hidden steps and thoughts no longer close it, and a thought
  still streaming always continues in its own row.

### Chat

- **What's running sits on one line above the prompt box.** A goal, a troupe, monitors, the checklist and this
  chat's changes each took a full row there: five rows, 204px of a 460×820 side bar. With two or more showing, each
  is now a chip on one line (36px): "◎ 1:12:00", "Troupe 5/8", "2 monitors", "Tasks 4/7", "6 files +214 −37". Click
  a chip and its usual row opens just above the box, over the end of the chat, with every button it had: Stop,
  Pause, Edit, Review, Clear, the troupe's stages and the checklist (already open). Esc, a click elsewhere, × or the
  chip again closes it.
  - **Anything that needs you turns its chip amber and says why:** a blocked task ("1 blocked"), monitor events
    waiting for your next message ("3 waiting"), a blocked goal, a failed troupe, a Pips alert. A screen reader hears
    it in the chip's label.
  - **One kind alone keeps its full row**, as before.
  - **From the keyboard** the chips are one Tab stop: ←/→, Home and End move along them, Enter or Space opens one,
    and the focus goes into it and back to the chip when it closes.
  - **A troupe's popover** also opens its journal (the plan, every agent's result, the report) and shows the troupe
    in the agent map; the monitors' popover shows them there too.
  - **A narrow panel** drops the words first, then the line counts, then a chip's number when it needs you (the
    reason stays), and only then wraps onto a second line.
  - The invisible-characters notice keeps its own row: it is about the message you're typing. "2 queued" and
    **Workspace changes** move onto the chip line instead of taking rows of their own, and the Pips digest is a chip
    too.
- **What fills the window.** The context menu shows the session's window part by part, as ChatDGC's does: the
  messages and tool results, the system prompt, each tool (MCP tools by server), memory by file, skills and
  plugins, the room kept for summarizing, the free space, and the MCP tools held back until a search finds them.
- The model menu's note is three lines at most, with **Show more** to read the rest in place: Ollama's
  note about thinking levels took over the menu.

### Plugins

- **What DGC may do on GitHub.** Above Sign in with GitHub, a checklist: code, issues and pull requests, your
  organisations, and your profile and email are always on (ticked, not untickable); Notifications, Gists, Projects,
  Packages — read and Packages — write are off until you turn them on, each with a line on what it lets DGC do and the
  GitHub scope it asks for. Your choice is saved at once. Signed in, the page says what with ("Signed in with: code,
  issues, pull requests, organisations, profile, notifications"); after a change it says GitHub asks you to approve
  it and offers **Sign in again**. A permission a GitHub tool asked for is marked "A tool asked for this". Needs a DGC
  CLI with `plugin_sign_in_scopes`.
- Hosted plugins no longer need Node.js: the CLI connects to them itself and keeps their sign-ins in your system
  keychain. The MCP server form's transport now reads **Remote (Streamable HTTP or SSE)**.
- **A key field on the plugin's own page.** GitHub (personal access token), Brevo (MCP server API key) and Arize AX
  (API key) show a masked field under the plugin's name, with a link to where the key is made and the permissions it
  needs. Save hands it to DGC, which keeps it in your system keychain; the page then reads **Saved**, never the key,
  with **Remove** beside it, and Connect appears. Anything missing is said beside the field, as is a key the service
  refuses. The field comes with a CLI that offers `plugin_keys`.
- **Sign in with GitHub** appears on GitHub's page once DGC has its GitHub app: the editor shows the code, copies it
  and opens GitHub's device page, and the page shows the code again with Copy until you finish.
- **Asana and Docusign** in Apps, with a guided setup for the app you create for DGC in your own account: the steps,
  the redirect URL to register with a Copy button, and fields for its ID and secret (kept in secret storage). For
  Docusign, choose a developer or a production account.
- **Zoom** in Apps, with the same guided setup: build a General app, turn on Zoom's public client, register
  `http://127.0.0.1:3336/oauth/callback` (with Copy), add the listed scopes, and paste the public client ID. Zoom's
  public client has no secret, so the form has no secret field and nothing goes to secret storage.
- **Cancel on "Finish connecting … in your browser" works.** Once the browser had opened, Cancel cleared the banner
  but never reached DGC: the editor's connection to DGC refused a second answer to the same sign-in. DGC went on
  waiting for the service for up to two minutes, and the next Connect was refused as "unavailable while a turn is
  running". One Cancel after the browser opens now goes through; nothing else is answered twice.
- **Save and connect** on an MCP server that needs a sign-in now says "Finish connecting … in your browser" under
  the form, with Open browser and Cancel. Nothing on the page said a browser was waiting before.
- Typing in the plugin search boxes keeps every letter in order. Each key rebuilt the list and put
  the caret back at the start, so "Granola" typed key by key came out as "alonar".

### DGC on Windows

- **DGC in VS Code or Cursor on Windows, with nothing else to install.** DGC is a Linux and macOS program, so on
  Windows the extension runs it inside WSL, in a distro of its own named `DGC`, and translates every path that
  crosses: your `C:\work\proj` is `/mnt/c/work/proj` to DGC, and files DGC keeps for itself open from
  `\\wsl.localhost\DGC\...`. Your own WSL distros are never touched.
- **It sets itself up, one dialog at a time.** WSL off: "Turn on WSL for DGC?" (Windows asks for administrator
  permission, then a restart). No distro yet: "Set up DGC on Windows?" downloads Ubuntu 24.04 straight from its
  site, prepares it (DGC's user, Python's venv, bubblewrap for Pip computers) and installs DGC in it, with each step
  in a progress notification and the full output in the DGC Backend log. A step that fails says which.
- **The CLI update, `DGC: Notes` and the export terminal** run the DGC in that distro too.
- Settings: `dgc.windows.wslDistro` (the distro's name) and `dgc.windows.useWsl` (off, with `dgc.command`, runs a
  DGC you installed on Windows yourself).

### Troupes

- **A troupe is a row above the prompt box**, like the checklist and the goal, never a card in the chat. One line:
  its mark (four tiles in the sub-agents' colours, which light up in turn while it works), its title, the stage it
  is on ("Verify 2/6") with a small progress bar, and Stop. The chevron opens every stage with its progress bar
  ("Review 4 of 4 · 2 kept") and, when it ends, where its results are.
  - **When it ends**, the row says how ("Done · 5 kept", "Stopped") and stays until you dismiss it (✕) or send your
    next message. The turn its results start doesn't count as yours.
  - **Several at once:** the row leads with the newest one still working ("2 troupes"); open, each has its own Stop.
  - **A reconnect** brings back the ones still running, and a new or switched chat starts without any.
- **Its approval card** (outside auto mode) says what it will do: the plan in words, the goal and the items.
- **A troupe on a schedule:** "Schedule a troupe?" says when it runs, what it works through each time and which Pip
  reports. In the Pip's Settings, Routines, the routine shows "Troupe · Review → Verify · <project>"; its name and
  time can be changed, and what it does is kept as approved (ask in a chat for a new one).

### Settings

- **Settings and a Pip's Computer tab fit a narrow editor group** (about 230–270px): rows keep their words beside a
  control that wraps underneath, the usage figures stack, and the Computer title no longer runs under its button.
- **Token cap per turn** (Settings → General): what one turn may spend, sub-agents included; 0 means no cap. An older
  CLI shows it but can't save it.

### Pips

- **Dismiss a Pip's news on the side bar's home.** A row that is news (failed runs, new findings) has a ✕ beside its
  name, shown on hover or focus and always reached with Tab; it says what it dismisses ("Dismiss: GST watchdog — 1 run
  failed"). The Pip's news is marked seen, here, in the chat's Pips bar and in the digest, and the Pip comes back only
  when something new happens, such as another failed run. **Dismiss all** in the Pips heading does every news row at
  once. A row that waits for your answer has no ✕: it needs the answer. With the last row gone, your Pips sit in the
  quiet row of faces again. Needs the DGC CLI with this release (Pips API 48).
- **The home shows the 3 Pips that most need you, however many you have:** what waits for your answer first, then
  alerts, then failed runs, then new findings, then one line, "34 more need you · Show all", which opens the Pips view
  at Needs attention, open in full, with your Pips listed under it. 100 Pips with 37 needing you took 1,600px of the
  side bar and put Chat and Work two screens down; it is 204px now. A Pip with both failed runs and new findings says
  both ("1 run failed · 2 new findings"). The home also read only your first 50 Pips: one past those that needed you
  had no row.
- **A Pip opened from a chat opens, in its own project.** Clicking the name of a Pip the chat ran (its run line, or
  the agent map) opened the Pips view on your Personal Pips, showed only Core and said "This Pip is not available in
  the selected workspace. Refresh the dashboard." The Pips view now switches to the Pip's project and opens it at the
  run; a Pip that was deleted says "That Pip isn’t on this computer. It may have been deleted."
- **Which Core is which.** "Meet Core" says Core is also the character of DGC's main chat and that your Primary Pip
  uses it, and the Primary Pip's page and row say "Your Primary Pip, in the main chat's character" (they said
  "Personal helper"). A user had to ask what the Pip named Core was.
- **Pips settings stay readable in the side bar.** "How many Pips you can have" broke one letter per line; every
  settings row now keeps its words in a readable column, with the control underneath when the side bar is narrow.
- **A reply's details open into view** at the bottom of a conversation, where they used to open out of sight.
- **A Pip's context and thinking, in its message box, are the Pip's own:** "For this Pip: its replies and the work it
  does on its own", saved the moment you change them (with a DGC from before, still the next reply only). A run's
  details say **None** for the time, tool-call and step limits a run that keeps going doesn't have.
- **Patch helpers work until the run ends:** the Helpers section of a Patch handoff no longer promises 12 model
  requests, 64 tool calls and 5 minutes; helpers share the run's lifetime, and stopping the run stops them. A run saved
  under the old limits still opens with its receipts.

- **No daily limit in a Pip's Job tab:** Usage shows what it spent today and over 30 days, with its chart, and says
  Pips have no daily limit. The setup card no longer mentions a 200,000-token limit.

- **On Windows outside WSL, the Pips view says where Pips run:** "On Windows, Pips run in WSL", with how to get there.

- **What fills a Pip's window.** A Personal Pip's context menu shows it part by part: its instructions, each
  tool, its job, what it remembers, its skills, apps and references, as its last reply sent them, then its
  conversation brief and the messages its next reply sends.
- **Needs attention.** The Pips home lists, above Your Pips, every card your Personal Pips are waiting
  on you for: an email to Send, an event to add, a plugin action, a Connect card, a submit its computer
  holds, a robot check, a routine it suggested, a new Pip to create. Newest first, six until you choose
  Show all; each row opens that Pip at the card (the chat scrolls to it and it flashes; a held submit
  opens its computer). Each Pip's row counts what waits for you there, and the Sessions home only says
  "All quiet" when nothing does.
- **Change a draft right on its card.** Edit on an email's Allow card turns To, Subject and Message
  into fields; Send sends what the card shows ("Sent with your changes."). A calendar event a Pip
  drafted is now an Allow card too ("Add this event?", its time in its own zone), with Edit for the
  title, times, time zone, guests (who are invited) and description. A plugin action's Edit gives each
  input its own field (JSON for a list or an object). A field that won't read says so on the card and
  nothing is sent; Undo changes puts the card back.
- **What it remembers.** A Personal Pip's page lists what it remembers about you, notes it kept from
  your chat and ones you add there, each with Forget (Forget all asks first). Under a reply that kept
  one, the chat says "Remembered: …" with Forget. The Memory tab and its claims form are gone for
  Personal Pips.
- **Careful mode.** A Pip with a computer has a Careful mode switch on its page (on) and the sites it may
  visit, each with Remove. A new site waits as "Let Ava visit amazon.in?" with Allow this site; something
  it read from your apps waits as "Let Ava put this on …?" with Allow once. Neither has Always allow.
- **Pips settings → Plugins** shows which Pips use each plugin, with Remove for one, a count past 50,
  and the plugins added that no Pip uses.
- **Your own OAuth app for a remote MCP server.** Settings → MCP servers → a remote server has **Your own
  OAuth app**: its Client ID, Client secret and a fixed Callback port, for a service that doesn't let DGC
  register itself (Asana, Zoom, Docusign, or a Google app of your own). The form shows the redirect URL
  to add at the service (`http://localhost:<port>/oauth/callback`). The secret is kept in the editor's
  secret storage and handed to the sign-in bridge in an owner-only file, never on its command line;
  a blank secret keeps the saved one for the same client, and removing the server deletes the file.
- The 41 vendor plugins and Context7 show their own logos in Settings → Plugins (bundled; sources in
  `media/plugin-logos/SOURCES.md`); Google Workspace shows Google's mark.
- A search that finds no Pip says it looked in names, instructions and chats. Search snippets in
  Sessions and Pips start and end on whole words. A Pip says a card is below its reply, where it is.
- **As many Pips as you want.** Pips settings has **How many Pips you can have**: 100 unless you
  choose another number, up to 100,000; archived Pips don't count. The Pips home shows your most
  recent hundred (Core first) with **Load more** and a **Search your Pips** box over names and
  titles, and says how many there are ("Showing 100 of 5,000"). The search also finds a Pip by its
  instructions and by what was said in its chat, and shows the words around the match ("In its chat: …"). A Pip opened from elsewhere (the
  Sessions home, a notification) opens even when it is not in the pages read so far, and stays
  open as the list refreshes. A search that finds nothing no longer shows "Meet Core".
- **A Pip's prompt box works like DGC's.** The model chip names the model and its thinking level
  ("deepseek-v4.1-flash:cloud Off", not "Same as DGC off"). Its menu is DGC's: the model row, the
  thinking slider and a short note with **Show more**; the model list opens from the model row, and
  a Personal Pip switches model at once (a project Pip's change is still reviewed). The context chip
  shows how full the window is ("22%"), and its menu has DGC's meter: used and free tokens, recent
  messages and those in the chat's brief, and the window size. Clicking elsewhere closes either menu.
- **A Pip's reply shows what it is doing, as DGC's chat does.** While it answers, its row says what it
  is doing (loading the model, thinking, the tool it uses, writing) with the clock and tokens so
  far, "(12s · ↓ 340 tok)"; the reply reads as it is written (its stream is read every 400 ms, not at
  the chat's 4 s refresh) and shows the moment it is saved. Under each reply, what it took: "8.4s ·
  1.5k tokens" (in, out and model requests on hover).
- What you send is in the chat at once, and the box clears: it no longer sits in the box until the
  reply is queued. A choice you tap under a Pip's reply goes straight into the chat the same way.
- A Pip's face and name at the top of its chat have no outline around them: the face's movement touched it.
- **Plugins in Pips: each Pip asks first.** When a Pip needs one of the plugins you added to DGC,
  its chat shows "Let Ava use Airtable?" with **Allow** and **Not now**; no second sign-in. What it
  would then do in a plugin is an Allow card showing the tool and its inputs, with **Allow**,
  **Always allow** and **Don’t**. A plugin that can move money (1inch, Aave, Airwallex) has no
  Always allow: it asks every time. After you allow an action the chat reloads and the Pip carries
  on with what the plugin answered. Its page lists the plugins it may use, each with **Take back**.
  Needs the DGC CLI with Pips API 44.
- **A Personal Pip's page, like a Grok bot's.** Its Settings are one clean page: its face, name and
  an optional title at the top, then **Info**, **Links**, **Media** and **Files**. Info has its
  **Instructions** (a full page to edit them), its **Routines**, a **Notifications** switch and
  **Share as template**. Links, Media and Files list what was shared in its chat (and its
  computer's Files). **Edit** under its face picks one of the eight Pip faces and a colour, with
  **Reset to default**; the face shows everywhere the Pip does. Share, **Copy ID**, **Pause** and
  **Archive** sit in the top bar. Model, usage and schedule forms are gone from the page: the model
  is chosen by the message box, and apps are in Pips settings. An **Always allow** you gave is listed
  on Info, with **Stop allowing**, only when there is one.
- **Routines.** **+ Add routine** takes a name, what to do, and when: every day, weekdays, every
  week, every few hours, once, when an email matching a Gmail search arrives, or before calendar
  events. Each routine has an on/off switch; tap one to edit or delete it. When a Pip suggests a
  routine in its chat, the card under its reply says what and when, with **Add routine** and
  **Not now**.
- **Pips settings** (the gear on Your Pips): **Computer** has **Update computer** (check now),
  **Reset** for each Pip's computer (asks first; its Files stay) and **Disk space**; **Apps** lists
  every account your Pips use and which Pips use it, with **Remove**, and the skills they use.
- When another of your Pips already uses an account, a Pip's app card asks **Let Ava use your
  Gmail?** with **Allow**, instead of a new sign-in.

- **Plain words across Pips.** The runner bar says "Pips running", "Pips not running" or "Pips
  stopped", with **Start Pips**, **Resume Pips…** and **Turn off Pips…**; a Personal Pip's work is
  "Working", "Done" or "Waiting to start", never "Auditing source" or "Report ready". The shield in the
  chat box opens **What <Pip> can do** (with a computer: its browser, online Terminal and files, and
  the apps you connected; anything it would send, submit or change waits for your Allow), replacing
  "Read-only Pip chat" with "no browser tools". The chat's hints, memory, live reply ("Still
  writing…"), model menu ("Same as DGC"), email and calendar dialogs (**Send this email?**, From the
  account's name, "Sent. Gmail accepted it"), change dialogs (**Change <Pip>?**, **Accept** / **Turn
  down**, app reads in words instead of JSON), Settings, results, notifications and the setup cards
  ("New Pip") follow, along with the turn-on screen (**Meet your Pips**, **Turn on Pips**) and the
  shared errors.
- No longer true, and gone: "It cannot also read your connected apps" and "You sign in yourself with
  Open browser" in **Give a computer** (it lists the browser, the online Terminal, connected apps,
  signing in with **Open its computer**, and that anything it would submit, send, pay or change waits
  for your OK); "the Job tab" (now Settings); "Connect an app once in DGC Settings" (Settings shows
  **Reads before each task** only for a Pip that has them; apps connect from the chat); "Online like
  Grok's bots" in the Terminal; "A completed Pip run never performs one automatically".
- **Plain words for project Pips too.** Scout, Lens, Rook, Lock, Quill, Patch and Pulse no longer
  say runner, revision, proposal, receipt, artifact, invocation, digest or "Pips API 22". An audit is
  **Compared with the last audit** ("Found again", "Not found again", and that a finding not found
  again isn't fixed); Patch and Pulse results list **Test commands (1 of 1 ran)** as command lines
  rather than JSON, with how each ended ("Stopped: took too long", not "timed out"); a project
  Pip's change review is **Change <Pip>?** with **Accept** / **Turn down**, as a Personal Pip's is;
  handoffs, schedules, path triggers, Memory, claims, Context, notifications and check-command
  results say what they are, and who asked ("by you in the editor", not `editor-user`). Run IDs and
  hashes sit under **Technical details**, with the exact saved records. A DGC too old for something
  says what to update ("Update DGC to watch paths."), not "Update the computer to Pips API 22".
- No longer true, and gone: "Restore from Job" and "in Job" (now Settings), "update the lab", a
  Pip computer's "Its own browser and files" in a change review (it has a Terminal too), and a
  Personal Pip's finished task reading "Report ready" in the main chat (it is "Done").
- A Personal Pip has no **Run now**, like Grok's bots: you chat with it, or it works on its schedule.
  Its Results say what it made on its schedule, or how to give it one in its chat.
- **You can message Core.** Core's chat never sent: the choices and the send button stayed grey and
  Enter did nothing, because DGC's type list marks Core "not available" as a background Pip and the
  chat required an available type. Core's hello worked (DGC sends it), so it went unnoticed.
- A screen reader names a Pip's replies by the Pip's name, not its character's ("Shopper", not "Lens").
- A failed message says why on the line under it, for example "Failed · It stopped after 12 steps
  without finishing. Say “continue” and it carries on." (with a DGC that sends it), else "Failed · No
  reply".
- Pressing Enter while a Pip is answering keeps your message in the box and says "<Pip> is still
  answering. Send this when it is done." (it did nothing before).
- **A Pip computer's Terminal is online**, like Grok's: public websites only, never this computer or
  your network. Under each command it lists the sites reached and anything DGC blocked.
- **"Needs you" when a site checks for robots.** A Pip stops at a robot check; its chat shows
  **<Pip> needs you** with **Open its computer** and **I've done it**, and it carries on after.
- **Allow cards.** An email a Pip wrote shows in its chat as **Send this email?** with who it is from,
  to, subject and the text, and **Send**, **Always allow**, **Edit** and **Don't send**, like Grok's
  Allow card. Send uses the Gmail account connected to that Pip and sends exactly that draft, once;
  Always allow also lets it send from that account without asking (take it back in its Settings).
  Without a connected Gmail the card offers **Choose account…**, the full review as before.
- **A Pip's choices.** A Pip can end its message with 2 to 4 choices, shown as buttons under it (A, B,
  …); a tap answers it. A new Pip's hello offers its next steps this way. Choices under an older
  message are gone once you have answered; with words already in the box, a tap adds the choice to
  them instead of sending.
- **Connect your apps from a Pip's chat.** Ask a Pip to set up Gmail and it puts a **Connect Gmail**
  card in its chat; **Connect Gmail** opens Composio's sign-in in your browser (or uses the account
  Composio already has), and the card turns into **Gmail connected** by itself. The Pip carries on;
  it reads the app when you ask, and anything it would send still waits for your Allow. A Pip's
  **Settings** list its **Apps**, with **Disconnect**.
- A Pip the main chat proposes docks above the chat box, where questions dock: its face and name,
  what it will do, and chips for when it runs, what it reads and its model, with **Create Pip**,
  **Details** and **Not now** (the founder chose this over the card in the reply). **×** puts it
  aside; the reply keeps one line that says what became of it ("Waiting for you", "Morning Brief is
  on · First run Thu 8:00 AM", "Not created") with **Review**, **Open in Pips** and **Details**. A
  question that arrives meanwhile takes the place; the Pip docks again after it. In auto mode the Pip
  is created at once and only the line shows.
- Typing on a Pip computer's screen, such as a web address in its browser, no longer closes the screen.
- Approving one of two waiting changes for the same Pip says first that the other will be set aside
  (it was written for the same version, so it is not approved), and afterwards says what happened:
  "India Market Brief is updated. The other waiting change was set aside, not approved." instead
  of "Change recorded.". Notices in the Pips view go away after long enough to read them.
- The faces in the quiet Pips row above your sessions have room between them.
- Archiving a Pip takes you back to your Pips instead of leaving you in its chat; the notice says how
  to bring it back (Show archived).
- Pips are characters you meet, not jobs you configure (Pips API 43). The first time, the
  Pips view introduces **Core**, your Primary Pip; **Create Core** opens its chat and Core says
  hello. **New Pip** is a character and a name; its chat opens on its own greeting, where it
  guesses from its name what you want. Each Pip's chat has a header with its name, a **computer**
  button that opens its screen (or offers it one), and a menu for Results and Settings.
- A Pip's **Settings** is one short page: what it does, when it runs (when you ask, every day,
  weekdays or every few hours), what it can use, its model, what it may do without asking, usage,
  and pause or archive. Everything else is under **Advanced**, and the less-used sections are under
  **More** beside Chat, Results and Settings.
- Changes you make save straight away. There is no reason to type: DGC records it for you.
- Changes waiting for you show at the top of the Pip in plain words, with **Review** and **Reject**.
  Archiving a Pip that has some offers to reject them and archive, instead of refusing.
- A cleaner look: one purple action per section, quiet buttons for the rest, and more room.
- Send a Pip images and files: the attach button in its message box, paste, or drop them on it.
  Images, text and code files, PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV and TSV; up to
  4 images and 4 files, 2 MB in all. They show above your message (files by name and size), and
  you can send them without text. Needs Pips API 43.
- Pips move more like characters: an idle Pip glances around and leans the way it looks, blinks
  (sometimes twice), and its eyes follow your pointer, settling back when you stop. Thinking looks
  up to each side, working reads and bobs, waiting hops for your attention, success bounces and
  failure droops. Reduced motion keeps them still.
- With the desktop programs installed, a Pip's computer tab is its real screen, like Grok's bots:
  Chrome, a file manager and a terminal on a desktop with a dock, which you use directly. While
  the Pip works you watch. Without them, the tab says what to install and shows the simpler view.
- A Pip's Settings shows its **Skills** (your DGC skills that fit everyday work) with **Manage
  skills…**, which opens them in DGC Settings.
- A Pip's computer opens as an editor tab, "Gmail · Computer": a desktop with a dock of three apps,
  each in its own window (minimise or close it; the browser comes up when the Pip starts using
  it): **Browser** (its
  live screen: click, type, scroll, go to an address), **Files** (its own folder: open folders,
  preview, add files, Save to…, remove) and **Terminal** (run a command; yours and the Pip's show
  together; no internet). What it would submit waits at the top with Send once, Always allow and
  Reject. The tab only ever touches that Pip's computer. Needs Pips API 43.
- Fixed: a busy page's live screen (an inbox, say) no longer shows "The browser view reply is
  invalid".
- The **Pips** button in the chat header shows Core, the main chat's Pip, breathing and
  blinking softly. It stays still when motion is reduced or the panel is hidden.
- The new Pips view opens beside the chat (the Pips button in the panel header, or **DGC: Open
  Pips**). Create Project and Personal Pips, review their setups, proposals, findings, handoffs
  and drafts, and talk to each Pip in its own conversation. Each Pip has its own plush character,
  whose pose follows its real state.
- **New** offers starter Pips: review each commit, a nightly security review, and a weekday
  morning brief. Pick one, choose the branch or time, and DGC prepares a setup card that opens
  straight into its review. Nothing is created until you approve the card.
- The Pips bar above the composer shows the day's digest when there is something to say: new
  findings, failed runs, reviews waiting and findings that went away after their file changed.
  Expand it to open a finding's report; **Dismiss** marks it seen until the next day. A new
  finding at a Pip's alert level brings it back straight away.
- A project reviewer's **Job** tab has **Notifications** (which findings reach the digest, which
  alert) and **What became of its findings**.
- A project reviewer or Quill can read open issues, open pull requests, CI checks and failed
  workflow runs from GitHub before each run, with your own GitHub login. Choose the reads under
  **GitHub reads** in its **Job** tab; the proposal review shows exactly what will be read.
- **Computer** in a Personal Pip's **Job** tab (Linux, Pips API 42): **Give this Pip a
  computer…** gives it its own browser and files in one step. **Open browser** shows its screen:
  click, type and go to an address to sign in to the sites it needs. What the Pip would submit
  appears under **Waiting for you**; **Review…** shows the screenshot and exactly what would be
  sent, then **Send once**, **Always allow** (the same submit on that site, from then on) or
  **Reject**. A payment waits for you like anything else, and its review says it sends card
  details. The Pips bar says when something is waiting.
  **Stop computer** closes it at once.
- **Always allow** beside Send once, Create once and Run once: the Pip does that kind of action
  again without asking, and you are told after. Its **Job** tab lists them under **Allowed without
  asking**, with **Stop allowing**. Actions waiting for you count in the Pips bar.
- **Settings → Token usage** has a **Pips** view: each Pip's tokens and runs for the range, its share,
  and how much of everything the Pips used.
- A Pip the chat sets up is approved on its permission card, which shows the Pip, its job, what it
  reads and when it runs, instead of raw arguments; once allowed it is created and on.
- **Share this Pip → Export…** in the Job tab and **Import a shared Pip…** under **New**: an
  imported Pip opens as a setup card for you to review.
- **Was this result useful?** under each finished Pip result, report and draft: a thumbs up or down
  and an optional note, which the Pip's later runs read. The job itself does not change.
- Each answer has **Make this a Pip**: it drafts the request in your composer to turn that task
  into a Pip on a schedule. Nothing is sent or created until you do.
- On Windows the Pips view says Pips run on Linux and macOS instead of asking you to update the CLI.
- **New** offers five more Personal starters (page watch, market brief, weekly research digest,
  release watch, news on a topic), each with an example of what to read. Starter schedules read
  "Weekdays at 08:30" or "Mondays at 09:00" instead of a cron expression.
- Each Pip's **Job** tab shows its token usage today and over 30 days, with a two-week chart, and
  takes a daily limit for its automatic runs.
- When a Pip finds something at its alert level or a new review is waiting, the editor says so
  once with **Open Pips**, even when the DGC panel is not on screen (`dgc.notifyPips`). The
  runner controls also switch the runner's desktop notifications on or off.
- **Keep Pips running** in the runner controls: one switch so the runner starts when you log in
  and after a restart, and restarts if it fails (Linux and macOS).
- On macOS, Patch and Pulse run under Seatbelt; their reviews state how that confinement is
  weaker than Linux's (sampled memory and process limits, readable system folders).
- Reference a Pip in the main chat with `@`. Setup cards, run rows and email, calendar and
  connector draft rows in the main chat open the matching review in the Pips view.
- Personal Pips: choose a connected account and exact app reads, add reviewed web reads (up to
  four https pages or searches), and review each email, calendar event or connector action
  before it is sent or created.

### Chat

- Tool groups start collapsed, during the turn and after a reload, and stay the way you leave
  them. A failure shows in the group's summary instead of opening it under you.
- A resolved permission request becomes a compact receipt you can expand to read.
- A pending question stays visible until you answer it, skip it or collapse it; it no longer
  folds itself away after 30 seconds.
- While a goal is running you can edit its objective or budget, or replace it, and the change
  applies at the turn's next step without stopping the turn. With no goal, a running turn can
  adopt one.
- Text follows the editor's font size.
- A sent prompt shows its first three lines, then **Show more**, so a pinned prompt takes less of
  the panel (it was five, from seven lines up).
- Chat tabs, redone. Every tab has the same height and the new chat's tab no longer gets a white
  border. Drag a tab to reorder your chats, or press Alt+Shift+Left/Right on it. With more chats
  than fit, tabs shrink first, then the strip scrolls (the mouse wheel scrolls it sideways), the
  chat on screen stays in view and a chevron lists every chat. The tabs are hidden on an agent's
  page.
- A tab's dot says what its chat is doing: purple and pulsing while it works, purple and still
  when it finished and you have not read it yet, green and pulsing when it needs your answer, grey
  when it is idle. Coming back to a chat that finished in the background no longer shows it
  working, and a chat that still waits on you keeps its dot after you look in and leave.
- When a chat you are not looking at needs your answer (an approval, a question or a plan), DGC
  says so in a notification once; **Open chat** goes straight to it. `dgc.notifyWhenWaiting`
  turns it off.
- A working specialist's mark moves and glows less, and its glow is no longer cut off on the left.

## 0.32.1 — 2026-10-02

- A prompt beginning with an absolute path such as `/workspace/project` is sent normally and keeps
  the editor's live file context instead of being treated as an unknown slash command.
- When the chat view narrows, footer controls collapse to their icons: model and reasoning becomes
  a lightning icon, permission mode and context keep their icons, and Settings remains available.
  Their full names remain in tooltips and screen-reader labels.
- A model or thinking change made while DGC is working now says exactly when it applies: the next
  model request for native providers, or the next turn for a delegated subscription CLI.
- An Ultra fan-out keeps the parent available for mid-turn steering while its independent sub-agents
  work. Transcript agent summaries use at most four agents per line, so eight agents appear as two
  stable lines instead of hiding half their identity marks.
- Sub-agent work pages are read-only: their composer clearly asks you to return to the chat, keeps
  the draft intact, and cannot accidentally send it to the parent conversation. Images viewed by a
  sub-agent open in the full image viewer from that page, as they do in the main chat.
- Typing `/goal` immediately removes the highlighted slash text and pins the existing Goal control
  inside the composer for that draft. The control disappears with the message; progress and
  lifecycle controls remain in the standing-goal row above the composer.

## 0.32.0 — 2026-10-02

- Every chat can have its own folder. **Open a chat in another folder** (in the header, and as
  *DGC: Open a Chat in Another Folder…*) opens one in a different project, with that project's
  settings, trust, MCP servers, skills, permission rules and mode. Its tab names the folder.
  A folder outside your window is asked about first, as `/new DIR` asks in the terminal: your
  MCP servers start there and your hooks run there before you type anything. Restart Backend,
  or recovery after a crash, brings the chat back on its own conversation.
- Chats share one `dgc serve`, the way Codex runs its threads, instead of one process each. A Stop
  ends only its own chat's turn and approval cards — before, one chat's Stop could expire another
  chat's open approval, and your answer to it was refused as stale. Closing a chat keeps the backend
  for the chats still on it. `dgc.shareBackend` turns sharing off. This extension needs DGC CLI
  0.47.1 or newer.
- While a turn runs you can rename the chat, open a saved session (it opens beside the running
  chat instead of being refused with "unavailable while a turn is running"), and install or remove
  a plugin. Cancel on a plugin's browser sign-in stops that install, not the turn on screen.
- A chat comes back in the permission mode it ran in when you reopen it, when that mode asks no
  less than the one you are in; a new chat after it starts in your mode again.
- Sub-agents working at the same time never share a face. The same eight faces, handed out
  seafoam, coral, violet, amber, lime first so look-alikes are never side by side, and kept
  through a reload, a chat switch and a restart. Chats saved before this keep their faces.
- A chat tab keeps its folder name whole; a long chat name gives way first.
- A message to a running sub-agent reads "Sent message to <what it was asked to do>", with a
  message mark, instead of "Used tool · message task" with a wrench. The other sub-agent tools wear
  the sub-agent mark.
- Sub-agents read the way they do in Codex: one quiet line for the agents started together, their
  faces first, then "Durable rules review, Remote web and Paper pip concept started working" — where
  each used to get a full-width row of its own. Only the names are links, each opening that agent's
  page, and Back or Escape brings you back to the name you used. The words change in place —
  started working, running, queued, waiting for your permission or your answer, finished, failed,
  stopped — and the names never move: "Durable rules review running · Remote web finished · Paper
  pip concept running". More than three read "A, B and 14 more", and "14 more" shows them all.
- The "⟳ sub-task", "↳ isolated checkout" and "↯ running N isolated sub-tasks" notices are gone;
  the agent's line says it, and its page says when it worked in an isolated checkout. When an
  agent's changes were only partly integrated or not integrated, its page says so, with where the
  worktree is kept.
- An agent started by another agent is a line on its parent's page instead of in the chat, and
  Back from it returns to the parent.
- A background sub-agent's late work no longer opens an empty "Working" turn or raises "New".
- A delegation that never started an agent reads "Delegated <what it was asked to do>" instead of
  "Used 1 tool".
- A reopened chat folds each finished run of tools, as the live chat did; it used to show every
  run open.
- The changes bar shows the turn's own edits in a folder too large for its workspace scan.
- A background sub-agent's step that is still running when your turn ends keeps its card: it no
  longer reads "stopped", its progress keeps arriving, and its result lands on it instead of on a
  second card with no command.
- The diagram renderer's DOMPurify moves to 3.4.16 (GHSA-p98j-92pf-mc4p, low severity; the
  affected IN_PLACE mode is not one mermaid uses, and the panel's content security policy blocks
  inline event handlers either way).
- A long message you sent no longer fills the screen. One that runs to seven lines or more shows
  its first five, fading out, with **Show more** when you point at it or Tab to it (always shown on
  touch screens and in high contrast). Open, **Show less** stays in reach at the bottom of the chat
  while you read down a long one. Attachments, images and the question an answer replies to always
  show in full, and Run again, Edit and Restore still use the whole message. Opening one while DGC
  is still answering keeps you where you are; **Latest** takes you back to the end. A message you
  opened stays open when you switch chats and come back.
- The message you sent stays at the top of the chat while you read DGC's answer to it, as in Claude
  Code. The next message takes its place, and scrolling back up brings the earlier one back. A long
  message stays there folded to its first five lines; one you opened with **Show more** scrolls
  with the answer instead. A message too tall to keep there in a short window (one with a
  screenshot, say) scrolls as before. Turns DGC starts on its own (a monitor or agent waking it, a
  resumed goal, a continued turn) keep the message they continue at the top. Click a message to go
  back to where you sent it. Tabbing to something behind it brings that into view below it.
- A message whose turn started before DGC confirmed receiving it is no longer drawn below its own
  answer, and a queued message drops its "queued for the next turn" line once its turn starts.
- A chat opened from its history shows a message you sent twice in a row (such as "continue")
  twice, as you sent it; only one used to show.
- **Latest** goes all the way to the end of the chat. It used to stop about 15 pixels short until
  the next line arrived.
- The DGC Backend log writes what a shared `dgc serve` says about itself — a traceback, a stop, its
  exit — once, however many chats run on it; with three chats every line appeared three times.
  Closing a chat is logged as that chat closing, with its folder, instead of as "dgc serve exited"
  while the process went on serving the other chats, and a chat that could not open says so
  instead of reading as a backend that failed to start.
- Requires CLI 0.47.1; editor protocol v14.

## 0.31.4 — 2026-09-30

- Undo takes back a pasted attachment. A paste big enough to fold into a chip, or a pasted image,
  changed no text in the box, so Ctrl+Z and Cmd+Z had nothing to act on and the chip could only be
  dismissed by finding its remove button. Undo now takes it back and redo returns it; typing after
  a paste is undone first, a run at a time.
- The changed-files bar no longer reads as broken when a scan could not reach far enough. On a large
  repository it stops at its limits and cannot say whether anything changed — it now says that,
  instead of "Changes unavailable".
- Requires CLI 0.46.4; editor protocol v14.

## 0.31.3 — 2026-09-30

- Pairs with CLI 0.46.3, which stops an interrupt mid-integration from leaving a half-applied
  checkout, stops a `git pull` during a delegation being reported as your own edit, and lets a
  message to a running sub-task add work rather than only correct it. The extension itself is
  unchanged; the handshake minimum moves with the CLI version it quotes.

## 0.31.2 — 2026-09-29

- The caret in an empty prompt box rests where your first character will appear. It sat at the end
  of "Ask DGC to build, fix or explain…" and the text then appeared back at the left.

- An open question's card stays on screen after the turn that asked it ends, and stays answerable:
  clicking an option a minute later starts a new turn with your answer. It used to be replaced by a
  single "Not answered" line the moment the model stopped talking, taking every option with it.
- Pointing at the card stops it folding. Only typing did before, so a card with several options to
  read folded away mid-read after thirty seconds.
- A question that has closed keeps its options on screen as the record of what was offered, dimmed
  and no longer clickable, instead of being emptied.
- An option's description no longer shrinks into a narrow column beside a long label: it takes a
  line of its own when there is not room to read it, and the "Recommended" badge stays on the
  label's line at every panel width.
- Build-time dependency lock refreshed: two advisories in packages used only to build and test
  the extension. The published VSIX has no runtime dependencies and is unaffected.
- Pairs with CLI 0.46.2.

## 0.31.1 — 2026-09-28

- Pairs with CLI 0.46.1, which stops a remote MCP sign-in from opening a browser before the editor
  asks for it on macOS. The extension itself is unchanged; the handshake minimum moves with the CLI
  version it quotes.

## 0.31.0 — 2026-09-28

0.30.0 was built and installed on one machine and never published. Auditing that build found 27
defects and a first real session found twelve more; those fixes and this release's new work are all
here, under one version number.

- **The chat panel now proves its window exists.** The panel says it is on screen every twenty
  seconds, and the backend decides a session handover on that rather than on whether some process
  is alive. A window reload takes the panel with it, which is the one thing an extension host left
  behind by that reload cannot fake -- so reloading a window and typing "continue" gets the session
  back in about two minutes instead of being refused for fifteen. Unchecking the chat view says
  which of the two went away, once, and still does not stop the backend. The statement is never
  queued: one that arrived late would move the backend's clock forward on behalf of a window that
  had already gone.

- **A paste can carry instructions you cannot see, and now says so.** A bar over the composer reads
  **Remove 3 invisible characters -- 2 can carry a hidden instruction**, with **Keep** beside it.
  Nothing is altered unless you ask. Arabic, Persian and Hebrew directional marks, multi-person
  emoji and the three subdivision flags never raise it.

- **The edited-files list folds again.** It could be expanded and then not collapsed. Paths in it
  are shortened the way a reader wants them: project-relative where it can be,
  `../packages/ui/x.ts` for a sibling in the same repository, `~/` under your home directory, and
  absolute only where the full path is the useful information.

- **A tool group you folded by hand stays folded.** It still opens itself the first time something
  inside it fails, but a later failure no longer throws it open under you.

- **A question you had started answering gives your words back.** Retiring the card used to take
  the half-typed answer with it; it is now appended to the composer, ready to send. Not on an
  explicit Skip, which is you deciding not to answer.

- **A blocked or paused goal says what blocked it.** The goal bar showed the objective, which you
  already knew, instead of the reason.

- **A goal is a control, not text you type.** Picking `/goal` opens a control in the composer
  footer beside the permission mode, carrying whatever you had already typed -- those words are the
  objective. Cancelling leaves your draft alone; saving moves the words into the goal. Codex models
  a goal the same way, as thread state rather than composer text, and puts its control in the same
  place. Typing `/goal TEXT` and pressing Enter is unchanged.

- **Pills lost their box, and the slash menu lost its sigils.** A skill or template is now a mark
  and its name in the accent colour, wearing the same icon its menu row shows; a bordered chip
  beside another bordered chip was two rectangles competing with the words between them. The menu
  rows show that icon and the bare name, because "/goal" beside "$code-review" read as two
  alphabets.

- **A paste keeps its shape, and a paste can no longer vanish.** Multi-line text was handed to the
  browser's own insert and trusted; what that does with consecutive blank lines is the host's
  business, so a numbered list came back flattened on some builds. The result is now checked and
  repaired. Separately, a clipboard carrying only rich text pasted NOTHING at all -- only the plain
  flavour was read, while the default action was prevented on every paste. Rich text is now taken
  for its words, with a newline at each block boundary; no markup ever enters the composer.

- **Token usage gets a filter, and hides what reported nothing.** A row there always ran at least
  one request, so "no counted tokens" means unmetered -- a provider that reported none, which local
  llama.cpp and vLLM builds often do. Those are hidden by default but not dropped, with a line
  saying how many are behind the checkbox. One search box covers model, provider and host.

What was already in 0.30.0:

- **A finished run of tools folds to the one line that describes it.** The group stays open while
  it works -- you can watch what is being done -- and folds once the model moves on, so a long
  transcript reads as a sequence of steps instead of a wall of cards. A group whose tools failed,
  were denied or were stopped stays open: an error is the one thing you should never have to
  expand to find.

- **"Edited N files" rebuilt.** The directory is dimmed and the filename is not, the totals sit
  under the title, Undo and Review moved into the header, counts line up on the right, and a list
  longer than three files collapses behind "Show N more files".

- **A file with no line count says so.** A brand-new file, a binary write, or a change too large
  to diff used to arrive as "+0 −0", which reads as "nothing changed" when it means "there was
  never a diff to count".

- **Auto mode is announced quietly.** The accent ring and focus glow around the composer are gone;
  the control that names the mode carries the colour instead.

- **The image viewer can keep a picture and scale it.** Save writes wherever you choose, and zoom
  steps with a live percentage, by button or with + and -.

## 0.29.1 — 2026-09-24

- **A file chip opens when you click it.** Clicking a produced PNG did nothing: the open path
  refused binary files and swallowed the error.
- **A chip looks like a chip**, not a white box, and stays legible on a light theme.
- **File marks are the icons they claim to be.** Six were wrong — an image drew an RSS feed — and
  the whole table had never actually rendered. They come from Seti now, with a mark per language:
  Go, Rust, Java, Kotlin, Swift, Ruby, PHP, C, C++, C#, React and SVG.
- **Two delegated agents keep their places** instead of trading rows on every tool call.
- **A sub-agent's page fills while it works**, rather than showing a timer and nothing else.
- Pairs with a CLI that, when another window has advanced the session, names the resume control
  and says the conversation is intact — instead of "start a new session".

Pairs with CLI 0.44.1.

## 0.29.0 — 2026-09-23

- **Files the agent makes appear as chips you can click.** Ask it to record something or export a
  report and the file shows up under the step that produced it, with its name, size and kind mark.
  Clicking opens it in the editor. The chip carries a path, not the file, so size costs nothing.
  Pairs with CLI 0.44.0, which adds the `show_file` tool the agent uses.

- **Links wear the site's own favicon**, both in the prompts you type and in the agent's answers.
  Only a link's origin is sent to fetch the icon — never its path or query — so a URL carrying a
  token discloses its host and nothing else. Turn it off with `dgc.linkFavicons`.

- **A URL you type in a prompt is now a link**, instead of plain text you had to select and copy.

- **Fixed: a file named in an answer never showed its kind.** A duplicate rule of equal specificity
  sat later in the stylesheet and won every cascade, so every file link drew one grey glyph and the
  entire per-kind table — python, shell, json and twelve more — never reached the screen.

- **Fixed: link text was below the readability minimum on both themes** (4.08:1 dark, 4.09:1 light,
  against a 4.5:1 floor). Links now take a tone chosen per theme, and the system's own link colour
  in high contrast. The underline under every link is gone; it appears on hover and on focus.

## 0.28.4 — 2026-09-23

- Pairs with CLI 0.43.4. Nothing in the extension changed; the CLI floor it quotes did.

## 0.28.3 — 2026-09-22

- Pairs with CLI 0.43.3. Nothing in the extension changed; the CLI floor it quotes did.

## 0.28.2 — 2026-09-22

- Pairs with CLI 0.43.2. Nothing in the extension changed; the CLI floor it quotes did.

## 0.28.1 — 2026-09-22

- Pairs with CLI 0.43.1, which fixes an install that left a broken dependency set. Nothing in the
  extension itself changed; the CLI floor it quotes did.

## 0.28.0 — 2026-09-22

- **As many chats at once as you want.** The **+** beside the model name opens another chat with
  its own `dgc serve`, its own model context and its own session file, so the chat you switch away
  from keeps working. A rail above the transcript shows them all: a pulsing dot while one is
  mid-turn, an amber square when it is waiting on a decision, a count of what it has said since
  you last looked. Switching rebuilds the incoming chat from its own backend's snapshot, so a chat
  you left mid-turn comes back where it is now. There is no built-in ceiling; set
  `dgc.maxLiveChats` if you want one. *DGC: Open a Second Chat* and *DGC: Switch Chat* do the same
  from the command palette.
- **A chat you switch away from mid-handshake no longer wedges.** A backend that became ready
  while you were in another chat could never finish its handshake — the roots acknowledgement is
  one of the events a background chat drops — so it accepted nothing and every prompt you typed
  there queued for ever. Coming back now picks the handshake up where it stopped.
- **A chat waiting on you says so.** An open question was never recorded against the chat you left
  (its event carries `ask_id`, and only `id` was read), so a chat stopped dead on a question
  showed the idle dot. A chat blocked on more than one thing now keeps its marker until all of
  them settle, instead of clearing on the first — and accepting a plan stops the marker, rather
  than leaving it lit for the rest of a turn that is already working.
- **A background chat no longer redraws the rail on every token.** A chat answering out of sight
  posted one message per streamed chunk, and the webview rebuilt every tab each time — which also
  took keyboard focus off a tab you were on. The count is now coalesced; anything needing an
  answer still appears at once.
- **A background chat's crash stays its own.** Its exit was recorded against whichever chat was on
  screen, marking a healthy running turn as interrupted by another chat's kill, and charging its
  crash to the shared recovery breaker. Closing a chat is also no longer written to the log as
  that chat losing its backend.
- **Capabilities no longer leak between chats.** `dgc.command` restarts only the active backend,
  so two chats really can run different CLI builds; five flags read off `ready` kept whichever
  chat set them last, and the panel offered an older CLI commands it rejects.
- **Permission rules that do not parse are marked.** The engine drops them but the file keeps
  them, so the list was showing a `deny` you could read back and believe was in force.

## 0.27.1 — 2026-09-22

- **Chats start again on a CLI older than 0.42.0.** 0.27.0 sent `open_asks` on every
  `set_workspace_roots`. That field arrived in CLI 0.42.0, and the editor protocol rejects a
  command carrying a field the CLI does not declare — so against an older CLI the handshake command
  was refused with *"invalid command: set_workspace_roots has undeclared field 'open_asks'"* and no
  chat could start at all. In Cursor it showed as *"DGC timed out waiting for sessions"*, and
  Resume reported *"No past DGC sessions in this project"*: one bug, three faces. The field is now
  sent only to a CLI that declared the capability.
- **The automatic CLI update works again.** It asked the installer for the exact CLI version this
  extension was built against, and the installer publishes exactly one build — the latest — and
  refuses any other by name. So the update could only fail, which is why it could not pull anyone
  forward onto the CLI that fixes the above. It now installs what is published.
- The minimum CLI is stated correctly (0.42.0) in the handshake, the walkthrough and the README.
  Nothing in the release scripts bumped that field, which is how it drifted to 0.41.6; a test now
  fails when it disagrees with the CLI in the checkout.
- A new test loads the schema of the oldest CLI this extension claims to support and fails if the
  extension would send anything that CLI cannot parse. Run against 0.27.0 it names `open_asks`.

## 0.27.0 — 2026-09-21

- **A question you can answer without stopping the work.** When the model needs a decision it can
  ask in the transcript and keep working while it waits: the card shows the question, why it is
  asking and any choices it offered. Your answer stays in the chat as a message of yours, carrying
  the question it answers, so nothing is lost when the card goes.
- **Copy a quoted block.** A drafted mail or a message to forward now reads as a block of its own
  with room at the top and bottom — it used to sit flush against its own edges — and a Copy button
  appears on hover, giving you the text without the `>` markers running down its left edge.
- **Attach a document.** Pick a `.docx`, `.xlsx`, `.pptx`, `.pdf` and the rest with `@`, and DGC
  reads the text out of it locally. The tool row says plainly that it is extracted text, so you
  know layout and images are not in what the model saw.
- **The `@` picker opens on the first `@`.** It used to show nothing until you typed another
  character, because the file list is fetched the first time it is needed.
- **A message sent mid-turn says what became of it**, on its own line under the message: steering,
  queued, or read by the model. It briefly sat inside the message bubble, where a status line read
  as something you had typed.
- **Specialists look like what they are doing.** A working specialist's mark glows in its own
  colour and breathes; a finished one is still. The list keeps the order they were first seen in —
  the rows used to swap places as the backend reported — and a mark whose artwork will not load
  falls back to its own coloured shape instead of a broken-image placeholder.
- **Paste more images.** Up to 32 MB per prompt with no count limit, when the DGC you are talking
  to supports it.

## 0.26.8 — 2026-09-20

- **Cleaner activity icons.** Every step, diff, card and notice in the chat now carries a thin outline icon in the same grey as its words, in place of the old `→ ✎ $ ✱ ▸` glyphs and the single wrench. The header above a run of steps shows what it actually did — a book for reading files, a pencil for edits, a terminal for commands — and steps that used to look alike (an update to the checklist, a skill, an image, an MCP call, a sub-agent) each have their own mark. An MCP form request no longer shows a blank square.
- **Reduced motion stops the running step's dot.** With "reduce motion" on, the dot beside a running step kept pulsing; the rule meant to switch it off was overruled by a later one.
- **Conversation text one step larger.** Prompts and answers are 13px (code 12px): 12px read too small. Prompts keep the answers' line spacing.
- **No ring around working sub-agents.** A running sub-agent's icon no longer has a pulsing coloured ring around it; the chip's "working" label shows it is running.
- **See the image you attached.** An image in the prompt box shows as a preview chip with its
  type, size and dimensions, the same way it appears once sent. It used to read "image".
- **A tidier agents list.** A finished agent's row in the agents list shows its status and stats only. Its report and the files it named are on the agent's own page, one path per line, under "Files to open" (it said "Edited" even for agents that edit nothing). A note beside a path stays plain text, and a folder is not offered as a file to open.

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
