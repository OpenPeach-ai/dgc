"""What one reply did and how long each step took, for its Trace (editors/vscode/media/trace.js).

A Work turn's Trace comes from its saved history. ChatDGC and a Pip's chat keep theirs differently, so each records its
steps here as they happen and saves the result with the reply: model rounds with the tokens the provider reported,
tools with their own start and end, searches with their hits, cards. Every number is one that was measured. A step
that has no measurement says nothing, and a reply whose steps can't all be closed has no Trace at all: a missing end is
never filled in from the end of the reply.

A saved trace is an open object on the reply, never a field of an event:
    {"v": 1, "ms": total, "steps": [{"kind": "model"|"tool", "label": str, "start": ms, "end": ms,
                                     "tokens"?: int, "detail"?: str, "hits"?: int, "error"?: true, "denied"?: true}]}
Times are whole milliseconds from the first step, and steps stay in the order they started.
"""
from __future__ import annotations

import json
import re
import time

VERSION = 1
MAX_STEPS = 256
MAX_LABEL = 72
MAX_DETAIL = 110
MAX_TOKENS = 100_000_000
MAX_MS = 30 * 24 * 3600 * 1000
# Kept with a reply, and read back in one answer: well past what MAX_STEPS rows of these lengths can reach.
MAX_BYTES = 96 * 1024
MODEL_LABEL = "model.response"
# The tools whose answer is a list of finds: their row counts hits, as a Work grep's does.
SEARCH_TOOLS = frozenset({"grep", "web_search"})
_NUMBERED_RESULT = re.compile(r"^(?:\[\d+\] |\d+\. )", re.M)     # ChatDGC's "[1] Title", the shared search's "1. Title"
REFUSALS = ("error:", "permission denied:", "invalid ", "not searched", "not drafted", "not kept", "not done")


def now_ms() -> float:
    """One process's clock for its marks: durations must survive the wall clock being set."""
    return time.monotonic() * 1000


def words(value, length: int) -> str:
    return " ".join(str(value or "").split())[:length]


def hits_in(name: str, output) -> int | None:
    """How many things a search found, read from its own answer; None when this isn't a search, or it failed."""
    if name not in SEARCH_TOOLS:
        return None
    text = str(output or "").strip()
    if text.lower().startswith(("error:", "permission denied:")):
        return None
    if name == "web_search":
        return len(_NUMBERED_RESULT.findall(text))
    if not text or text.lower().startswith("no matches"):
        return 0
    return sum(1 for line in text.splitlines() if line.strip())


def summary_of(name: str, args) -> str:
    """A tool call's one line, as Work's row shows it. Only ever a label: it can't cost a reply or a run."""
    from .ui import arg_summary
    try:
        return words(arg_summary(name, args if isinstance(args, dict) else {}), MAX_DETAIL)
    except Exception:                         # noqa: BLE001 -- a tool's odd arguments are that tool's to refuse
        return ""


def said_no(output) -> bool:
    """A tool's own answer says it didn't happen: an error, or a Pip's tool turning it down."""
    return str(output or "").lstrip().lower().startswith(REFUSALS)


def usage_tokens(usage) -> int | None:
    """One model request's reported tokens, in and out, as Work's trace counts them; None when it reported none."""
    if not isinstance(usage, dict):
        return None
    total = 0
    for key in ("input_tokens", "output_tokens"):
        value = usage.get(key)
        if type(value) is int and value > 0:
            total += value
    return total if 0 < total < MAX_TOKENS else None


class ReplyTrace:
    """The steps of one reply as they happen. Marks are given in order, in milliseconds of one clock."""

    def __init__(self, clock=now_ms):
        self._clock = clock
        self._origin = None
        self._rows: list[dict] = []
        self._open: dict[str, dict] = {}
        self._model = None                # (start, label) of the model request running now
        self._tokens = None               # what the running request reported, before it closed
        self._broken = False              # it outgrew its bound: a part of a trace is not its trace

    def _at(self, at) -> float:
        when = self._clock() if at is None else at
        if self._origin is None:
            self._origin = when
        return when

    def _add(self, row: dict) -> dict | None:
        if len(self._rows) >= MAX_STEPS:
            self._broken = True
            return None
        self._rows.append(row)
        return row

    def model_start(self, label: str = MODEL_LABEL, *, at=None) -> None:
        """A model request begins. One already running stays the same round: a retry is still that round."""
        when = self._at(at)
        if self._model is None:
            self._model = (when, label)

    def model_end(self, tokens=None, *, at=None, error: bool = False) -> None:
        """The running request answered. With nothing running, it has nothing to close."""
        if self._model is None:
            return
        when = self._at(at)
        start, label = self._model
        self._model = None
        row = self._add({"kind": "model", "label": words(label, MAX_LABEL), "start": start, "end": max(start, when)})
        if row is None:
            return
        tokens = self._tokens if tokens is None else tokens
        self._tokens = None
        if type(tokens) is int and 0 < tokens < MAX_TOKENS:
            row["tokens"] = tokens
        if error:
            row["error"] = True

    def model_tokens(self, tokens) -> None:
        """A model request's measured tokens, which can come just before or just after it closes."""
        if self._model is not None:
            self._tokens = tokens
            return
        row = next((row for row in reversed(self._rows) if row["kind"] == "model"), None)
        if row is not None and type(tokens) is int and 0 < tokens < MAX_TOKENS:
            row["tokens"] = tokens

    def tool_start(self, call_id, name, detail="", *, at=None, kind: str = "tool") -> str:
        """A tool (a search, a plugin, a card) begins, and with it the model's round has ended."""
        when = self._at(at)
        self.model_end(at=when)
        key = str(call_id or "") or f"{name}:{len(self._rows)}"
        if key in self._open:
            return key
        row = self._add({"kind": kind, "label": words(name, MAX_LABEL) or "tool", "start": when, "end": None})
        if row is not None:
            summary = words(detail, MAX_DETAIL)
            if summary:
                row["detail"] = summary
            self._open[key] = row
        return key

    def open_row(self, call_id) -> dict | None:
        """The tool still running under this id, for a caller that says what its row reads as it ends."""
        return self._open.get(str(call_id or ""))

    def tool_end(self, call_id, *, at=None, error: bool = False, denied: bool = False, detail=None, hits=None,
                 tokens=None) -> None:
        row = self._open.pop(str(call_id or ""), None)
        if row is None:
            return
        row["end"] = max(row["start"], self._at(at))
        if error:
            row["error"] = True
        if denied:
            row["denied"] = True
        if detail is not None:
            row["detail"] = words(detail, MAX_DETAIL)
        if type(hits) is int and hits >= 0 and not error and not denied:
            row["hits"] = hits
        if type(tokens) is int and 0 < tokens < MAX_TOKENS:
            row["tokens"] = tokens

    def saved(self) -> dict | None:
        """The trace to keep, or None: nothing was measured, a step never ended, or it outgrew its bound."""
        if self._broken or self._open or self._model is not None or not self._rows or self._origin is None:
            return None
        steps = []
        for row in self._rows:
            step = {k: v for k, v in row.items() if k not in ("start", "end") and v not in (None, "")}
            step["start"], step["end"] = round(row["start"] - self._origin), round(row["end"] - self._origin)
            steps.append(step)
        # A timeline needs a length, even when everything took under a millisecond.
        return validated({"v": VERSION, "ms": max(1, max(step["end"] for step in steps)), "steps": steps})


class MeasuredClient:
    """A model client whose requests are steps of a trace: the small calls around a reply (its search check, its
    summary of older turns, a widget's check) are model rounds too, with their own time and tokens."""

    def __init__(self, client, trace: ReplyTrace, label: str):
        self._client, self._trace, self._label = client, trace, label

    def chat(self, *args, **kwargs):
        self._trace.model_start(self._label)
        try:
            result = self._client.chat(*args, **kwargs)
        except BaseException:
            self._trace.model_end(error=True)
            raise
        self._trace.model_end(usage_tokens(getattr(result, "usage", None)))
        return result

    def __getattr__(self, name):
        return getattr(self._client, name)


def validated(value) -> dict | None:
    """A trace exactly as the module writes it, or None. Nothing past this is trusted to be whole or small."""
    try:
        if (not isinstance(value, dict) or value.get("v") != VERSION or type(value.get("ms")) is not int
                or not 0 < value["ms"] <= MAX_MS or not isinstance(value.get("steps"), list)
                or not 1 <= len(value["steps"]) <= MAX_STEPS):
            return None
        for step in value["steps"]:
            if (not isinstance(step, dict) or step.get("kind") not in ("model", "tool")
                    or not isinstance(step.get("label"), str) or not 0 < len(step["label"]) <= MAX_LABEL
                    or type(step.get("start")) is not int or type(step.get("end")) is not int
                    or not 0 <= step["start"] <= step["end"] <= value["ms"]):
                return None
            if "tokens" in step and (type(step["tokens"]) is not int or not 0 < step["tokens"] < MAX_TOKENS):
                return None
            if "hits" in step and (type(step["hits"]) is not int or step["hits"] < 0):
                return None
            if "detail" in step and (not isinstance(step["detail"], str) or len(step["detail"]) > MAX_DETAIL):
                return None
            if any(key in step and step[key] is not True for key in ("error", "denied")):
                return None
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_BYTES:
            return None
    except (TypeError, ValueError, RecursionError):
        return None
    return value


def joined(before, after) -> dict | None:
    """A reply carried on (Send it now, Continue): the part it had, then this part. The wait between them is the
    user's, not the reply's, so this part starts where the last one ended. Both durations stay as measured. A reply
    whose earlier part has no trace has no trace now: part of a reply isn't what it did."""
    if not validated(before) or not validated(after):
        return None
    shift = before["ms"]
    steps = before["steps"] + [{**step, "start": step["start"] + shift, "end": step["end"] + shift}
                               for step in after["steps"]]
    return validated({"v": VERSION, "ms": shift + after["ms"], "steps": steps})


def with_step(before, step: dict, took_ms) -> dict | None:
    """A reply's trace with one more measured step on its end: a card the user sent after it was written."""
    if not validated(before):
        return None
    took = max(0, round(took_ms))
    only = {**step, "start": 0, "end": took}
    # A step under a millisecond still takes its place on the timeline, and a joined trace needs a length.
    return joined(before, {"v": VERSION, "ms": max(1, took), "steps": [only]})


# ---- a Pip's run: its worker stamps what its Agent does, and its controller keeps the steps ----------------------

def worker_mark(**fields) -> dict:
    """The stamp on a worker's event: when it happened by the worker's one clock, kept off the event's own record."""
    return {"t": now_ms(), **fields}


class RunRecorder:
    """Builds a run's trace from its worker's events, by the worker's own stamps. An event with no stamp measures
    nothing, and its step leaves the run with no trace rather than a guess."""

    def __init__(self):
        self.trace = ReplyTrace()
        self._broken = False

    def feed(self, kind: str, event: dict, mark) -> None:
        try:
            if not isinstance(mark, dict) or type(mark.get("t")) not in (int, float):
                if kind in ("tool_call", "tool_result", "tool_denied", "model_start", "model_end", "step_start", "step_end"):
                    self._broken = True
                return
            at = float(mark["t"])
            if kind == "model_start":
                self.trace.model_start(at=at)
            elif kind == "model_end":
                self.trace.model_end(mark.get("tokens"), at=at)
            elif kind == "tool_call":
                self.trace.tool_start(event.get("call_id"), event.get("tool"), mark.get("summary"), at=at)
            elif kind == "step_start":
                self.trace.tool_start(mark.get("call_id"), mark.get("tool"), mark.get("summary"), at=at)
            elif kind in ("tool_result", "tool_denied"):
                self.trace.tool_end(mark.get("call_id", event.get("call_id")), at=at,
                                    error=kind == "tool_result" and event.get("status") == "failed",
                                    denied=kind == "tool_denied", hits=mark.get("hits"))
            elif kind == "step_end":
                self.trace.tool_end(mark.get("call_id"), at=at, error=mark.get("failed") is True, hits=mark.get("hits"))
        except (TypeError, ValueError):
            self._broken = True

    def saved(self) -> dict | None:
        try:
            return None if self._broken else self.trace.saved()
        except (TypeError, ValueError, OverflowError):
            return None
