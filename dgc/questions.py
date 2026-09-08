"""Bounded, explicit user decisions shared by the native clients."""
from __future__ import annotations

MAX_QUESTIONS = 6
MAX_ANSWER = 4096


def normalize_questions(args: dict) -> list[dict]:
    """Accept the original single question or a grouped questionnaire; never invent an answer."""
    grouped = "questions" in args
    raw = args.get("questions") if grouped else [args]
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_QUESTIONS:
        raise ValueError("provide 1–6 questions")
    result, ids = [], set()
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError("each question must be an object")
        ident = item.get("id", f"q{i + 1}")
        question = item.get("question")
        header = item.get("header", f"Question {i + 1}")
        options = item.get("options", [])
        if (not isinstance(ident, str) or not ident.strip() or len(ident) > 64 or ident in ids
                or not isinstance(question, str) or not question.strip() or len(question) > 2000
                or not isinstance(header, str) or not header.strip() or len(header) > 32):
            raise ValueError("questions need unique short IDs, a question (1–2000 characters) and a short header")
        if (not isinstance(options, list) or len(options) > 8
                or any(not isinstance(o, str) or not o.strip() or len(o) > 2000 for o in options)):
            raise ValueError("provide up to 8 non-empty text options per question")
        ids.add(ident)
        result.append({"id": ident, "header": header, "question": question, "options": options})
    return result


def valid_answers(questions: list[dict], answers) -> bool:
    return (isinstance(answers, dict) and set(answers) == {q["id"] for q in questions}
            and all(isinstance(v, str) and bool(v.strip()) and len(v) <= MAX_ANSWER
                    for v in answers.values()))
