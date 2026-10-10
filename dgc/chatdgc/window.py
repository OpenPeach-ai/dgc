"""How much of the model's context window a chat fills, and keeping it inside.

Small windows are how local chat fails: a 32k model fills up after a long document and a few dozen turns. So:
  * the window is the model's real one (asked of the provider), capped by the preset in Settings -> ChatDGC
    (8k, 32k, 128k, or the model's maximum) and sent with every request;
  * what a chat takes is counted by the provider where it reports it, estimated otherwise;
  * before a reply that would pass COMPACT_AT of the window, the older turns become a summary and the recent
    ones stay word for word (KEEP_RECENT of the window, counted in tokens, not messages); the summary is shown,
    and can be edited, and the full transcript stays where it was;
  * one attachment never takes more than FILE_SHARE of the window.
"""
from __future__ import annotations

WINDOWS = {"8k": 8192, "32k": 32768, "128k": 131072, "max": 0}
DEFAULT_WINDOW = "32k"
FALLBACK_WINDOW = 32768          # a "max" the provider didn't report
COMPACT_AT = 0.75                # of the window: past this before a reply, older turns are summarized
KEEP_RECENT = 0.35               # of the window kept word for word
FILE_SHARE = 0.4                 # of the window, at most, for one attachment's text
CHARS_PER_TOKEN = 4              # an estimate's ratio, for what the provider hasn't counted
IMAGE_TOKENS = 1000              # an image, roughly, as most vision models count it
MAX_SUMMARY_CHARS = 20_000
COMPACT_PROMPT = (
    "You are summarizing a conversation so it can continue without its earlier messages. Write a summary the "
    "assistant can rely on: the user's goals and preferences, facts and numbers they gave, decisions made, what "
    "was asked and answered (briefly), files and images discussed, open questions, and anything they asked to be "
    "remembered. Keep names, numbers and dates exact. Plain text, short paragraphs or bullets, at most {words} "
    "words. Write only the summary.")


def tokens(text: str) -> int:
    return (len(text or "") + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def estimate(messages: list[dict]) -> int:
    """What a request's messages take, estimated: text by its length, images by a typical count."""
    total = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            total += tokens(content)
        elif isinstance(content, list):
            for part in content:
                if part.get("type") == "image_url":
                    total += IMAGE_TOKENS
                else:
                    total += tokens(str(part.get("text") or ""))
        total += 4                       # each message's own framing
    return total


def window(client, preset: str) -> tuple[int, int]:
    """(the window this chat uses, the model's own limit or 0), and the client set to send it."""
    try:
        client.prepare_model()
    except Exception:                    # noqa: BLE001 -- discovery is advice; the preset still stands
        pass
    try:
        limit = int(client.model_context_limit() or 0)
    except Exception:                    # noqa: BLE001
        limit = 0
    wanted = WINDOWS.get(preset, WINDOWS[DEFAULT_WINDOW]) or limit or FALLBACK_WINDOW
    size = min(wanted, limit) if limit else wanted
    try:
        client.context_size = size       # Ollama gets it as num_ctx on every request
    except Exception:                    # noqa: BLE001
        pass
    return size, limit
