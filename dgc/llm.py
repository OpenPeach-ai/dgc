"""OpenAI-compatible LLM client with streaming, <think> tag handling,
native tool calling, and a text-protocol fallback for models without
tool support (common with small local models)."""
from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field

import requests


def _raw_socket(resp):
    """Best-effort reach into requests/urllib3 for the live socket, so a cancel can shut it
    down (SHUT_RDWR) and unblock a stalled read. Returns None if the internals differ."""
    raw = getattr(resp, "raw", None)
    for path in (("_connection", "sock"), ("_fp", "fp", "raw", "_sock"), ("_fp", "fp", "_sock")):
        obj = raw
        for attr in path:
            obj = getattr(obj, attr, None)
            if obj is None:
                break
        if obj is not None and hasattr(obj, "shutdown"):
            return obj
    return None


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


# --- reasoning / thinking control, per provider (F1) -------------------------
# There is no single wire format that toggles reasoning across every OpenAI-
# compatible backend, so we express DGC's thinking level in the right shape for
# the detected provider. Golden rule: never OMIT for a thinking-capable Ollama
# model — omitting forces thinking ON (Ollama routes.go), the bug behind the
# "200s think, never edits" symptom.
_REASONING_OFF = {None, "", "off", "none"}
_REASONING_KEYS = ("reasoning_effort", "chat_template_kwargs", "thinking")
_SAMPLING_KEYS = ("temperature", "top_p", "top_k", "min_p")


def _provider_family(base_url: str) -> str:
    u = base_url.lower()
    if "11434" in u or "ollama" in u:
        return "ollama"
    if "api.openai.com" in u:
        return "openai"
    if "deepseek.com" in u:
        return "deepseek"
    if "anthropic" in u:
        return "anthropic"
    if ":8000" in u or ":30000" in u or "vllm" in u or "sglang" in u:
        return "vllm"
    return "compat"                 # LM Studio, llama.cpp, or any other OpenAI-compatible host


def _openai_reasoning_model(model: str) -> bool:
    m = model.lower()
    return m.startswith(("o1", "o3", "o4")) or m.startswith("gpt-5") or "gpt-5" in m


def is_reasoning_model(model: str) -> bool:
    """Heuristic: does this model reason by default (so `/think high` tends to help)?"""
    m = model.lower()
    return (_openai_reasoning_model(model) or "reasoner" in m or "-r1" in m or "deepseek-r" in m
            or "qwq" in m or "think" in m)


def _reasoning_payload(family: str, model: str, level) -> dict:
    """Request fields expressing thinking `level` (off|low|medium|high|None) for
    this provider. `{}` means 'let the model's own default stand'."""
    off = level in _REASONING_OFF
    if family == "ollama":                              # omitting forces thinking ON → always send
        return {"reasoning_effort": "none" if off else level}
    if family == "vllm":                                # server renders the chat template
        p = {"chat_template_kwargs": {"enable_thinking": not off}}
        if not off:
            p["reasoning_effort"] = level
        return p
    if family == "openai":                              # only o-series / gpt-5 accept effort; no "none"
        if not _openai_reasoning_model(model):
            return {}
        return {"reasoning_effort": "low" if off else level}
    if family == "deepseek":                            # reasoning is selected by the model id
        return {}
    if family == "anthropic":
        if off:
            return {}
        budget = {"low": 2048, "medium": 8192, "high": 16384}.get(level, 8192)
        return {"thinking": {"type": "enabled", "budget_tokens": budget}}
    # unknown OpenAI-compatible host → send both switches; each server ignores the other's field
    if off:
        return {"reasoning_effort": "none", "chat_template_kwargs": {"enable_thinking": False}}
    return {"reasoning_effort": level, "chat_template_kwargs": {"enable_thinking": True}}


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str, read_timeout: int = 1800,
                 think_budget_tokens: int = 8000, max_tokens: int = 0, ollama_keep_alive: str = "",
                 sampling: dict | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.family = _provider_family(self.base_url)   # picks the reasoning wire format
        self.read_timeout = read_timeout  # seconds to wait BETWEEN streamed chunks (slow-prefill guard)
        self.think_budget_chars = max(0, think_budget_tokens) * 4   # F4 over-thinking watchdog (0=off)
        self.max_tokens = max(0, max_tokens)            # F3 output backstop per request (0=don't send)
        self.keep_alive = ollama_keep_alive             # D2: keep Ollama model resident between turns
        self.sampling = dict(sampling or {})            # optional temperature/top_p/top_k/min_p overrides
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
        if self.reasoning_supported:        # F1: provider-aware reasoning/thinking control
            payload.update(_reasoning_payload(self.family, self.model, reasoning_effort))
        if self.max_tokens:                 # F3: output-token backstop (dropped on a 400 if unwanted)
            payload["max_tokens"] = self.max_tokens
        if self.sampling:                   # optional temperature/top_p/top_k/min_p (user override)
            payload.update(self.sampling)
        if self.family == "ollama" and self.keep_alive:   # D2: model residency (Ollama honours it on /v1)
            payload["keep_alive"] = self.keep_alive

        last_err = ""
        transient = 0      # count of retried timeouts / 5xx (bounded, with backoff)
        repaired = False   # whether we've swapped in the endpoint-agnostic repaired shape
        overthink = 0      # F4: times the reasoning-watchdog fired this turn (bounded)
        level = reasoning_effort   # current thinking level; the watchdog steps it down on a runaway
        _LOWER = {"high": "medium", "medium": "low", "low": "off", "none": "off", "off": "off"}
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
                if (r.status_code == 400 and self.reasoning_supported
                        and any(k in payload for k in _REASONING_KEYS)
                        and re.search(r"reason|effort|think|template", low)):
                    self.reasoning_supported = False        # F2: server rejects our reasoning shape →
                    for k in _REASONING_KEYS:               # strip every reasoning key, respect its default
                        payload.pop(k, None)
                    continue
                if (r.status_code == 400 and "max_tokens" in payload
                        and re.search(r"max_tokens|max_completion|max.{0,8}output", low)):
                    payload.pop("max_tokens", None)         # F3: server rejects our cap → drop it, retry
                    continue
                if (r.status_code == 400 and self.sampling
                        and any(k in payload for k in _SAMPLING_KEYS)
                        and re.search(r"unrecognized|unsupported|unexpected|unknown|invalid|"
                                      r"top_k|top_p|min_p|temperature|sampl", low)):
                    for k in _SAMPLING_KEYS:                # server rejects a sampling knob → drop ALL of
                        payload.pop(k, None)                #   them (respect its defaults) and don't re-add,
                    self.sampling = {}                      #   so a strict endpoint can't brick the session
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
                # Transient upstream error — retry instead of killing the turn (robust
                # clients do the same). Ollama, for one, intermittently 500s
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
            budget = 0 if overthink > 2 else self.think_budget_chars   # let the last attempt finish
            res = self._consume(r, on_text, on_thinking, cancel, think_budget=budget)
            if res.finish_reason == "overthink":          # F4: reasoning ran away → retry with less
                overthink += 1
                level = _LOWER.get(level or "off", "off")  # high→medium→low→off (floor)
                for k in _REASONING_KEYS:
                    payload.pop(k, None)
                if self.reasoning_supported:
                    payload.update(_reasoning_payload(self.family, self.model, level))
                continue
            return res
        raise LLMError(f"request failed repeatedly: {last_err}")

    def _consume(self, r: requests.Response, on_text, on_thinking, cancel=None,
                 think_budget: int = 0) -> ChatResult:
        ctype = r.headers.get("Content-Type", "")
        if "application/json" in ctype and "text/event-stream" not in ctype:
            return self._consume_json(r, on_text, on_thinking)   # server ignored stream:true
        result = ChatResult()
        filt = _ThinkFilter()
        produced = False               # F4: has any content/tool-call appeared yet? (disarms the watchdog)
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

        # Cancel watcher: a stalled iter_lines() — the model still prefilling a huge resumed
        # context, with no first token yet — never runs the in-loop cancel check, because the
        # loop body doesn't execute until a line arrives. Closing the socket from a watcher
        # thread unblocks the read, so Esc / Stop takes effect immediately instead of hanging
        # forever on "responding…".
        stop_watch = threading.Event()
        if cancel is not None:
            def _watch(resp=r, ev=stop_watch, cx=cancel):
                while not ev.wait(0.15):
                    if cx.is_set():
                        # Shutting the raw socket down is what actually unblocks a stalled
                        # recv(); resp.close() alone races and often waits for the server.
                        sock = _raw_socket(resp)
                        if sock is not None:
                            try:
                                import socket as _socket
                                sock.shutdown(_socket.SHUT_RDWR)
                            except Exception:
                                pass
                        try:
                            resp.close()
                        except Exception:
                            pass
                        return
            threading.Thread(target=_watch, daemon=True).start()
        # SSE streams are UTF-8, but requests defaults to latin-1 when the Content-Type carries no
        # charset — which mangles every multibyte char (→ becomes "â\x86\x92", ° becomes "Â°"). Pin it.
        r.encoding = "utf-8"
        _lines = r.iter_lines(decode_unicode=True)
        while True:
            try:
                line = next(_lines)
            except StopIteration:
                break
            except Exception:
                # Closing the socket mid-read (the watcher, on cancel) surfaces as any of
                # several low-level errors depending on timing — swallow them ONLY when the
                # user actually cancelled; otherwise it's a real stream error, re-raise.
                if cancel is not None and cancel.is_set():
                    result.finish_reason = "cancelled"
                    break
                stop_watch.set()
                raise
            if cancel is not None and cancel.is_set():
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
                produced = True
            for tc in delta.get("tool_calls") or []:
                produced = True
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

            if think_budget and not produced and len(result.thinking) > think_budget:
                result.finish_reason = "overthink"     # F4: reasoning ran away before any output
                try:
                    r.close()
                except Exception:
                    pass
                break

        stop_watch.set()               # stop the cancel watcher (all loop-exit paths pass here)
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
