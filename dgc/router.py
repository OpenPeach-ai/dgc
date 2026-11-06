"""DGC Router: spread sub-agents and Pip runs across the computers on the user's network that run models.

The main model decides; DGC enforces. A *system* is a model endpoint (no SSH, nothing installed on the other
computer): a sub-agent's tools still run here, only its model calls go there. A *worker* is one request a system
can work on at once; a *lease* is one worker held for one sub-agent, Pip run or main turn.

- Leases are shared by every chat of one process (one Router) and by every DGC process of this user on this
  computer (``~/.dgc/router/leases.json`` under a file lock, each lease with its PID and a heartbeat). A lease of
  a process that has died is dropped at once; one whose heartbeat stopped is dropped after LEASE_STALE_S.
- A system has a ceiling (``workers``) and each model its own; a one-model-at-a-time system never mixes models
  while it holds a lease, so a unified-memory box is never asked to swap a big model mid-run.
- Each model has ONE context per system. For Ollama it is sent as num_ctx on every request, so the model is
  never reloaded for a different window.
- A cheap check every HEALTH_EVERY_S marks a system offline after OFFLINE_AFTER misses. A sub-agent whose
  system fails mid-task (after the usual stall retries) moves to another system with the same model, else a
  compatible one with the sub-agents job; its result says what moved and why.

With the Router off (the default) nothing here is consulted: every route is 0.50's.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from . import router_state
from .config import ROUTER_JOBS, router_base_url, validate_router

LEASE_STALE_S = 30.0
HEARTBEAT_S = 10.0
HEALTH_EVERY_S = 60.0
OFFLINE_AFTER = 2
WAIT_POLL_S = 0.5
SIZE_ORDER = ("small", "medium", "large")
GUIDANCE = ("Small models suit search, reading and mechanical edits; give design, debugging and anything risky to "
            "the largest free model.")


class RouteRefused(Exception):
    """A route the model asked for that can't exist (no such system or model): said before anything starts."""


@dataclass
class Route:
    """One leased worker: where a sub-agent's or Pip's model calls go, and with what fixed context."""
    lease_id: str
    system_id: str
    system_name: str
    model: str
    base_url: str               # the system's address (no /v1)
    server: str
    api_mode: str
    context: int
    key: str = field(repr=False, default="")
    keep_alive: object = None
    params_b: float | None = None
    owner: str = ""
    job: str = ""
    waited_s: float = 0.0
    note: str = ""
    label: str = ""
    thinking: str = ""          # the model's own thinking choice on this system ("" = the helper's level)
    thinks: bool | None = None  # whether the model can think, as its server says (None: not known)

    @property
    def client_url(self) -> str:
        return self.base_url.rstrip("/") + "/v1"

    @property
    def client_api_mode(self) -> str:
        if self.api_mode:
            return self.api_mode
        return "ollama" if self.server == "ollama" else "auto"

# ---- reading the settings -----------------------------------------------------------------------------------------
def settings(config) -> dict:
    """The validated `router` block of ``config``: defaults when it has none or can't be read."""
    reader = getattr(config, "router_block", None)
    if callable(reader):
        try:
            value = reader()
        except Exception:                     # noqa: BLE001 -- a stub config: the Router is off
            value = None
        if isinstance(value, dict) and isinstance(value.get("systems"), list) and value.get("enabled") in (True, False):
            return value
        return validate_router(None)[0]
    try:
        raw = config.get("router")
    except Exception:                         # noqa: BLE001
        raw = None
    return validate_router(raw)[0]


def enabled(config) -> bool:
    return bool(settings(config).get("enabled"))


def find_system(block: dict, name: str) -> dict | None:
    """A system by its id, or (case-insensitively) its name."""
    wanted = str(name or "").strip().lower()
    for system in block.get("systems") or []:
        if system["id"] == wanted or system["name"].lower() == wanted:
            return system
    return None


def _key(config, system_id: str) -> str:
    reader = getattr(config, "router_key", None)
    try:
        return str(reader(system_id) or "") if callable(reader) else ""
    except Exception:                         # noqa: BLE001
        return ""


# How often a window looks for a DGC Router change made outside it (another window, `dgc router` in a terminal).
WATCH_EVERY_S = 2.0


def change_marks(config) -> tuple:
    """(settings, state): what Settings shows that another DGC process may change. ``settings``: the Router block as
    config.json holds it and which systems have a key or a dgc node's pairing token. ``state``: when the hardware
    readings, the servers' model lists and the tests were last written (the minute's health check writes the
    readings). Read only from disk; never a network call."""
    block = settings(config)
    from .router_hardware import token_for
    keys = [(item["id"], bool(_key(config, item["id"])), bool(token_for(config, item["id"]))) for item in block["systems"]]
    marks = []
    for name in ("hardware", "discovery", "probes"):
        try:
            info = (router_state.directory() / f"{name}.json").stat()
            marks.append((info.st_mtime_ns, info.st_size))
        except OSError:
            marks.append(None)
    return json.dumps([block, keys], sort_keys=True, default=str), tuple(marks)


def _private_host(base_url: str) -> bool:
    import ipaddress
    host = urlsplit(base_url).hostname or ""
    if host in ("localhost",) or host.endswith((".local", ".lan", ".home", ".internal")):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


def plain_http_warning(base_url: str) -> str:
    """The sentence Settings shows for an http:// address outside the user's own network."""
    if urlsplit(base_url).scheme == "http" and not _private_host(base_url):
        return "Systems on other networks aren't encrypted unless they use https."
    return ""


# ---- what DGC knows about each model -------------------------------------------------------------------------------
def _model_facts(system: dict, model: dict) -> dict:
    """Size, capabilities and measured speed of one configured model, from config, discovery and probes."""
    from .router_probe import params_from_name, size_class
    found = {m.get("name"): m for m in (router_state.discovery(system["id"]).get("models") or [])
             if isinstance(m, dict)}.get(model["name"], {})
    probe = router_state.probes(system["id"]).get(model["name"], {})
    params = model.get("params_b") or found.get("params_b") or params_from_name(model["name"])
    tools = model.get("tools")
    tools_test = probe.get("tools") if isinstance(probe.get("tools"), dict) else None
    if tools is None and tools_test is not None and "ok" in tools_test:
        tools = bool(tools_test["ok"])
    if tools is None and "tools" in found:
        tools = bool(found["tools"])
    speed = probe.get("speed") if isinstance(probe.get("speed"), dict) and probe["speed"].get("ok") else None
    parallel = probe.get("parallel") if isinstance(probe.get("parallel"), dict) and probe["parallel"].get("ok") else None
    return {"params_b": params, "size_class": size_class(params) if params else "", "tools": tools,
            "vision": found.get("vision"), "thinking": found.get("thinking"), "quant": found.get("quant", ""),
            "loaded": found.get("loaded", False),
            "pinned": bool(found.get("pinned")), "kind": found.get("kind", ""), "cloud": bool(found.get("cloud")),
            "context_max": found.get("context_max"), "loaded_context": found.get("loaded_context"),
            "tokens_per_s": (speed or {}).get("tokens_per_s"), "ttft_ms": (speed or {}).get("ttft_ms"),
            "speed_at": (speed or {}).get("at"), "parallel": (parallel or {}).get("runs"),
            "tools_test": tools_test}


def _eligible(system: dict, model: dict, facts: dict, job: str) -> tuple[bool, str]:
    if model.get("use") is False:
        return False, "not used"
    if facts.get("kind") == "embedding":
        return False, "an embedding model"
    if job == "subagents" and facts.get("tools") is False:
        return False, "can't call tools"
    return True, ""


# ---- leases ---------------------------------------------------------------------------------------------------------
def _alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class Router:
    """One per process: the leases this process holds, waiters, and the health of every system."""

    def __init__(self):
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._held: dict[str, dict] = {}
        self._health: dict[str, dict] = {}
        self._health_config = None
        self._health_thread: threading.Thread | None = None
        self._heartbeat_thread: threading.Thread | None = None
        self._listeners: list = []
        self.pid = os.getpid()

    # ---- the shared lease file -----------------------------------------------------------------------------
    def _live_leases(self, value: dict) -> list[dict]:
        now = time.time()
        leases = []
        for lease in value.get("leases") or []:
            if not isinstance(lease, dict) or not lease.get("id"):
                continue
            try:
                pid = int(lease.get("pid") or 0)
                heartbeat = float(lease.get("heartbeat") or 0)
            except (TypeError, ValueError, OverflowError):
                continue
            if not math.isfinite(heartbeat):
                continue
            if pid == self.pid:
                if lease["id"] in self._held:
                    leases.append(lease)
                continue                       # this process's own, released or from a forked parent: gone
            if not _alive(pid) or now - heartbeat > LEASE_STALE_S:
                continue
            leases.append(lease)
        return leases

    def leases(self) -> list[dict]:
        """Every live lease on this computer, this process's and others'."""
        with router_state.locked("leases"):
            value = router_state.read("leases")
            live = self._live_leases(value)
            if len(live) != len(value.get("leases") or []):
                router_state.write("leases", {"leases": live})
            return live

    def _counts(self, leases: list[dict]):
        per_system: dict[str, int] = {}
        per_model: dict[tuple[str, str], int] = {}
        models_on: dict[str, set] = {}
        for lease in leases:
            system, model = str(lease.get("system")), str(lease.get("model"))
            per_system[system] = per_system.get(system, 0) + 1
            per_model[(system, model)] = per_model.get((system, model), 0) + 1
            models_on.setdefault(system, set()).add(model)
        return per_system, per_model, models_on

    def _free(self, system: dict, model: dict, counts) -> bool:
        per_system, per_model, models_on = counts
        if per_system.get(system["id"], 0) >= system["workers"]:
            return False
        if per_model.get((system["id"], model["name"]), 0) >= model["workers"]:
            return False
        if system.get("one_model_at_a_time") and (models_on.get(system["id"], set()) - {model["name"]}):
            return False                       # it is running another model: never make it swap mid-run
        return True

    def candidates(self, config, job: str, *, system: str = "", model: str = "", size: str = "",
                   exclude=(), same_model: str = "", include_offline: bool = False) -> list[tuple[dict, dict, dict]]:
        """Every (system, model, facts) that may take this job, best first. Never touches the network."""
        block = settings(config)
        wanted_system = find_system(block, system) if system else None
        if system and wanted_system is None:
            raise RouteRefused(f"DGC Router has no system named {system!r}; its systems: "
                               + (", ".join(s["id"] for s in block["systems"]) or "none"))
        rows = []
        for place, item in enumerate(block["systems"]):
            if not item.get("enabled", True) or (job and job not in item.get("jobs", [])):
                continue
            if wanted_system is not None and item["id"] != wanted_system["id"]:
                continue
            if item["id"] in exclude or (self.offline(item["id"]) and not include_offline):
                continue
            for index, entry in enumerate(item["models"]):
                if model and entry["name"].lower() != model.lower():
                    continue
                facts = _model_facts(item, entry)
                ok, _why = _eligible(item, entry, facts, job)
                if not ok:
                    continue
                rows.append((place, index, item, entry, facts))
        if model and not rows and not any(entry["name"].lower() == model.lower()
                                          for item in block["systems"] for entry in item["models"]):
            raise RouteRefused(f"DGC Router has no system with the model {model!r}")

        def rank(row):
            place, index, item, entry, facts = row
            same = 0 if same_model and entry["name"] == same_model else 1
            if size and facts["size_class"]:
                distance = abs(SIZE_ORDER.index(facts["size_class"]) - SIZE_ORDER.index(size))
            else:
                distance = 1 if size else 0
            speed = -(facts.get("tokens_per_s") or 0.0)
            return (same, distance, speed, place, index)
        rows.sort(key=rank)
        return [(item, entry, facts) for _p, _i, item, entry, facts in rows]

    def acquire(self, config, job: str, *, system: str = "", model: str = "", size: str = "", owner: str = "",
                exclude=(), same_model: str = "", wait: bool | None = None, cancel: threading.Event | None = None,
                on_wait=None, require_enabled: bool = True, label: str = "") -> tuple[Route | None, str]:
        """Lease a worker for ``job``. Returns (route, "") or (None, why): "busy" (every worker taken and not
        waiting), "none" (no system can take it), or "cancelled". ``wait`` defaults to when_busy == "wait".
        ``owner`` is who holds it (a sub-agent's id: the agent map's badge); ``label`` is what it is doing in words
        (the helper's description, "Pip Inbox"), which is what a person is shown."""
        block = settings(config)
        if require_enabled and not block.get("enabled"):
            return None, "off"
        if wait is None:
            wait = block.get("when_busy", "wait") == "wait"
        started = time.monotonic()
        told = False
        while True:
            rows = self.candidates(config, job, system=system, model=model, size=size, exclude=exclude,
                                   same_model=same_model, include_offline=not require_enabled)
            if not rows:
                return None, "none"
            with self._lock:
                with router_state.locked("leases"):
                    value = router_state.read("leases")
                    live = self._live_leases(value)
                    counts = self._counts(live)
                    chosen = next(((s, m, f) for s, m, f in rows if self._free(s, m, counts)), None)
                    if chosen is not None:
                        item, entry, facts = chosen
                        lease = {"id": uuid.uuid4().hex[:16], "system": item["id"], "model": entry["name"],
                                 "pid": self.pid, "owner": str(owner)[:120], "job": job, "started": time.time(),
                                 "heartbeat": time.time()}
                        if label:
                            lease["label"] = " ".join(str(label).split())[:120]
                        live.append(lease)
                        self._held[lease["id"]] = lease
                        router_state.write("leases", {"leases": live})
                    elif len(live) != len(value.get("leases") or []):
                        router_state.write("leases", {"leases": live})
            if chosen is not None:
                self._ensure_heartbeat()
                route = Route(lease_id=lease["id"], system_id=item["id"], system_name=item["name"],
                              model=entry["name"], base_url=item["base_url"], server=item["server"],
                              api_mode=item.get("api_mode", ""), context=int(entry["context"]),
                              key=_key(config, item["id"]), keep_alive=-1 if facts.get("pinned") else None,
                              params_b=facts.get("params_b"), owner=str(owner), job=job,
                              waited_s=round(time.monotonic() - started, 1), label=lease.get("label", ""),
                              thinking=str(entry.get("thinking") or ""),
                              thinks=facts.get("thinking") if isinstance(facts.get("thinking"), bool) else None)
                self._changed("leased")
                return route, ""
            if not wait:
                return None, "busy"
            if not told and callable(on_wait):
                told = True
                try:
                    on_wait(rows)
                except Exception:              # noqa: BLE001 -- a status line never stops the wait
                    pass
            with self._cond:
                if cancel is not None and cancel.is_set():
                    return None, "cancelled"
                self._cond.wait(WAIT_POLL_S)
            if cancel is not None and cancel.is_set():
                return None, "cancelled"

    def mark_thinking(self, lease_id: str, level: str) -> None:
        """The thinking level the helper holding this worker uses ("" when its model can't think): shown on the
        lease, so the agent map says "on NAS · qwen3.5:9b · thinking low"."""
        with self._lock:
            held = self._held.get(lease_id)
            if held is None:
                return
            level = str(level or "")[:16]
            if level:
                held["thinking"] = level
            else:
                held.pop("thinking", None)
            with router_state.locked("leases"):
                value = router_state.read("leases")
                live = self._live_leases(value)
                for lease in live:
                    if lease.get("id") == lease_id:
                        if level:
                            lease["thinking"] = level
                        else:
                            lease.pop("thinking", None)
                router_state.write("leases", {"leases": live})
        self._changed("leased")

    def lease_system(self, config, system_id: str, *, owner: str = "", job: str = "images", wait: bool = True,
                     cancel: threading.Event | None = None) -> tuple["Route | None", str]:
        """One worker of one system for work that isn't a chat model's (an image generation): it counts against the
        system's workers, and on a one-model-at-a-time system it is a model of its own, so a big model and a picture
        never run there together. Returns (route, "") or (None, why): "offline", "none", "busy", "cancelled"."""
        block = settings(config)
        item = find_system(block, system_id)
        if item is None or not item.get("enabled", True):
            return None, "none"
        started = time.monotonic()
        while True:
            if self.offline(item["id"]):
                return None, "offline"
            with self._lock:
                with router_state.locked("leases"):
                    value = router_state.read("leases")
                    live = self._live_leases(value)
                    per_system, _per_model, models_on = self._counts(live)
                    free = per_system.get(item["id"], 0) < item["workers"] and not (
                        item.get("one_model_at_a_time") and (models_on.get(item["id"], set()) - {job}))
                    lease = None
                    if free:
                        lease = {"id": uuid.uuid4().hex[:16], "system": item["id"], "model": job, "pid": self.pid,
                                 "owner": str(owner)[:120], "job": job, "started": time.time(),
                                 "heartbeat": time.time()}
                        live.append(lease)
                        self._held[lease["id"]] = lease
                        router_state.write("leases", {"leases": live})
            if lease is not None:
                self._ensure_heartbeat()
                self._changed("leased")
                return Route(lease_id=lease["id"], system_id=item["id"], system_name=item["name"], model=job,
                             base_url=item["base_url"], server=item["server"], api_mode="", context=0,
                             owner=str(owner), job=job, waited_s=round(time.monotonic() - started, 1)), ""
            if not wait:
                return None, "busy"
            with self._cond:
                if cancel is not None and cancel.is_set():
                    return None, "cancelled"
                self._cond.wait(WAIT_POLL_S)
            if cancel is not None and cancel.is_set():
                return None, "cancelled"

    def release(self, route) -> None:
        lease_id = getattr(route, "lease_id", None) if not isinstance(route, str) else route
        if not lease_id:
            return
        with self._lock:
            if self._held.pop(lease_id, None) is None:
                return
            with router_state.locked("leases"):
                value = router_state.read("leases")
                live = [lease for lease in self._live_leases(value) if lease.get("id") != lease_id]
                router_state.write("leases", {"leases": live})
            self._cond.notify_all()
        self._changed("released")

    def held(self) -> list[dict]:
        with self._lock:
            return [dict(lease) for lease in self._held.values()]

    def _ensure_heartbeat(self) -> None:
        with self._lock:
            if self._heartbeat_thread is not None and self._heartbeat_thread.is_alive():
                return
            self._heartbeat_thread = threading.Thread(target=self._heartbeat, name="dgc-router-heartbeat",
                                                      daemon=True)
            self._heartbeat_thread.start()

    def _heartbeat(self) -> None:
        while True:
            time.sleep(HEARTBEAT_S)
            with self._lock:
                if not self._held:
                    self._heartbeat_thread = None
                    return
                try:
                    with router_state.locked("leases"):
                        value = router_state.read("leases")
                        live = self._live_leases(value)
                        now = time.time()
                        known = {lease["id"] for lease in live}
                        for lease in live:
                            if lease.get("pid") == self.pid:
                                lease["heartbeat"] = now
                        for lease_id, lease in self._held.items():
                            if lease_id not in known:     # the file was lost or cleared: ours still stand
                                lease["heartbeat"] = now
                                live.append(lease)
                        router_state.write("leases", {"leases": live})
                except OSError:
                    pass
            with self._cond:
                self._cond.notify_all()        # a lease from a dead process may have gone: waiters look again

    # ---- health ---------------------------------------------------------------------------------------------
    def offline(self, system_id: str) -> bool:
        with self._lock:
            return int((self._health.get(system_id) or {}).get("misses", 0)) >= OFFLINE_AFTER

    def health(self, system_id: str) -> dict:
        with self._lock:
            row = dict(self._health.get(system_id) or {})
        if not row:
            return {"state": "unknown"}
        row["state"] = "offline" if row.get("misses", 0) >= OFFLINE_AFTER else "online"
        return row

    def record_health(self, system_id: str, ok: bool, latency_ms: int = 0, error: str = "") -> None:
        with self._lock:
            row = self._health.setdefault(system_id, {"misses": 0})
            was_offline = row.get("misses", 0) >= OFFLINE_AFTER
            row["checked"] = time.time()
            if ok:
                row.update(misses=0, latency_ms=int(latency_ms), error="")
                row.pop("offline_since", None)
            else:
                row["misses"] = int(row.get("misses", 0)) + 1
                row["error"] = str(error)[:200]
                if row["misses"] >= OFFLINE_AFTER and not was_offline:
                    row["offline_since"] = time.time()
            now_offline = row.get("misses", 0) >= OFFLINE_AFTER
            self._cond.notify_all()
        if now_offline != was_offline:
            self._changed("offline" if now_offline else "online")

    def check(self, config, system_ids=None) -> None:
        """One health round now (in parallel, a few seconds at most)."""
        from concurrent.futures import ThreadPoolExecutor
        from .router_probe import health as check_one
        systems = [s for s in settings(config)["systems"] if s.get("enabled", True)
                   and (system_ids is None or s["id"] in system_ids)]
        if not systems:
            return
        with ThreadPoolExecutor(max_workers=min(8, len(systems)), thread_name_prefix="dgc-router-health") as pool:
            answers = list(pool.map(lambda s: check_one(s["base_url"], s["server"], _key(config, s["id"])), systems))
        for system, (ok, latency, why) in zip(systems, answers):
            self.record_health(system["id"], ok, latency, why)
        # The hardware readout (optional, per system) rides the same check, at most once a minute each.
        try:
            from . import router_hardware
            router_hardware.refresh(config, systems)
        except Exception:                      # noqa: BLE001 -- a readout never stops the health check
            pass

    def ensure_health(self, config) -> None:
        """While the Router is on, check every system every HEALTH_EVERY_S (on a thread of its own)."""
        if not enabled(config):
            return
        with self._lock:
            self._health_config = config
            if self._health_thread is not None and self._health_thread.is_alive():
                return
            self._health_thread = threading.Thread(target=self._health_loop, name="dgc-router-health", daemon=True)
            self._health_thread.start()

    def _health_loop(self) -> None:
        while True:
            with self._lock:
                config = self._health_config
            if config is None or not enabled(config):
                with self._lock:
                    self._health_thread = None
                return
            try:
                self.check(config)
            except Exception:                  # noqa: BLE001 -- a check never stops the checks
                pass
            time.sleep(HEALTH_EVERY_S)

    # ---- listeners (router_changed) ----------------------------------------------------------------------
    def listen(self, callback) -> None:
        with self._lock:
            if callback not in self._listeners:
                self._listeners.append(callback)

    def unlisten(self, callback) -> None:
        with self._lock:
            if callback in self._listeners:
                self._listeners.remove(callback)

    def _changed(self, why: str) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for callback in listeners:
            try:
                callback(why)
            except Exception:                  # noqa: BLE001 -- a listener never breaks routing
                pass


ROUTER = Router()


# ---- status ---------------------------------------------------------------------------------------------------------
def status(config, *, refresh: bool = False, router: Router | None = None) -> dict:
    """Every system with its jobs, models (size, quant, context, tools, vision), workers busy and free, health,
    last measured speed and parallel count. ``refresh`` checks health and re-reads every server first."""
    router = router or ROUTER
    block = settings(config)
    router.ensure_health(config)
    if refresh and block["systems"]:
        refresh_discovery(config, router=router)
    leases = router.leases() if block["systems"] else []
    counts = router._counts(leases)
    systems = []
    total = free_total = 0
    for item in block["systems"]:
        per_system, per_model, models_on = counts
        busy = per_system.get(item["id"], 0)
        health = router.health(item["id"])
        models = []
        for entry in item["models"]:
            facts = _model_facts(item, entry)
            ok, why = _eligible(item, entry, facts, "subagents")
            used = per_model.get((item["id"], entry["name"]), 0)
            row = {"name": entry["name"], "workers": entry["workers"], "busy": used,
                   "free": max(0, entry["workers"] - used) if router._free(item, entry, counts) else 0,
                   "context": entry["context"], **({"note": entry["note"]} if entry.get("note") else {}),
                   **{key: value for key, value in facts.items() if value not in (None, "", False)
                      and key in ("params_b", "size_class", "quant", "tools", "vision", "loaded", "cloud",
                                  "context_max", "tokens_per_s", "ttft_ms", "speed_at", "parallel")}}
            if facts.get("tools") is False:
                row["tools"] = False
            if entry.get("use") is False:
                row["use"] = False
            # Its thinking: the choice on this system ("" = the helper's level), and whether it can think at all.
            if entry.get("thinking"):
                row["thinking"] = entry["thinking"]
            if isinstance(facts.get("thinking"), bool):
                row["thinks"] = facts["thinking"]
            if not ok and why:
                row["subagents"] = f"not for sub-agents: {why}"
            models.append(row)
        free = 0 if health["state"] == "offline" or not item.get("enabled", True) else max(0, item["workers"] - busy)
        if item.get("enabled", True):
            total += item["workers"]
            free_total += free
        row = {"id": item["id"], "name": item["name"], "base_url": item["base_url"], "server": item["server"],
               "enabled": item.get("enabled", True), "jobs": item["jobs"], "workers": item["workers"],
               "busy": busy, "free": free, "one_model_at_a_time": item["one_model_at_a_time"],
               "health": health, "models": models, "has_key": bool(_key(config, item["id"])),
               "leases": [{"owner": lease.get("owner", ""), "model": lease.get("model"), "job": lease.get("job"),
                           "label": lease_label(lease), "started": lease.get("started"),
                           "this_process": lease.get("pid") == router.pid,
                           **({"thinking": lease["thinking"]} if lease.get("thinking") else {})}
                          for lease in leases if lease.get("system") == item["id"]]}
        warning = plain_http_warning(item["base_url"])
        if warning:
            row["warning"] = warning
        if item.get("memory_gb"):
            row["memory_gb"] = item["memory_gb"]
        found = router_state.discovery(item["id"])
        # What a context costs here, for Settings' "≈ 4.4 GB each · 2 workers ≈ 8.8 GB of 64 GB free" (Suggest's own
        # arithmetic, dgc/router_suggest.py): the memory it has and keeps free, and each model's weights and context
        # memory per token, where DGC knows them.
        from . import router_suggest
        mem = router_suggest.memory(item)
        if mem.get("total_bytes"):
            row["memory"] = {"total_bytes": int(mem["total_bytes"]),
                             "kept_free_bytes": int(router_suggest.headroom(float(mem["total_bytes"]),
                                                                          bool(mem.get("unified")))),
                             "source": str(mem.get("source") or "")}
        known = {m.get("name"): m for m in found.get("models") or [] if isinstance(m, dict) and m.get("name")}
        for model_row in models:
            sized = _memory_facts(known.get(model_row["name"]))
            if sized:
                model_row.update(sized)
        if found.get("load"):
            row["server_load"] = found["load"]
        if found.get("slots"):
            row["server_slots"] = found["slots"]
        # The server's own room, for Settings' check beside the total context (llama.cpp's context per slot; vLLM's
        # and SGLang's tokens of context memory in all), and every model it serves, for Settings to offer.
        if isinstance(found.get("slot_context"), int) and found["slot_context"] > 0:
            row["server_slot_context"] = found["slot_context"]
        if isinstance(found.get("kv_tokens"), int) and found["kv_tokens"] > 0:
            row["server_kv_tokens"] = found["kv_tokens"]
        available = _available(found)
        if available:
            row["available"] = available
        if found.get("error"):
            row["discovery_error"] = found["error"]
        from .router_hardware import status_row
        hardware = status_row(config, item)
        if hardware is not None:
            row["hardware"] = hardware
        systems.append(row)
    return {"enabled": block["enabled"], "when_busy": block["when_busy"], "systems": systems,
            "workers": {"total": total, "free": free_total, "busy": total - free_total},
            "line": prompt_line(config, router=router) if block["enabled"] else ""}


_AVAILABLE_FACTS = ("params_b", "size_class", "quant", "context_max", "tools", "vision", "loaded", "loaded_context",
                    "cloud", "kind")
MAX_AVAILABLE = 64


def _memory_facts(model) -> dict:
    """{"weights_bytes", "kv_bytes_per_token"} as Suggest counts them (dgc/router_suggest.py), each when known."""
    if not isinstance(model, dict):
        return {}
    from .router_suggest import _weights
    out = {}
    try:
        weights = _weights(model)
    except (TypeError, ValueError):
        weights = None
    if weights:
        out["weights_bytes"] = int(weights)
    kv = model.get("kv_bytes_per_token")
    if isinstance(kv, (int, float)) and not isinstance(kv, bool) and math.isfinite(kv) and kv > 0:
        out["kv_bytes_per_token"] = int(kv)
    return out


def _available(found: dict) -> list[dict]:
    """The models a system's server serves, as DGC last read them (status' ``available``): name and what is known of
    each, the ones it can't use for chat (embedding models) included and marked, at most MAX_AVAILABLE."""
    rows = []
    for model in found.get("models") or []:
        if not isinstance(model, dict) or not isinstance(model.get("name"), str) or not model["name"]:
            continue
        row = {"name": model["name"][:256], **_memory_facts(model)}
        for key in _AVAILABLE_FACTS:
            value = model.get(key)
            if value is False and key == "tools":
                row[key] = False
            elif value not in (None, "", False):
                row[key] = value
        rows.append(row)
        if len(rows) >= MAX_AVAILABLE:
            break
    return rows


def refresh_discovery(config, *, router: Router | None = None, system_ids=None) -> None:
    """Check health and re-read what each (enabled) system serves, all at once, a few seconds at most."""
    from concurrent.futures import ThreadPoolExecutor
    from .router_probe import ProbeError, discover
    router = router or ROUTER
    systems = [s for s in settings(config)["systems"] if system_ids is None or s["id"] in system_ids]
    if not systems:
        return
    router.check(config, [s["id"] for s in systems])

    def read(item):
        if router.offline(item["id"]):
            return item, None
        try:
            return item, discover(item["base_url"], item["server"], _key(config, item["id"]))
        except ProbeError as exc:
            return item, {"error": str(exc), "at": time.time(), "models": []}
    with ThreadPoolExecutor(max_workers=min(8, len(systems)), thread_name_prefix="dgc-router-read") as pool:
        for item, found in pool.map(read, systems):
            if found is None:
                continue
            if found.get("error"):
                previous = router_state.discovery(item["id"])
                found = {**previous, "error": found["error"], "at": found["at"]} if previous.get("models") else found
            router_state.save_discovery(item["id"], found)


def prompt_line(config, *, router: Router | None = None) -> str:
    """One short line for the system prompt: systems, models and free workers, from what DGC already knows
    (never a network read): ``Systems: spark qwen3.8:32b 2/3 free, qwen3:8b 4/4 · nas qwen3:4b 2/2 (Pips only)``."""
    router = router or ROUTER
    block = settings(config)
    if not block["enabled"] or not block["systems"]:
        return ""
    try:
        counts = router._counts([lease for lease in router.leases()
                                 if not (lease.get("pid") == router.pid and lease.get("job") == "main")])
    except OSError:
        counts = ({}, {}, {})
    parts = []
    for item in block["systems"]:
        if not item.get("enabled", True):
            continue
        if router.offline(item["id"]):
            parts.append(f"{item['id']} offline")
            continue
        models = []
        for entry in item["models"]:
            if entry.get("use") is False:
                continue
            facts = _model_facts(item, entry)
            if facts.get("kind") == "embedding":
                continue
            used = counts[1].get((item["id"], entry["name"]), 0)
            free = max(0, entry["workers"] - used) if router._free(item, entry, counts) else 0
            size = f" {facts['params_b']:g}B" if facts.get("params_b") and str(facts["params_b"]) not in entry["name"] \
                and not re.search(r"\d+(?:\.\d+)?b", entry["name"].lower()) else ""
            tools = " no tools" if facts.get("tools") is False else ""
            models.append(f"{entry['name']}{size} {free}/{entry['workers']}{tools}")
        if not models:
            continue
        jobs = item.get("jobs") or []
        only = "" if "subagents" in jobs and "pips" in jobs else (" (Pips only)" if "pips" in jobs else
                                                                  " (sub-agents only)" if "subagents" in jobs else
                                                                  " (no jobs)")
        parts.append(f"{item['id']} " + ", ".join(models) + only)
    return "Systems: " + " · ".join(parts) if parts else ""


# ---- the agent's side: sub-agents ------------------------------------------------------------------------------------
_HINT_KEYS = ("system", "model", "size")


def hints_from_call(arguments) -> dict:
    """The routing hints a `task` call (or one of its `tasks`) carries: system, model, size."""
    if not isinstance(arguments, dict):
        return {}
    hint = {}
    for key in _HINT_KEYS:
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            hint[key] = value.strip()[:256]
    if hint.get("size") and hint["size"].lower() not in SIZE_ORDER:
        hint.pop("size")
    elif hint.get("size"):
        hint["size"] = hint["size"].lower()
    return hint


def task_hint_error(config, arguments) -> str:
    """Why a `task` call's system/model can't be honoured, before anything starts ("" when it can)."""
    if not enabled(config):
        return ""
    items = arguments.get("tasks") if isinstance(arguments, dict) and isinstance(arguments.get("tasks"), list) \
        else [arguments]
    top = hints_from_call(arguments)
    for item in items:
        hint = {**top, **hints_from_call(item)}
        if not hint.get("system") and not hint.get("model"):
            continue
        try:
            ROUTER.candidates(config, "subagents", system=hint.get("system", ""), model=hint.get("model", ""))
        except RouteRefused as exc:
            return f"error: {exc}. Call router_status to see the systems and their models."
    return ""


def lease_label(lease: dict) -> str:
    """What a worker is busy with, in words a person reads ("count bolts", "Pip Inbox"), never an internal id: the
    lease's own label, else what kind of job it is."""
    label = str(lease.get("label") or "").strip()
    if label:
        return label
    return {"main": "the main chat", "pips": "a Pip run", "subagents": "a helper"}.get(str(lease.get("job") or ""),
                                                                                      "a test")


def subagent_route(agent, hint: dict, *, owner: str, cancel=None, registry=None, agent_id=None, label: str = ""):
    """A leased client for a sub-agent, or None for the usual route (Router off, nothing fits, or busy with
    when_busy = default). Leaves a note for the task result on ``agent._router_notes[owner]``."""
    config = agent.config
    notes = agent.__dict__.setdefault("_router_notes", {})
    if not enabled(config):
        if hint:
            notes[owner] = ("DGC Router is off, so " + "/".join(sorted(hint)) + " was not used; this helper ran on "
                            "the usual sub-agent model.")
        return None
    ROUTER.ensure_health(config)

    def waiting(_rows):
        if registry is not None and agent_id:
            try:
                registry.activity(agent_id, "waiting for a free worker (DGC Router)")
            except Exception:                  # noqa: BLE001
                pass
    route, why = ROUTER.acquire(config, "subagents", system=hint.get("system", ""), model=hint.get("model", ""),
                                size=hint.get("size", ""), owner=owner, cancel=cancel, on_wait=waiting, label=label)
    if route is None:
        if why == "busy":
            notes[owner] = "DGC Router: every worker was busy, so this helper ran on the usual sub-agent model."
        elif why == "none":
            notes[owner] = ("DGC Router: no online system with the sub-agents job could take it, so this helper "
                            "ran on the usual sub-agent model.")
        return None
    client = client_for(agent, route)
    if route.waited_s >= 1:
        route.note = f"waited {route.waited_s:g}s for a free worker"
    return client


def client_for(agent, route: Route):
    """An LLMClient for ``route``, built like every other client of ``agent``, with the worker's fixed context."""
    from .agent import Agent
    try:
        client = Agent._new_client(agent, route.client_url, route.key, route.model, api_mode=route.client_api_mode,
                                   source="subagent")
        client.context_size = int(route.context)
        # Another computer's server keeps its own residency: a model it keeps loaded for good stays so (-1), and
        # otherwise DGC sends no keep_alive at all, so that server's own default applies, not this computer's setting.
        client.keep_alive = route.keep_alive if route.keep_alive is not None else ""
        client._router_route = route
        return client
    except Exception:
        ROUTER.release(route)
        raise


def move(agent, error_text: str, *, cancel=None, attempts: int | None = None):
    """The sub-agent's system failed mid-task (after the stall retries): release its worker, and lease one on
    another system with the same model, else a compatible one. Returns the new client or None."""
    client = getattr(agent, "client", None)
    route = getattr(client, "_router_route", None)
    if route is None:
        return None
    ROUTER.release(route)
    ROUTER.record_health(route.system_id, False, 0, error_text)
    failed = agent.__dict__.setdefault("_router_failed", set())
    failed.add(route.system_id)
    try:
        moved, _why = ROUTER.acquire(agent.config, "subagents", owner=route.owner, exclude=tuple(failed),
                                     same_model=route.model, cancel=cancel, label=route.label)
    except RouteRefused:
        moved = None
    agent.__dict__.setdefault("_router_moves", []).append(
        {"from": route.system_name, "from_model": route.model, "to": moved.system_name if moved else "",
         "to_model": moved.model if moved else "", "why": error_text,
         **({"attempts": int(attempts)} if isinstance(attempts, int) and attempts > 0 else {})})
    if moved is None:
        return None
    new = client_for(agent, moved)
    config = getattr(agent, "config", None)
    data = getattr(config, "data", None)
    if isinstance(data, dict):
        data["context_size"] = int(moved.context)
    return new


def release_agent(agent) -> None:
    """Give back every worker a sub-agent (or Pip run) still holds."""
    client = getattr(agent, "client", None)
    route = getattr(client, "_router_route", None)
    if route is not None:
        ROUTER.release(route)


def result_note(agent, owner: str) -> str:
    """What the task result says about where the helper ran and anything that moved: one or two sentences."""
    notes = getattr(agent, "_router_notes", None) or {}
    parts = []
    if notes.get(owner):
        parts.append(notes.pop(owner))
    return " ".join(parts)


def child_note(child) -> str:
    client = getattr(child, "client", None)
    route = getattr(client, "_router_route", None)
    moves = getattr(child, "_router_moves", None) or []
    if route is None and not moves:
        return ""
    words = []
    if route is not None:
        # The level it thought at, as its row and the agent map say it ("" for a model that can't think, or a helper
        # following a main chat that doesn't): the terminal shows only this result.
        thinking = str(getattr(child, "_router_thinking", "") or "")
        thinking = {"xhigh": "extra high"}.get(thinking, thinking)
        words.append(f"DGC Router: ran on {route.system_name} ({route.model}"
                     + (f", {route.note}" if route.note else "") + (f", thinking {thinking}" if thinking else "") + ").")
    for item in moves:
        why = re.sub(r"\s+", " ", str(item.get("why") or "it stopped answering")).strip()[:160]
        tries = item.get("attempts")
        after = f"after {tries} failed tries" if isinstance(tries, int) and tries > 1 else "after it failed"
        if item.get("to"):
            words.append(f"Moved from {item['from']} ({item['from_model']}) to {item['to']} ({item['to_model']}) "
                         f"{after}: {why}.")
        else:
            words.append(f"{item['from']} failed {after} ({why}) and no other system could take the work.")
    return " ".join(words)


# ---- the main turn's own worker -----------------------------------------------------------------------------------
def _same_endpoint(left: str, right: str) -> bool:
    a, _ = router_base_url(left)
    b, _ = router_base_url(right)
    return bool(a) and a == b


def runs_elsewhere(system: dict, model: str) -> bool:
    """Whether ``model`` on ``system`` runs on other hardware than that computer's: an Ollama cloud model (":cloud",
    "-cloud", or one discovery found to be a stub of a few bytes) is run by Ollama's service, using no GPU there."""
    if str(model).endswith((":cloud", "-cloud")):
        return True
    found = next((m for m in router_state.discovery(system["id"]).get("models") or []
                  if isinstance(m, dict) and m.get("name") == model), {})
    return bool(found.get("cloud"))


def hold_main(agent):
    """While a main turn runs on a model whose endpoint IS one of the systems, and on that computer's own hardware,
    that system has one worker fewer. A cloud model behind the same address (Ollama's :cloud models) holds none: it
    uses no GPU there, so a one-worker system still takes a helper. Never waits, never fails the turn."""
    config = getattr(agent, "config", None)
    try:
        if config is None or not enabled(config):
            return None
        base = str(getattr(config, "base_url", "") or "")
        model = str(getattr(config, "model", "") or "")
        block = settings(config)
        target = next((s for s in block["systems"] if s.get("enabled", True) and _same_endpoint(s["base_url"], base)),
                      None)
        if target is None or runs_elsewhere(target, model):
            return None
        with ROUTER._lock:
            with router_state.locked("leases"):
                value = router_state.read("leases")
                live = ROUTER._live_leases(value)
                busy = sum(1 for lease in live if lease.get("system") == target["id"])
                if busy >= target["workers"]:
                    router_state.write("leases", {"leases": live})
                    return None
                lease = {"id": uuid.uuid4().hex[:16], "system": target["id"], "model": model, "pid": ROUTER.pid,
                         "owner": "main turn", "label": "the main chat", "job": "main", "started": time.time(),
                         "heartbeat": time.time()}
                live.append(lease)
                ROUTER._held[lease["id"]] = lease
                router_state.write("leases", {"leases": live})
        ROUTER._ensure_heartbeat()
        ROUTER._changed("leased")
        return lease["id"]
    except Exception:                          # noqa: BLE001 -- the Router never costs a turn
        return None


def release_main(lease_id) -> None:
    if lease_id:
        try:
            ROUTER.release(lease_id)
        except Exception:                      # noqa: BLE001
            pass


def jobs_text(jobs) -> str:
    return " and ".join({"subagents": "sub-agents", "pips": "Pips", "images": "images"}.get(job, job)
                        for job in jobs) or "nothing"


def as_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


__all__ = ["ROUTER", "ROUTER_JOBS", "Route", "RouteRefused", "Router", "settings", "enabled", "status",
           "prompt_line", "hints_from_call", "task_hint_error", "subagent_route", "client_for", "move",
           "release_agent", "child_note", "hold_main", "release_main", "GUIDANCE"]
