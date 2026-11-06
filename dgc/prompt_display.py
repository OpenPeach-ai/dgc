"""Bounded, display-only positions for mentions in a prompt (Work, ChatDGC, a Pip's chat).

The model receives the original prompt text. These positions only let an editor
draw its inline selections again after a reload.
"""

import re


_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
_KINDS = {"plugin", "artifact", "pip", "skill", "template", "file", "command"}
_ZERO_WIDTH = {"pip", "skill", "template", "file"}
_KEYS = {"start", "kind", "label", "identity"}
_PIP_TYPES = {"core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"}


def checked_mentions(value, text: str):
    """Return canonical mentions, or an empty list for invalid cosmetic data."""
    if not isinstance(text, str) or not isinstance(value, list) or len(value) > 24 or len(text) > 50_000:
        return []
    result = []
    end = 0
    for item in value:
        if not isinstance(item, dict) or not _KEYS <= set(item) or set(item) - _KEYS - {"pip_type", "wired"}:
            return []
        start, kind, label, identity = (item[key] for key in ("start", "kind", "label", "identity"))
        if (type(start) is not int or start < end or start > len(text)
                or not isinstance(kind, str) or kind not in _KINDS or not isinstance(label, str)
                or not 1 <= len(label) <= 120 or any(ord(ch) < 32 for ch in label)
                or not isinstance(identity, str) or not _ID.fullmatch(identity)):
            return []
        if kind == "pip" and (not isinstance(item.get("pip_type"), str)
                              or item["pip_type"] not in _PIP_TYPES):
            return []
        if kind != "pip" and "pip_type" in item:
            return []
        # A selection that adds no words, unless its name IS the words (a Pip named in ChatDGC, a path in a Pip's chat).
        wired = item.get("wired", False)
        if "wired" in item and (wired is not True or kind not in _ZERO_WIDTH):
            return []
        width = 0 if kind in _ZERO_WIDTH and not wired else len(label) + (kind == "command")
        if width and text[start:start + width] != ("/" + label if kind == "command" else label):
            return []
        end = start + width
        result.append({"start": start, "kind": kind, "label": label, "identity": identity,
                       **({"pip_type": item["pip_type"]} if kind == "pip" else {}),
                       **({"wired": True} if wired else {})})
    return result


def named_pips(mentions) -> list:
    """The Pips a prompt's mentions name, each once: {identity, label, pip_type}."""
    seen, named = set(), []
    for mark in mentions or []:
        if mark.get("kind") == "pip" and mark["identity"] not in seen:
            seen.add(mark["identity"])
            named.append({"identity": mark["identity"], "label": mark["label"], "pip_type": mark.get("pip_type", "")})
    return named[:8]
