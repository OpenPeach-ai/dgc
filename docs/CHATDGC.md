# ChatDGC

ChatDGC is a chat app inside DGC. You ask a question and your own model answers. A chat doesn't belong to
the folder you have open, so every window lists the same chats. It runs on its own engine and keeps its
own store, separate from Work (the coding sessions) and from Pips.

This page covers Phase 1: chats, streaming replies, the model and thinking picker, Stop and Continue,
and temporary chats. Attachments, web search, editing and regenerating, memory, Deep Research and voice
come in later phases.

## Using it

- **Open it.** In the DGC side bar, **Chat** sits above **Work**. **New chat** opens a chat in an editor
  tab. You can also run **DGC: New Chat (ChatDGC)** from the Command Palette. One search box searches both
  lists.
- **Ask.** Enter sends your message. Shift+Enter adds a new line, and Esc stops a reply. Replies stream
  in as Markdown, with code blocks, tables and links. A link opens in your browser only after you click
  it.
- **Model and thinking.** Each chat keeps the model and thinking level you choose, and gets them back
  when you reopen it. The levels are off, low, medium, high and extra high; chats have no ultra mode. If
  the model thought before answering, **Thought** above the reply opens what it thought.
- **Long replies.** ChatDGC doesn't limit reply length; the model's own limit is the only one. If a reply
  stops at that limit, or you press Stop, the reply keeps what was written and shows **Continue**.
  Continue picks up in the same reply.
- **Temporary chats.** Tick **Temporary** before your first message. A temporary chat is never saved or
  listed, and it disappears when DGC stops.
- **Names.** A chat is named from its first line at once. After the first reply, your model gives it a
  short name, the way a chat app does. A name you give a chat yourself is never replaced.
- **Rename, pin, archive, delete.** Use the **⋯** button at the top of a chat. You can also delete a chat
  from the list. Pinned chats come first.

## Where chats live

Chats are stored in `~/.dgc/chat/`:

- each chat is one file, `chats/<id>.json`, holding its title, times, model, thinking level, pinned and
  archived state, and messages;
- `index.sqlite3` keeps the list and search fast.

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
| `chatdgc_send` | `request_id`, `conversation_id`, `text`, `model?`, `thinking?` | a turn (below) |
| `chatdgc_continue` | `request_id`, `conversation_id`, `message_id` | a turn |
| `chatdgc_cancel` | `conversation_id`, `request_id?` | the turn ends `cancelled` |
| `chatdgc_update` | `request_id`, `conversation_id`, `title?`, `pinned?`, `archived?`, `delete?` | `chatdgc_changed` |

A turn sends its events in this order:

1. `chatdgc_turn` with `state: "started"` and the `reply_id`.
2. Your message, as `chatdgc_message` (a continued reply has none).
3. The reply's text and thinking, as `chatdgc_delta` parts, sent about every 50 ms.
4. The finished reply, as `chatdgc_message` with `finish` set to `stop`, `length`, `cancelled` or `error`.
5. `chatdgc_changed`, the chat's new list entry.
6. `chatdgc_turn` with `state: "ended"`.

After a new chat's first reply, the model names it. That arrives later as another `chatdgc_changed` with
no `request_id`.

Step 6 always arrives, even when the model never answered; in that case a `chatdgc_error` explains why.
A conversation runs one turn at a time, but turns in different conversations run side by side.

`chatdgc_opened` carries the conversation's latest messages, up to about 3 MiB, and an `earlier` count of
the messages before them. `chatdgc_earlier` pages back from there. A single message too large for one
frame is shortened for display and marked `partial: true`; the file still holds the whole message.
`busy` and `reply_id` in `chatdgc_opened` let a second window follow a reply that is already running.

When the process shuts down, every reply in progress stops and saves what it has written.
