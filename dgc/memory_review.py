"""Memory that learns: after a conversation, one bounded look back at what the user said.

The one memory DGC keeps (shared_memory.py) is written by the user's own words: a remember tool, ChatDGC's check
before a reply, Settings. Those catch what someone asks to keep or states outright in one message; they miss what
only shows over a conversation: a preference said in passing, a decision, how something turned out. So when a chat
goes quiet, or a turn ends after enough new words from the user, DGC asks the chat's own model once to look back
(``ask``), and keeps what passes the rules every memory passes (``keep``):

  * From the user's own words only: each fact must share most of its words, and every address, link and long
    number, with what the USER wrote in the turns reviewed -- never the model's replies, a page, a file, an email,
    a meeting or a tool's output (shared_memory.grounded).
  * Never a secret: one that looks like a key, a password or a card is refused (shared_memory.clean).
  * Not already kept, even in other words, and at most MAX_PER_REVIEW a review.
  * A kind (preference, fact, decision, outcome) and, when it ends on a known day, an expiry: after that day no
    prompt reads it.

Memory off means no review at all, and the user's words from while it was off are never reviewed later. A turn DGC
wrote (a Pip's report post, a wake-up, a hello, a "carry on") is never reviewed: only what the user typed. Every fact
it keeps shows once in the chat as a quiet line with Forget, and in Settings -> Memory's history with Undo.
"""
from __future__ import annotations

import re
import threading
from datetime import date

from . import shared_memory

MAX_PER_REVIEW = 3
MIN_TURN_CHARS = 280         # new words from the user that start a review as soon as a turn ends
MIN_IDLE_CHARS = 24          # at idle, anything longer than a pleasantry ("ok", "thanks")
IDLE_SECONDS = 120           # a chat this quiet is looked back over (config memory_review_idle_s)
MAX_TURNS = 12               # of the conversation, from its end
MAX_USER_CHARS = 1_500       # of one of the user's messages
MAX_REPLY_CHARS = 600        # of one reply: context for a decision, never a source of facts
MAX_KNOWN = 80
REVIEW_TIMEOUT = 90          # seconds the look back may take
FROM_USER = ("told", "asked", "agreed")
FROM = (*FROM_USER, "task", "question", "assistant")

PROMPT = (
    "You look back over a conversation between a user and their assistant in DGC and pick out what is worth "
    "remembering about the user in their later conversations. You have no tools; read only what is below. Today is "
    "{weekday}, {today}.\n\n"
    "Keep only these, and only from the lines marked User:\n"
    "- preference: how they like things done, said as lasting (\"I prefer\", \"always\", \"from now on\", \"I hate\"): "
    "units, language, tone, tools, how they pay, how they want answers. An instruction for one message (\"make it "
    "shorter\", \"answer in one line\") is not a preference.\n"
    "- fact: a lasting fact about them, stated for its own sake: their name, where they live, their job or company, "
    "the people in their life or work by name and role, their own health needs, diet or allergies, their goals.\n"
    "- decision: something they decided about their own work or life (\"we'll use Postgres\", \"I'm filing in "
    "March\"). Not what they are only considering, planning or asking about.\n"
    "- outcome: how something they did turned out, as they report it (\"the visa came through\").\n\n"
    "Never keep:\n"
    "- anything from the Assistant's lines, or from a file, a web page, an email, a meeting, a document or a tool's "
    "output, even when the user pasted it: only what the user says about themselves.\n"
    "- the details of a task they ask for: the people, pets, places, dates and events in something they ask you to "
    "write, reply to, translate or plan, even when it's their own family (\"write a toast for my brother Rahul, a "
    "chef\" keeps nothing), or the background of a question (\"my son is 14, which language should he learn?\" "
    "keeps nothing).\n"
    "- passwords, PINs, codes, keys, card, account or ID numbers.\n"
    "- anything already remembered (listed below), even in other words.\n\n"
    "For each item say where it comes from: \"told\" (they state it about themselves), \"asked\" (they ask to have it "
    "remembered), \"agreed\" (in their own words they agree to a decision), \"task\" (a detail of something they ask "
    "you to do), \"question\" (the background of a question), or \"assistant\" (only the assistant said it). Only "
    "told, asked and agreed are kept, so label honestly.\n"
    "Write each as one short sentence about the user as \"they\" (never guess a gender), in words close to theirs, "
    "with names, numbers and dates exactly as they wrote them (\"next Tuesday\", \"from next week\"). Never add "
    "a date, a reason or a remark of your own to the sentence.\n"
    "A fact that stops being true on a known day (a trip next week, an appointment on Friday, a deadline) gets that "
    "day as until, YYYY-MM-DD, worked out from today: in until only, never in the sentence. A lasting fact, a "
    "birthday or an anniversary gets none.\n"
    "At most three items, the most useful first. Usually there is nothing new: then give no items.")
SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "description": "What to remember, or none.",
                                                     "items": {"type": "object", "properties": {
                                                         "fact": {"type": "string"},
                                                         "kind": {"type": "string", "enum": list(shared_memory.KINDS)},
                                                         "from": {"type": "string", "enum": list(FROM)},
                                                         "until": {"type": "string",
                                                                   "description": "YYYY-MM-DD, or empty"}},
                                                         "required": ["fact", "kind", "from"]}}},
          "required": ["items"]}
_WORD = re.compile(r"[a-z0-9À-￿]+")
_TRIVIAL = re.compile(r"^\W*(?:ok(?:ay)?|thanks?|thank you|ty|great|cool|nice|yes|no|sure|hi|hello|hey|bye)\W*$", re.I)


def worth(said: str) -> bool:
    """Whether what the user said could hold anything to keep: not a bare "ok" or "thanks"."""
    text = " ".join(str(said or "").split())
    return len(text.encode("utf-8")) >= MIN_IDLE_CHARS and not _TRIVIAL.match(text)


def transcript(turns: list[dict]) -> str:
    """The turns as the model reads them: who wrote each line, the user's in full (bounded), the replies cut short."""
    lines = []
    for turn in turns[-MAX_TURNS:]:
        user = " ".join(str(turn.get("user") or "").split())[:MAX_USER_CHARS]
        reply = " ".join(str(turn.get("assistant") or "").split())[:MAX_REPLY_CHARS]
        if user:
            lines.append("User: " + user)
        if reply:
            lines.append("Assistant: " + reply)
    return "\n".join(lines)


# What a user pastes into their own message (an email in quotes, a code block, a quoted reply) is someone else's
# words: it can't back a fact either, though the model still reads it for context.
_PASTED = re.compile(r"```.*?```|\"[^\"\n]{30,}\"|“[^”]{30,}”|^\s*>.*$", re.S | re.M)


def own_words(text: str) -> str:
    return _PASTED.sub(" ", str(text or ""))


def said_in(turns: list[dict]) -> str:
    """Only the user's own words, which alone can back a fact: never what they pasted in quotes or a code block."""
    return "\n".join(own_words(t.get("user")) for t in turns[-MAX_TURNS:] if str(t.get("user") or "").strip())


def ask(client, turns: list[dict], known: list[dict], *, on: str | None = None, cancel=None) -> list[dict]:
    """The model's candidates, each {fact, kind, until?}, those it says come from the user only (at most a few).
    Raises whatever the call raises: the caller keeps nothing then."""
    from .chatdgc import research
    when = date.fromisoformat(on) if on else date.today()
    system = PROMPT.format(weekday=when.strftime("%A"), today=when.isoformat())
    asked = "The conversation, oldest first:\n<<<\n" + transcript(turns) + "\n>>>"
    if known:
        asked += "\n\nRemembered about the user now:\n" + "\n".join(
            "- " + str(f.get("text") or "") for f in list(known)[-MAX_KNOWN:])
    decided = research.structured(client, system, asked, "remember", SCHEMA, cancel=cancel)
    return [c for c in parse(decided, on=when.isoformat()) if not _task_detail(c, turns)]


def _task_detail(candidate: dict, turns: list[dict]) -> bool:
    """A fact only a request to write or do something says ("write a toast for my brother, a chef") is that task's
    material, not something to keep, unless they asked to have it remembered: ChatDGC's check before a reply keeps
    the same rule (measured there: 21 of 38 runs kept a task's details without it)."""
    if candidate.get("kind") != "fact" or candidate.get("from") == "asked":
        return False
    from .chatdgc.engine import WRITE_OR_DO
    backing = [t for t in turns[-MAX_TURNS:] if shared_memory.grounded(candidate["fact"], str(t.get("user") or ""))]
    return bool(backing) and all(WRITE_OR_DO.search(str(t.get("user") or "")) for t in backing)


def parse(decided, *, on: str | None = None) -> list[dict]:
    items = decided.get("items") if isinstance(decided, dict) else None
    out: list[dict] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or item.get("from") not in FROM_USER:
            continue
        text = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s+", "", " ".join(str(item.get("fact") or "").split())).strip()
        if not text:
            continue
        kind = item.get("kind") if item.get("kind") in shared_memory.KINDS else "fact"
        raw_until = str(item.get("until") or "").strip()
        until = shared_memory.until_date(raw_until, on=on)
        if raw_until and re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_until) and until is None and raw_until < (on or ""):
            continue                                   # already over: nothing to keep
        candidate = {"fact": text[:shared_memory.MAX_FACT_CHARS], "kind": kind, "from": item["from"]}
        if until:
            candidate["until"] = until
        out.append(candidate)
        if len(out) >= MAX_PER_REVIEW * 2:
            break
    return out


def _stem(word: str) -> str:
    for suffix, keep in (("ies", "y"), ("ing", ""), ("es", ""), ("ed", ""), ("s", "")):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: len(word) - len(suffix)] + keep
    return word


def _words(text: str) -> set[str]:
    from .pip_notes import COMMON
    return {_stem(w) for w in _WORD.findall(str(text or "").lower()) if len(w) > 2 and w not in COMMON}


def similar(a: str, b: str) -> bool:
    """The same fact in other words, near enough: the shorter's words are nearly all in the longer, which adds at
    most one of its own ("Uses UPI to pay bills" is "Pays bills with UPI"; "Lives in Pune with two kids" isn't
    "Lives in Pune")."""
    left, right = _words(a), _words(b)
    if not left or not right:
        return False
    small, large = (left, right) if len(left) <= len(right) else (right, left)
    return len(small & large) / len(small) >= 0.8 and len(large - small) <= 1


def keep(memory, candidates: list[dict], *, said: str, surface: str, where: str = "", pip: str = "",
         run: str = "") -> list[dict]:
    """Save what passes every rule (from the user's words, no secret, not known yet), at most MAX_PER_REVIEW."""
    kept: list[dict] = []
    try:
        known = memory.facts()
    except shared_memory.NotRemembered:
        return []
    for candidate in candidates:
        if len(kept) >= MAX_PER_REVIEW:
            break
        text = str(candidate.get("fact") or "")
        if any(similar(text, f.get("text") or "") for f in known + kept):
            continue
        before = {f["id"] for f in known}
        try:
            fact = memory.remember(text, said=said, surface=surface, where=where, pip=pip, run=run,
                                   kind=candidate.get("kind"), until=candidate.get("until"), by="review")
        except shared_memory.NotRemembered:
            continue
        if fact["id"] not in before:
            kept.append(fact)
    return kept


def shown(facts: list[dict]) -> list[dict]:
    """The saved facts as a chat line shows them."""
    return [{"id": f["id"], "text": f["text"], **({"kind": f["kind"]} if f.get("kind") else {}),
             **({"until": f["until"]} if f.get("until") else {})} for f in facts]


def client_for(config, *, model: str | None = None, base_url: str | None = None, api_key: str | None = None,
               api_mode: str | None = None, source: str = "memory"):
    """A client for the look back: the conversation's own model on its connection, bounded, its usage counted."""
    from . import usage_ledger
    from .llm import LLMClient, normalize_usage, usage_reported
    client = LLMClient(base_url or config.base_url, config.api_key if api_key is None else api_key,
                       model or config.model, read_timeout=REVIEW_TIMEOUT, max_tokens=2048,
                       think_budget_tokens=config.get("think_budget_tokens", "auto"),
                       ollama_keep_alive=str(config.get("ollama_keep_alive", "30m")),
                       api_mode=str(api_mode or config.get("api_mode", "auto")),
                       provider_capabilities=config.get("provider_capabilities", {}),
                       capability_cache_ttl_s=int(config.get("capability_cache_ttl_s", 300)),
                       context_size=int(config.get("context_size", 0) or 0))

    def ledger(finished, result):
        try:
            raw = getattr(result, "usage", None)
            usage = normalize_usage(raw)
            transport = str(getattr(finished, "api_mode", "") or "")
            provider = ({"ollama": "ollama", "anthropic": "anthropic"}.get(transport)
                        or getattr(finished, "family", "") or "unknown")
            usage_ledger.record(provider=provider, base_url=getattr(finished, "base_url", ""),
                                model=getattr(finished, "model", ""), source=source,
                                input_tokens=usage["input_tokens"], output_tokens=usage["output_tokens"],
                                cached_input_tokens=usage["cached_input_tokens"], metered=usage_reported(raw))
        except Exception:                          # noqa: BLE001 -- the ledger never breaks a review
            pass
    client.usage_source = source
    client.usage_sink = ledger
    return client


def idle_seconds(config) -> float:
    try:
        value = float(config.get("memory_review_idle_s", IDLE_SECONDS))
    except (TypeError, ValueError):
        value = IDLE_SECONDS
    return max(0.0, min(value, 24 * 3600.0))


class Reviews:
    """When to look back, per conversation: as soon as a turn ends with enough new words from the user, or once the
    conversation has been quiet for a while with anything worth a look. One review at a time per conversation;
    a turn that starts cancels its wait. ``pending(key)`` says how much the user wrote since the last review;
    ``review(key)`` does it (on a thread of its own)."""

    def __init__(self, pending, review, *, idle: float = IDLE_SECONDS, min_turn: int = MIN_TURN_CHARS,
                 min_idle: int = MIN_IDLE_CHARS):
        self._pending, self._review = pending, review
        self.idle, self.min_turn, self.min_idle = idle, min_turn, min_idle
        self._lock = threading.Lock()
        self._timers: dict[str, threading.Timer] = {}
        self._running: dict[str, threading.Thread] = {}
        self._closed = False

    def started(self, key: str) -> None:
        with self._lock:
            timer = self._timers.pop(key, None)
        if timer is not None:
            timer.cancel()

    def ended(self, key: str) -> None:
        try:
            waiting = int(self._pending(key) or 0)
        except Exception:                          # noqa: BLE001 -- a review is a nicety; the chat goes on
            return
        if waiting >= self.min_turn:
            self.now(key)
        elif waiting >= self.min_idle and self.idle > 0:
            self._arm(key)

    def _arm(self, key: str) -> None:
        with self._lock:
            if self._closed:
                return
            old = self._timers.pop(key, None)
            timer = threading.Timer(self.idle, self._quiet, args=(key,))
            timer.daemon = True
            self._timers[key] = timer
        if old is not None:
            old.cancel()
        timer.start()

    def _quiet(self, key: str) -> None:
        with self._lock:
            self._timers.pop(key, None)
        try:
            if int(self._pending(key) or 0) >= self.min_idle:
                self.now(key)
        except Exception:                          # noqa: BLE001
            return

    def now(self, key: str) -> threading.Thread | None:
        with self._lock:
            if self._closed or (key in self._running and self._running[key].is_alive()):
                return None
            thread = threading.Thread(target=self._run, args=(key,), daemon=True,
                                      name=f"dgc-memory-review-{str(key)[:24]}")
            self._running[key] = thread
        thread.start()
        return thread

    def _run(self, key: str) -> None:
        try:
            self._review(key)
        except Exception:                          # noqa: BLE001 -- never past the chat
            pass
        finally:
            with self._lock:
                if self._running.get(key) is threading.current_thread():
                    del self._running[key]

    def busy(self) -> bool:
        with self._lock:
            return any(t.is_alive() for t in self._running.values())

    def wait(self, timeout: float = 5.0) -> None:
        """Until the reviews running now are done (tests, and closing)."""
        with self._lock:
            running = list(self._running.values())
        for thread in running:
            thread.join(timeout)

    def close(self, timeout: float = 2.0) -> None:
        with self._lock:
            self._closed = True
            timers, self._timers = list(self._timers.values()), {}
        for timer in timers:
            timer.cancel()
        self.wait(timeout)
