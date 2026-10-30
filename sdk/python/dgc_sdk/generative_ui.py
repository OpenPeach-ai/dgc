"""Read DGC's bounded presentation cards from a reply without executing model markup.

The host owns rendering and decides whether to send a choice as a new message. A
choice is never an approval or a tool call.
"""

from __future__ import annotations

import json
import re
from typing import Any

_FENCE = re.compile(r"^```dgc-ui[ \t]*\n(.*?)\n```[ \t]*$", re.MULTILINE | re.DOTALL)
_LIMITS = {"metrics": 8, "steps": 8, "bars": 12, "table": 8, "choices": 4}


def _word(value: Any, limit: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


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
                        and all(isinstance(cell, str) and len(cell) <= 150 for cell in row)
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
                                 or item.get("state", "waiting") not in ("done", "running", "attention", "waiting")):
            return False
        if kind == "bars" and (not _word(item.get("label"), 45)
                                or isinstance(item.get("value"), bool)
                                or not isinstance(item.get("value"), (int, float))
                                or not 0 <= item["value"] <= 1_000_000):
            return False
        if kind == "choices":
            reply = item.get("reply")
            if (not _word(item.get("label"), 70) or not _word(reply, 500)
                    or reply.lstrip().startswith("/")
                    or re.search(r"\s/(?:goal|plan|review|init)$", reply, re.I)):
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
            card = json.loads(source)
        except (ValueError, TypeError):
            continue
        if (isinstance(card, dict) and card.get("version") == "1"
                and _word(card.get("title"), 120)
                and isinstance(card.get("blocks"), list)
                and 1 <= len(card["blocks"]) <= 6
                and all(_valid_block(block) for block in card["blocks"])):
            cards.append(card)
    return cards
