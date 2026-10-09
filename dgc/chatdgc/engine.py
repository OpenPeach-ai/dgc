"""ChatDGC's engine: one chat turn, start to end, on the user's own model.

A turn is the chat's history, ChatDGC's own instructions, and one streamed request through ``LLMClient`` (the
layer Work and Pips share). Nothing here is the coding agent's: no project, no tools in Phase 1, no reply cap of
its own. A reply is as long as the model allows; when the model stops at its own limit the message is marked
``finish: "length"`` and ``continue_reply`` picks up exactly where it stopped.
"""
from __future__ import annotations

import threading
from typing import Callable

from .prompt import system_prompt
from .store import (MAX_TEXT, ChatStore, ChatStoreError, new_chat_id, new_message_id, now,
                    title_from)

THINKING = ("off", "low", "medium", "high", "xhigh")
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
        """An existing chat, or a new one (temporary: kept in memory only, never in the list)."""
        if chat_id:
            return self._chat(chat_id)
        if temporary:
            stamp = now()
            chat = {"id": new_chat_id(), "title": "Temporary chat", "created_at": stamp, "updated_at": stamp,
                    "model": None, "thinking": None, "pinned": False, "archived": False, "messages": [],
                    "temporary": True}
            with self._lock:
                self._temporary[chat["id"]] = chat
            return chat
        return self.store.create()

    def _chat(self, chat_id: str) -> dict:
        with self._lock:
            if chat_id in self._temporary:
                return self._temporary[chat_id]
        return self.store.get(chat_id)

    def _save(self, chat: dict) -> dict:
        if chat.get("temporary"):
            chat["updated_at"] = now()
            with self._lock:
                self._temporary[chat["id"]] = chat
            return chat
        return self.store.save(chat)

    # -- a turn

    def send(self, chat_id: str, text: str, *, model: str | None = None, thinking: str | None = None,
             on_text=None, on_thinking=None, cancel: threading.Event | None = None) -> dict:
        """Add the user's message and stream the reply. Returns the reply message (also saved)."""
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
        chat["messages"].append({"id": new_message_id(), "role": "user", "text": text, "created_at": now()})
        chat = self._save(chat)
        return self._reply(chat, self._history(chat["messages"]), None, on_text, on_thinking, cancel)

    def continue_reply(self, chat_id: str, message_id: str, *, on_text=None, on_thinking=None,
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
        return self._reply(chat, history, chat["messages"][index], on_text, on_thinking, cancel)

    def _history(self, messages: list[dict]) -> list[dict]:
        """What the model reads: ChatDGC's instructions and the conversation. Earlier thinking never goes back."""
        zone = str(self.config.get("timezone", "") or "")
        return ([{"role": "system", "content": system_prompt(timezone_name=zone)}]
                + [{"role": m["role"], "content": m["text"]} for m in messages if m.get("text")])

    def _reply(self, chat, history, existing, on_text, on_thinking, cancel) -> dict:
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
            message = {"id": new_message_id(), "role": "assistant", "text": text[:MAX_TEXT], "thinking": thought_text,
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
