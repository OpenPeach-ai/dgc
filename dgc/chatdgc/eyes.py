"""ChatDGC's eyes: when a chat's model can't see images, a model that can looks at them for it.

The look is one request: the images and the user's message, no tools. What the vision model says is kept on the
user's message (``vision``: which model looked, and what it saw), and the chat's own model reads that in place
of the pictures, this turn and every later one. A model that can see gets the pictures themselves.

Which model looks:
  1. the sub-agent route in Settings (its model, on its own host or the main one), as it always has;
  2. else a model that can see on one of the user's connections (dgc/seeing.py, shared with Work and Pips): the one
     this chat or Settings chose, or, the first time, the one DGC found -- offered on a card with three choices
     (engine.send makes the card; its answer is the chat's from then on).
The sub-agent route's answer is cached for a few minutes, so a chat of pictures doesn't ask again for each one.
"""
from __future__ import annotations

import time

LOOK_SYSTEM = (
    "You are the eyes of a chat assistant whose own model cannot see images. You receive the user's message and "
    "the image(s) they attached. Answer what the message asks about the images from what they actually show, "
    "then describe them in detail: quote all visible text exactly, and give layout, colours, objects, people and "
    "anything else the assistant needs to answer without seeing them. Say when something is unreadable or you're "
    "unsure; never invent details.")
ROUTE_TTL_S = 300
MAX_ANSWER_CHARS = 8000


class Eyes:
    def __init__(self, engine):
        self.engine = engine
        self._cache: dict[str, tuple[float, dict | None]] = {}
        self._settings_signature = None

    def _signature(self):
        config = self.engine.config
        return (config.base_url, config.api_key, config.model, config.get("api_mode", "auto"),
                config.get("subagent_model", ""), config.get("subagent_base_url", ""),
                config.get("subagent_api_key", ""), config.get("subagent_api_mode", ""))

    def _candidates(self, chat_model: str):
        config = self.engine.config
        base, mode = str(config.base_url or ""), str(config.get("api_mode", "auto") or "auto")
        sub = str(config.get("subagent_model", "") or "")
        if sub:
            sub_base = str(config.get("subagent_base_url", "") or "") or base
            same = sub_base.rstrip("/").lower() == base.rstrip("/").lower()
            key = str(config.get("subagent_api_key", "") or "") or (config.api_key if same else "")
            yield {"model": sub, "base_url": sub_base, "api_key": key,
                   "api_mode": str(config.get("subagent_api_mode", "") or "") or mode, "origin": "sub-agent model"}

    # -- a model that can see on one of the user's connections (dgc/seeing.py)

    def chat_key(self, chat: dict) -> str:
        model = str(chat.get("model") or "")
        return f"provider:{model.split(':', 2)[1]}" if model.startswith("provider:") and model.count(":") >= 2 else "main"

    def connections(self, chat: dict) -> list:
        """DGC's own connection, the Sub-agents model, and the editor's saved providers (each asked for its route only
        when the search reaches it; the chat's own provider from this turn's route)."""
        from .. import seeing
        engine, config = self.engine, self.engine.config
        make = (lambda model: engine._client_factory(model)) if engine._client_factory is not None else None
        main = seeing.main_connection(config)
        out = []
        if main is not None:
            main.make = make
            out.append(main)
        sub = seeing.subagent_connection(config, main)
        if sub is not None:
            sub.make = make
            out.append(sub)
        turn = getattr(engine._provider_turn, "route", None)
        named = []
        try:
            named = list(engine.connections() or []) if callable(getattr(engine, "connections", None)) else []
        except Exception:                          # noqa: BLE001 -- no list: no saved providers searched
            named = []
        route_of = getattr(engine, "connection_route", None)
        own = self.chat_key(chat)
        if isinstance(turn, dict) and own == f"provider:{turn.get('id')}":
            name = next((str(c.get("name") or "") for c in named if isinstance(c, dict)
                         and c.get("id") == turn.get("id")), "") or seeing.host_name(turn.get("base_url", ""))
            out.append(seeing.Connection(key=own, kind="provider", name=name[:80], base_url=str(turn["base_url"]),
                                         api_key=str(turn.get("api_key") or ""), api_mode=str(turn.get("api_mode") or "auto"),
                                         make=make))
            named = [c for c in named if not (isinstance(c, dict) and c.get("id") == turn.get("id"))]
        if named and callable(route_of):
            for conn in seeing.provider_connections(named, route_of,
                                                    skip_hosts=(seeing.host_of(main.base_url),) if main else ()):
                conn.make = make
                out.append(conn)
        return out

    @staticmethod
    def route_of(found) -> dict:
        """A Found as the route dict a look takes."""
        conn = found.connection
        conn.ready()
        return {"model": found.model, "base_url": conn.base_url, "api_key": conn.api_key,
                "api_mode": conn.api_mode or "auto", "origin": conn.name}

    def route(self, chat_model: str, cancel=None) -> dict | None:
        """The first model that can see, for a chat whose own model can't (None: none can)."""
        from ..vision import has_vision
        signature = self._signature()
        if signature != self._settings_signature:
            self._cache.clear()
            self._settings_signature = signature
        now = time.monotonic()
        cached = self._cache.get(chat_model)
        if cached is not None and now - cached[0] < ROUTE_TTL_S:
            return cached[1]
        found, seen = None, {chat_model}
        for candidate in self._candidates(chat_model):
            if candidate["model"] in seen:
                continue
            seen.add(candidate["model"])
            if cancel is not None and cancel.is_set():
                return None
            try:
                client = self._client(candidate)
                if has_vision(client, cancel):
                    found = candidate
                    break
            except Exception:
                continue
        self._cache[chat_model] = (now, found)
        return found

    def _client(self, candidate: dict):
        return self.engine.client(candidate["model"], base_url=candidate["base_url"], api_key=candidate["api_key"],
                                  api_mode=candidate["api_mode"])

    def look(self, route: dict, images: list[tuple[str, str]], message: str, cancel=None) -> str:
        """One look: ``images`` ([(data URI, name)]) and the user's message. Returns what the model saw; raises
        RuntimeError saying why when it can't."""
        client = self._client(route)
        client.provider_state = "stateless"
        parts: list = [{"type": "text", "text": "The user's message:\n<<<\n" + (message.strip()[:4000] or
                                                                              "(no words, only the image)") + "\n>>>"}]
        for index, (uri, name) in enumerate(images, 1):
            parts.append({"type": "text", "text": f"Image {index} of {len(images)}: {name}"})
            parts.append({"type": "image_url", "image_url": {"url": uri}})
        before = int(getattr(client, "dropped_images", 0) or 0)
        result = client.chat([{"role": "system", "content": LOOK_SYSTEM}, {"role": "user", "content": parts}],
                             tools=None, reasoning_effort="off", cancel=cancel)
        if int(getattr(client, "dropped_images", 0) or 0) > before:
            self._cache.clear()
            raise RuntimeError(f"{route['model']} refused the image")
        if cancel is not None and cancel.is_set():
            raise RuntimeError("stopped before it answered")
        answer = str(getattr(result, "content", "") or "").strip()
        if not answer:
            raise RuntimeError(f"{route['model']} returned nothing")
        return answer[:MAX_ANSWER_CHARS]
