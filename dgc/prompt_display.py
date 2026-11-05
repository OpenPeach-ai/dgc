"""Bounded, display-only positions for mentions in a Work prompt.

The model receives the original prompt text. These positions only let an editor
draw its inline selections again after a session reload.
"""

import re


_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
_KINDS = {"plugin", "artifact", "pip", "skill", "template", "file", "command"}
_ZERO_WIDTH = {"pip", "skill", "template", "file"}
_PIP_TYPES = {"core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"}


def checked_mentions(value, text: str):
    """Return canonical mentions, or an empty list for invalid cosmetic data."""
    if not isinstance(text, str) or not isinstance(value, list) or len(value) > 24 or len(text) > 50_000:
        return []
    result = []
    end = 0
    for item in value:
        if not isinstance(item, dict) or (set(item) != {"start", "kind", "label", "identity"}
                                          and set(item) != {"start", "kind", "label", "identity", "pip_type"}):
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
        if kind not in _ZERO_WIDTH and text[start:start + len(label) + (kind == "command")] != (
                "/" + label if kind == "command" else label):
            return []
        end = start + (0 if kind in _ZERO_WIDTH else len(label) + (kind == "command"))
        result.append({"start": start, "kind": kind, "label": label, "identity": identity,
                       **({"pip_type": item["pip_type"]} if kind == "pip" else {})})
    return result
