"""Read DGC's bounded presentation cards from a reply without executing model markup.

The host owns rendering and decides whether to send a choice as a new message. A
choice is never an approval or a tool call.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

_FENCE = re.compile(r"^```dgc-ui[ \t]*\n(.*?)\n```[ \t]*$", re.MULTILINE | re.DOTALL)
_LIMITS = {"metrics": 8, "steps": 8, "bars": 12, "table": 8, "choices": 4}
_STATES = ("done", "running", "attention", "waiting")
# The TypeScript SDK's extractGenerativeUi reads a reply the same way (tests/fixtures/sdk_generative_ui.json): lengths
# in characters (code points), a step's state a string or absent, the slash rule on the trimmed reply, no NaN.


# The text fields of each block's items; a bar's value stays a number.
_TEXT = {"metrics": ("label", "value", "detail"), "steps": ("label", "detail"), "bars": ("label",),
         "choices": ("label", "description", "reply")}


def _text(value: Any) -> str | None:
    """A text field: a string, or a finite number or true/false read as its text (as the editor draws it).
    Models write {"value": 42} and [["a.py", 120]] as often as strings."""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        return str(int(value)) if value.is_integer() and abs(value) < 1e21 else repr(value)
    return None


def _word(value: Any, limit: int) -> bool:
    text = _text(value)
    return text is not None and bool(text.strip()) and len(text) <= limit


def _as_text(value: Any) -> Any:
    text = _text(value)
    return value if text is None else text


def _card_text(card: dict[str, Any]) -> dict[str, Any]:
    """The card with every number or true/false in a text field given as its text."""
    out = {key: (_as_text(value) if key in ("title", "subtitle") else value) for key, value in card.items()}
    blocks = []
    for block in card["blocks"]:
        block = {key: (_as_text(value) if key == "label" else value) for key, value in block.items()}
        if block["type"] == "table":
            block["columns"] = [_as_text(column) for column in block["columns"]]
            block["rows"] = [[_as_text(cell) for cell in row] for row in block["rows"]]
        else:
            fields = _TEXT[block["type"]]
            block["items"] = [{key: (_as_text(value) if key in fields else value) for key, value in item.items()}
                              for item in block["items"]]
        blocks.append(block)
    out["blocks"] = blocks
    return out


def _not_json(name: str):
    raise ValueError(f"{name} is not JSON")


def _valid_block(block: Any) -> bool:
    if not isinstance(block, dict) or block.get("type") not in _LIMITS:
        return False
    kind = block["type"]
    if kind == "table":
        columns, rows = block.get("columns"), block.get("rows")
        return (isinstance(columns, list) and 1 <= len(columns) <= 5
                and all(_word(column, 70) for column in columns)
                and isinstance(rows, list) and 1 <= len(rows) <= 8
                and all(isinstance(row, list) and len(row) == len(columns)
                        and all(_text(cell) is not None and len(_text(cell)) <= 150 for cell in row)
                        for row in rows))
    items = block.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= _LIMITS[kind]:
        return False
    for item in items:
        if not isinstance(item, dict):
            return False
        if kind == "metrics" and not (_word(item.get("label"), 60) and _word(item.get("value"), 40)):
            return False
        if kind == "steps" and (not _word(item.get("label"), 110)
                                 or not isinstance(item.get("state", "waiting"), str)
                                 or item.get("state", "waiting") not in _STATES):
            return False
        if kind == "bars" and (not _word(item.get("label"), 45)
                                or isinstance(item.get("value"), bool)
                                or not isinstance(item.get("value"), (int, float))
                                or not 0 <= item["value"] <= 1_000_000):
            return False
        if kind == "choices":
            reply = _text(item.get("reply"))
            if (not _word(item.get("label"), 70) or not _word(reply, 500)
                    or reply.lstrip().startswith("/")
                    or re.search(r"\s/(?:goal|plan|review|init)\Z", reply.strip(), re.I)):
                return False
    return True


def extract_generative_ui(reply: str) -> list[dict[str, Any]]:
    """Return validated v1 cards in a Work, ChatDGC or Pip reply.

    Invalid cards are ignored. The reply text remains the source of truth; callers
    may show it alongside the cards. Sending ``choice['reply']`` must go through the
    normal SDK session/chat/Pip method and its existing permission policy.
    """
    if not isinstance(reply, str):
        raise TypeError("reply must be a string")
    cards: list[dict[str, Any]] = []
    for match in _FENCE.finditer(reply):
        source = match.group(1)
        if len(source) > 16_384:
            continue
        try:
            card = json.loads(source, parse_constant=_not_json)
        except (ValueError, TypeError, RecursionError):
            continue
        if (isinstance(card, dict) and card.get("version") == "1"
                and _word(card.get("title"), 120)
                and isinstance(card.get("blocks"), list)
                and 1 <= len(card["blocks"]) <= 6
                and all(_valid_block(block) for block in card["blocks"])):
            cards.append(_card_text(card))
    return cards
