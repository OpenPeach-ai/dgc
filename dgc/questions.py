"""Bounded, explicit user decisions shared by every frontend (editor, TUI, classic CLI, ACP).

One shape on the wire and in the transcript: a question is ``{id, header, question, multi_select,
options: [{label, description, recommended}]}``. Models write options as objects or plain strings and
mark the option they recommend by ending its label with "(Recommended)"; `normalize_questions` turns
that into data and never reorders. An answer is ``{question_id: {"selected": [0-based index...],
"other": str}}``: a question with no selection and no text was skipped. Nothing is recorded as the
user's choice unless they made it.
"""
from __future__ import annotations

import json
import re
import unicodedata

MAX_QUESTIONS = 4
MIN_OPTIONS = 2
MAX_OPTIONS = 6
MAX_QUESTION = 2000
MAX_LABEL = 120
MAX_LEGACY_OPTION = 2000
MAX_DESCRIPTION = 400
MAX_HEADER_CELLS = 24
MAX_ANSWER = 4096
MAX_QUESTION_IN_RESULT = 200

OUTCOMES = ("answered", "dismissed", "cancelled", "unavailable")

ERR_QUESTIONS = "ask 1-4 questions in one call."
ERR_FEW = "give at least 2 options. If only one path makes sense, take it and say so."
ERR_MANY = "give at most 6 options; 2-4 is best."
ERR_DUPLICATE = "option labels must differ within a question."
ERR_RECOMMENDED = "recommend at most one option in a single-choice question."
ERR_LENGTH = "keep labels short (a few words) and descriptions to one sentence."
ERR_SHAPE = "each question needs question text and a list of options."

DISMISSED_RESULT = ("The user closed this question without answering. Do not choose for them or act "
                    "on it; wait for their next message.")
CANCELLED_RESULT = "No decision was submitted. Do not assume a choice or act on unanswered questions."
UNAVAILABLE_RESULT = ("error: nobody can answer questions here. If a wrong guess is cheap to undo, "
                      "decide, and state the assumption in your reply; otherwise stop and report the "
                      "question.")
OWN_WORDS = ("Their written answers are their own words: follow what they say, even if it changes "
             "the task.")
CONTINUE = "Continue with these decisions."

_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_SUFFIX = re.compile(r"\s*\(\s*recommended\s*\)\s*$", re.IGNORECASE)
# A model-added free-text row: the client always offers one, so a second would be a duplicate.
_OTHER = re.compile(r"^(?:other|something else)\s*[.…:!?]*\s*(?:\([^)]*\))?\s*[.…:!?]*$", re.IGNORECASE)


def cells(text: str) -> int:
    """Terminal cells ``text`` occupies (wide East Asian characters take two, combining marks none)."""
    width = 0
    for ch in text:
        if unicodedata.combining(ch):
            continue
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def cut_cells(text: str, limit: int) -> str:
    """``text`` cut to at most ``limit`` cells, ending in "…" when anything was dropped."""
    if cells(text) <= limit:
        return text
    out, width = [], 0
    for ch in text:
        step = 0 if unicodedata.combining(ch) else (2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1)
        if width + step > limit - 1:
            break
        out.append(ch)
        width += step
    return "".join(out).rstrip() + "…"


def one_line(text: str) -> str:
    return " ".join(str(text or "").split())


def _header_from(question: str) -> str:
    """A short tab label for a question the model gave no header: its first words, cut to fit."""
    text = one_line(question).rstrip("?.:! ")
    if cells(text) <= MAX_HEADER_CELLS:
        return text
    words, kept = text.split(" "), ""
    for word in words:
        candidate = f"{kept} {word}".strip()
        if cells(candidate) > MAX_HEADER_CELLS - 1:
            break
        kept = candidate
    return (kept + "…") if kept else cut_cells(text, MAX_HEADER_CELLS)


def _option(raw) -> dict | None:
    """One normalised option, or None for a model-added Other row. Raises on a hard-rule breach."""
    if isinstance(raw, str):
        label, description, flagged = raw, "", False
        if len(label) > MAX_LEGACY_OPTION:
            raise ValueError(ERR_LENGTH)
    elif isinstance(raw, dict):
        label = raw.get("label")
        if not isinstance(label, str):
            raise ValueError("give every option a label.")
        description = raw.get("description")
        description = description.strip() if isinstance(description, str) else ""
        flagged = bool(raw.get("recommended", False))
        if len(label) > MAX_LABEL or len(description) > MAX_DESCRIPTION:
            raise ValueError(ERR_LENGTH)
    else:
        raise ValueError("give every option a label.")
    label = label.strip()
    if _OTHER.match(label):
        return None
    if _SUFFIX.search(label):
        label, flagged = _SUFFIX.sub("", label).strip(), True
    if not label:
        raise ValueError("give every option a label.")
    return {"label": label, "description": description, "recommended": flagged}


def normalize_questions(args) -> list[dict]:
    """The v14 question list from any shape a model sends; ValueError says how to fix a bad call.

    Accepted: ``{questions: [{header?, question, multi_select?, options: [{label, description?,
    recommended?}]}]}``, the 0.39 grouped shape (``id``, ``header``, string options) and the 0.39
    single shape (``question`` + ``options: [str]``). Error messages carry no "error: " prefix.
    """
    if not isinstance(args, dict):
        raise ValueError(ERR_SHAPE)
    raw = args.get("questions") if "questions" in args else [args]
    if isinstance(raw, str):                  # some models send the array JSON-encoded
        try:
            raw = json.loads(raw)
        except ValueError:
            raise ValueError(ERR_SHAPE) from None
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_QUESTIONS:
        raise ValueError(ERR_QUESTIONS)
    result = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("options"), list):
            raise ValueError(ERR_SHAPE)
        question = item.get("question")
        if not isinstance(question, str) or not question.strip() or len(question) > MAX_QUESTION:
            raise ValueError(ERR_LENGTH if isinstance(question, str) and question.strip() else ERR_SHAPE)
        question = question.strip()
        options = [o for o in (_option(raw_option) for raw_option in item["options"]) if o is not None]
        if len(options) < MIN_OPTIONS:
            raise ValueError(ERR_FEW)
        if len(options) > MAX_OPTIONS:
            raise ValueError(ERR_MANY)
        if len({o["label"].casefold() for o in options}) != len(options):
            raise ValueError(ERR_DUPLICATE)
        multi = item.get("multi_select", item.get("multiSelect", False))
        multi = bool(multi) if not isinstance(multi, str) else multi.strip().lower() in ("true", "1", "yes")
        if not multi and sum(o["recommended"] for o in options) > 1:
            raise ValueError(ERR_RECOMMENDED)
        header = item.get("header")
        header = one_line(header) if isinstance(header, str) else ""
        header = cut_cells(header, MAX_HEADER_CELLS) if header else _header_from(question)
        result.append({"id": item.get("id"), "header": header, "question": question,
                       "multi_select": multi, "options": options})
    # Ids: a model id is kept when it is well formed and unique; the rest get q1..qn by position.
    kept = [q["id"] if isinstance(q["id"], str) and _ID.fullmatch(q["id"]) else None for q in result]
    counts = {ident: kept.count(ident) for ident in kept if ident}
    kept = [ident if ident and counts[ident] == 1 else None for ident in kept]
    taken = {ident for ident in kept if ident}
    for index, q in enumerate(result):
        ident = kept[index]
        if ident is None:
            n = index + 1
            while f"q{n}" in taken:
                n += 1
            ident = f"q{n}"
            taken.add(ident)
        q["id"] = ident
    return result


def validate_response(questions: list[dict], payload) -> dict | None:
    """The decision a client response states, or None when it is invalid (the request stays open).

    ``payload`` is ``{"answers": ..., "dismissed": ...}``. Exactly one of a non-empty ``answers``
    object or ``dismissed: true``. Every answer key must name a question; ``selected`` holds unique
    in-range indices (at most one for a single choice, which also excludes free text); ``other`` is
    at most 4096 characters. A question with no key, or an empty selection and no text, is skipped.
    """
    if not isinstance(payload, dict):
        return None
    answers, dismissed = payload.get("answers"), payload.get("dismissed")
    has_answers = isinstance(answers, dict) and bool(answers)
    if dismissed is True:
        if has_answers:
            return None
        return {"outcome": "dismissed", "answers": {}}
    if dismissed not in (None, False) or not has_answers:
        return None
    by_id = {q["id"]: q for q in questions}
    if any(key not in by_id for key in answers):
        return None
    settled = {}
    for q in questions:
        entry = answers.get(q["id"], {})
        if not isinstance(entry, dict):
            return None
        selected = entry.get("selected", [])
        other = entry.get("other", "")
        if not isinstance(selected, list) or not isinstance(other, str) or len(other) > MAX_ANSWER:
            return None
        if any(type(i) is not int or not 0 <= i < len(q["options"]) for i in selected):
            return None
        if len(set(selected)) != len(selected):
            return None
        other = other.strip()
        if not q.get("multi_select") and (len(selected) > 1 or (selected and other)):
            return None
        settled[q["id"]] = {"selected": sorted(selected) if q.get("multi_select") else list(selected),
                            "other": other}
    return {"outcome": "answered", "answers": settled}


def settle(questions: list[dict], value) -> dict:
    """A frontend's return value as a decision; anything unrecognised counts as cancelled."""
    if isinstance(value, dict):
        outcome = value.get("outcome")
        if outcome == "answered":
            return validate_response(questions, {"answers": value.get("answers")}) or {
                "outcome": "cancelled", "answers": {}}
        if outcome in OUTCOMES:
            return {"outcome": outcome, "answers": {}}
    return {"outcome": "cancelled", "answers": {}}


def _quoted(labels: list[str]) -> str:
    return ", ".join(json.dumps(label, ensure_ascii=False) for label in labels)


def _question_line(text: str) -> str:
    line = one_line(text)
    if len(line) > MAX_QUESTION_IN_RESULT:
        line = line[:MAX_QUESTION_IN_RESULT - 1].rstrip() + "…"
    return line


def format_result(questions: list[dict], decision: dict) -> str:
    """What the model reads back: one plain line per question, values JSON-quoted."""
    outcome = decision.get("outcome") if isinstance(decision, dict) else None
    if outcome == "dismissed":
        return DISMISSED_RESULT
    if outcome == "unavailable":
        return UNAVAILABLE_RESULT
    if outcome != "answered":
        return CANCELLED_RESULT
    answers = decision.get("answers") or {}
    count = len(questions)
    lines = ["The user answered your question:" if count == 1 else f"The user answered your {count} questions:"]
    wrote_any = False
    for q in questions:
        entry = answers.get(q["id"]) or {}
        selected = [i for i in entry.get("selected", []) if 0 <= i < len(q["options"])]
        other = str(entry.get("other", "") or "").strip()
        labels = [q["options"][i]["label"] for i in selected]
        recommended = [o["label"] for o in q["options"] if o["recommended"]]
        head = f"- {_question_line(q['question'])} "
        if not selected and not other:
            lines.append(head + (f"skipped: go with your recommendation {_quoted(recommended)} and say so"
                                 if recommended else "skipped: decide this yourself and state the assumption"))
            continue
        parts = []
        if selected:
            note = ""
            if q.get("multi_select"):
                if recommended and set(labels) != set(recommended):
                    note = f" (you recommended {_quoted(recommended)})"
            elif recommended:
                note = (" (your recommendation)" if labels[0] in recommended
                        else f" (you recommended {_quoted(recommended)})")
            parts.append(f"chose {_quoted(labels)}{note}")
        if other:
            wrote_any = True
            parts.append("wrote: " + json.dumps(other, ensure_ascii=False))
        lines.append(head + " and ".join(parts))
    lines.append(OWN_WORDS if wrote_any else CONTINUE)
    return "\n".join(lines)


def decision_record(call_id, questions: list[dict], decision: dict) -> dict:
    """The private ``_dgc_decision`` sidecar: the same fields ``options_resolved`` carries."""
    outcome = decision.get("outcome") if isinstance(decision, dict) else "cancelled"
    return {"call_id": call_id if isinstance(call_id, str) and call_id else None,
            "outcome": outcome if outcome in OUTCOMES else "cancelled",
            "questions": questions,
            "answers": dict(decision.get("answers") or {}) if outcome == "answered" else {}}


def asked_summary(questions: list[dict], answers: dict | None, outcome: str) -> list[str]:
    """Transcript lines for a settled question batch (TUI and classic CLI): a head, then Q → A."""
    count = len(questions)
    lines = [f"Asked {count} question{'s' if count != 1 else ''}"]
    for q in questions:
        if outcome != "answered":
            continue
        entry = (answers or {}).get(q["id"]) or {}
        picks = [q["options"][i] for i in entry.get("selected", []) if 0 <= i < len(q["options"])]
        text = ", ".join(o["label"] + (" (recommended)" if o["recommended"] else "") for o in picks)
        other = str(entry.get("other", "") or "").strip()
        if other:
            text = (text + " · " if text else "") + json.dumps(one_line(other)[:200], ensure_ascii=False)
        lines.append(f"{q['header']} → {text or 'skipped'}")
    if outcome == "dismissed":
        lines.append("Dismissed without an answer")
    elif outcome in ("cancelled", "unavailable"):
        lines.append("Not answered")
    return lines


def args_summary(args) -> str:
    """``2 questions · Storage, Extras`` for a propose_options call, from whatever the model sent."""
    try:
        questions = normalize_questions(args)
    except (ValueError, TypeError, KeyError):
        raw = args.get("questions") if isinstance(args, dict) else None
        count = len(raw) if isinstance(raw, list) else 1
        return f"{count} question{'s' if count != 1 else ''}"
    count = len(questions)
    return f"{count} question{'s' if count != 1 else ''} · " + ", ".join(q["header"] for q in questions)
