"""DGC Router's tools for the main model, and the one change path every surface shares.

- ``router_status`` (read): every system, its jobs, models, workers busy and free, health and measured speed.
- ``router_probe`` (read; a few seconds of that computer's GPU): discovery, speed, parallel and tool-call tests.
- ``router_update`` (a change): ALWAYS an Allow card with the exact diff of the settings, in every mode. It can
  never read or write a key: a system that needs one is added without it, and the user pastes the key.
- ``router_find`` (asks first): model servers on the user's own /24, known ports only.

They are offered every turn, Router on or off (the model decides; dgc/agent.py _tool_schemas), and never to a
session a launching application's policy governs (its SDK can't name them; it has session.router instead).
plan_update / apply_plan are also what `dgc router`, `/router`, the editor's router_update command and the SDK use,
so a change reads and validates the same everywhere.
"""
from __future__ import annotations

import copy
import difflib
import json
import re
import time
from dataclasses import dataclass, field

from . import router as router_mod
from . import router_state
from .config import (ROUTER_DEFAULT_CONTEXT, ROUTER_JOBS, ROUTER_WHEN_BUSY, router_base_url, router_slug,
                     validate_router)
from .tools import _fn

ACTIONS = ("turn_on", "turn_off", "add_system", "edit_system", "remove_system", "enable_system", "disable_system",
           "set_model", "set_jobs", "set_when_busy", "set_hardware", "apply_suggestion")
TOOL_NAMES = frozenset({"router_status", "router_probe", "router_update", "router_find"})
# Never a key, whatever a call says (router_update, the editor's command, the CLI's --set).
_KEY_WORDS = ("key", "api_key", "token", "secret", "password", "authorization")

SCHEMAS = [
    _fn("router_status", "DGC Router: the user's other computers that run models (systems), for sub-agents and Pips. "
        "Lists every system with its jobs, models (size, quant, context, tools, vision), workers busy and free, "
        "whether it is online, its last measured speed and parallel count, and what its hardware is doing when the "
        "user set up a readout (GPU, memory, utilisation, temperature). Says when the Router is off. Read it before "
        "naming a system in task, and when the user asks why helpers are slow or what is available.",
        {"refresh": {"type": "boolean", "description": "Check every system and re-read what it serves first "
                     "(a few seconds). Default false: what DGC already knows"}}, []),
    _fn("router_probe", "DGC Router: test one system now and save the results: models (what it serves), speed "
        "(time to first token, tokens a second), parallel (how many requests it runs at once) and tools (whether a "
        "model calls a tool correctly). Its answer ends with a suggestion: workers per model, with the memory "
        "arithmetic (router_update apply_suggestion uses it). Uses a few seconds of that computer's GPU, so run it "
        "when the user asks or a new system was just added, not by reflex.",
        {"system": {"type": "string", "description": "The system's id or name (router_status)"},
         "model": {"type": "string", "description": "One of its models; omit for every model it uses (up to 3)"},
         "checks": {"type": "array", "items": {"type": "string", "enum": ["models", "speed", "parallel", "tools"]},
                    "description": "Which tests; default all four"}}, ["system"]),
    _fn("router_update", "DGC Router: change its settings on the user's ask. Every call shows the user an Allow "
        "card with the exact change; nothing changes until they allow it. turn_on/turn_off switch the Router; "
        "add_system adds a computer by its address (DGC detects the server and lists its models); edit_system, "
        "remove_system, enable_system, disable_system; set_model (use, workers, context, note, thinking); set_jobs; "
        "set_when_busy (wait for a free worker, or use the usual sub-agent model); set_hardware reads what a "
        "computer's GPU and memory are doing from an exporter the user runs (node_exporter, NVIDIA DCGM, AMD's "
        "exporter, Glances, Netdata) or a dgc node, by its address (empty turns it off); apply_suggestion sets each "
        "model's workers from Suggest's memory arithmetic. It never reads or sets a key or token: for a system or "
        "dgc node that needs one, tell the user to paste it in Settings (or /router key, /router token in the "
        "terminal).",
        {"action": {"type": "string", "enum": list(ACTIONS)},
         "system": {"type": "string", "description": "The system's id or name; for add_system, an id to give it "
                    "(optional: one is made from its name)"},
         "name": {"type": "string", "description": "add_system / edit_system: the name the user calls it"},
         "base_url": {"type": "string", "description": "add_system / edit_system: its address, e.g. gpu-box.local, "
                      "nas.local:11434 or http://10.0.0.5:8080"},
         "jobs": {"type": "array", "items": {"type": "string", "enum": list(ROUTER_JOBS)},
                  "description": "add_system / set_jobs: what it may do: subagents, pips"},
         "models": {"type": "array", "items": {"type": "string"},
                    "description": "add_system: which of its models to use (default: the ones it has loaded now; "
                                   "with none loaded, DGC asks you to ask the user)"},
         "workers": {"type": "integer", "description": "add_system / edit_system: the most requests at once on the "
                     "system; set_model: the most at once for that model"},
         "one_model_at_a_time": {"type": "boolean", "description": "add_system / edit_system: never mix models "
                                 "while it works (a unified-memory computer that holds one big model)"},
         "memory_gb": {"type": "number", "description": "add_system / edit_system: its memory in GB, if known"},
         "model": {"type": "string", "description": "set_model: which model"},
         "use": {"type": "boolean", "description": "set_model: use it (false keeps it listed but unused)"},
         "context": {"type": "integer", "description": "set_model: its fixed context in tokens on that system; "
                     "add_system: the context for every model it adds; "
                     "apply_suggestion: the context to plan for (default: each model's own)"},
         "hardware_url": {"type": "string", "description": "set_hardware: the exporter's or dgc node's address, e.g. "
                          "http://nas.local:9100/metrics, mac.local:61208 or gpu-box.local:8577; empty turns it off"},
         "note": {"type": "string", "description": "set_model: a short note on what it is good at"},
         "thinking": {"type": "string", "enum": ["", "off", "low", "medium", "high"],
                      "description": "set_model: how hard a helper on this model thinks; empty is the helper's own "
                      "level. Only for a model that can think (router_status says which can't)"},
         "when_busy": {"type": "string", "enum": list(ROUTER_WHEN_BUSY),
                       "description": "set_when_busy: wait, or default (the usual sub-agent model)"}},
        ["action"]),
    _fn("router_find", "DGC Router: look for model servers on the user's own network (this computer's /24, the "
        "known ports only: 11434, 8080, 1234, 8000, 30000, 8188). Asks the user first. Use it only when they ask "
        "to find or add their computers; then add what they choose with router_update.",
        {"subnet": {"type": "string", "description": "Leave out: DGC uses this computer's own network"}}, []),
]


class UpdateError(ValueError):
    pass


class ChooseModels(UpdateError):
    """add_system without models where the server has nothing loaded: DGC chooses none (it would load a model on that
    computer), and the user chooses from ``choices``."""

    def __init__(self, name: str, choices: list[str]):
        self.name, self.choices = name, choices
        super().__init__(f"nothing is loaded on {name} now, so DGC didn't choose its models (using one loads it on "
                         f"that computer). Ask the user which to use, then add it again with models. It serves: "
                         f"{choices_text(choices)}")


@dataclass
class UpdatePlan:
    """One change, worked out before anyone is asked: the settings now, the settings after, and in words."""
    action: str
    before: dict
    after: dict
    summary: str
    notes: list[str] = field(default_factory=list)
    needs_key: str = ""
    discovered: dict | None = None
    system_id: str = ""
    reading: dict | None = None          # set_hardware: the first reading, taken once it is saved
    done: str = ""                       # what was done, in words, once it is made (apply_suggestion: "Applied: …")

    @property
    def diff(self) -> str:
        old = json.dumps({"router": self.before}, indent=2, ensure_ascii=False).splitlines(keepends=True)
        new = json.dumps({"router": self.after}, indent=2, ensure_ascii=False).splitlines(keepends=True)
        return "".join(difflib.unified_diff(old, new, fromfile="a/~/.dgc/config.json",
                                            tofile="b/~/.dgc/config.json"))

    def card(self) -> dict:
        """What the Allow card shows: the change in words, and the exact diff."""
        return {"change": self.summary, "diff": self.diff, **({"notes": self.notes} if self.notes else {})}

    def said(self) -> str:
        """The change once made, in words: what was done (Settings' note under the card, the CLI's first line)."""
        return self.done + "." if self.done else " ".join([self.summary + ".", *self.notes])


def _refuse_keys(args: dict) -> None:
    for key in args:
        if any(word in str(key).lower() for word in _KEY_WORDS):
            raise UpdateError("router_update never reads or sets a key: ask the user to paste it in Settings → "
                              "Models → DGC Router (or /router key in the terminal)")


def _system(block: dict, name: str) -> dict:
    found = router_mod.find_system(block, name)
    if found is None:
        raise UpdateError(f"there is no system {name!r}; systems: "
                          + (", ".join(s["id"] for s in block["systems"]) or "none yet"))
    return found


def _cloud(row: dict) -> bool:
    name = str(row.get("name") or "")
    return bool(row.get("cloud")) or name.endswith((":cloud", "-cloud"))


def _params(row: dict) -> float:
    try:
        return float(row.get("params_b") or 0) or float("inf")
    except (TypeError, ValueError):
        return float("inf")


def model_choices(found: dict) -> list[str]:
    """Every chat model a found server serves, what the user chooses from when DGC chose none (never an embedding
    model): the ones it has loaded first, then the smallest, cloud models last."""
    rows = [m for m in found.get("models") or [] if isinstance(m, dict) and m.get("name")
            and m.get("kind") != "embedding"]
    return [m["name"] for m in sorted(rows, key=lambda m: (not m.get("loaded"), _cloud(m), _params(m)))]


def choices_text(names, *, most: int = 12) -> str:
    shown = ", ".join(names[:most])
    return shown + (f" and {len(names) - most} more" if len(names) > most else "")


def suggest_models(found: dict, wanted=None, *, limit: int = 8) -> list[dict]:
    """The models to use on a newly found system, each with a context that never makes the server reload it:
    the context it is loaded with now, else 32K (or its maximum, when smaller). Workers follow the server's own
    slots when it says (llama.cpp, SGLang, TGI); the parallel probe measures the rest.

    Unasked, only what the server has loaded now (Ollama's /api/ps, LM Studio's loaded models, the one model
    llama.cpp, vLLM, SGLang or TGI serve; a plain OpenAI-compatible server's only chat model): using any other model
    there would load it on that computer, and a computer serving many models (some of them big) may be running other
    work. Never a cloud model (Ollama runs those elsewhere) or an embedding model. Nothing loaded: none, and the user
    chooses (model_choices)."""
    rows = [m for m in found.get("models") or [] if isinstance(m, dict) and m.get("name")]
    if wanted:
        by_name = {m["name"].lower(): m for m in rows}
        picked = []
        for name in wanted:
            row = by_name.get(str(name).lower())
            picked.append(row or {"name": str(name)})
    else:
        chat = [m for m in rows if m.get("kind") != "embedding" and m.get("tools") is not False and not _cloud(m)]
        picked = [m for m in chat if m.get("loaded")][:limit]
        if not picked and len(chat) == 1 and not any("loaded" in m for m in rows):
            picked = chat                      # a server that serves one model and doesn't say: that one
    slots = found.get("slots") if isinstance(found.get("slots"), int) else 0
    out = []
    for row in picked:
        context = row.get("loaded_context") or min(int(row.get("context_max") or ROUTER_DEFAULT_CONTEXT),
                                                   ROUTER_DEFAULT_CONTEXT)
        context = max(2_048, int(context))
        model = {"name": row["name"], "workers": max(1, min(64, slots or 1)), "context": context}
        if row.get("params_b"):
            model["params_b"] = row["params_b"]
        if row.get("tools") is False:
            model["tools"] = False
        out.append(model)
    return out


CONTEXT_MIN, CONTEXT_MAX = 2048, 16_777_216


def context_tokens(value) -> int:
    """A context size as people write it, the same everywhere (Settings' box, dgc router --context, the SDK): 16384,
    "16384", "16,384", "16K" or "16k" (K is 1,024 tokens), between 2,048 and 16,777,216. Raises UpdateError."""
    if isinstance(value, bool):
        raise UpdateError("a context is a number of tokens, like 16384 or 16K")
    if isinstance(value, int):
        tokens = value
    else:
        raw = str(value or "").strip().lower().replace(",", "").replace("_", "").replace(" ", "")
        scale = 1024 if raw.endswith("k") else 1
        digits = raw[:-1] if scale > 1 else raw
        # Digits only, as the editor's box reads them: never "nan", "inf" or "1e5" through float().
        if not re.fullmatch(r"\d+(\.\d+)?", digits):
            raise UpdateError("a context is a number of tokens, like 16384 or 16K")
        if scale == 1 and "." in digits:
            raise UpdateError("a context is a whole number of tokens, like 16384 or 16K")
        tokens = round(float(digits) * scale)
    if not CONTEXT_MIN <= tokens <= CONTEXT_MAX:
        raise UpdateError("a context is between 2,048 and 16,777,216 tokens (2K and up)")
    return tokens


def plan_update(config, args: dict, *, detect=True, pick_later=False) -> UpdatePlan:
    """Work out one change without making it. Raises UpdateError with a plain reason.

    add_system without models on a server with nothing loaded raises ChooseModels (the model's tool and the CLI ask
    the user), unless ``pick_later``: then the system is added with none chosen and its form or the user picks them
    (the editor's Add, the SDK, /router add)."""
    if not isinstance(args, dict):
        raise UpdateError("router_update takes an object")
    _refuse_keys(args)
    action = str(args.get("action") or "")
    if action not in ACTIONS:
        raise UpdateError(f"action must be one of {', '.join(ACTIONS)}")
    before = router_mod.settings(config)
    after = copy.deepcopy(before)
    notes: list[str] = []
    needs_key = ""
    discovered = None
    system_id = ""
    done = ""
    if action == "turn_on":
        after["enabled"] = True
        summary = "Turn DGC Router on"
        if not after["systems"]:
            notes.append("There are no systems yet: add one with add_system.")
    elif action == "turn_off":
        after["enabled"] = False
        summary = "Turn DGC Router off (sub-agents and Pips go back to the usual model)"
    elif action == "set_when_busy":
        value = str(args.get("when_busy") or "")
        if value not in ROUTER_WHEN_BUSY:
            raise UpdateError("when_busy must be wait or default")
        after["when_busy"] = value
        summary = ("When every worker is busy, wait for one" if value == "wait" else
                   "When every worker is busy, use the usual sub-agent model")
    elif action == "add_system":
        address = str(args.get("base_url") or "").strip()
        if not address:
            raise UpdateError("add_system needs base_url: the computer's address, e.g. gpu-box.local:11434")
        name = " ".join(str(args.get("name") or "").split())
        system_id = str(args.get("system") or "").strip().lower() or router_slug(name) or router_slug(
            router_base_url(address)[0].split("://", 1)[-1].split(":")[0].split(".")[0])
        if router_mod.find_system(before, system_id):
            raise UpdateError(f"there is already a system {system_id!r}: use edit_system, or pick another id")
        server, base = "openai_compatible", router_base_url(address)[0]
        if not base:
            raise UpdateError(router_base_url(address)[1])
        if detect:
            from .router_probe import ProbeError, detect as detect_server, discover
            try:
                found = detect_server(address)
            except ProbeError as exc:
                raise UpdateError(str(exc)) from None
            server, base = found["server"], found["base_url"]
            if found.get("needs_key"):
                needs_key = system_id
                notes.append("It wants a key: ask the user to paste it in Settings → Models → DGC Router, or run "
                             f"/router key {system_id} in the terminal. DGC Router never handles keys itself.")
            else:
                try:
                    discovered = discover(base, server)
                except ProbeError as exc:
                    notes.append(f"DGC couldn't list its models yet: {exc}")
        jobs = args.get("jobs") if isinstance(args.get("jobs"), list) else (
            ["images"] if server in ("comfyui", "a1111") else ["subagents", "pips"])
        if server in ("comfyui", "a1111"):
            jobs = ["images"]
            discovered = {"models": []}
            notes.append("An image server: it does the images job (an image generator that names this system holds "
                         "one of its workers while it makes a picture).")
        wanted = [str(m) for m in args["models"] if str(m).strip()] if isinstance(args.get("models"), list) else None
        models = suggest_models(discovered or {}, wanted)
        if args.get("context"):
            # One context for every model it adds (dgc router add --context 16K): never past a model's own maximum.
            wanted_context = context_tokens(args["context"])
            maxima = {m.get("name"): m.get("context_max") for m in (discovered or {}).get("models") or []
                      if isinstance(m, dict)}
            for model in models:
                most = maxima.get(model["name"])
                model["context"] = min(wanted_context, int(most)) if isinstance(most, int) and most >= 2048 \
                    else wanted_context
        choices = model_choices(discovered or {}) if not wanted else []
        if not models and choices and not needs_key and server not in ("comfyui", "a1111"):
            if not pick_later:
                raise ChooseModels(name or system_id, choices)
            notes.append(f"Nothing is loaded on {name or system_id} now, so DGC chose no model (using one loads it "
                         f"on that computer). Choose the ones to use; it serves {choices_text(choices)}.")
        elif not models and not needs_key and server not in ("comfyui", "a1111"):
            notes.append("No chat model that calls tools was found there; add one with set_model.")
        system = {"id": system_id, "name": name or system_id, "base_url": base, "server": server, "jobs": jobs,
                  "models": models, "workers": args.get("workers") or max([1, *(m["workers"] for m in models)]),
                  "one_model_at_a_time": bool(args.get("one_model_at_a_time", False))}
        if args.get("memory_gb"):
            system["memory_gb"] = args["memory_gb"]
        after["systems"].append(system)
        summary = (f"Add {system['name']} ({server} at {base}) for {router_mod.jobs_text(jobs)}"
                   + (f" with {', '.join(m['name'] for m in models)}" if models else ""))
        warning = router_mod.plain_http_warning(base)
        if warning:
            notes.append(warning)
    else:
        target = _system(after, str(args.get("system") or ""))
        system_id = target["id"]
        if action == "remove_system":
            after["systems"] = [s for s in after["systems"] if s["id"] != system_id]
            summary = f"Remove {target['name']} (its saved key goes too)"
        elif action in ("enable_system", "disable_system"):
            target["enabled"] = action == "enable_system"
            summary = f"{'Use' if target['enabled'] else 'Stop using'} {target['name']}"
        elif action == "set_jobs":
            jobs = args.get("jobs")
            if not isinstance(jobs, list) or any(job not in ROUTER_JOBS for job in jobs):
                raise UpdateError("jobs takes subagents, pips and images")
            target["jobs"] = [job for job in ROUTER_JOBS if job in jobs]
            summary = f"{target['name']} does {router_mod.jobs_text(target['jobs'])}"
        elif action == "set_hardware":
            address = str(args.get("hardware_url") or "").strip()
            if not address or address.lower() in ("off", "none"):
                if (target.get("hardware") or {}).get("source", "none") == "none":
                    raise UpdateError(f"{target['name']} has no hardware readout to turn off")
                target["hardware"] = {"source": "none"}
                summary = f"Stop reading {target['name']}'s hardware"
            else:
                from .router_hardware import KINDS, HardwareError, detect as detect_hardware
                if not detect:
                    raise UpdateError("set_hardware looks at the address first")
                try:
                    found = detect_hardware(address)
                except HardwareError as exc:
                    raise UpdateError(str(exc)) from None
                target["hardware"] = {"source": found["source"], "url": found["url"]}
                summary = f"Read {target['name']}'s hardware from {KINDS.get(found['kind'], found['kind'])} at {found['url']}"
                if found["source"] == "node":
                    notes.append(f"It is a dgc node: it needs its pairing token (dgc router hardware {system_id} "
                                 f"--token in a terminal, /router token {system_id}, or Settings).")
                notes.append("Read only, at most once a minute, and only by DGC itself. Routing never depends on it; "
                             "Suggest and router_status use it.")
        elif action == "apply_suggestion":
            from .router_suggest import SuggestError, applied, suggest
            try:
                result = suggest(config, system_id, context=args.get("context"))
            except SuggestError as exc:
                raise UpdateError(str(exc)) from None
            if not result["applicable"]:
                raise UpdateError(f"DGC can't back a suggestion for {target['name']} yet: "
                                  + "; ".join(plan["line"] for plan in result["models"])[:600])
            new_system, changed = applied(target, result)
            if not changed:
                raise UpdateError(f"{target['name']} already matches the suggestion")
            after["systems"] = [new_system if s["id"] == system_id else s for s in after["systems"]]
            summary = f"Use the suggestion for {target['name']}: " + "; ".join(changed)
            done = f"Applied: {target['name']} · " + "; ".join(changed)
            notes += [plan["line"] + "." for plan in result["models"] if plan.get("workers")]
        elif action == "edit_system":
            changed = []
            for key in ("name", "workers", "one_model_at_a_time", "memory_gb"):
                if key in args and args[key] is not None:
                    target[key] = args[key]
                    changed.append(key)
            if args.get("jobs") is not None:
                target["jobs"] = args["jobs"]
                changed.append("jobs")
            if args.get("base_url"):
                base, problem = router_base_url(args["base_url"])
                if problem:
                    raise UpdateError(problem)
                if base != target["base_url"]:
                    target["base_url"] = base
                    changed.append("base_url")
                    notes.append("A new address drops the key saved for the old one.")
            if not changed:
                raise UpdateError("edit_system needs something to change: name, base_url, jobs, workers, "
                                  "one_model_at_a_time or memory_gb")
            summary = f"Change {target['name']}: " + ", ".join(changed)
        else:  # set_model
            name = str(args.get("model") or "").strip()
            if not name:
                raise UpdateError("set_model needs model")
            entry = next((m for m in target["models"] if m["name"].lower() == name.lower()), None)
            if entry is None:
                entry = {"name": name, "workers": 1, "context": ROUTER_DEFAULT_CONTEXT}
                found = router_state.discovery(system_id)
                suggestion = suggest_models(found, [name]) if found else []
                if suggestion:
                    entry.update(suggestion[0])
                target["models"].append(entry)
                what = "Add"
            else:
                what = "Change"
            for key in ("use", "workers", "context", "note", "thinking"):
                if key in args and args[key] is not None:
                    entry[key] = args[key]
            if entry.get("use") is True:
                entry.pop("use")
            if "thinking" in entry and not entry["thinking"]:
                entry.pop("thinking")                  # the helper's own level, as when it was never set
            summary = f"{what} {entry['name']} on {target['name']}"
    cleaned, problems = validate_router(after)
    if problems:
        raise UpdateError("; ".join(problems[:4]))
    return UpdatePlan(action=action, before=before, after=cleaned, summary=summary, notes=notes,
                      needs_key=needs_key, discovered=discovered, system_id=system_id,
                      done=done)


def apply_plan(config, plan: UpdatePlan) -> dict:
    """Make the planned change, if the settings are still what it was planned against. Returns the new block."""
    current = router_mod.settings(config)
    if current != plan.before:
        raise UpdateError("the router settings changed while this was being asked; ask again")
    saved = config.set_router(plan.after)
    if plan.action == "remove_system" and plan.system_id:
        router_state.forget(plan.system_id)
    if plan.discovered and plan.system_id:
        router_state.save_discovery(plan.system_id, plan.discovered)
    if plan.action == "set_hardware" and plan.system_id:
        from .router_hardware import forget, read_system
        system = router_mod.find_system(saved, plan.system_id)
        if system is not None and (system.get("hardware") or {}).get("source", "none") != "none":
            plan.reading = read_system(config, system, max_age=0)
        else:
            forget(plan.system_id)
    router_mod.ROUTER._changed("settings")
    return saved


# ---- what the model reads ------------------------------------------------------------------------------------------
def _k(tokens) -> str:
    try:
        value = int(tokens)
    except (TypeError, ValueError):
        return "?"
    return f"{value // 1024}K" if value >= 1024 and value % 1024 == 0 else f"{value:,}"


def status_text(status: dict, *, unused_names: bool = False) -> str:
    """The Router in words: every system, its jobs, workers and the models it uses. A system's models it doesn't use
    are folded into one line, as Settings' card does ("8 more models not used"); ``unused_names`` lists them on that
    line (the model's router_status, so it can name one); --json keeps every row."""
    if not status["systems"]:
        return ("DGC Router is " + ("on" if status["enabled"] else "off") + " and has no systems. With the user's "
                "go-ahead, add one with router_update add_system (or look with router_find).")
    workers = status["workers"]
    lines = [f"DGC Router is {'on' if status['enabled'] else 'OFF (nothing is routed; router_update turn_on)'} · "
             f"{workers['free']} of {workers['total']} workers free · when all are busy: "
             + ("wait" if status["when_busy"] == "wait" else "use the usual sub-agent model")]
    for system in status["systems"]:
        health = system["health"]
        state = health.get("state", "unknown")
        where = f"{system['server']} at {system['base_url']}"
        head = f"- {system['id']} \"{system['name']}\" ({where})"
        if not system["enabled"]:
            lines.append(head + " · not used")
            continue
        if state == "offline":
            since = time.strftime("%H:%M", time.localtime(health.get("offline_since") or health.get("checked") or 0))
            lines.append(head + f" · OFFLINE since {since} ({health.get('error') or 'no answer'})")
            continue
        bits = [f"jobs: {router_mod.jobs_text(system['jobs'])}", f"{system['free']} of {system['workers']} workers free"]
        if system["one_model_at_a_time"]:
            bits.append("one model at a time")
        if state == "online" and health.get("latency_ms") is not None:
            bits.append(f"online, {health['latency_ms']} ms")
        if system.get("server_load"):
            load = system["server_load"]
            words = {"running": "{} running", "waiting": "{} waiting", "slots": "{} slots",
                     "kv_used_pct": "memory for context {}% used", "tokens_per_s": "{} tok/s"}
            said = [words[key].format(f"{value:g}" if isinstance(value, float) else value)
                    for key, value in load.items() if key in words and value not in (None, 0.0) or key == "running"]
            if said:
                bits.append("the server says: " + ", ".join(said))
        if not system.get("has_key") and system.get("discovery_error", "").startswith("the server wants a key"):
            bits.append("needs a key (the user pastes it in Settings)")
        if system.get("warning"):
            bits.append(system["warning"])
        lines.append(head + " · " + " · ".join(bits))
        if system.get("hardware"):
            lines.append("  · hardware: " + hardware_text(system["hardware"]))
        unused = [model["name"] for model in system["models"] if model.get("use") is False]
        for model in system["models"]:
            if model.get("use") is False:
                continue
            facts = []
            if model.get("params_b"):
                facts.append(f"{round(float(model['params_b']), 1):g}B")
            if model.get("quant"):
                facts.append(model["quant"])
            facts.append(f"context {_k(model['context'])}")
            facts.append(f"{model['free']}/{model['workers']} free")
            if "tools" in model:
                facts.append("tools ✓" if model["tools"] else "tools ✗")
            if model.get("vision"):
                facts.append("vision ✓")
            if model.get("tokens_per_s"):
                facts.append(f"{model['tokens_per_s']:g} tok/s")
            if model.get("parallel"):
                facts.append(f"runs {model['parallel']} at once")
            if model.get("thinks") is False:
                facts.append("doesn't think")
            elif model.get("thinking"):
                facts.append(f"thinking {thinking_words(model['thinking'])}")
            elif model.get("thinks"):
                facts.append("thinking: same as the helper")
            if model.get("subagents"):
                facts.append(model["subagents"])
            if model.get("note"):
                facts.append(f"note: {model['note']}")
            lines.append(f"  · {model['name']}: " + " · ".join(facts))
        if unused:
            lines.append(f"  · {len(unused)} more model{'' if len(unused) == 1 else 's'} not used"
                         + (": " + ", ".join(unused) if unused_names else ""))
        for lease in system["leases"]:
            # What it is doing, in words ("count bolts", "Pip Inbox"); its id stays in the --json status alone.
            lines.append(f"  · busy: {lease['model']} for {router_mod.lease_label(lease)}")
    return "\n".join(lines)


def thinking_words(level: str) -> str:
    """A thinking level as a person reads it: "low", "extra high"."""
    return {"xhigh": "extra high"}.get(str(level), str(level))


def _ago(at) -> str:
    try:
        seconds = max(0, int(time.time() - float(at)))
    except (TypeError, ValueError):
        return ""
    return f"{seconds} s ago" if seconds < 120 else f"{seconds // 60} min ago" if seconds < 7200 else \
        f"{seconds // 3600} h ago"


def hardware_text(row: dict) -> str:
    """One system's hardware readout in words: "GB10 · 92 of 128 GB · 34% · 61°C (dgc node, 20 s ago)"."""
    from .router_hardware import KINDS
    kind = KINDS.get(str(row.get("kind") or ""), "dgc node" if row.get("source") == "node" else "an exporter")
    if row.get("source") == "node" and not row.get("has_token"):
        return (f"a dgc node at {row.get('url')}: it needs its pairing token (--token, /router token, or "
                "Settings)")
    if row.get("line"):
        said = row["line"] + f" ({kind}, {_ago(row.get('at'))})"
        if row.get("error"):
            said += f"; the last read failed: {row['error']}"
        return said
    if row.get("error"):
        return f"couldn't read it at {row.get('url')}: {row['error']}"
    return f"{kind} at {row.get('url')}: not read yet"


def probe(config, system_name: str, *, model: str = "", checks=None, on_step=None) -> dict:
    """Run the probes on one system and save them: {"system", "results": {model: {...}}, "models"?: n}.

    Testing a system tests the models it uses (up to 3), and never loads one: on a server that loads models when
    asked (Ollama, LM Studio), a used model it hasn't loaded now is left out with {"not_loaded": true, "error": why},
    so the person is told first. Naming the model (``model``) tests it, loading it if need be."""
    from .router_probe import CHECKS, LOADS_ON_DEMAND, ProbeError, Target, discover, loaded_now, run_probes
    checks = [c for c in (checks or CHECKS) if c in CHECKS] or list(CHECKS)
    block = router_mod.settings(config)
    system = router_mod.find_system(block, system_name)
    if system is None:
        raise UpdateError(f"there is no system {system_name!r}")
    key = router_mod._key(config, system["id"])
    out: dict = {"system": system["id"], "results": {}}
    if "models" in checks:
        try:
            found = discover(system["base_url"], system["server"], key)
            router_state.save_discovery(system["id"], found)
            out["models"] = len(found.get("models") or [])
            router_mod.ROUTER.record_health(system["id"], True, found.get("took_ms", 0))
        except ProbeError as exc:
            out["models_error"] = str(exc)
            router_mod.ROUTER.record_health(system["id"], False, 0, str(exc))
    model_checks = [c for c in checks if c != "models"]
    if not model_checks:
        _with_suggestion(config, out)
        return out
    names = [model] if model else [m["name"] for m in system["models"] if m.get("use") is not False][:3]
    loaded = loaded_now(system["base_url"], system["server"], key) if (
        not model and names and system["server"] in LOADS_ON_DEMAND) else None
    for name in names:
        entry = next((m for m in system["models"] if m["name"].lower() == name.lower()), None)
        if entry is None:
            out["results"][name] = {"error": f"{system['name']} doesn't list {name}"}
            continue
        facts = router_mod._model_facts(system, entry)
        if loaded is not None and entry["name"] not in loaded and not facts.get("cloud") and not _cloud(entry):
            found = next((m for m in router_state.discovery(system["id"]).get("models") or []
                          if isinstance(m, dict) and m.get("name") == entry["name"]), {})
            size = found.get("size_bytes") if isinstance(found.get("size_bytes"), int) else 0
            out["results"][entry["name"]] = {
                "not_loaded": True,
                "error": f"not loaded on {system['name']} now: testing it would load it there"
                         + (f" (about {size / 1024 ** 3:.0f} GB)" if size >= 1024 ** 3 else "")}
            continue
        # A probe takes a worker like any job, so it never crowds out real work or swaps a one-model system.
        route, why = router_mod.ROUTER.acquire(config, "", system=system["id"], model=entry["name"],
                                               owner="probe", wait=False, require_enabled=False, label="a test")
        if route is None:
            out["results"][entry["name"]] = {"error": "busy right now; probe it later" if why == "busy" else why}
            continue
        try:
            if callable(on_step):
                on_step(f"testing {entry['name']} on {system['name']}")
            target = Target(system["base_url"], system["server"], entry["name"], context=entry["context"], key=key,
                            api_mode=system.get("api_mode", ""), thinking=bool(facts.get("thinking")),
                            keep_alive=route.keep_alive)
            results = run_probes(target, checks=model_checks)
        finally:
            router_mod.ROUTER.release(route)
        router_state.save_probe(system["id"], entry["name"], results)
        out["results"][entry["name"]] = results
    _with_suggestion(config, out)
    return out


def _with_suggestion(config, out: dict) -> None:
    """A probe's answer ends with Suggest's workers per model (router_update apply_suggestion applies it)."""
    from .router_suggest import SuggestError, suggest
    try:
        out["suggest"] = suggest(config, out["system"])
    except (SuggestError, KeyError, TypeError, ValueError):
        pass


def probe_text(result: dict, *, surface: str = "tool") -> str:
    """A probe in words for the model's tools (``surface`` "tool"), `dgc router test` ("cli") or /router ("tui")."""
    system = result["system"]
    lines = [f"Tested {system}:"]
    if "models" in result:
        lines.append(f"- it serves {result['models']} models (saved)")
    if result.get("models_error"):
        lines.append(f"- couldn't list its models: {result['models_error']}")
    for name, checks in result["results"].items():
        if checks.get("not_loaded"):
            how = {"cli": f"dgc router test {system} --model {name} loads it and tests it",
                   "tui": f"/router test {system} {name} loads it and tests it"}.get(
                surface, "router_probe with this model loads it: ask the user first")
            lines.append(f"- {name}: {checks['error']}. Not tested; {how}.")
            continue
        if "error" in checks:
            lines.append(f"- {name}: {checks['error']}")
            continue
        bits = []
        speed = checks.get("speed")
        if speed:
            bits.append(f"{speed['tokens_per_s']:g} tok/s, first token in {speed['ttft_ms']} ms" if speed.get("ok")
                        else f"speed test failed: {speed.get('error')}")
        parallel = checks.get("parallel")
        if parallel:
            bits.append(f"runs {parallel['runs']} at once" if parallel.get("ok")
                        else f"parallel test failed: {parallel.get('error')}")
        tools = checks.get("tools")
        if tools:
            bits.append("tool calls ✓" if tools.get("ok")
                        else f"tool calls ✗ ({tools.get('detail') or tools.get('error')}): kept away from sub-agents")
        lines.append(f"- {name}: " + "; ".join(bits))
    if result.get("suggest"):
        from .router_suggest import text as suggestion_text
        lines.append("Suggest: " + suggestion_text(result["suggest"], surface="tool" if surface == "tool" else "cli"))
    return "\n".join(lines)


def find_text(config, result: dict) -> str:
    block = router_mod.settings(config)
    known = {s["base_url"]: s["id"] for s in block["systems"]}
    if not result["found"]:
        return f"No model server answered on {result['network']} (ports {', '.join(map(str, result['ports']))})."
    lines = [f"Model servers on {result['network']}:"]
    for item in result["found"]:
        extra = f" — already added as {known[item['base_url']]}" if item["base_url"] in known else ""
        note = f" ({item['note']})" if item.get("note") else ""
        version = f" {item['version']}" if item.get("version") else ""
        lines.append(f"- {item['base_url']}: {item['server']}{version}{note}{extra}")
    lines.append("Add the ones the user wants with router_update add_system.")
    return "\n".join(lines)


def run(agent, name: str, args: dict, *, plan: UpdatePlan | None = None) -> str:
    """Execute one router tool for the main model; the answer is plain text."""
    config = agent.config
    try:
        if name == "router_status":
            return status_text(router_mod.status(config, refresh=bool(args.get("refresh"))), unused_names=True)
        if name == "router_probe":
            checks = args.get("checks") if isinstance(args.get("checks"), list) else None
            return probe_text(probe(config, str(args.get("system") or ""), model=str(args.get("model") or ""),
                                    checks=checks))
        if name == "router_find":
            from .router_probe import ProbeError, find
            try:
                return find_text(config, find(str(args.get("subnet") or "") or None))
            except ProbeError as exc:
                return f"error: {exc}"
        if name == "router_update":
            plan = plan or plan_update(config, args)
            apply_plan(config, plan)
            words = [plan.said()] if plan.done else ["Done: " + plan.summary + ".", *plan.notes]
            if any("pairing token" in note for note in plan.notes):
                words.append("DGC Router's tools never handle a token: ask the user to paste it.")
            if plan.reading:
                from .router_hardware import line as hardware_line
                words.append(f"Its hardware now: {hardware_line(plan.reading)}." if plan.reading.get("gpus")
                             or plan.reading.get("memory") else f"The first read failed: {plan.reading.get('error')}.")
            if plan.action == "add_system" and plan.after["enabled"] is False:
                words.append("DGC Router is off: router_update turn_on uses it (with the user's go-ahead).")
            return " ".join(words)
    except UpdateError as exc:
        return f"error: {exc}"
    return f"error: {name} is not a DGC Router tool"
