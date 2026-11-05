"""Bind a Pip's priced media confirmation to one reviewed request and an explicit user reply."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import fields


_YES = re.compile(r"yes(?:[,.! ]+(?:please|make it|generate it|do it))?[.! ]*", re.I)


def user_said_yes(message: str) -> bool:
    """A short, unqualified yes to the one pending media request; prose and negations do not authorize spending."""
    return bool(_YES.fullmatch(str(message or "").strip()))


def request_identity(plan) -> str:
    """Hash the effective provider request, including options the price may not reflect (seed, prompt, start image)."""
    request = plan.request
    values = {}
    for field in fields(request):
        value = getattr(request, field.name)
        if field.name == "images":
            value = [_image_identity(item) for item in value]
        elif field.name in ("image", "mask"):
            value = _image_identity(value) if value is not None else None
        values[field.name] = value
    payload = {"generator": plan.generator["id"], "provider": plan.generator.get("provider"),
               "endpoint": plan.generator.get("base_url"), "model": plan.card().get("model"),
               "request": values}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _image_identity(item) -> dict:
    return {"sha256": hashlib.sha256(item.data).hexdigest(), "mime": item.mime, "name": item.name}
