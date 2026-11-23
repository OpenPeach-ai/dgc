"""A question card in a Pip's chat, as Work has it (Pips API 106, 18 Nov).

The request: "pip asks in chat, but if user says propose me options with your suggestion, then pip can also send the
question or multiple question propose tool, like the work chat does ... so it can instead propose questions which user
can just select and submit".

One capability, one module: the tool is Work's own propose_options (dgc/tools.py's schema) and its questions are read
by Work's own validator (dgc/questions.py), 1-4 questions of 2-6 options, a recommended one, multi-select; the client
adds Other. What is a Pip's own here:

- **Who is offered it.** Only a conversation whose client draws the card: send_pip_message `questions: true` says so,
  and the conversation remembers what the client that wrote last in it can draw, so DGC's own turns there (a
  carry-on after a card, a message that waited) follow it. An older editor never says so and keeps offer_choices.
- **The card is kept with the reply.** The worker collects it as the reply's `questions` (the reply ends there, as with
  offer_choices); insert_reply checks it again and keeps it here. The chat lists it with its state: open, answered
  (with what was chosen), dismissed, or closed (the chat moved on without an answer).
- **The answer is the user's own next message.** answer_pip_questions sends the answers as their message in that
  conversation, a normal turn of theirs (so a held step's yes reads it, pip_holds), and the card can't be answered
  again. Dismiss closes it, with nothing sent. Only while that reply is the conversation's last message, as ChatDGC
  answers a reply's question.
"""
from __future__ import annotations

import contextlib
import copy
import json
import re

from . import questions as asks
from .workspace_registry import RegistryError

TOOL = "propose_options"
STATES = ("open", "answered", "dismissed")
SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_chat_questions (
 message_id TEXT PRIMARY KEY REFERENCES pip_chat_messages(id),
 pip_id TEXT NOT NULL REFERENCES pips(id),
 questions TEXT NOT NULL CHECK(json_valid(questions) AND length(CAST(questions AS BLOB)) <= 65536),
 state TEXT NOT NULL CHECK(state IN ('open','answered','dismissed')),
 answers TEXT CHECK(answers IS NULL OR (json_valid(answers) AND length(CAST(answers AS BLOB)) <= 32768)),
 request_key TEXT,
 decided_at TEXT
);
CREATE TABLE IF NOT EXISTS pip_chat_question_clients (
 conversation_id TEXT PRIMARY KEY,
 pip_id TEXT NOT NULL REFERENCES pips(id),
 draws INTEGER NOT NULL CHECK(draws IN (0,1))
);
"""
_MESSAGE = re.compile(r"message_[0-9a-f]{32}\Z")
_KEY = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
# What the chat's turn hears beside the tool, when it is offered: which of its two ways to ask fits.
NOTICE = ("questions: besides offer_choices you have propose_options, a question card the user answers under your reply. "
          "When there is a decision with options worth weighing (the user asked you to propose options or suggest one, "
          "or you need several answers at once), ask with propose_options: 1 to 4 questions, 2 to 4 options each, the "
          "one you recommend first and marked recommended. For a quick next step with a few short answers, use "
          "offer_choices. One or the other in a reply, never both.")
SHOWN = ("These questions appear as a card under your reply. The user picks, or writes their own answer, and submits; "
         "their answers come as their next message. Your message is complete: don't list the options in your text.")
CLOSED = "These questions were answered already."
DISMISSED = "These questions were closed without an answer."
MOVED_ON = "The conversation has moved on since these questions: write your answer as a message."


def schema() -> dict:
    """Work's propose_options, as Work offers it (a copy: a Pip's tool list never edits Work's)."""
    from .tools import TOOL_SCHEMAS
    return copy.deepcopy(next(tool for tool in TOOL_SCHEMAS if tool["function"]["name"] == TOOL))


def tool_result(arguments) -> tuple[list | None, str]:
    """(the card's questions, or None; what the model is told), read by Work's validator."""
    try:
        return asks.normalize_questions(arguments), SHOWN
    except (ValueError, TypeError) as exc:
        return None, f"error: {exc}"


def _has(db, table="pip_chat_questions") -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def _ensure(db) -> None:
    if not (_has(db) and _has(db, "pip_chat_question_clients")):
        from .workspace_registry import _execute_schema
        _execute_schema(db, SCHEMA)


# ---------------------------------------------------------------------------------------- who draws the card

def note_client(registry, pip_id: str, conversation_id, draws: bool) -> None:
    """The client that wrote last in this conversation does (or doesn't) draw the card."""
    if not isinstance(conversation_id, str) or not conversation_id:
        return
    if not draws and not _has(registry.db, "pip_chat_question_clients"):
        return                                   # (a registry no card-drawing client ever wrote to stays as it was)
    with contextlib.nullcontext() if registry.db.in_transaction else registry.transaction():
        _ensure(registry.db)
        registry.db.execute("INSERT INTO pip_chat_question_clients VALUES(?,?,?) ON CONFLICT(conversation_id) "
                            "DO UPDATE SET draws=excluded.draws", (conversation_id, pip_id, 1 if draws else 0))


def drawn(db, conversation_id) -> bool:
    """Whether the client that wrote last in this conversation draws the card (offered propose_options there)."""
    if not isinstance(conversation_id, str) or not _has(db, "pip_chat_question_clients"):
        return False
    row = db.execute("SELECT draws FROM pip_chat_question_clients WHERE conversation_id=?", (conversation_id,)).fetchone()
    return bool(row and row[0] == 1)


# ---------------------------------------------------------------------------------------- the card with its reply

def checked(value) -> list:
    """A reply's `questions` as insert_reply takes it: Work's normalized list, exactly."""
    kept = asks.validate_kept(value)
    if kept is None or len(json.dumps(kept, ensure_ascii=False).encode("utf-8")) > 65536:
        raise RegistryError("invalid_reply", "This reply's questions are not a card of 1 to 4 questions.")
    return kept


def attach(db, pip_id: str, reply_id: str, value) -> None:
    """Keep the card with the reply (in insert_reply's transaction)."""
    _ensure(db)
    db.execute("INSERT INTO pip_chat_questions(message_id,pip_id,questions,state) VALUES(?,?,?,'open')",
               (reply_id, pip_id, json.dumps(checked(value), ensure_ascii=False, separators=(",", ":"))))


def _row(db, message_id):
    if not _has(db):
        return None
    return db.execute("SELECT q.*,m.conversation_id,m.seq,m.role FROM pip_chat_questions q "
                      "JOIN pip_chat_messages m ON m.id=q.message_id WHERE q.message_id=?", (message_id,)).fetchone()


def _moved_on(db, row) -> bool:
    """A message after this reply in its conversation: the card is no longer the chat's last word."""
    return db.execute("SELECT 1 FROM pip_chat_messages WHERE pip_id=? AND conversation_id IS ? AND seq>? LIMIT 1",
                      (row["pip_id"], row["conversation_id"], row["seq"])).fetchone() is not None


def _view(db, row) -> dict | None:
    kept = asks.validate_kept(_loads(row["questions"]))
    if kept is None:
        return None
    state = row["state"] if row["state"] in STATES else "open"
    if state == "open" and _moved_on(db, row):
        state = "closed"
    answers = _loads(row["answers"]) if state == "answered" else None
    return {"questions": kept, "state": state, "answers": answers if isinstance(answers, dict) else {}}


def _loads(text):
    try:
        return json.loads(text) if isinstance(text, str) else None
    except ValueError:
        return None


def view(db, message_id) -> dict | None:
    """A reply's card as the chat lists it: {questions, state, answers}, or None for a reply that asked none."""
    row = _row(db, message_id)
    return _view(db, row) if row is not None else None


# ---------------------------------------------------------------------------------------- answering

def answer(store, pip_id, message_id, key, actor, config, *, answers=None, dismissed=None, chat_options=None) -> dict:
    """answer_pip_questions: the answers as the user's next message (R: questions, run, message), or Dismiss (R:
    questions, nothing sent). Only while the card is open and its reply is the conversation's last message."""
    if not isinstance(message_id, str) or not _MESSAGE.match(message_id):
        raise RegistryError("invalid_request", "Name the reply whose questions these answer by its message id.")
    if (dismissed is True) == (answers is not None) or dismissed not in (None, True):
        raise RegistryError("invalid_request", "Send the answers, or dismissed: true to close the card.")
    store._job(pip_id)
    row = _row(store.db, message_id)
    if row is None or row["pip_id"] != pip_id or row["role"] != "assistant":
        raise RegistryError("not_found", "That reply of this Pip asked no questions.")
    kept = asks.validate_kept(_loads(row["questions"]))
    if kept is None:
        raise RegistryError("not_found", "That reply of this Pip asked no questions.")
    if dismissed is True:
        if row["state"] == "dismissed":
            return {"questions": _view(store.db, row)}
        if row["state"] == "answered":
            raise RegistryError("questions_closed", CLOSED)
        if _moved_on(store.db, row):
            raise RegistryError("questions_closed", MOVED_ON)
        with store.registry.transaction():
            store.db.execute("UPDATE pip_chat_questions SET state='dismissed',decided_at=? WHERE message_id=? AND state='open'",
                             (store.registry.clock(), message_id))
        return {"questions": view(store.db, message_id)}
    if not isinstance(key, str) or not _KEY.match(key):
        raise RegistryError("invalid_request", "Conversation retry keys use 1–128 letters, digits, underscores or hyphens.")
    decision = asks.validate_response(kept, {"answers": answers})
    if decision is None:
        raise RegistryError("invalid_answers", "Answer the card's own questions: one choice in a single-choice question "
                                               "(or your own words), any in a multi-select one.")
    from .pip_chat import send
    retry = row["state"] == "answered" and row["request_key"] == key
    if not retry:
        if row["state"] == "answered":
            raise RegistryError("questions_closed", CLOSED)
        if row["state"] == "dismissed":
            raise RegistryError("questions_closed", DISMISSED)
        if _moved_on(store.db, row):
            raise RegistryError("questions_closed", MOVED_ON)
    elif _loads(row["answers"]) != decision["answers"]:
        raise RegistryError("conflict", "This request key answered these questions differently.")
    sent = send(store, pip_id, asks.answer_words(kept, decision), key, actor, config, chat_options=chat_options,
                conversation_id=row["conversation_id"], questions=True)
    if not retry:
        with store.registry.transaction():
            store.db.execute("UPDATE pip_chat_questions SET state='answered',answers=?,request_key=?,decided_at=? "
                             "WHERE message_id=? AND state='open'",
                             (json.dumps(decision["answers"], ensure_ascii=False, separators=(",", ":")), key,
                              store.registry.clock(), message_id))
    return {"questions": view(store.db, message_id), **sent}
