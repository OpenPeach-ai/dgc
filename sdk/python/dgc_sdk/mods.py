"""Write a DGC mod in Python. DGC puts this file on every Python mod's path; the SDK re-exports it as dgc_sdk.mods.

    import dgc_mod as dm

    mod = dm.Mod()

    @mod.on("tool.call")
    def careful(event):                     # {"tool": "bash", "args": {...}}
        if "rm -rf" in str(event["args"]):
            return dm.ask("This deletes files.")     # or dm.deny("…"); return None to only watch

    @mod.on("turn.complete")
    def done(event):
        mod.set_ui("status", dm.Text(f"{event['usage'].get('total_tokens', 0)} tokens"))

    @mod.command("hello")
    def hello(args):
        return dm.Text("Hello from my mod")

    mod.run()

A mod only hears the events its dgc-mod.json declares, draws only where it declared, and can never approve: on a step
it may watch, ask you first (dm.ask) or stop it (dm.deny). print() goes to the mod's log, never to DGC.
"""
from __future__ import annotations

import json
import queue
import sys
import threading
import traceback

__all__ = ["Mod", "ask", "deny", "rewrite", "Box", "Row", "Column", "Text", "Markdown", "Button", "Input", "Select",
           "Bar", "Table", "Sparkline", "ModError"]


class ModError(RuntimeError):
    """DGC refused a request (a host it didn't declare, a file outside the project, ...)."""


# ---- answers --------------------------------------------------------------------------------------------------
def ask(reason: str) -> dict:
    """On tool.call: ask the user first, even where DGC would have gone ahead."""
    return {"decision": "ask", "reason": str(reason)[:300]}


def deny(reason: str) -> dict:
    """On tool.call: stop the step; DGC tells the model why."""
    return {"decision": "deny", "reason": str(reason)[:300]}


def rewrite(text: str, note: str = "") -> dict:
    """On prompt.submit (with rewrites_prompt): send this instead; it's marked as changed by this mod."""
    return {"rewrite": str(text), "note": str(note)[:200]}


# ---- elements -------------------------------------------------------------------------------------------------
def _el(kind, **fields):
    return {"type": kind, **{k: v for k, v in fields.items() if v is not None}}


def Box(*children, title=None, tone=None):             # noqa: N802
    return _el("Box", children=list(children), title=title, tone=tone)


def Row(*children):                                    # noqa: N802
    return _el("Row", children=list(children))


def Column(*children):                                 # noqa: N802
    return _el("Column", children=list(children))


def Text(text, tone=None):                             # noqa: N802
    return _el("Text", text=str(text), tone=tone)


def Markdown(text):                                    # noqa: N802
    return _el("Markdown", text=str(text))


def Button(id, label):                                 # noqa: N802,A002
    return _el("Button", id=id, label=label)


def Input(id, placeholder=None, value=None):           # noqa: N802,A002
    return _el("Input", id=id, placeholder=placeholder, value=value)


def Select(id, options, value=None):                   # noqa: N802,A002
    return _el("Select", id=id, options=[o if isinstance(o, dict) else {"value": str(o), "label": str(o)}
                                          for o in options], value=value)


def Bar(segments, total=None):                         # noqa: N802
    return _el("Bar", segments=list(segments), total=total)


def Table(columns, rows):                              # noqa: N802
    return _el("Table", columns=list(columns), rows=[list(r) for r in rows])


def Sparkline(values, label=None):                     # noqa: N802
    return _el("Sparkline", values=list(values), label=label)


# ---- the mod --------------------------------------------------------------------------------------------------
class Mod:
    def __init__(self):
        self._events: dict[str, list] = {}
        self._commands: dict[str, object] = {}
        self._renders: dict[str, object] = {}
        self._actions: list = []
        self._pending: dict[int, dict] = {}
        self._next = 0
        self._lock = threading.Lock()
        self._write = threading.Lock()
        self._inbox: queue.Queue = queue.Queue()
        self.info: dict = {}
        self._out = sys.stdout
        sys.stdout = sys.stderr            # a print() goes to the log, never into the pipe

    # -- registering ---------------------------------------------------------------------------------------------
    def on(self, event: str):
        def deco(fn):
            self._events.setdefault(event, []).append(fn)
            return fn
        return deco

    def command(self, name: str):
        def deco(fn):
            self._commands[name] = fn
            return fn
        return deco

    def render(self, slot: str):
        """What to draw in a slot when DGC asks (a new window, a reload)."""
        def deco(fn):
            self._renders[slot] = fn
            return fn
        return deco

    def action(self, fn):
        """A Button pressed, an Input or Select changed: fn({"id", "value"})."""
        self._actions.append(fn)
        return fn

    # -- asking DGC ----------------------------------------------------------------------------------------------
    def call(self, method: str, params: dict | None = None, timeout: float = 30.0):
        with self._lock:
            self._next += 1
            ident = self._next
            waiting = {"done": threading.Event(), "result": None, "error": None}
            self._pending[ident] = waiting
        try:
            self._send({"jsonrpc": "2.0", "id": ident, "method": method, "params": params or {}})
            if not waiting["done"].wait(timeout):
                raise ModError(f"DGC didn't answer {method}.")
            if waiting["error"] is not None:
                raise ModError(str(waiting["error"]))
            return waiting["result"]
        finally:
            with self._lock:
                self._pending.pop(ident, None)

    def set_ui(self, slot: str, tree) -> None:
        """Draw in a slot you declared (pane, band, status); None clears it."""
        self.call("ui.set", {"slot": slot, "tree": tree})

    def toast(self, text: str, tone: str | None = None) -> None:
        self.call("ui.toast", {"text": str(text), **({"tone": tone} if tone else {})})

    def fetch(self, url: str, *, method: str = "GET", headers: dict | None = None, body: str | None = None) -> dict:
        """A web request to a host you declared: {status, headers, text}."""
        return self.call("http.fetch", {"url": url, "method": method, "headers": headers or {},
                                        **({"body": body} if body is not None else {})})

    def read_file(self, path: str) -> str:
        return self.call("files.read", {"path": path})["text"]

    def git(self) -> dict:
        return self.call("git.status", {})

    def usage(self) -> dict:
        return self.call("usage.get", {})

    def transcript(self, limit: int = 20) -> list:
        return self.call("transcript.get", {"limit": limit})["messages"]

    def ask_model(self, prompt: str, max_tokens: int = 400) -> str:
        return self.call("model.complete", {"prompt": prompt, "max_tokens": max_tokens}, timeout=120)["text"]

    def store_get(self, key: str, default=None):
        got = self.call("store.get", {"key": key})
        return default if got is None or got.get("value") is None else got["value"]

    def store_set(self, key: str, value) -> None:
        self.call("store.set", {"key": key, "value": value})

    def state_get(self, key: str, default=None):
        got = self.call("state.get", {"key": key})
        return default if got is None or got.get("value") is None else got["value"]

    def state_set(self, key: str, value) -> None:
        self.call("state.set", {"key": key, "value": value})

    # -- the loop ------------------------------------------------------------------------------------------------
    def _send(self, message: dict) -> None:
        data = json.dumps(message, separators=(",", ":"), ensure_ascii=False, default=str) + "\n"
        with self._write:
            self._out.write(data)
            self._out.flush()

    def _reader(self) -> None:
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            if "method" in message:
                self._inbox.put(message)
                continue
            with self._lock:
                waiting = self._pending.pop(message.get("id"), None)
            if waiting is not None:
                if "error" in message:
                    err = message["error"]
                    waiting["error"] = err.get("message") if isinstance(err, dict) else str(err)
                else:
                    waiting["result"] = message.get("result")
                waiting["done"].set()
        self._inbox.put(None)

    def _handle(self, method: str, params: dict):
        if method == "initialize":
            self.info = params
            return {"hooks": sorted(self._events), "commands": sorted(self._commands), "renders": sorted(self._renders)}
        if method == "event":
            name, data = params.get("name"), params.get("data") or {}
            answer = None
            for fn in self._events.get(name, []):
                got = fn(data)
                if got is not None and answer is None:
                    answer = got
            return answer or {}
        if method == "command":
            fn = self._commands.get(params.get("name"))
            if fn is None:
                raise ModError(f"no command {params.get('name')}")
            got = fn(params.get("args") or "")
            return {"text": got} if isinstance(got, str) else ({"tree": got} if isinstance(got, dict) else {})
        if method == "ui.render":
            fn = self._renders.get(params.get("slot"))
            return {"tree": fn() if fn else None}
        if method == "ui.action":
            for fn in self._actions:
                fn({"id": params.get("id"), "value": params.get("value")})
            return {}
        if method == "shutdown":
            raise SystemExit(0)
        raise ModError(f"unknown method {method}")

    def run(self) -> None:
        threading.Thread(target=self._reader, daemon=True).start()
        while True:
            message = self._inbox.get()
            if message is None:
                return
            method, params, ident = message.get("method"), message.get("params") or {}, message.get("id")
            try:
                result = self._handle(method, params)
                if ident is not None:
                    self._send({"jsonrpc": "2.0", "id": ident, "result": result})
            except SystemExit:
                return
            except Exception as error:                     # noqa: BLE001 -- DGC hears it failed
                traceback.print_exc()
                if ident is not None:
                    self._send({"jsonrpc": "2.0", "id": ident,
                                "error": {"code": -32000, "message": f"{type(error).__name__}: {error}"[:500]}})
