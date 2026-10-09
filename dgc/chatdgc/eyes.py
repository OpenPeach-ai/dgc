"""ChatDGC's eyes: when a chat's model can't see images, a model that can looks at them for it.

The look is one request: the images and the user's message, no tools. What the vision model says is kept on the
user's message (``vision``: which model looked, and what it saw), and the chat's own model reads that in place
of the pictures, this turn and every later one. A model that can see gets the pictures themselves.

Which model looks, first that can see:
  1. the sub-agent route in Settings (its model, on its own host or the main one);
  2. the main model in Settings, when the chat uses another;
  3. a model installed on the same Ollama whose metadata says it sees (names that suggest vision are tried
     first, and only a few are asked).
The answer is cached for a few minutes, so a chat of pictures doesn't ask again for each one.
"""
from __future__ import annotations

import time

LOOK_SYSTEM = (
    "You are the eyes of a chat assistant whose own model cannot see images. You receive the user's message and "
    "the image(s) they attached. Answer what the message asks about the images from what they actually show, "
    "then describe them in detail: quote all visible text exactly, and give layout, colours, objects, people and "
    "anything else the assistant needs to answer without seeing them. Say when something is unreadable or you're "
    "unsure; never invent details.")
MAX_PROBES = 6
ROUTE_TTL_S = 300
MAX_ANSWER_CHARS = 8000
_VISION_NAMES = ("vl", "vision", "llava", "gemma3", "minicpm-v", "moondream", "pixtral", "llama4", "mistral-small3")


class Eyes:
    def __init__(self, engine):
        self.engine = engine
        self._cache: dict[str, tuple[float, dict | None]] = {}

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
        if config.model and config.model != chat_model:
            yield {"model": config.model, "base_url": base, "api_key": config.api_key, "api_mode": mode,
                   "origin": "main model"}
        try:
            installed = self.engine.client(chat_model).list_models()
        except Exception:
            installed = []
        likely = sorted((m for m in installed if m != chat_model),
                        key=lambda m: (not any(word in m.lower() for word in _VISION_NAMES), m))
        for model in likely[:MAX_PROBES]:
            yield {"model": model, "base_url": base, "api_key": config.api_key, "api_mode": mode,
                   "origin": "installed model"}

    def route(self, chat_model: str, cancel=None) -> dict | None:
        """The first model that can see, for a chat whose own model can't (None: none can)."""
        from ..vision import has_vision
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
