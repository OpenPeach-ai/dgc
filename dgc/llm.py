"""OpenAI-compatible LLM client with streaming, <think> tag handling,
native tool calling, and a text-protocol fallback for models without
tool support (common with small local models)."""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

import requests


class LLMError(Exception):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict


@dataclass
class ChatResult:
    content: str = ""
    thinking: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"


class _ThinkFilter:
    """Incrementally split a token stream into ('text'|'think', chunk) events, tolerating
    tags split across chunks. Recognises several reasoning-marker pairs, because local
    models disagree: <think>, <thinking>, <reasoning>, and Kimi-style ◁think▷."""

    PAIRS = [("<think>", "</think>"), ("<thinking>", "</thinking>"),
             ("<reasoning>", "</reasoning>"), ("◁think▷", "◁/think▷")]

    def __init__(self):
        self.buf = ""
        self.in_think = False
        self._close = None                # the close tag we're waiting for while in_think

    @staticmethod
    def _hold(buf: str, tag: str) -> int:
        """Length of buf's tail that is a proper prefix of `tag`."""
        for k in range(min(len(buf), len(tag) - 1), 0, -1):
            if tag.startswith(buf[-k:]):
                return k
        return 0

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        self.buf += chunk
        events: list[tuple[str, str]] = []
        while self.buf:
            if self.in_think:
                i = self.buf.find(self._close)
                if i != -1:
                    if i:
                        events.append(("think", self.buf[:i]))
                    self.buf = self.buf[i + len(self._close):]
                    self.in_think, self._close = False, None
                    continue
                hold = self._hold(self.buf, self._close)
            else:
                # earliest open marker among all known pairs
                best_i, best = None, None
                for op, cl in self.PAIRS:
                    j = self.buf.find(op)
                    if j != -1 and (best_i is None or j < best_i):
                        best_i, best = j, (op, cl)
                if best_i is not None:
                    if best_i:
                        events.append(("text", self.buf[:best_i]))
                    op, cl = best
                    self.buf = self.buf[best_i + len(op):]
                    self.in_think, self._close = True, cl
                    continue
                hold = max((self._hold(self.buf, op) for op, _ in self.PAIRS), default=0)
            emit = self.buf[:len(self.buf) - hold] if hold else self.buf
            self.buf = self.buf[len(emit):]
            if emit:
                events.append(("think" if self.in_think else "text", emit))
            break
        return events

    def flush(self) -> list[tuple[str, str]]:
        if not self.buf:
            return []
        ev = [("think" if self.in_think else "text", self.buf)]
        self.buf = ""
        return ev


def _loads_lenient(s):
    """Parse JSON a local model probably meant: tolerate trailing commas, single quotes,
    unquoted keys, and Python literals (True/False/None). Returns a dict or None."""
    if not isinstance(s, str):
        return s if isinstance(s, dict) else None
    s = s.strip()
    if not s:
        return {}
    for candidate in (s, re.sub(r",\s*([}\]])", r"\1", s)):     # drop trailing commas
        try:
            v = json.loads(candidate)
            return v if isinstance(v, dict) else None
        except json.JSONDecodeError:
            pass
    try:
        import ast
        v = ast.literal_eval(s)                                  # single quotes / True/False/None
        return v if isinstance(v, dict) else None
    except (ValueError, SyntaxError):
        return None


# Fenced ```tool_call / ```tool_code / ```json blocks, and two XML shapes local models emit.
_FENCE = re.compile(r"```+[ \t]*(tool_call|tool_code|json)?[ \t]*\n(.*?)\n?```+", re.S)
_XML_TOOLCALL = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.S)
_XML_FUNCTION = re.compile(r"<function\s*=\s*([\w.\-]+)\s*>(.*?)</function>", re.S)


def parse_text_tool_calls(content: str) -> tuple[str, list[ToolCall]]:
    """Recover tool calls a model emitted as TEXT instead of native calls — fenced blocks
    (```tool_call / ```json) and XML (<tool_call>{…}</tool_call>, <function=name>{…}</function>)
    — parsing the arguments leniently. Returns (content-with-blocks-removed, calls)."""
    calls: list[ToolCall] = []

    def _add(name, args) -> None:
        parsed = _loads_lenient(args) if isinstance(args, str) else args
        calls.append(ToolCall(id=f"textcall_{len(calls)}", name=str(name),
                              arguments=parsed if isinstance(parsed, dict) else {}))

    def _obj_sub(m: re.Match) -> str:
        payload = _loads_lenient(m.group(1))
        if not isinstance(payload, dict) or not payload.get("name"):
            return m.group(0)
        _add(payload["name"], payload.get("arguments", {}))
        return ""

    def _fence_sub(m: re.Match) -> str:
        lang, payload = m.group(1), _loads_lenient(m.group(2))
        if not isinstance(payload, dict) or not payload.get("name"):
            return m.group(0)
        # a bare ```json block must clearly be a call (has "arguments") to avoid eating examples
        if lang not in ("tool_call", "tool_code") and "arguments" not in payload:
            return m.group(0)
        _add(payload["name"], payload.get("arguments", {}))
        return ""

    def _fn_sub(m: re.Match) -> str:
        body = m.group(2).strip()
        _add(m.group(1), _loads_lenient(body) if body else {})
        return ""

    clean = _XML_TOOLCALL.sub(_obj_sub, content)
    clean = _XML_FUNCTION.sub(_fn_sub, clean)
    clean = _FENCE.sub(_fence_sub, clean)
    if not calls:                                   # last-ditch: whole message is a bare call object
        stripped = clean.strip()
        payload = _loads_lenient(stripped) if stripped.startswith("{") else None
        if isinstance(payload, dict) and payload.get("name") and "arguments" in payload:
            _add(payload["name"], payload["arguments"])
            clean = ""
    return clean.strip(), calls


def _repair_for_retry(messages: list[dict]) -> list[dict]:
    """Collapse native tool-calling structure into plain user/assistant text.

    Some endpoints ship brittle chat templates — e.g. an Ollama model imported with a
    passthrough template intermittently 500s "no user query found in messages" once a turn
    becomes a chain of assistant(tool_calls) + tool results with no fresh user turn. Folding
    the tool results into a `user` message guarantees a "user query" exists, so ANY template
    can render it. This is DGC-level and endpoint-agnostic (it protects every user's models,
    not just one box's). Used only on a retry after a transient failure; it never mutates the
    caller's list or the stored conversation."""
    out: list[dict] = []
    for m in messages:
        role = m.get("role")
        if role == "tool":
            name = m.get("name") or "tool"
            out.append({"role": "user", "content": f"[result of {name}]\n{m.get('content', '')}"})
        elif role == "assistant" and m.get("tool_calls"):
            names = ", ".join((tc.get("function") or {}).get("name", "tool") for tc in m["tool_calls"])
            text = (m.get("content") or "").strip()
            note = f"(calling {names})" if names else ""
            out.append({"role": "assistant", "content": (f"{text}\n{note}".strip() or "(working)")})
        else:
            out.append({k: v for k, v in m.items() if k != "tool_calls"})
    # merge adjacent same-role turns — a run of user/user/user also trips some templates
    merged: list[dict] = []
    for m in out:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] = f"{merged[-1].get('content', '')}\n\n{m.get('content', '')}".strip()
        else:
            merged.append(dict(m))
    return merged


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str, read_timeout: int = 1800):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.read_timeout = read_timeout  # seconds to wait BETWEEN streamed chunks (slow-prefill guard)
        self.tools_supported = True      # flips off on first 400 about tools
        self.reasoning_supported = True  # flips off if server rejects the param

    @property
    def _url(self) -> str:
        return f"{self.base_url}/chat/completions"

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def list_models(self) -> list[str]:
        r = requests.get(f"{self.base_url}/models", headers=self._headers(), timeout=10)
        r.raise_for_status()
        return sorted(m.get("id", "?") for m in r.json().get("data", []))

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        reasoning_effort: str | None = None,
        on_text=None,
        on_thinking=None,
        cancel=None,
    ) -> ChatResult:
        payload: dict = {"model": self.model, "messages": messages, "stream": True}
        if tools and self.tools_supported:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if reasoning_effort and reasoning_effort != "off" and self.reasoning_supported:
            payload["reasoning_effort"] = reasoning_effort

        last_err = ""
        transient = 0      # count of retried timeouts / 5xx (bounded, with backoff)
        repaired = False   # whether we've swapped in the endpoint-agnostic repaired shape
        for _ in range(8):  # 400-fallbacks + up to 4 transient retries share this budget
            try:
                r = requests.post(self._url, headers=self._headers(), json=payload,
                                  stream=True, timeout=(15, self.read_timeout))
            except requests.ConnectionError as e:
                raise LLMError(
                    f"cannot connect to {self.base_url} — is your local LLM server running? "
                    f"(/connect <url> to change it)\n{e}") from e
            except requests.Timeout as e:
                last_err = f"timeout: {e}"
                transient += 1
                if transient < 4:
                    time.sleep(0.5 * transient)
                    continue
                raise LLMError(f"request timed out repeatedly: {last_err}") from e
            if r.status_code == 429:
                # rate limited — back off (honour Retry-After) and retry within the budget
                last_err = f"429 rate limited: {r.text[:200]}"
                transient += 1
                if transient < 4:
                    ra = r.headers.get("Retry-After", "")
                    try:
                        delay = float(ra) if ra else 0.5 * transient
                    except ValueError:
                        delay = 0.5 * transient
                    time.sleep(min(delay, 10))
                    continue
                raise LLMError(f"rate limited (429) after {transient} tries: {last_err}")
            if r.status_code in (400, 413):
                body = r.text[:600]
                last_err = body
                low = body.lower()
                # only disable a capability when the server actually blames THAT capability —
                # a 400 about something else must not permanently strip tools/reasoning.
                if (r.status_code == 400 and self.tools_supported and "tools" in payload
                        and re.search(r"tool|function", low)):
                    self.tools_supported = False
                    payload.pop("tools"); payload.pop("tool_choice", None)
                    continue
                if (r.status_code == 400 and self.reasoning_supported and "reasoning_effort" in payload
                        and re.search(r"reason|effort|think", low)):
                    self.reasoning_supported = False
                    payload.pop("reasoning_effort")
                    continue
                if re.search(r"context|token|too long|max.{0,8}length|length.{0,8}exceed", low):
                    raise LLMError("the conversation exceeds this model's context window — start a "
                                   "new session (Ctrl+N) or lower context_size")
                # unclear 400 with tools present: fall back to the text protocol (still robust)
                if r.status_code == 400 and self.tools_supported and "tools" in payload:
                    self.tools_supported = False
                    payload.pop("tools"); payload.pop("tool_choice", None)
                    continue
                raise LLMError(f"{r.status_code} from server: {body}")
            if r.status_code >= 500:
                # Transient upstream error — retry instead of killing the turn (Claude
                # Code / Codex do the same). Ollama, for one, intermittently 500s
                # "no user query found in messages" on long tool-loops.
                last_err = f"HTTP {r.status_code}: {r.text[:300]}"
                transient += 1
                if transient < 4:
                    # After a plain retry fails, also repair the message SHAPE — collapse
                    # native tool-calls/results into plain user/assistant text that even a
                    # brittle chat template can render. This is the DGC-level fix (works for
                    # any user's endpoint, not just one machine's Ollama models).
                    if transient >= 2 and not repaired:
                        payload["messages"] = _repair_for_retry(messages)
                        repaired = True
                    time.sleep(0.5 * transient)
                    continue
                raise LLMError(
                    f"HTTP {r.status_code} from {self._url} after {transient} tries: {r.text[:400]}")
            if r.status_code != 200:
                raise LLMError(f"HTTP {r.status_code} from {self._url}: {r.text[:400]}")
            return self._consume(r, on_text, on_thinking, cancel)
        raise LLMError(f"request failed repeatedly: {last_err}")

    def _consume(self, r: requests.Response, on_text, on_thinking, cancel=None) -> ChatResult:
        ctype = r.headers.get("Content-Type", "")
        if "application/json" in ctype and "text/event-stream" not in ctype:
            return self._consume_json(r, on_text, on_thinking)   # server ignored stream:true
        result = ChatResult()
        filt = _ThinkFilter()
        partial: dict[int, dict] = {}  # index -> accumulated native tool call
        noidx = -1                     # fallback slot cursor when a server omits tool_call 'index'
        idmap: dict[str, int] = {}     # tool-call id -> slot, so repeated ids don't split a call

        def emit(events):
            for kind, chunk in events:
                if not chunk:
                    continue
                if kind == "think":
                    result.thinking += chunk
                    if on_thinking:
                        on_thinking(chunk)
                else:
                    result.content += chunk
                    if on_text:
                        on_text(chunk)

        for line in r.iter_lines(decode_unicode=True):
            if cancel is not None and cancel.is_set():
                try:
                    r.close()
                except Exception:
                    pass
                result.finish_reason = "cancelled"
                break
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            choice = (obj.get("choices") or [{}])[0]
            if choice.get("finish_reason"):
                result.finish_reason = choice["finish_reason"]
            delta = choice.get("delta") or {}
            # reasoning is streamed in a separate field: ollama uses `reasoning`, others `reasoning_content`
            reasoning = delta.get("reasoning") or delta.get("reasoning_content")
            if reasoning:
                result.thinking += reasoning
                if on_thinking:
                    on_thinking(reasoning)
            if delta.get("content"):
                emit(filt.feed(delta["content"]))
            for tc in delta.get("tool_calls") or []:
                if "index" in tc:
                    idx = tc["index"]
                else:                          # server omitted index — infer slots from ids
                    tcid = tc.get("id")
                    if tcid and tcid in idmap:
                        idx = idmap[tcid]
                    elif tcid:
                        noidx += 1; idmap[tcid] = noidx; idx = noidx
                    elif not partial:
                        noidx += 1; idx = noidx
                    else:
                        idx = noidx if noidx >= 0 else 0
                slot = partial.setdefault(idx, {"id": "", "name": "", "args": ""})
                if tc.get("id"):
                    slot["id"] += tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] += fn["name"]
                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]

        emit(filt.flush())

        for idx in sorted(partial):
            slot = partial[idx]
            args = _loads_lenient(slot["args"]) if slot["args"] else {}
            if args is None:                   # repair (trailing comma etc.) before giving up
                args = {"_unparsed": slot["args"]}
            result.tool_calls.append(ToolCall(
                id=slot["id"] or f"call_{idx}", name=slot["name"], arguments=args))

        # fallback: model emitted tool calls as text despite native support
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content = clean
                result.tool_calls = text_calls
        return result

    def _consume_json(self, r: requests.Response, on_text, on_thinking) -> ChatResult:
        """A non-streaming server (ignored stream:true) returns one JSON completion — parse it
        through the same think-splitter / lenient-args / text-fallback path as the SSE stream."""
        result = ChatResult()
        try:
            obj = r.json()
        except ValueError:
            return result
        choice = (obj.get("choices") or [{}])[0]
        result.finish_reason = choice.get("finish_reason") or "stop"
        msg = choice.get("message") or {}
        reasoning = msg.get("reasoning") or msg.get("reasoning_content")
        if reasoning:
            result.thinking += reasoning
            if on_thinking:
                on_thinking(reasoning)
        filt = _ThinkFilter()
        for kind, chunk in filt.feed(msg.get("content") or "") + filt.flush():
            if kind == "think":
                result.thinking += chunk
                if on_thinking:
                    on_thinking(chunk)
            else:
                result.content += chunk
                if on_text:
                    on_text(chunk)
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            args = _loads_lenient(fn.get("arguments") or "{}")
            if args is None:
                args = {"_unparsed": fn.get("arguments")}
            result.tool_calls.append(ToolCall(id=tc.get("id") or f"call_{len(result.tool_calls)}",
                                              name=fn.get("name", ""), arguments=args))
        if not result.tool_calls:
            clean, text_calls = parse_text_tool_calls(result.content)
            if text_calls:
                result.content, result.tool_calls = clean, text_calls
        return result
