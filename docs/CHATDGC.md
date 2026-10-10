# ChatDGC

ChatDGC is a chat app inside DGC. You ask a question and your own model answers. A chat doesn't belong to
the folder you have open, so every window lists the same chats. It runs on its own engine and keeps its
own store, separate from Work (the coding sessions) and from Pips.

Today ChatDGC has chats, streaming replies, the model and thinking picker, files and images, web search with
cited sources, Stop and Continue, and temporary chats. Editing and regenerating, memory, Deep Research and
voice come in later phases.

## Using it

- **Open it.** In the DGC side bar, **Chat** sits above **Work**. **New chat** opens a chat in an editor
  tab. You can also run **DGC: New Chat (ChatDGC)** from the Command Palette. One search box searches both
  lists. It finds a chat by its name or anything said in it, and shows the words around what it found.
- **Ask.** Enter sends your message. Shift+Enter adds a new line, and Esc stops a reply. Replies stream
  in as Markdown, with code blocks, tables and links. A link opens in your browser only after you click
  it.
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
- **Web search.** Pick **Web** in the box:
  - **auto** (the default): your model searches when the answer depends on something current, such as
    news, prices, weather or a fact it isn't sure of.
  - **always**: it searches before it answers.
  - **off**: it never searches.

  While it searches, the reply says what it is looking for. A reply that used the web cites its pages with
  small numbered marks; click one to open the page. **Sources** under the reply lists every page and what
  it searched for. One reply makes at most five searches. The search itself is the one set in
  **Settings → Web search**, shared with Work and your Pips:
  - DuckDuckGo needs nothing.
  - Brave and Tavily need a key, which is kept in `~/.dgc/secrets.json` (owner-only), where `dgc setup`
    keeps it too.
  - SearXNG is a server you run.
- **Model and thinking.** Each chat keeps the model and thinking level you choose, and gets them back
  when you reopen it. The levels are off, low, medium, high and extra high; chats have no ultra mode. If
  the model thought before answering, **Thought** above the reply opens what it thought.
- **Long replies.** ChatDGC doesn't limit reply length; the model's own limit is the only one. If a reply
  stops at that limit, or you press Stop, the reply keeps what was written and shows **Continue**.
  Continue picks up in the same reply.
- **Temporary chats.** Tick **Temporary** before your first message. A temporary chat is never saved or
  listed, and it disappears when DGC stops.
- **The context window.** The meter in the box shows how much of the model's context window the chat fills.
  It uses the model's own count where it reports one, and turns amber at 70% and red at 85%. Click it for
  the breakdown (instructions, summary, files, conversation) and two actions:
  - **Compact now:** everything before the last exchange becomes a summary. When that's already
    summarized (right after a summary), the details say so and the button waits for another exchange.
  - **Continue in a new chat:** a new chat starts with a summary of this one.

  The window is the model's real one, capped by **Settings → ChatDGC → Window** (8k, 32k by default, 128k,
  or the model's maximum), and it is sent with every request. Before a reply would fill more than 75% of
  it, the older messages are summarized and the recent ones kept word for word. You see "Summarizing
  earlier messages…" when that happens; it is never done silently. An **Earlier messages summarized**
  divider shows the summary, and you can edit it. Every message stays in the chat for you. One file never
  takes more than 40% of the window; the model is told when it only got the first part.
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
| `chatdgc_send` | `request_id`, `conversation_id`, `text`, `model?`, `thinking?`, `search?` (`off`, `auto`, `on`), `attachments?` | a turn (below) |
| `chatdgc_continue` | `request_id`, `conversation_id`, `message_id` | a turn |
| `chatdgc_edit` | `request_id`, `conversation_id`, `message_id` (yours), `text`, `model?`, `thinking?`, `search?` | `chatdgc_opened` (from the new version on), then a turn |
| `chatdgc_regenerate` | `request_id`, `conversation_id`, `message_id` (a reply), `model?`, `thinking?`, `search?` | `chatdgc_opened`, then a turn |
| `chatdgc_version` | `request_id`, `conversation_id`, `parent_id` (the message before the point, or `root`), `index` | `chatdgc_opened` |
| `chatdgc_answer` | `request_id`, `conversation_id`, `message_id` (the reply that asked), `question` (its index), `choice`, `model?`, `thinking?`, `search?` | a turn, whose message is the one the model wrote for the question |
| `chatdgc_export` | `request_id`, `conversation_id`, `path` (absolute, chosen by the user), `format` (`markdown`, `json`) | `chatdgc_exported` (`path`, `bytes`) |
| `chatdgc_compact` | `request_id`, `conversation_id` | `chatdgc_compacted` (`summary`) |
| `chatdgc_summary` | `request_id`, `conversation_id`, `text` | `chatdgc_compacted` (marked `edited`) |
| `chatdgc_carry` | `request_id`, `conversation_id` | `chatdgc_opened` for the new chat (its `conversation.carried`) |
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
   message a choice sends (`{answer}` marks where the choice goes). The reply goes on.
4. The finished reply, as `chatdgc_message` with `finish` set to `stop`, `length`, `cancelled` or `error`.
   A reply that searched also carries `searches` (its queries) and `sources` (`[{n, title, url}]`, the
   numbers it cites as [n]). A reply that asked carries `questions`; the message that answered one carries
   `answers: {message, question, choice}`.
5. `chatdgc_changed`, the chat's new list entry.
6. `chatdgc_turn` with `state: "ended"`.

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
