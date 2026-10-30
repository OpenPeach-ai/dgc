"""Bounded references for images already saved in a user's prompt.

The transcript keeps the model-bound image data URI. History sends only a small reference; a
``get_image`` request can then return the bytes from that same conversation after an editor reload.
No remote URL is fetched and no second copy of the image is written to disk.
"""
from __future__ import annotations

import base64
import hashlib

from .attachments import MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES, validate_image_data_uris
from .image_views import dimensions


def from_message(message: dict) -> tuple[list[dict], dict[str, tuple[str, str, int, int]]]:
    """Return display items and ref -> (URI, MIME, width, height) for saved image parts."""
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return [], {}
    items: list[dict] = []
    refs: dict[str, tuple[str, str, int, int]] = {}
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "image_url":
            continue
        if len(items) >= MAX_IMAGE_FILES:
            break
        image = part.get("image_url")
        uri = image.get("url") if isinstance(image, dict) else None
        fallback = {"img": True, "label": "Image"}
        try:
            (uri,) = validate_image_data_uris(
                [uri], maximum_file_bytes=MAX_IMAGE_FILE_BYTES,
                maximum_total_bytes=MAX_IMAGE_FILE_BYTES)
            mime = uri[5:uri.index(";base64,")]
            raw = base64.b64decode(uri.partition(",")[2], validate=True)
            width, height = dimensions(raw)
            ref = "img_" + hashlib.sha256(raw).hexdigest()[:32]
        except (ValueError, TypeError):
            items.append(fallback)
            continue
        items.append({"img": True, "label": "Image", "ref": ref, "mime": mime,
                      "bytes": len(raw), "width": width, "height": height})
        refs[ref] = (uri, mime, width, height)
    return items, refs
