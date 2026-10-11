# ChatDGC

ChatDGC is a chat app inside DGC. You ask a question and your own model answers. A chat doesn't belong to
the folder you have open, so every window lists the same chats. It runs on its own engine and keeps its
own store, separate from Work (the coding sessions) and from Pips.

Everything described below is in ChatDGC today: chats and projects, web search with cited sources, deep
research, files, data and charts, the canvas, memory, plugins, dictation and more. Read aloud comes next.

## Using it

- **Open it.** The DGC side bar has two tabs, **Chat** and **Work**, so a long list of either never hides the
  other; it remembers the one you used last. **New chat** opens a chat in an editor tab. You can also run
  **DGC: New Chat (ChatDGC)** from the Command Palette. One search box searches both tabs, and while you
  search, each tab says how many it found. It finds a chat by its name or anything said in it, and shows the
  words around what it found.
- **Ask.** Enter sends your message. Shift+Enter adds a new line, and Esc stops a reply. Replies stream
  in as Markdown, with code blocks, tables and links. A link opens in your browser only after you click
  it.
- **Dictate.** Press the microphone beside Send and speak. Press it again, and what you said appears in the box
  where the caret is, so you can edit it before you send. Esc cancels the recording.
  - **The first time:** the microphone opens **Settings → Voice**. Install a speech model there:
    - **Moonshine Base:** English, 111 MB.
    - **NVIDIA Nemotron 3.5:** many languages, 475 MB.

    The first model you install also adds DGC's voice engine, about 50 MB.
  - **Your words stay on your computer.** The model runs on your own computer, and what you say is never sent
    anywhere.
  - **Recording happens on the computer you're at,** through the small **DGC Voice** extension. It records the
    same way in a Remote SSH window, where DGC itself runs on the other machine. DGC Voice keeps nothing once it
    hands the recording over.
  - **On a Mac,** macOS asks the first time whether your editor may use the microphone. If you said no, allow it
    in **System Settings → Privacy & Security → Microphone**.
- **Files, images and long pastes.** Use the paperclip to attach up to ten files to a message, or paste an
  image or a long piece of text (more than 5,000 characters) into the box. You can send a message with only
  files.
  - **Documents:** PDF, Word, PowerPoint, Excel, OpenDocument, RTF and CSV are read with DGC's document
    reader. Any other file must be plain text.
  - **Images:** PNG, JPEG, GIF or WebP, checked by their bytes rather than their name. They go to models
    that can see images; with a model that can't, ChatDGC says so before anything is kept.
  - **What the chat keeps:** its own copy of each file, so a file moved later is still what the
    conversation was about. Files are capped at 25 MB (images at 8 MB). A pasted image is scaled so its
    longer side is at most 2,048 pixels.
  - **Dragging files in:** you can also drag files onto the chat:
    - from VS Code's Explorer: any file, except one inside a hidden folder such as `~/.ssh` (pick those
      with the paperclip);
    - from your system's file manager: images and text files.
  - **Thumbnails:** images you sent show as thumbnails; click one to enlarge it.
  - **Models that can't see:** if the chat's model can't see images, a model that can looks at them first.
    ChatDGC tries your sub-agent model, then your main model, then a model installed on the same Ollama
    that says it can see. **Seen by** under your message shows which model looked and what it saw, and the
    chat's model reads that description in place of the pictures.
- **Web search** is always there, as in ChatGPT. Before it answers a message that turns on facts it could
  get wrong (news, prices, rates, rules, laws, taxes, limits, figures, specific people, products or places),
  ChatDGC checks whether it needs the web and, if so, searches first and answers from what it found. It
  doesn't search for maths, writing, code or explanations of things that don't change. Press **Search** in
  the box to make it search first for one message. **Settings → Web search → Search in ChatDGC** turns it off
  entirely; then ChatDGC never goes online (and Deep research says it needs the web).

  While it searches, the reply says what it is looking for. A reply that used the web cites each fact with a
  small pill naming the site (with its favicon; "+1" when two sources say it). Point at a pill for a card with
  the page's title and what it says; click it to open the page. **Sources** under the reply, with the sites'
  favicons, opens a panel beside the chat: what it searched for, the pages it cited, and the other results it
  found, each with its site, title and a few words from it. Favicons come from Google's icon service, asked
  about a site's address only (never the page), as Work's links do; `dgc.linkFavicons` off turns them all
  into a globe. One reply makes at most five searches.

  **Pictures**, as ChatGPT shows them, only where seeing helps: the same check that decides whether to search
  decides whether pictures belong in the answer (what a place, building, dish, animal, plant, product,
  artwork or style looks like), and for rules, prices, news, advice, code or writing there are none. Up to
  four show above the answer, each with the site it's from; click one for it larger, with its title and
  **Open page** (the arrow keys step through them). DGC fetches each picture's small copy from the image
  search and keeps it with the chat, so the chat screen never contacts an image site. The model is told the
  pictures are shown but hasn't seen them, so it doesn't describe them: an image search can return a picture
  of the wrong thing, and the site under each one is there to check it.

  The search itself is the one set in
  **Settings → Web search**, shared with Work and your Pips:
  - DuckDuckGo needs nothing.
  - Brave and Tavily need a key, which is kept in `~/.dgc/secrets.json` (owner-only), where `dgc setup`
    keeps it too.
  - SearXNG is a server you run.
- **Model and thinking.** As in main DGC, one button by Send names the model (a small arc beside it shows how much
  it thinks) and opens a menu: the models, and a **dial** for thinking. Click a mark, drag round it, or step it with
  the arrow keys: Off ("answers right away"), Low, Medium, High ("thinks hard: slower, more careful") or Extra high.
  Each chat keeps the model and thinking level you choose, and gets them back when you reopen it; chats have no
  ultra mode. If
  the model thought before answering, **Thought** above the reply opens what it thought.
- **Long replies.** ChatDGC doesn't limit reply length; the model's own limit is the only one. If a reply
  stops at that limit, or you press Stop, the reply keeps what was written and shows **Continue**.
  Continue picks up in the same reply.
- **The welcome.** A new chat greets you under ChatDGC's mark (its three slashes drawn in one by one) with a line
  for the time of day ("Up late? I'm here.", "Good morning. Where should we start?"), chosen once a chat.
- **Temporary chats.** Tick **Temporary** before your first message. A temporary chat is never saved or
  listed, and it disappears when DGC stops.
- **The context window.** The meter in the box shows how much of the model's context window the chat fills.
  It uses the model's own count where it reports one, and turns amber at 70% and red at 85%. Click it for
  what fills the window, as Claude's Usage sheet shows it: a bar in one colour a part, then each part with its
  tokens and its share (the conversation, files, ChatDGC's own instructions, yours, memory, the project, the canvas
  and data, the summary, and the tools a reply is offered, each listed with its own tokens, plugins' too), the room
  kept free for summarizing, and what's free. Then two actions:
  - **Compact now:** everything before the last exchange becomes a summary. When that's already
    summarized (right after a summary), the details say so and the button waits for another exchange.
  - **Continue in a new chat:** a new chat starts with a summary of this one.

  The window is the model's real one, capped by the size you choose (8K, 16K, 32K by default, 64K, 128K, 256K,
  512K, 1M or the model's maximum, as main DGC offers): in the meter's details (**Window size**, for every chat) or
  **Settings → ChatDGC → Window**. It is sent with every request. Before a reply would fill more than 75% of
  it, the older messages are summarized and the recent ones kept word for word. You see "Summarizing
  earlier messages…" when that happens; it is never done silently. An **Earlier messages summarized**
  divider shows the summary, and you can edit it. Every message stays in the chat for you. One file never
  takes more than 40% of the window; the model is told when it only got the first part.
- **Memory.** ChatDGC remembers what you tell it about yourself: your name, your diet, your health, where you
  live, your job, how you want things done. The quick check before each reply picks out what you state about
  yourself, so a fact doesn't depend on the model remembering to save it (it runs with web search off too). It
  keeps only what you say about yourself for its own sake, never the material of a task or the background of a
  question: a toast for your brother the chef, a poem about your cat, a packing list for your two kids, "my dad
  has diabetes, what snacks are safe?" or "we plan to move to the UK" save nothing, and nor does asking about a
  city's weather. From a request to write or do something it keeps only what you ask it to remember. It sees what's remembered
  already, so nothing is saved twice in other words, and when you say something has changed ("I'm not vegetarian
  anymore", "I moved to Goa") the old fact goes. A reply that saved or removed something says so underneath,
  **Remembered: …** (with **Forget**) or **Forgot: …**. You can also say "remember that…" or "forget that…", or
  ask what it remembers. The same memory is read by your Work sessions and your Pips, and ChatDGC also
  knows your projects from your Work sessions (each folder, when you last worked there, what you asked
  lately). **Settings → Memory** shows everything, lets you edit, delete or add facts, keep a project out,
  delete all, or turn memory off everywhere. A fact is kept only when it's something you said yourself (a
  page or a file can't plant one), never a password, key or account number, and at most three a reply.
  Temporary chats neither read nor write it.
- **Deep research.** Press **Deep research** in the box, then ask. ChatDGC first shows a research plan: a
  title and the steps it will take. It starts by itself after 15 seconds, or press **Start now**; **Edit**
  pauses it so you can change the steps or keep it to a few websites. Then it searches and reads in up to
  three rounds, about 20 pages in all, PDFs included, and each page that helps becomes a short note. The card
  shows what it's searching and reading as it goes. To steer it, type in **Add to the research**: it reads
  that next. Then it writes one report from the notes, citing them as [1], and checks every citation against
  its note; a claim its note doesn't support loses the citation, and **How it was researched** lists those.
  **Open report** shows the report full screen with its contents and sources; **Export…** saves it as
  Markdown. Stop keeps everything found: **Write the report from N sources** finishes from there, and **Keep
  researching** carries on. If the chat isn't on screen when it finishes, VS Code says so. It needs a context
  window of at least 16k (32k is the default). With `deepseek-v4.1-flash:cloud` a run took two to five minutes.
- **Questions in an answer.** When what the model would say next depends on something only you know, it can
  ask you inside its answer. A card shows the question with a few answers to pick from and a **Something
  else** box for your own. The answer goes on below the card. **Continue** sends a message the model wrote
  for that question, with your choice filled in. You can answer while that reply is the last thing said;
  afterwards the card shows what you chose, or **Not answered**. One question per reply. Models that can't
  use tools answer without asking.
- **Edit and try again.** **Edit** under a message you sent changes it; **Try again** under a reply asks
  for another one, with whatever model and thinking level the box is set to. Either way, the old version
  stays: **‹ 2 / 3 ›** steps between versions of the conversation from that point. A version that has its own
  versions comes back as you left it. One point keeps up to 50 versions.
- **Follow-ups**, as ChatGPT shows them: under the latest reply, up to three next messages you might send (a
  next step, a deeper detail, applying it to you). Click one and it's sent; what you were typing stays in the
  box. None after a greeting or thanks, a finished task, a reply that asked you something or waits on a card,
  or research. **Settings → ChatDGC → Suggest follow-ups** turns them off.
- **Branch in new chat**, as ChatGPT has it: the branch button under a reply starts a new chat holding the
  conversation up to that reply (the versions you see), with its files. It opens in a tab of its own, named
  "Branch · …", and a line after that reply says where it branched from, with a link back. The original
  stays as it was. A temporary chat can't be branched.
- **Projects**, as ChatGPT has them: chats, files and instructions kept together.
  - **In the side bar**, Projects sit above your chats. Click one to open its page; its arrow lists its chats
    there. Drag a chat onto a project to move it in, or back onto Chats to take it out. A chat's **⋯ →
    Move to project…** does the same, and can make a new project.
  - **A project's page** shows its instructions, its files, its memory setting and its chats. What you write
    in its box starts a new chat in the project. A chat in a project shows the project's name in its header.
  - **Instructions** (up to 8,000 characters) apply to every chat in it, on top of your own; where the two
    differ, the project's win.
  - **Files** (up to 40) are read by every chat in it, within a quarter of the context window; what doesn't
    fit is said, not sent. Images go to models that can see.
  - **Memory:** shared (the memory you share with your other chats, Work and Pips), or the project's only:
    its chats then don't see your saved memories and nothing is saved to them. Either way, a chat in a
    project knows what the project's other chats are about.
  - **Deleting a project** deletes its files and instructions, and its chats too unless you keep them; kept
    chats move back to your chats.
- **Plugins in chat**, as ChatGPT uses its apps: every plugin turned on in **Settings → Plugins** is ChatDGC's
  to use, with no "use this plugin?" question. Ask for something one of them does and it uses it in the reply.
  - **Reads** (what the vendor marks read-only, or DGC's reviewed list) run at once.
  - **Changes** (sending, creating, editing, deleting, sharing, paying) show a card under the reply with the
    exact tool and inputs. Nothing happens until you choose: **Send it now** (after **Edit**, if you like),
    **Hand it to a Pip** (one of your Personal Pips takes it on: that's offered first for something recurring,
    on a schedule, or that has to wait), or **Don't**. The card then says what came of it, and the chat's next
    reply knows.
  - **How much asks** is each plugin's level in Settings → Pips → Plugins (Always ask, Any changes, Important
    actions, Never ask), shared with your Pips. A plugin that can move money always asks.
  - **No made-up addresses:** a wallet address in a plugin call has to be one you gave or a plugin answered
    with; a guess (the model once wrote the zero address "as a placeholder") is refused before any card.
  - **Your private data stays put:** what the chat read from your apps never goes into a web search, and a
    change that carries it always shows its card, whatever the level (the careful check Pips use). What you
    said yourself isn't held back.
  - A plugin whose sign-in only the editor holds can't be reached from a chat (as from a Pip): sign it in from
    Settings → Plugins.
- **Data analysis**, as ChatGPT has it: attach a spreadsheet (CSV, TSV or Excel; each sheet is a table) and ask
  about it. ChatDGC answers with exact numbers by asking the data in SQL, read-only and in memory, rather than
  reading rows by eye: totals, groups, monthly trends, averages, medians, spreads and correlations. Nothing it
  writes runs as a program or can change a file. **Analyzed the data** under the reply shows each query and what it
  returned. Spreadsheets in the chat's project, and ones ChatDGC made, count too.
- **Charts**, as ChatGPT's interactive charts: where numbers compare or change, a reply can draw a bar, line, area,
  pie or scatter chart from numbers it has (never made-up ones). Hover for a value, click the legend to hide a
  series, **Data** for the numbers as a table, **Copy data** (CSV) and **Save image** (PNG).
- **Maths**, drawn as ChatGPT draws it: a formula in a reply (`$…$` or `\(…\)` in a line, `$$…$$` or `\[…\]` on
  its own) shows as typeset maths, in the editor's colours; a screen reader reads it too. Dollar amounts stay
  dollar amounts ("$5 and $10" has no maths in it), and code stays code. **Copy** gives the formula as it was
  written (TeX), as ChatGPT's does.
- **Interactive answers**, as ChatGPT has them: when something is better used than read (a loan calculator, a
  converter, a timer, a quiz, a small simulation), the reply makes a widget, and it opens in a tab beside the chat
  (as a canvas does; the chat keeps focus). It's a small page that runs on its own: no network, nothing loaded from
  anywhere, no access to your chats, files or VS Code. It takes the editor's colours. Once it's open, ChatDGC sees
  what it shows and checks its figures; if one is wrong, or its code failed, it fixes it once, in the same tab. (If
  it still fails, a bar in it says so.) It opens again as you left it: what you typed in it is kept on this computer
  (for the 60 widgets you used last), and a widget's tab that was open when VS Code closed comes back with it. A card
  under the reply names it: **Open** shows it again, **Show code** shows its page; every widget is also in the
  Library, under **Widgets**. (VS Code runs nothing in a frame inside the chat, so a widget can't sit inside the reply
  itself.)
- **Canvas**, as ChatGPT has it: for a longer piece you'll keep working on (an essay, a plan, a report, a program),
  or when you ask for one, ChatDGC opens a canvas: a real file in an editor beside the chat. You both work on it.
  - **A document opens formatted**, as a page (headings, lists, tables, maths drawn), with a toolbar: text style,
    bold, italic, strikethrough, code, link, lists, quote, divider, **Ask ChatDGC**, shortcuts, and **Open as
    Markdown**. Markdown shortcuts work as you type (`# `, `- `, `1. `, `> `, three backticks, `---`). It's the same
    `.md` file: **Open Canvas as Markdown** / **Open Canvas Formatted** switch between the two, and a block you didn't
    touch is written back exactly as it was (only what you changed is rewritten), so ChatDGC's edits and the
    versions stay exact. It saves itself when you pause; what ChatDGC changes lights up as it lands. Code opens in
    the code editor.
  - **Tables** are edited in place: type in a cell, Tab to the next (past the last, a new row), Enter to the cell
    below. In a table, a second row of tools adds or deletes rows and columns, aligns a column and deletes the table;
    **Table** in the toolbar adds one. It's written as a GitHub table.
  - **Maths:** click a formula (or press Enter on it) to edit its TeX, drawn as you type; Enter finishes, Esc
    cancels. Type `$x^2$` and it becomes a formula (`$5 and $10` stays money); `$$` and a space on an empty line
    starts an equation of its own (Ctrl+Enter to finish). **Equation** in the toolbar adds one.
  - **Checklists:** `- [ ]` items have a box to tick (a ticked one is crossed through). **Checklist** in the toolbar
    (Ctrl+Shift+9) makes the lines you're on one; `[ ] ` at the start of a list item does too; Enter adds an unticked
    item and Ctrl+Enter ticks the one you're in.
  - A table or equation inside a list or quote stays as written and opens in Markdown to edit.
  - **You edit it** like any file; what you typed is what ChatDGC reads next (it's saved before your message goes).
  - **ChatDGC changes it** with small exact edits, so the rest stays as you left it; each change shows in the
    editor as an edit you can undo. A card in the reply says it made or changed it, with **Open**.
  - **Ask about a part:** select it and choose **Ask ChatDGC About This** (right-click, or the editor's title bar).
  - **Shortcuts** in the title bar: for a document, suggest edits, shorter, longer, reading level, final polish; for
    code, review, comments, logs, fix bugs, port to another language.
  - **Versions:** every change is one, yours too. **Canvas Versions…** compares any of them with now (VS Code's
    diff) or brings one back.
  - **Download:** a document as Word, PDF or Markdown; code as its file.
  - Canvases live with the chat (`~/.dgc/chat/canvas/`); a branch gets its own copy, and deleting the chat deletes
    them.
- **Writing blocks**, as ChatGPT has them: an email, a message, a letter or a post you'll send as it is comes in
  its own box, apart from what ChatDGC says about it. An email shows who it's to and its subject on their own.
  - **Copy** puts just the text on the clipboard: no stars, no hashes.
  - **Open in mail app** starts a new email with the address, subject and text filled in (a long one's text goes
    on the clipboard to paste, as mail links can't carry it).
  - **Edit** changes it in place; the reply keeps your version, and ChatDGC works from it next.
  - The reply's own **Copy** copies it as it reads: formatted when you paste into a mail app or a document, clean
    text everywhere else.
- **No emoji** unless you ask for them, as in the rest of DGC.
- **Files it makes**, as ChatGPT hands you a report: ask for a document, a PDF, a spreadsheet or slides (or
  something that's plainly a file, like a CV or a budget to fill in) and the reply comes with a card: the
  file's name, kind, size and pages, with **Open** (in its own app; Markdown and CSV open in an editor tab) and
  **Save a copy…**.
  - **Formats:** Word (.docx), PDF, Excel (.xlsx), PowerPoint (.pptx), CSV and Markdown.
  - **How it's made:** the model writes what the file says (Markdown for a document, rows for a sheet, titles
    and bullets for a deck) and DGC lays it out the same way every time, with no extra software: headings,
    lists, tables, links, and in a workbook numbers as numbers, formulas that compute when it opens, and a
    header row that stays in view.
  - **PDFs** are printed by the Chrome or Edge you already have, so every script and symbol (₹, हिन्दी, 中文)
    prints as it should. Without one (or where Chrome can't start its sandbox and `browser_allow_unsandboxed`
    isn't set), a plain built-in writer lays it out in Helvetica, and the card says which characters it
    couldn't draw.
  - **Changing it:** ask ("make the title shorter") and it makes the file again; you keep both. Its next
    replies know what each file it made says.
  - **Where it's kept:** with the chat, and in the Library, marked as made. A temporary chat's files last
    only while DGC runs.
- **Study mode**, as ChatGPT's "Study and learn": **Study** in the box turns it on for the chat, until you turn
  it off (the chat remembers it). It teaches instead of handing over answers: it first asks what you know or
  what it's for, goes one step at a time, ends each reply with a question or something to try, gives hints
  before solutions, and every few steps checks with a quick quiz (a question card with choices; your choice
  comes back and it says whether you were right and why). Ask it to just tell you, and it does.
- **The Library**, as ChatGPT has it: **Library** in the side bar opens every file you attached or ChatDGC
  made, in every chat and project (temporary chats keep none), newest first. Show what you uploaded or what
  ChatDGC made, one kind (images, PDFs, documents, spreadsheets, presentations, code, pasted text), or search by
  name. Each file can open the chat or project it's in, start a
  new chat with it attached, be saved as a copy, be added to a project, or be deleted: the chat it was in keeps
  its name, marked as deleted, and its model is told it's no longer there. The paperclip lists your newest
  Library files before **Upload files…**; a file attached from the Library is a copy, so the chat keeps it even
  if the original goes. **Widgets** lists every widget ChatDGC made, in every chat, newest first, searched by name:
  open one beside you, open the chat it's in, or delete it (its tab closes, and its card in the chat says it was
  deleted).
- **Custom instructions and personality.** **Settings → ChatDGC** sets what ChatDGC should know about you and
  how it should respond (up to 1,500 characters each), and its personality: Default, Concise, Warm, Candid
  or Nerdy. Every chat uses them from its next reply; Work and your Pips don't.
- **Names.** A chat is named from its first line at once. After the first reply, your model gives it a
  short name, the way a chat app does. A name you give a chat yourself is never replaced.
- **Export.** **⋯ → Export…** saves the chat. As Markdown it holds the conversation you see, with its sources
  and the names of attached files; as JSON it holds the whole chat, every version included.
- **Keyboard shortcuts** (Ctrl on Windows and Linux, ⌘ on a Mac):
  - new chat: Ctrl+Shift+O;
  - copy the last reply: Ctrl+Shift+C;
  - copy the last code block: Ctrl+Shift+;;
  - focus the message box: Shift+Esc;
  - stop: Esc;
  - this list: Ctrl+/ (or the keyboard button at the top).
- **Rename, pin, archive, delete.** Use the **⋯** button at the top of a chat. You can also delete a chat
  from the list. Pinned chats come first.

## From the terminal and your code

- **`dgc chat`.** The same chats in a terminal: `dgc chat` opens one you type into (`/help` lists its commands),
  `dgc chat "question"` answers once, and `--list`, `--resume ID` and `--export ID` reach the rest. `--json` prints
  a reply or the list for a script.
- **The SDKs.** `DGC.chat()` in Python and `dgc.chat()` in TypeScript ask, stream, research and manage chats from
  your program, on a backend of their own (see [SDK.md](SDK.md#chatdgc-dgcchat)).

## Where chats live

Chats are stored in `~/.dgc/chat/`:

- each chat is one file, `chats/<id>.json`, holding its title, times, model, thinking level, pinned and
  archived state, and messages;
- `index.sqlite3` keeps the list fast and holds what each chat says for search (with SQLite's FTS5 where available).

Every file is owner-only and written atomically. A lock file keeps two windows from writing a chat at
once.

A new chat is written to disk only when you send its first message, so empty chats never appear in the
list. If you rename, pin or delete a chat while it is still replying, that change stands. A deleted chat
stays deleted.

ChatDGC uses the model settings in Settings: provider, address and key. Your Work sessions use the same
settings. ChatDGC's requests count in **Settings → Usage**, by model and by day, like every other request
DGC makes. The usage ledger records them under the source `chatdgc`.

## Protocol (`chatdgc_*`)

The `dgc serve` process answers every `chatdgc_*` command itself; no session ever does. A ChatDGC event
therefore never carries the envelope's `chat_id`, because that name belongs to the session router. A
conversation is named by `conversation_id` (`chat_` followed by 32 hex digits). A backend that supports
ChatDGC says so in `ready.capabilities.chatdgc = {"version": 1}`.

| Command | Fields | Answered by |
| --- | --- | --- |
| `chatdgc_list` | `request_id`, `query?`, `archived?`, `limit?` (1–200), `offset?` | `chatdgc_chats` |
| `chatdgc_open` | `request_id`, `conversation_id?` (omit for a new chat), `temporary?` | `chatdgc_opened` |
| `chatdgc_earlier` | `request_id`, `conversation_id`, `before` (a message id) | `chatdgc_earlier` |
| `chatdgc_send` | `request_id`, `conversation_id`, `text`, `model?`, `thinking?`, `search?` (`auto`, the default: it decides, and looks a factual question up first; `on`: search first; `off`: no web; the config's `chatdgc_web: false` makes every reply `off`), `attachments?`, `study?` (true turns study mode on for the chat from this message, false turns it off; the conversation carries `study`) | a turn (below) |
| `chatdgc_continue` | `request_id`, `conversation_id`, `message_id` | a turn |
| `chatdgc_edit` | `request_id`, `conversation_id`, `message_id` (yours), `text`, `model?`, `thinking?`, `search?` | `chatdgc_opened` (from the new version on), then a turn |
| `chatdgc_regenerate` | `request_id`, `conversation_id`, `message_id` (a reply), `model?`, `thinking?`, `search?` | `chatdgc_opened`, then a turn |
| `chatdgc_version` | `request_id`, `conversation_id`, `parent_id` (the message before the point, or `root`), `index` | `chatdgc_opened` |
| `chatdgc_research` | `request_id`, `conversation_id`, `text`, `model?`, `thinking?` | a turn whose reply is the plan (`research.status: "planned"`) |
| `chatdgc_research_start` | `request_id`, `conversation_id`, `message_id` (the plan's reply), `plan?` (as edited: `title`, `steps`, `sites`), `write?` | a turn on that reply, which becomes the report |
| `chatdgc_research_steer` | `request_id`, `conversation_id`, `message_id`, `text` | the next `chatdgc_research` shows it |
| `memory_list` | `request_id` | `memory_state` |
| `memory_add` / `memory_edit` | `request_id`, `text` (and `id` to edit) | `memory_state` (`error` when it wasn't kept) |
| `memory_forget` / `memory_clear` | `request_id` (and `id` to forget one) | `memory_state` |
| `memory_project` | `request_id`, `folder`, `remember` | `memory_state` |
| `chatdgc_answer` | `request_id`, `conversation_id`, `message_id` (the reply that asked), `question` (its index), `choice`, `model?`, `thinking?`, `search?` | a turn, whose message is the one the model wrote for the question |
| `chatdgc_export` | `request_id`, `conversation_id`, `path` (absolute, chosen by the user), `format` (`markdown`, `json`, or `report` with `message_id`) | `chatdgc_exported` (`path`, `bytes`) |
| `chatdgc_compact` | `request_id`, `conversation_id` | `chatdgc_compacted` (`summary`) |
| `chatdgc_summary` | `request_id`, `conversation_id`, `text` | `chatdgc_compacted` (marked `edited`) |
| `chatdgc_carry` | `request_id`, `conversation_id` | `chatdgc_opened` for the new chat (its `conversation.carried`) |
| `chatdgc_canvas` | `request_id`, `conversation_id`, `canvas_id`, `op` (`get`, `restore` with `version`, `export` with `format`: docx, pdf, md or file, and `path`) | `chatdgc_canvas` (`export`: `chatdgc_exported`) |
| `chatdgc_draft` | `request_id`, `conversation_id`, `message_id`, `original` (the draft's words as shown), `text` | `chatdgc_message` (the reply with the draft edited) |
| `chatdgc_cancel` | `conversation_id`, `request_id?` | the turn ends `cancelled` |
| `chatdgc_file` | `request_id`, `conversation_id`, `attachment_id` | `chatdgc_file` (`data`: an image as a `data:` URI up to 2.5 MB, or `error`) |
| `chatdgc_update` | `request_id`, `conversation_id`, `title?`, `pinned?`, `archived?`, `delete?` | `chatdgc_changed` |

`attachments` holds up to 10 items: `{kind: "file", path}` for a file the user picked (the backend reads it, so a
frame never carries it), `{kind: "image", data}` for a pasted image as a `data:` URI, or `{kind: "text", text}`
for a long paste. Each may also carry `name`. The user's message keeps `attachments` metadata: `id`, `kind`
(`document`, `image` or `text`), `name`, `size`, and `chars` for text.

A message that has other versions carries `versions: {parent, index, count}`: the point it belongs to, which
version this is (counting from 0), and how many there are.

A turn sends its events in this order:

1. `chatdgc_turn` with `state: "started"` and the `reply_id`.
2. Your message, as `chatdgc_message` (a continued reply has none).
3. The reply's text and thinking, as `chatdgc_delta` parts, sent about every 50 ms. While it searches the web,
   `chatdgc_activity` (`kind: "searching"`) carries the query. While a vision model looks at images for a
   model that can't see, `kind: "looking"` carries that model's name, and the user's message then keeps
   `vision: {model, text}`. When the model asks the user a question, `chatdgc_question` carries it as it's
   asked: `{at, question, options, prompt}`, where `at` is its place in the reply's text and `prompt` the
   message a choice sends (`{answer}` marks where the choice goes). The reply goes on. When it makes a file,
   `chatdgc_activity` (`kind: "making"`) carries the file's name, then `chatdgc_made` carries its card: `{id,
   name, kind: "document", mime, size, chars, format (docx, pdf, xlsx, pptx, csv or md), made: true, at,
   created_at, pages?, note?}`. It's opened or saved with `chatdgc_library_file` (`op: "save"`), as a Library
   file is, and the finished reply carries every file it made in `files`.
4. The finished reply, as `chatdgc_message` with `finish` set to `stop`, `length`, `cancelled` or `error`.
   A reply that searched also carries `searches` (its queries) and `sources` (`[{n, title, url}]`, the
   numbers it cites as [n]). A reply that asked carries `questions`; the message that answered one carries
   `answers: {message, question, choice}`.
5. `chatdgc_changed`, the chat's new list entry.
6. `chatdgc_turn` with `state: "ended"`.

`memory_state` is the one memory DGC keeps about the user (offered as `ready.capabilities.memory`):
`enabled` (the config's `memory`, settable with `set_config` and read through `get_config` `fields`),
`facts` (`{id, text, created_at, updated_at, edited?, source: {surface, where}}`), and `projects` (`{folder,
name, when, recent, remember}`). It's also sent, unasked, after a reply saved or forgot a fact; that reply
carries `memory: [{op: "saved"|"forgot", id, text}]`.

Deep research reports its progress as `chatdgc_research` with the reply's `research` as it is: `status`
(`planning`, `planned`, `running`, `writing`, `checking`, `done`, `stopped` or `failed`), `question`,
`plan`, `round`, `reads`, `notes` (number, title and address), the latest `activity` (`search`, `read`,
`note`, `skip`, `round`, `write`, `check`, `checked`, `steer`, `wait`, `info`, `error`), `steers`, and, at
the end, `check` (`claims`, `checked`, `supported`, `unsupported`, `invalid`). The saved reply keeps every
note's words and all its activity. The report streams as `chatdgc_delta` on the plan's reply.

After every turn, and when a chat opens, `chatdgc_context` reports `used` tokens out of `window` (the
model's own maximum is in `limit`), with `source` saying whether the model counted them (`reported`: its
last request, input and output) or ChatDGC estimated them (before any reply, and after Compact now or an
edited summary until the next reply), `parts` giving the breakdown, and `compactable` saying whether Compact now has
more than the last exchange to summarize. A reply that compacts first sends
`chatdgc_activity` with `kind: "compacting"`, then `chatdgc_compacted`. An opened conversation carries its
`summary` (`{upto, text, edited, …}`) and, for a chat continued from another, `carried`.

After a new chat's first reply, the model names it. That arrives later as another `chatdgc_changed` with
no `request_id`.

Step 6 always arrives, even when the model never answered; in that case a `chatdgc_error` explains why.
A conversation runs one turn at a time, but turns in different conversations run side by side.

`chatdgc_opened` carries the conversation's latest messages, up to about 3 MiB, and an `earlier` count of
the messages before them. `chatdgc_earlier` pages back from there. A single message too large for one
frame is shortened for display and marked `partial: true`; the file still holds the whole message.
`busy` and `reply_id` in `chatdgc_opened` let a second window follow a reply that is already running.

When the process shuts down, every reply in progress stops and saves what it has written.
