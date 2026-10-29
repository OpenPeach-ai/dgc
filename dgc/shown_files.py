"""Bounded path-only records for files deliberately shown in a conversation.

These records grant no filesystem access. The editor validates each path again before
reading a thumbnail or opening a file; files are never embedded in session metadata.
"""
from pathlib import PurePosixPath


def items(value) -> list[dict]:
    if not isinstance(value, (list, tuple)):
        return []
    out = []
    for item in value[:8]:
        if not isinstance(item, dict):
            continue
        rel = item.get("rel")
        if (not isinstance(rel, str) or not rel or len(rel) > 4096
                or any(ord(c) < 32 for c in rel) or "\\" in rel
                or PurePosixPath(rel).is_absolute() or ".." in PurePosixPath(rel).parts
                or ":" in rel.split("/", 1)[0]):
            continue
        size = item.get("bytes", 0)
        if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= 2**53 - 1:
            size = 0
        name = item.get("name")
        caption = item.get("caption")
        out.append({"name": (name if isinstance(name, str) else PurePosixPath(rel).name)[:256],
                    "rel": rel, "bytes": size,
                    "caption": caption[:200] if isinstance(caption, str) else ""})
    return out


def events(message: dict) -> list[dict]:
    records = message.get("_dgc_files")
    if not isinstance(records, list):
        return []
    out = []
    for record in records[:16]:
        if not isinstance(record, dict):
            continue
        rows = items(record.get("items"))
        if not rows:
            continue
        call = record.get("call_id")
        out.append({"type": "files_ready", "call_id": call[:200] if isinstance(call, str) and call else None,
                    "items": rows, "caption": rows[0]["caption"]})
    return out
