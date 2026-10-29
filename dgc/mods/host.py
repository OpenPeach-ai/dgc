"""The mods of one session: started, told what they asked to hear, asked what they may decide, and answered within
exactly what each one declared and the user allowed.

What a mod may decide can only make DGC more careful: on a step (tool.call) it may watch, ask the user first, or stop
it; it can never allow anything, never draw over an approval card, and an Ask it adds can't be answered by a rule
changing behind the user's back (the agent turns off the card's re-check for it). A prompt it rewrites is marked
"Edited by <mod>" and the original is kept. Everything it draws is drawn under its own name.

Turned off by DGC's safe mode (``dgc --safe-mode``, DGC_SAFE_MODE=1) and the ``mods_enabled`` setting.

A mod DGC itself writes in the project (the mod-author skill) is asked about once a session: "Turn on the mods DGC
writes in this session?" (``wrote``, ``answer_offer``). Allowed, its folder runs as ``dgc mods dev`` runs one, for
this session only, and later ones start without asking unless they ask for more than was allowed; Not now, nothing
runs and nothing more is asked, and /mods lists each as written this session, with an Allow. Never where nobody is
watching (a Pip's run), and never while mods are off.
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..config import dgc_home
from . import catalog, consent, ui
from .manifest import Manifest, describe
from .runtime import ModError, ModProcess

DECIDE_SECONDS = 1.5
PROMPT_SECONDS = 2.0
COMMAND_SECONDS = 10.0
MAX_STORE_BYTES = 256 * 1024
MAX_FETCH_BYTES = 1024 * 1024
MAX_READ_BYTES = 512 * 1024
ORDER = {"observe": 0, "ask": 1, "deny": 2}
UNATTENDED = {"pip"}              # surfaces nobody watches while they run


def safe_mode() -> bool:
    return os.environ.get("DGC_SAFE_MODE", "").strip() in ("1", "true", "yes")


def enabled(config) -> bool:
    try:
        on = config.get("mods_enabled", True) if config is not None else True
    except Exception:                                    # noqa: BLE001
        on = True
    return bool(on) and not safe_mode()


def _host_allowed(host: str, allowed) -> bool:
    host = (host or "").lower().rstrip(".")
    for pattern in allowed:
        if pattern.startswith("*."):
            if host.endswith(pattern[1:]) and host != pattern[2:]:
                return True
        elif host == pattern:
            return True
    return False


class _Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed):
        super().__init__()
        self.allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _host_allowed(urllib.parse.urlsplit(newurl).hostname or "", self.allowed):
            raise ModError(f"It redirected to {urllib.parse.urlsplit(newurl).hostname}, which this mod didn't declare.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Running:
    def __init__(self, manifest: Manifest, proc: ModProcess):
        self.manifest = manifest
        self.proc = proc
        self.hooks: set[str] = set()


class ModHost:
    def __init__(self, *, project_root, session_id: str = "", surface: str = "work", on_ui=None, providers=None,
                 extra=(), config=None, redact=None):
        self.project_root = Path(project_root).resolve() if project_root else None
        self.session_id = session_id or "default"
        self.surface = surface
        # A Pip's run (surface "pip") is unattended: only guard mods (ones that hear tool.call) run there, they hear
        # nothing else and draw nothing, and an "ask" stops the step, since nobody is there to answer it.
        self.unattended = surface in UNATTENDED
        self.on_ui = on_ui
        self.providers = providers or {}
        self.extra = tuple(extra)
        self.config = config
        self.redact = redact or (lambda value: value)
        self.running: dict[str, Running] = {}
        self.ui_state: dict[str, dict] = {}
        self.toasts: list[dict] = []
        self._lock = threading.RLock()
        self._closed = False
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mods")
        self.session_allowed: set[str] = set()      # dev mods the user turned on for this session only
        self.session_grants: dict[str, tuple[str, set[str]]] = {}
        # The mods DGC wrote in this session's project: name -> folder; every grant the user allowed for them; their
        # one answer ("allow", "not_now", or None before the question); the question open now, and any waiting.
        self.written: dict[str, str] = {}
        self.written_grants: set[str] = set()
        self.written_answer: str | None = None
        self.offer: dict | None = None
        self._offers_waiting: list[str] = []
        self._watched: set[str] = set()
        self._clashed: set[str] = set()
        self._watching = True

    # -- what there is -------------------------------------------------------------------------------------------
    @property
    def on(self) -> bool:
        return enabled(self.config)

    def mods(self) -> list[dict]:
        """Every mod this session knows: running or not, and why not. ``plugin`` (with ``plugin_title``) names the
        plugin an installed one came with; ``written`` marks one DGC wrote in this session."""
        out = []
        for m in catalog.available(self.extra):
            run = self.running.get(m.name)
            record = consent.record(m.name)
            written = self.written.get(m.name) == str(m.folder)
            if written:
                missing = sorted(m.grants() - self.written_grants) if m.name in self.session_allowed \
                    else sorted(m.grants())
            else:
                missing = sorted(consent.missing(m) - (self._session_granted(m) or set()))
            came = catalog.origin(m)
            out.append({"name": m.name, "title": m.title, "version": m.version, "description": m.description,
                        "builtin": m.builtin, "dev": str(m.folder) in {str(Path(p).resolve()) for p in self.extra},
                        "state": run.proc.state if run else ("off" if record and not record.get("enabled", True)
                                                             and not written
                                                             else "needs_allow" if not self._may_run(m) else "stopped"),
                        "error": run.proc.error if run else "", "asks": describe(m), "missing": missing,
                        "commands": [dict(c) for c in m.commands], "draws": list(m.draws), "review": m.review_id(),
                        **({"plugin": came["plugin"], "plugin_title": came["title"]} if came else {}),
                        **({"written": True} if written else {})})
        return out

    def _may_run(self, m: Manifest) -> bool:
        """Allowed: by the user's record, or for this session (a dev folder, or one DGC wrote and the user allowed,
        while it asks for nothing more than they allowed)."""
        if self.written.get(m.name) == str(m.folder):
            return m.name in self.session_allowed and m.grants() <= self.written_grants
        granted = self._session_granted(m)
        return consent.allowed(m) or (granted is not None and m.grants() <= granted)

    def _session_granted(self, m: Manifest) -> set[str] | None:
        got = self.session_grants.get(m.name)
        return got[1] if m.name in self.session_allowed and got and got[0] == str(m.folder) else None

    def grant_session(self, m: Manifest) -> None:
        """The dev/SDK caller authorizes this folder and these capabilities for this session."""
        self.session_grants[m.name] = (str(m.folder), set(m.grants()))
        self.session_allowed.add(m.name)

    def commands(self) -> list[dict]:
        with self._lock:
            return [{**c, "mod": r.manifest.name, "title": r.manifest.title}
                    for r in self.running.values() for c in r.manifest.commands]

    # -- starting and stopping -----------------------------------------------------------------------------------
    def start(self) -> None:
        if not self.on:
            return
        for m in catalog.available(self.extra):
            if m.name in self.running or (self.unattended and "tool.call" not in m.events):
                continue
            if self._may_run(m):
                self._start(m)
        self.fire("session.start", {"surface": self.surface})

    def _start(self, m: Manifest) -> Running | None:
        from .. import sandbox
        record = consent.record(m.name) or {}
        boxed = sandbox._backend() is not None
        # DGC's own mods run anyway where there's no sandbox; another's only when the user said so for it.
        sandboxed = boxed or not (m.builtin or record.get("unsandboxed"))
        proc = ModProcess(m, on_request=lambda method, params: self._request(m.name, method, params, process=proc),
                          on_exit=self._exited, sandboxed=sandboxed)
        run = Running(m, proc)
        with self._lock:
            self._closed = False
            self.running[m.name] = run
        proc.start()
        if proc.state != "running":
            self._changed()
            return run
        try:
            got = proc.request("initialize", {"api": 1, "mod": m.name, "surface": self.surface,
                                              "session": self.session_id,
                                              "project": str(self.project_root or ""),
                                              "capabilities": m.capabilities()}, timeout=10)
            run.hooks = {h for h in (got or {}).get("hooks") or [] if h in m.events}
        except ModError as error:
            proc.error = f"It didn't start: {error}"
            proc.stop()
            self._changed()
            return run
        for slot in (() if self.unattended else ("pane", "band", "status")):
            if slot in m.draws:
                try:
                    tree = (proc.request("ui.render", {"slot": slot}, timeout=3) or {}).get("tree")
                    if tree is not None:
                        self._set_ui(m.name, slot, tree)
                except ModError:
                    pass
        self._changed()
        return run

    def _exited(self, proc: ModProcess) -> None:
        self._changed()

    def stop(self, name: str | None = None) -> None:
        if name is None:
            self._watching = False                       # the session ends: its dev folders stop being watched
        with self._lock:
            names = [name] if name else list(self.running)
            retired = self._pool if name is None else None
            if retired is not None:
                self._closed = True
                # A later explicit start may reuse this host; a fresh executor creates no
                # threads until then. The ended session must release its existing workers.
                self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mods")
        if retired is not None:
            retired.shutdown(wait=False, cancel_futures=True)
        for n in names:
            run = self.running.get(n)
            if run is None:
                continue
            if run.proc.state == "running" and "session.end" in run.hooks:
                try:
                    run.proc.notify("event", {"name": "session.end", "data": {}})
                except ModError:
                    pass
            run.proc.stop()
            with self._lock:
                self.running.pop(n, None)
                self.ui_state.pop(n, None)
        self._changed()

    def reload(self, name: str | None = None) -> None:
        targets = [name] if name else [r for r in list(self.running)]
        for n in targets:
            self.stop(n)
        if name:
            m = catalog.find(name, self.extra)
            if m and self._may_run(m):
                self._start(m)
        else:
            self.start()

    def allow(self, name: str, *, session_only: bool = False, unsandboxed: bool = False,
              review: str | None = None) -> dict:
        """The user's Allow (the card showed describe()): remembered, or for this session only (a mod DGC wrote,
        always: what it may do this session is what the user saw, and it isn't kept)."""
        m = catalog.find(name, self.extra)
        if m is None:
            raise ModError(f"There's no mod named {name}.")
        if review is not None and review != m.review_id():
            raise ModError("This mod changed since its permissions were shown. Refresh Mods and review it again.")
        if self.written.get(m.name) == str(m.folder):
            self.written_grants |= m.grants()
            self.session_allowed.add(m.name)
            if self.offer is not None and self.offer["name"] == m.name:
                self.offer = None
            self.watch(str(m.folder), m.name)
        elif session_only:
            self.grant_session(m)
        else:
            consent.allow(m, unsandboxed=unsandboxed)
        self.stop(m.name)
        if self.on:
            self._start(m)
        return next(e for e in self.mods() if e["name"] == m.name)

    def turn_off(self, name: str) -> None:
        consent.set_enabled(name, False)
        self.session_allowed.discard(name)
        self.session_grants.pop(name, None)
        self.stop(name)

    def turn_on(self, name: str) -> None:
        m = catalog.find(name, self.extra)
        if m is not None and self.written.get(m.name) == str(m.folder):
            if not m.grants() <= self.written_grants:
                raise ModError(f"Allow {name} first: it asks for more than you allowed.")
            self.session_allowed.add(m.name)
        elif m is None or consent.set_enabled(name, True) is None:
            raise ModError(f"Allow {name} first.")
        if self.on and self._may_run(m):
            self._start(m)

    # -- the mods DGC writes ---------------------------------------------------------------------------------------
    def wrote(self, folder) -> dict | None:
        """The model wrote (or changed) a mod's folder in the project. The question to ask the user, when there is
        one ({id, name, title, version, folder, asks, more}); it is also said to the screen (on_ui "offer"). None when
        there's nothing to ask: it runs already, starts at once, the user said Not now, or nobody is watching."""
        if not self.on or self.unattended:
            return None
        try:
            from .manifest import load as load_manifest
            m = load_manifest(folder)
        except Exception:                                    # noqa: BLE001 -- not a whole mod yet; asked once it is
            return None
        where = str(m.folder)
        known = self.written.get(m.name)
        if known != where:
            other = catalog.find(m.name, self.extra)
            if other is not None and known is None and str(other.folder) == where:
                return None                                   # the user's own dev folder (dgc mods dev)
            if other is not None:
                # Its name is another mod's (DGC's own, an installed one, a dev folder, another folder DGC wrote):
                # beside it, this folder would hide that mod for the rest of the session. Said once; never run.
                if where not in self._clashed:
                    self._clashed.add(where)
                    self._emit("toast", {"mod": "DGC", "name": m.name, "tone": "warn", "at": time.time(),
                                         "text": f"DGC wrote a mod named {m.name}, the name of one you already "
                                                 "have, so it can't run here. Give it another name in its "
                                                 "dgc-mod.json."})
                return None
            self.written[m.name] = where
            self.extra = self.extra + (where,)
        if m.name in self.running and self._may_run(m):
            return None                                       # its watcher reloads it
        if self.written_answer == "not_now":
            self._changed()                                   # listed as written this session, with an Allow
            return None
        if self.written_answer == "allow" and m.grants() <= self.written_grants:
            self.session_allowed.add(m.name)
            self.watch(where, m.name)
            self.stop(m.name)
            self._start(m)
            return None
        if self.offer is not None and self.offer["name"] != m.name:
            if m.name not in self._offers_waiting:
                self._offers_waiting.append(m.name)          # asked once the open question is answered
            self._changed()
            return None
        if self.offer is not None and set(self.offer["grants"]) == m.grants():
            return None                                       # the same question is open already
        return self._ask_about(m)                             # first, or it changed what it asks while asked

    def _ask_about(self, m: Manifest) -> dict:
        project = self.project_root
        try:
            shown = m.folder.relative_to(project).as_posix() if project else m.folder.name
        except ValueError:
            shown = m.folder.name
        self.offer = {"id": "mo_" + secrets.token_hex(8), "name": m.name, "title": m.title, "version": m.version,
                      "folder": shown or ".", "asks": describe(m), "more": self.written_answer == "allow",
                      "grants": sorted(m.grants())}
        self._changed()
        self._emit("offer", dict(self.offer))
        return dict(self.offer)

    def answer_offer(self, offer_id: str, allow: bool) -> None:
        """Allow or Not now, for the question asked (``offer``). Allow covers exactly what it showed."""
        offer = self.offer
        if offer is None or offer["id"] != offer_id:
            raise ModError("That question was already answered.")
        self.offer = None
        m = catalog.find(offer["name"], self.extra)
        if not allow:
            self.written_answer = "not_now"
            self._offers_waiting.clear()
            self._changed()
            return
        if (m is None or self.written.get(offer["name"]) != str(m.folder)
                or m.grants() != set(offer["grants"])):
            if m is not None and self.written.get(offer["name"]) == str(m.folder):
                self._ask_about(m)
            else:
                self._changed()
            raise ModError("This mod changed since its permissions were shown. Review the new question.")
        self.written_answer = "allow"
        self.written_grants |= set(offer["grants"])
        if m is not None and self.written.get(m.name) == str(m.folder):
            self.session_allowed.add(m.name)
            self.watch(str(m.folder), m.name)
            self.stop(m.name)
            if self._may_run(m):
                self._start(m)
        waiting, self._offers_waiting = self._offers_waiting, []
        for name in waiting:
            folder = self.written.get(name)
            if folder and self.offer is None:
                self.wrote(folder)
            elif folder:
                self._offers_waiting.append(name)
        self._changed()

    def watch(self, folder: str, name: str) -> None:
        """Reload a dev mod when a file in its folder changes (a check a second; no file-system events needed)."""
        if folder in self._watched:
            return
        self._watched.add(folder)

        def snapshot():
            out = {}
            for p in Path(folder).rglob("*"):
                if p.is_file() and not {"node_modules", ".git", "__pycache__"} & set(p.parts):
                    try:
                        out[str(p)] = p.stat().st_mtime_ns
                    except OSError:
                        pass
            return out

        def loop():
            seen = snapshot()
            while getattr(self, "_watching", True):
                time.sleep(1.0)
                now = snapshot()
                if now != seen:
                    seen = now
                    try:
                        self.reload(name)
                        self._emit("toast", {"mod": "DGC", "name": name, "text": f"reloaded {name}", "tone": None,
                                             "at": time.time()})
                    except Exception:                    # noqa: BLE001
                        pass
        threading.Thread(target=loop, daemon=True, name=f"mod-dev-{name}").start()

    # -- events --------------------------------------------------------------------------------------------------
    def _hearing(self, event: str) -> list[Running]:
        if self._closed or not self.on or (self.unattended and event != "tool.call"):
            return []
        with self._lock:
            return [r for r in self.running.values() if r.proc.state == "running" and event in r.hooks
                    and self._may_run(r.manifest)]

    def fire(self, event: str, data: dict) -> None:
        """An event a mod only watches: sent, not waited for."""
        clean = self.redact(data)
        for run in self._hearing(event):
            try:
                run.proc.notify("event", {"name": event, "data": clean})
            except ModError:
                pass

    def _ask_all(self, event: str, data: dict, timeout: float, only=None) -> list[tuple[Running, dict]]:
        clean = self.redact(data)
        runs = [r for r in self._hearing(event) if only is None or only(r)]
        with self._lock:
            if self._closed:
                return []
            futures = [(r, self._pool.submit(r.proc.request, "event", {"name": event, "data": clean}, timeout)) for r in runs]
        out = []
        for run, future in futures:
            try:
                got = future.result(timeout=timeout + 0.5)
            except Exception:                                # noqa: BLE001 -- a mod that didn't answer only watched
                continue
            if isinstance(got, dict):
                out.append((run, got))
        return out

    def tool_call(self, tool: str, args) -> dict:
        """What the mods say about a step: {decision: observe|ask|deny, mod, reason}. Never allow."""
        best = {"decision": "observe", "mod": "", "reason": ""}
        for run, got in self._ask_all("tool.call", {"tool": tool, "args": args}, DECIDE_SECONDS):
            decision = got.get("decision")
            if decision in ("ask", "deny") and ORDER[decision] > ORDER[best["decision"]]:
                best = {"decision": decision, "mod": run.manifest.title,
                        "reason": " ".join(str(got.get("reason") or "").split())[:300]}
        if self.unattended and best["decision"] == "ask":
            best = {**best, "decision": "deny",
                    "reason": (best["reason"] + " " if best["reason"] else "") + "(It asks first, and a Pip's run has "
                              "nobody to ask, so the step is stopped.)"}
        return best

    def prompt(self, text: str) -> tuple[str, dict | None]:
        """What the user sent, as the mods leave it: (text, None) or (rewritten, {mod, note, original})."""
        answers = self._ask_all("prompt.submit", {"text": text}, PROMPT_SECONDS)
        for run, got in answers:
            new = got.get("rewrite")
            if run.manifest.rewrites_prompt and isinstance(new, str) and new.strip() and new != text:
                return new[:100_000], {"mod": run.manifest.title, "note": str(got.get("note") or "")[:200],
                                       "original": text}
        return text, None

    def run_command(self, name: str, args: str = "") -> dict | None:
        """A mod's own command: at once, with no model turn. None when no running mod has it."""
        with self._lock:
            run = next((r for r in self.running.values()
                        if self.on and r.proc.state == "running" and self._may_run(r.manifest)
                        and any(c["name"] == name for c in r.manifest.commands)), None)
        if run is None:
            return None
        try:
            got = run.proc.request("command", {"name": name, "args": args}, timeout=COMMAND_SECONDS) or {}
        except ModError as error:
            return {"mod": run.manifest.title, "error": str(error)}
        out = {"mod": run.manifest.title}
        if isinstance(got.get("text"), str):
            out["text"] = ui._text(got["text"], 20_000)
        if got.get("tree") is not None:
            try:
                out["tree"] = ui.clean(got["tree"])
            except ui.UIError as error:
                out["error"] = f"It drew something DGC can't show: {error}"
        return out

    def action(self, name: str, ident: str, value=None) -> None:
        with self._lock:
            run = self.running.get(name)
            if not self._closed and self.on and run is not None and run.proc.state == "running" and self._may_run(run.manifest):
                self._pool.submit(self._quiet_request, run, "ui.action", {"id": str(ident)[:64], "value": value})

    def _quiet_request(self, run, method, params):
        try:
            run.proc.request(method, params, timeout=COMMAND_SECONDS)
        except ModError:
            pass

    # -- what a mod asks of DGC ----------------------------------------------------------------------------------
    def _request(self, name: str, method: str, params: dict, *, process=None):
        run = self.running.get(name)
        if run is None or (process is not None and (run.proc is not process or process.state != "running")):
            raise ModError("This mod isn't running.")
        if not self.on or not self._may_run(run.manifest):
            raise ModError("This mod is no longer allowed to run.")
        m = run.manifest
        if method == "ui.set":
            slot = params.get("slot")
            if slot not in ("pane", "band", "status") or slot not in m.draws:
                raise ModError(f"It didn't declare drawing in {slot!r}.")
            self._set_ui(name, slot, params.get("tree"))
            return {}
        if method == "ui.toast":
            if "toast" not in m.draws:
                raise ModError("It didn't declare toasts.")
            toast = {"mod": m.title, "name": m.name, "text": ui._text(params.get("text"), 300),
                     "tone": params.get("tone") if params.get("tone") in ui.TONES else None, "at": time.time()}
            self.toasts = (self.toasts + [toast])[-20:]
            self._emit("toast", toast)
            return {}
        if method == "http.fetch":
            return self._fetch(m, params)
        if method == "files.read":
            return self._read_file(m, params)
        if method == "git.status":
            return self._git(m)
        if method == "usage.get":
            self._need(m, "usage")
            return self._provide("usage")
        if method == "transcript.get":
            self._need(m, "transcript")
            limit = params.get("limit") if isinstance(params.get("limit"), int) else 20
            return {"messages": self._provide("transcript", max(1, min(100, limit)))}
        if method == "model.complete":
            if not m.model:
                raise ModError("It didn't declare using your model.")
            prompt = str(params.get("prompt") or "")[:20_000]
            limit = params.get("max_tokens") if isinstance(params.get("max_tokens"), int) else 400
            return {"text": self._provide("complete", prompt, max(16, min(4000, limit)))}
        if method in ("store.get", "store.set", "state.get", "state.set"):
            return self._kept(m, method, params)
        if method == "log":
            run.proc.stderr.append(ui._text(params.get("text"), 500))
            return {}
        raise ModError(f"DGC has no {method}.")

    def _need(self, m: Manifest, read: str) -> None:
        if read not in m.reads:
            raise ModError(f"It didn't declare reading {read}.")

    def _provide(self, what: str, *args):
        fn = self.providers.get(what)
        if fn is None:
            raise ModError(f"{what} isn't available here.")
        return fn(*args)

    def _set_ui(self, name: str, slot: str, tree) -> None:
        if self.unattended:
            return                                       # nothing is on screen in a Pip's run
        try:
            cleaned = ui.clean(tree) if tree is not None else None
        except ui.UIError as error:
            raise ModError(f"DGC can't draw that: {error}") from None
        with self._lock:
            slots = self.ui_state.setdefault(name, {})
            if cleaned is None:
                slots.pop(slot, None)
            else:
                slots[slot] = cleaned
        run = self.running.get(name)
        self._emit("set", {"mod": run.manifest.title if run else name, "name": name, "slot": slot, "tree": cleaned})

    def _emit(self, kind: str, payload: dict) -> None:
        if self.on_ui is not None:
            try:
                self.on_ui(kind, payload)
            except Exception:                                # noqa: BLE001 -- a screen's trouble never stops a mod
                pass

    def _changed(self) -> None:
        self._emit("mods", {"mods": self.mods()})

    def _fetch(self, m: Manifest, params: dict) -> dict:
        url = str(params.get("url") or "")
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ModError("Give an http:// or https:// address.")
        if not _host_allowed(parts.hostname, m.network):
            raise ModError(f"{parts.hostname} isn't one of the hosts this mod declared.")
        method = str(params.get("method") or "GET").upper()
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
            raise ModError("method is GET, POST, PUT, PATCH, DELETE or HEAD.")
        headers = {str(k)[:100]: str(v)[:2000] for k, v in (params.get("headers") or {}).items()
                   if str(k).lower() not in ("host", "cookie")} if isinstance(params.get("headers"), dict) else {}
        body = params.get("body")
        data = body.encode("utf-8") if isinstance(body, str) else None
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        opener = urllib.request.build_opener(_Redirects(m.network))
        try:
            with opener.open(request, timeout=15) as answer:
                raw = answer.read(MAX_FETCH_BYTES + 1)
                status, head = answer.status, dict(answer.headers.items())
        except urllib.error.HTTPError as error:
            raw, status, head = error.read(MAX_FETCH_BYTES + 1), error.code, dict(error.headers.items())
        except (urllib.error.URLError, OSError) as error:
            raise ModError(f"The request failed: {getattr(error, 'reason', error)}") from None
        if len(raw) > MAX_FETCH_BYTES:
            raise ModError("The answer is larger than 1 MB.")
        return {"status": status, "headers": head, "text": raw.decode("utf-8", "replace")}

    def _read_file(self, m: Manifest, params: dict) -> dict:
        from ..artifacts import _private_rel
        from ..workspace import resolve_path, read_regular_bytes
        self._need(m, "project")
        if self.project_root is None:
            raise ModError("This session has no project.")
        rel = str(params.get("path") or "").replace("\\", "/").lstrip("/")
        if not rel or _private_rel(rel):
            raise ModError(f"{rel or 'That'} is private or not a file in the project.")
        try:
            target = resolve_path(rel, self.project_root)
        except (OSError, ValueError):
            raise ModError(f"{rel} isn't a file in the project.") from None
        if not target.is_file() or target.stat().st_size > MAX_READ_BYTES:
            raise ModError(f"{rel} isn't a file of at most 512 KB.")
        if _private_rel(target.relative_to(self.project_root).as_posix()):
            raise ModError(f"{rel} is private.")
        try:
            raw, _version = read_regular_bytes(target, maximum=MAX_READ_BYTES)
        except (OSError, ValueError) as exc:
            raise ModError(f"{rel} couldn't be read safely: {exc}") from None
        return {"text": raw.decode("utf-8", "replace")}

    def _git(self, m: Manifest) -> dict:
        self._need(m, "git")
        if self.project_root is None:
            raise ModError("This session has no project.")

        def run(*args):
            from ..worktree import _run_git
            done = _run_git(list(args), self.project_root, timeout=10, max_stdout=20_000,
                            text=True, read_only=True)
            return done.stdout if done.returncode == 0 else ""
        return {"status": run("status", "--porcelain=v1", "--branch")[:20_000],
                "diffstat": run("diff", "--no-ext-diff", "--no-textconv", "--stat")[:20_000]}

    def _kept(self, m: Manifest, method: str, params: dict):
        key = str(params.get("key") or "")[:100]
        if not key:
            raise ModError("Give a key.")
        if method.startswith("store."):
            path = dgc_home() / "mods" / "store" / f"{m.name}.json"
        else:
            safe = "".join(ch for ch in self.session_id if ch.isalnum() or ch in "-_")[:80] or "default"
            path = dgc_home() / "mods" / "state" / safe / f"{m.name}.json"
        with consent.write_lock():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            if not isinstance(data, dict):
                data = {}
            if method.endswith(".get"):
                return {"value": data.get(key)}
            data[key] = params.get("value")
            text = json.dumps(data, ensure_ascii=False)
            if len(text.encode("utf-8")) > MAX_STORE_BYTES:
                raise ModError("A mod keeps at most 256 KB.")
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            from ..workspace import atomic_write_bytes
            atomic_write_bytes(path, text.encode("utf-8"), mode=0o600)
            return {}
