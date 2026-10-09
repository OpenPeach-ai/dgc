"""ChatDGC's engine: one chat turn, start to end, on the user's own model.

A turn is the chat's history, ChatDGC's own instructions, and one streamed request through ``LLMClient`` (the
layer Work and Pips share). Nothing here is the coding agent's: no project, no tools in Phase 1, no reply cap of
its own. A reply is as long as the model allows; when the model stops at its own limit the message is marked
``finish: "length"`` and ``continue_reply`` picks up exactly where it stopped.
"""
from __future__ import annotations

import threading
from typing import Callable

from ..editor_protocol import CHATDGC_THINKING as THINKING
from .prompt import system_prompt
from .store import (MAX_TEXT, ChatStore, ChatStoreError, new_chat_id, new_message_id, now,
                    title_from)

MAX_DRAFTS = 64
NAME_PROMPT = ("Name this conversation in three to six words, the way a chat app titles it. Reply with the name "
               "only: no quotes, no full stop.")
CONTINUE = ("Continue exactly where your last reply stopped. Don't repeat anything you already wrote, and don't "
            "add an introduction: start with the next word.")


class ChatEngineError(Exception):
    """A turn didn't happen; the text says why, for the user."""


class ChatEngine:
    def __init__(self, config, store: ChatStore | None = None, *, client_factory: Callable | None = None):
        self.config = config
        self.store = store or ChatStore()
        self._client_factory = client_factory
        self._temporary: dict[str, dict] = {}      # temporary chats: never written, gone with the process
        self._drafts: dict[str, dict] = {}         # new chats: written with their first message
        self._lock = threading.Lock()

    # -- the model

    def client(self, model: str | None):
        if self._client_factory is not None:
            return self._client_factory(model)
        from ..llm import LLMClient, normalize_usage, usage_reported
        from .. import usage_ledger
        config = self.config
        client = LLMClient(config.base_url, config.api_key, model or config.model,
                           read_timeout=int(config.get("request_timeout", 1800)),
                           think_budget_tokens=config.get("think_budget_tokens", "auto"),
                           max_tokens=0,               # no cap of ChatDGC's own: the model's limit, then Continue
                           ollama_keep_alive=str(config.get("ollama_keep_alive", "30m")),
                           api_mode=str(config.get("api_mode", "auto")),
                           provider_capabilities=config.get("provider_capabilities", {}),
                           capability_cache_ttl_s=int(config.get("capability_cache_ttl_s", 300)),
                           prompt_cache=bool(config.get("prompt_cache", True)),
                           context_size=int(config.get("context_size", 0)),
                           first_token_timeout=config.get("model_first_token_timeout_s", "auto"),
                           idle_timeout=config.get("model_idle_timeout_s", 300),
                           stall_notice=config.get("model_stall_notice_s", 45),
                           stall_retries=config.get("model_stall_retries", 2),
                           load_timeout=config.get("model_load_timeout_s", 900))

        def ledger(finished, result):
            try:
                raw = getattr(result, "usage", None)
                usage = normalize_usage(raw)
                transport = str(getattr(finished, "api_mode", "") or "")
                provider = ({"ollama": "ollama", "anthropic": "anthropic"}.get(transport)
                            or getattr(finished, "family", "") or "unknown")
                usage_ledger.record(provider=provider, base_url=getattr(finished, "base_url", ""),
                                    model=getattr(finished, "model", ""), source="chatdgc",
                                    input_tokens=usage["input_tokens"], output_tokens=usage["output_tokens"],
                                    cached_input_tokens=usage["cached_input_tokens"], metered=usage_reported(raw))
            except Exception:                  # noqa: BLE001 -- the ledger never breaks a reply
                pass
        client.usage_source = "chatdgc"
        client.usage_sink = ledger
        return client

    # -- chats

    def open(self, chat_id: str | None = None, *, temporary: bool = False) -> dict:
        """An existing chat, or a new one. A new chat is written with its first message (an empty one is
        never in the list); a temporary one is kept in memory only, never written or listed."""
        if chat_id:
            return self._chat(chat_id)
        stamp = now()
        chat = {"id": new_chat_id(), "title": "Temporary chat" if temporary else "New chat", "created_at": stamp,
                "updated_at": stamp, "model": None, "thinking": None, "pinned": False, "archived": False,
                "messages": []}
        chat["temporary" if temporary else "draft"] = True
        with self._lock:
            held = self._temporary if temporary else self._drafts
            held[chat["id"]] = chat
            while len(self._drafts) > MAX_DRAFTS:          # opened and left: the oldest goes
                self._drafts.pop(next(iter(self._drafts)))
        return dict(chat)

    def _chat(self, chat_id: str) -> dict:
        with self._lock:
            held = self._temporary.get(chat_id) or self._drafts.get(chat_id)
            if held is not None:
                return {**held, "messages": list(held["messages"])}
        return self.store.get(chat_id)

    def _save(self, chat: dict) -> dict:
        if chat.get("temporary"):
            chat = {**chat, "updated_at": now()}
            with self._lock:
                if chat["id"] not in self._temporary:
                    raise ChatStoreError("This chat was deleted.")
                self._temporary[chat["id"]] = chat
            return chat
        if chat.get("draft"):
            with self._lock:
                draft = self._drafts.pop(chat["id"], None)
            chat = {key: value for key, value in chat.items() if key != "draft"}
            if draft is not None:
                self.store.create(chat_id=chat["id"])
        return self.store.save(chat)

    def delete(self, chat_id: str) -> None:
        with self._lock:
            if self._temporary.pop(chat_id, None) is not None or self._drafts.pop(chat_id, None) is not None:
                return
        self.store.delete(chat_id)

    # -- a turn

    def send(self, chat_id: str, text: str, *, model: str | None = None, thinking: str | None = None,
             on_start=None, on_text=None, on_thinking=None, cancel: threading.Event | None = None) -> dict:
        """Add the user's message and stream the reply. Returns the reply message (also saved).

        ``on_start(user_message, reply_id)`` runs once the message is saved, before the model is asked:
        ``reply_id`` is the id the streamed parts and the finished reply will carry."""
        text = str(text or "")
        if not text.strip():
            raise ChatEngineError("Type a message first.")
        if len(text) > MAX_TEXT:
            raise ChatEngineError("That message is too long to send.")
        if thinking is not None and thinking not in THINKING:
            raise ChatEngineError("Choose off, low, medium, high or extra high thinking.")
        chat = self._chat(chat_id)
        if model:
            chat["model"] = str(model)[:200]
        if thinking is not None:
            chat["thinking"] = thinking
        if not chat["messages"] and chat["title"] in ("New chat", "Temporary chat") and not chat.get("temporary"):
            chat["title"] = title_from(text)
        mine = {"id": new_message_id(), "role": "user", "text": text, "created_at": now()}
        chat["messages"].append(mine)
        chat = self._save(chat)
        reply_id = new_message_id()
        if on_start is not None:
            on_start(mine, reply_id)
        return self._reply(chat, self._history(chat["messages"]), None, reply_id, on_text, on_thinking, cancel)

    def continue_reply(self, chat_id: str, message_id: str, *, on_start=None, on_text=None, on_thinking=None,
                       cancel: threading.Event | None = None) -> dict:
        """Carry on a reply the model stopped at its limit (or one that was stopped), in the same message."""
        chat = self._chat(chat_id)
        index = next((i for i, m in enumerate(chat["messages"]) if m.get("id") == message_id), None)
        if index is None or chat["messages"][index]["role"] != "assistant":
            raise ChatEngineError("That reply isn't in this chat.")
        if index != len(chat["messages"]) - 1:
            raise ChatEngineError("Only the last reply can be continued.")
        if chat["messages"][index].get("finish") not in ("length", "cancelled"):
            raise ChatEngineError("That reply is already complete.")
        history = self._history(chat["messages"]) + [{"role": "user", "content": CONTINUE}]
        if on_start is not None:
            on_start(None, message_id)
        return self._reply(chat, history, chat["messages"][index], message_id, on_text, on_thinking, cancel)

    def name(self, chat_id: str) -> dict | None:
        """Give a new chat a short name from its first exchange, as a chat app does. Only while it still has
        the name its first line gave it: a name the user chose is never replaced. Returns the chat if renamed."""
        chat = self._chat(chat_id)
        if chat.get("temporary") or len(chat["messages"]) < 2:
            return None
        first, reply = chat["messages"][0], chat["messages"][1]
        if first.get("role") != "user" or reply.get("role") != "assistant" or not reply.get("text"):
            return None
        if chat.get("title") != title_from(first.get("text", "")):
            return None
        client = self.client(chat.get("model") or None)
        result = client.chat([{"role": "system", "content": NAME_PROMPT},
                              {"role": "user", "content": f"User: {first['text'][:2000]}\n\nAssistant: {reply['text'][:2000]}"}],
                             tools=None, reasoning_effort="off")
        name = " ".join(str(getattr(result, "content", "") or "").split()).strip(" \"'`*#.")
        if not name or len(name) > 80:
            return None
        # Only if it still has that name now: one renamed while the model thought keeps the user's.
        return self.store.update(chat_id, title=name[:60], expect_title=title_from(first.get("text", "")))

    def _history(self, messages: list[dict]) -> list[dict]:
        """What the model reads: ChatDGC's instructions and the conversation. Earlier thinking never goes back."""
        zone = str(self.config.get("timezone", "") or "")
        return ([{"role": "system", "content": system_prompt(timezone_name=zone)}]
                + [{"role": m["role"], "content": m["text"]} for m in messages if m.get("text")])

    def _reply(self, chat, history, existing, reply_id, on_text, on_thinking, cancel) -> dict:
        model = chat.get("model") or None
        thinking = chat.get("thinking") or str(self.config.get("thinking", "off") or "off")
        streamed, thought = [], []

        def text_part(part):
            streamed.append(part)
            if on_text is not None:
                on_text(part)

        def thought_part(part):
            thought.append(part)
            if on_thinking is not None:
                on_thinking(part)

        client = self.client(model)
        finish, usage, failure = "stop", {}, None
        try:
            result = client.chat(history, tools=None, reasoning_effort=thinking, on_text=text_part,
                                 on_thinking=thought_part, cancel=cancel)
            text = "".join(streamed) or str(getattr(result, "content", "") or "")
            thought_text = "".join(thought) or str(getattr(result, "thinking", "") or "")
            reason = str(getattr(result, "finish_reason", "stop") or "stop")
            finish = "length" if reason in ("length", "max_tokens", "incomplete") else "stop"
            usage = dict(getattr(result, "usage", {}) or {})
        except Exception as exc:               # noqa: BLE001 -- said in the chat, never raised past it
            text, thought_text = "".join(streamed), "".join(thought)
            if cancel is not None and cancel.is_set():
                finish = "cancelled"
            else:
                finish, failure = "error", exc
        if cancel is not None and cancel.is_set() and finish != "error":
            finish = "cancelled"
        if failure is not None and not text:
            raise ChatEngineError(_failure_text(failure)) from failure
        if existing is not None:
            joined = existing["text"] + text
            message = {**existing, "text": joined[:MAX_TEXT], "finish": finish,
                       "thinking": (existing.get("thinking") or "") + thought_text,
                       "usage": _add_usage(existing.get("usage") or {}, usage)}
            chat["messages"][-1] = message
        else:
            message = {"id": reply_id, "role": "assistant", "text": text[:MAX_TEXT], "thinking": thought_text,
                       "created_at": now(), "model": getattr(client, "model", model) or model, "finish": finish,
                       "usage": usage}
            if failure is not None:
                message["error"] = _failure_text(failure)
            chat["messages"].append(message)
        self._save(chat)
        return message


def _add_usage(a: dict, b: dict) -> dict:
    out = dict(a)
    for key, value in (b or {}).items():
        if isinstance(value, (int, float)) and isinstance(out.get(key, 0), (int, float)):
            out[key] = out.get(key, 0) + value
    return out


def _failure_text(exc) -> str:
    text = " ".join(str(exc).split())[:300]
    return f"The model didn't answer: {text}" if text else "The model didn't answer. Try again."


__all__ = ["ChatEngine", "ChatEngineError", "ChatStoreError", "THINKING"]
