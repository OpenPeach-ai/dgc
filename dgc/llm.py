"""OpenAI-compatible LLM client with streaming, <think> tag handling,
native tool calling, and a text-protocol fallback for models without
tool support (common with small local models)."""
from __future__ import annotations

import json
import re
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
    """Incrementally split a token stream into ('text'|'think', chunk) events,
    tolerating tags split across chunks."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self):
        self.buf = ""
        self.in_think = False

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
            tag = self.CLOSE if self.in_think else self.OPEN
            i = self.buf.find(tag)
            if i != -1:
                if i:
                    events.append(("think" if self.in_think else "text", self.buf[:i]))
                self.buf = self.buf[i + len(tag):]
                self.in_think = not self.in_think
                continue
            hold = self._hold(self.buf, tag)
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


_TOOL_BLOCK = re.compile(r"```tool_call\s*\n(.*?)```", re.S)


def parse_text_tool_calls(content: str) -> tuple[str, list[ToolCall]]:
    """Extract ```tool_call fenced blocks (the text-protocol fallback)."""
    calls: list[ToolCall] = []

    def _sub(m: re.Match) -> str:
        raw = m.group(1).strip()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return m.group(0)  # leave unparseable blocks alone
        name = payload.get("name")
        if not name:
            return m.group(0)
        args = payload.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        calls.append(ToolCall(id=f"textcall_{len(calls)}", name=name, arguments=args))
        return ""

    clean = _TOOL_BLOCK.sub(_sub, content)
    return clean.strip(), calls


class LLMClient:
    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
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
    ) -> ChatResult:
        payload: dict = {"model": self.model, "messages": messages, "stream": True}
        if tools and self.tools_supported:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if reasoning_effort and reasoning_effort != "off" and self.reasoning_supported:
            payload["reasoning_effort"] = reasoning_effort

        last_err = ""
        for _ in range(3):
            try:
                r = requests.post(self._url, headers=self._headers(), json=payload,
                                  stream=True, timeout=(10, 900))
            except requests.ConnectionError as e:
                raise LLMError(
                    f"cannot connect to {self.base_url} — is your local LLM server running? "
                    f"(/connect <url> to change it)\n{e}") from e
            if r.status_code == 400:
                body = r.text[:600]
                last_err = body
                if "tools" in payload and self.tools_supported:
                    self.tools_supported = False
                    payload.pop("tools")
                    payload.pop("tool_choice", None)
                    continue
                if "reasoning_effort" in payload and self.reasoning_supported:
                    self.reasoning_supported = False
                    payload.pop("reasoning_effort")
                    continue
                raise LLMError(f"400 from server: {body}")
            if r.status_code != 200:
                raise LLMError(f"HTTP {r.status_code} from {self._url}: {r.text[:400]}")
            return self._consume(r, on_text, on_thinking)
        raise LLMError(f"request failed repeatedly: {last_err}")

    def _consume(self, r: requests.Response, on_text, on_thinking) -> ChatResult:
        result = ChatResult()
        filt = _ThinkFilter()
        partial: dict[int, dict] = {}  # index -> accumulated native tool call

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
            if delta.get("reasoning_content"):  # some servers stream this separately
                result.thinking += delta["reasoning_content"]
                if on_thinking:
                    on_thinking(delta["reasoning_content"])
            if delta.get("content"):
                emit(filt.feed(delta["content"]))
            for tc in delta.get("tool_calls") or []:
                idx = tc.get("index", 0)
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
            try:
                args = json.loads(slot["args"]) if slot["args"] else {}
            except json.JSONDecodeError:
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
