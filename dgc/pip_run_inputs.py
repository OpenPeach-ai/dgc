"""A run's large pinned inputs, kept beside the run instead of inside its manifest (0.52, 10 Nov).

A Pip's history is sized from its chat's context window (about half of it: up to 2 MiB at a 1M-token window), and a
message can be up to 256 KB (Limits for everyone, 10 Nov), but a stored run manifest stays small (every reader bounds
it at 128 KiB). So when the history pinned for a reply is larger than INLINE_BYTES, or the message is larger than
TEXT_INLINE_BYTES, what is too big is kept here, pinned by its digest when the message is queued. The manifest then
carries ``inputs_ref`` ({digest, bytes, history: how many messages or None, text: True or False}): an empty
``history`` when the history is kept here, and the start of a kept message as its ``text``, so any reader of the
stored run still sees a message. The supervisor puts both back, digest checked, just before the worker starts
(``attach``); the worker never opens the registry and sees the ordinary shape. ``turn_text`` gives the whole message
to supervisor code that reads it before then.
"""
from __future__ import annotations

import hashlib
import json

from .workspace_registry import RegistryError

SCHEMA = """
CREATE TABLE IF NOT EXISTS pip_run_inputs (
 run_id TEXT PRIMARY KEY REFERENCES pip_runs(id),
 inputs TEXT NOT NULL CHECK(length(CAST(inputs AS BLOB)) <= 8388608),
 digest TEXT NOT NULL CHECK(length(digest) = 64)
);
"""
INLINE_BYTES = 64 * 1024          # a history up to this stays inside the manifest, as before
TEXT_INLINE_BYTES = 16 * 1024     # a message up to this stays inside the manifest, as before
TEXT_START_CHARS = 2000           # what the manifest keeps of a longer message
REF_KEYS = {"digest", "bytes", "history", "text"}


def _encode(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def split(conversation: dict):
    """(conversation for the manifest, inputs to keep beside the run or None)."""
    if not isinstance(conversation, dict):
        return conversation, None
    kept, out = {}, dict(conversation)
    history = conversation.get("history")
    if isinstance(history, list) and len(_encode(history)) > INLINE_BYTES:
        kept["history"] = history
        out["history"] = []
    text = conversation.get("text")
    if isinstance(text, str) and len(text.encode("utf-8")) > TEXT_INLINE_BYTES:
        kept["text"] = text
        out["text"] = text[:TEXT_START_CHARS].rstrip() + " …"
    if not kept:
        return conversation, None
    raw = _encode(kept)
    out["inputs_ref"] = {"digest": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                         "history": len(kept["history"]) if "history" in kept else None, "text": "text" in kept}
    return out, kept


def put(db, run_id: str, kept) -> None:
    raw = _encode(kept)
    db.execute("INSERT INTO pip_run_inputs(run_id,inputs,digest) VALUES(?,?,?)",
               (run_id, raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()))


def valid_ref(ref, conversation) -> bool:
    """The shape a manifest's ``inputs_ref`` must have (pip_chat.validate_context)."""
    import re
    return (isinstance(ref, dict) and set(ref) == REF_KEYS and isinstance(ref["digest"], str)
            and re.fullmatch(r"[0-9a-f]{64}", ref["digest"]) is not None
            and type(ref["bytes"]) is int and 0 < ref["bytes"] <= 8388608 and type(ref["text"]) is bool
            and (ref["history"] is None or (type(ref["history"]) is int and ref["history"] >= 0))
            and (ref["history"] is not None or ref["text"])
            and (ref["history"] is None or conversation.get("history") == []))


def attach(db, run_id: str, manifest: dict) -> dict:
    """The manifest with what was kept beside it back in place, for the worker. Refuses inputs that changed."""
    conversation = manifest.get("conversation") if isinstance(manifest, dict) else None
    ref = conversation.get("inputs_ref") if isinstance(conversation, dict) else None
    if ref is None:
        return manifest
    row = db.execute("SELECT inputs,digest FROM pip_run_inputs WHERE run_id=?", (run_id,)).fetchone()
    if row is None or not valid_ref(ref, conversation) or row[1] != ref["digest"] \
            or hashlib.sha256(row[0].encode("utf-8")).hexdigest() != ref["digest"]:
        raise RegistryError("invalid_history", "This reply's pinned inputs are missing or changed. Nothing unverified was used.")
    kept = json.loads(row[0])
    if (not isinstance(kept, dict) or set(kept) != ({"history"} if ref["history"] is not None else set()) | ({"text"} if ref["text"] else set())
            or ("history" in kept and (not isinstance(kept["history"], list) or len(kept["history"]) != ref["history"]))
            or ("text" in kept and not isinstance(kept["text"], str))):
        raise RegistryError("invalid_history", "This reply's pinned inputs are malformed.")
    restored = {key: value for key, value in conversation.items() if key != "inputs_ref"}
    restored.update(kept)
    return {**manifest, "conversation": restored}


def turn_text(db, run_id: str, manifest: dict) -> str:
    """The user's whole message this turn, even when it is kept beside the run."""
    conversation = manifest.get("conversation") if isinstance(manifest, dict) else None
    if not isinstance(conversation, dict):
        return ""
    ref = conversation.get("inputs_ref")
    if isinstance(ref, dict) and ref.get("text") is True:
        return str(attach(db, run_id, manifest)["conversation"].get("text") or "")
    return str(conversation.get("text") or "")
