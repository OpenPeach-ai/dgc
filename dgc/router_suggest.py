"""DGC Router's Suggest: how many workers each model of a system can have at a chosen context, worked out from what
DGC knows, never guessed (plan §4).

- **Memory**: the hardware readout (dgc/router_hardware.py: the GPU's memory, or the computer's when they share it),
  else the system's ``memory_gb``. Part of it is kept free (HEADROOM): the computer, and the server's own buffers.
- **Weights**: the model's file size from the server (Ollama's /api/tags), else parameters × quant bits ÷ 8.
- **Context memory**: KV bytes per token from the architecture in Ollama's /api/show (layers × KV heads × head size
  × 2 for K and V × 2 bytes, an f16 cache: a q8 cache or a sliding window only makes it smaller), times the context.
- **What the server says**: llama.cpp's slots and their n_ctx, vLLM's and SGLang's KV capacity in tokens, SGLang's and
  TGI's request ceilings: memory those servers already set aside, so their numbers win.
- **What was measured**: the parallel test (dgc/router_probe.py). Ollama and LM Studio run as many at once as their
  own setting allows (OLLAMA_NUM_PARALLEL): more workers than that only wait.

workers ≈ (memory − weights − headroom) ÷ (context × KV per token), shown in one line ("8B Q4 ≈ 4.9 GB + 2 × 32K
context ≈ 9 GB → 2 workers fit in 16 GB"). When memory or the context's size is unknown it says so, and suggests from
what the server reports or what was measured instead; with neither, it suggests nothing.
"""
from __future__ import annotations

import re

from . import router as router_mod
from . import router_state
from .config import ROUTER_DEFAULT_CONTEXT, ROUTER_MAX_WORKERS

GB = 1024 ** 3
PROBE_WIDEST = 4                   # the parallel test tries 1, 2 and 4 at once: 4 means "at least 4"


class SuggestError(ValueError):
    pass


def headroom(total: float, unified: bool) -> float:
    """What is kept free: 10% (at least 1 GB) of a card's memory; 15% (at least 4 GB) of a computer whose GPU shares
    its memory, which also runs everything else."""
    return max(4 * GB, 0.15 * total) if unified else max(1 * GB, 0.10 * total)


def _gb(value: float) -> str:
    gigs = value / GB
    if gigs >= 10:
        return f"{gigs:.0f}"
    return f"{gigs:.1f}".rstrip("0").rstrip(".")


def _k(tokens: int) -> str:
    return f"{tokens // 1024}K" if tokens >= 1024 and tokens % 1024 == 0 else f"{tokens:,}"


def _size(params_b) -> str:
    try:
        value = float(params_b)
    except (TypeError, ValueError):
        return ""
    return f"{value:.0f}B" if value >= 10 else f"{value:.1f}".rstrip("0").rstrip(".") + "B"


def _quant(quant: str) -> str:
    match = re.match(r"(Q\d|IQ\d|BF16|F16|FP16|F32|FP8|MXFP4|NVFP4|INT4|INT8)", str(quant or "").upper())
    return match.group(1) if match else str(quant or "")


def _workers(n: int) -> str:
    return f"{n} worker" + ("" if n == 1 else "s")


def memory(system: dict) -> dict:
    """{"total_bytes", "source", "unified"} for Suggest, or {} when DGC doesn't know it."""
    from .router_hardware import KINDS, memory_of, saved
    hardware = system.get("hardware") or {}
    if hardware.get("source") in ("exporter", "node"):
        snapshot = saved(system["id"])
        if snapshot.get("url") == hardware.get("url"):
            found = memory_of(snapshot)
            total = found.get("limit_bytes") or found.get("total_bytes")
            if total:
                kind = KINDS.get(str(snapshot.get("kind") or ""), "the hardware readout")
                return {"total_bytes": int(total), "unified": bool(found.get("unified")),
                        "source": f"the hardware readout ({kind})"}
    if system.get("memory_gb"):
        return {"total_bytes": int(float(system["memory_gb"]) * GB), "unified": False, "source": "the memory set for it"}
    return {}


def _found(system_id: str) -> tuple[dict, dict]:
    found = router_state.discovery(system_id)
    models = {m.get("name"): m for m in found.get("models") or [] if isinstance(m, dict) and m.get("name")}
    return found, models


def _weights(row: dict) -> float | None:
    from .router_probe import bits_for
    size = row.get("size_bytes")
    if isinstance(size, (int, float)) and size >= 50_000_000:
        return float(size)
    if row.get("params_b"):
        return float(row["params_b"]) * 1e9 * bits_for(row.get("quant", "")) / 8
    return None


def _measured(system_id: str, name: str) -> dict:
    probe = router_state.probes(system_id).get(name, {})
    parallel = probe.get("parallel") if isinstance(probe.get("parallel"), dict) else {}
    return parallel if parallel.get("ok") and isinstance(parallel.get("runs"), int) else {}


def _fit_context(budget: float, kv_per_token: float) -> int:
    """The largest context (a multiple of 1K, at least 2K) one worker fits in ``budget``; 0 when none does."""
    if budget <= 0 or kv_per_token <= 0:
        return 0
    tokens = int(budget // kv_per_token) // 1024 * 1024
    return tokens if tokens >= 2048 else 0


def _plan_model(system: dict, found: dict, row: dict, name: str, context: int, mem: dict, others: float,
                share: int) -> dict:
    """One model's suggestion: {"name", "context", "workers" (None when nothing backs a number), "basis", "line"}."""
    server = system.get("server", "")
    out: dict = {"name": name, "context": context, "workers": None, "basis": "none"}
    label = " ".join(bit for bit in (_size(row.get("params_b")), _quant(row.get("quant", ""))) if bit) or name
    if row.get("context_max") and context > int(row["context_max"]):
        out["context"] = context = int(row["context_max"])
        out["note"] = f"{name} takes at most {_k(context)}"
    measured = _measured(system["id"], name)
    if row.get("kind") == "embedding":
        out["line"] = f"{name}: an embedding model, not for sub-agents or Pips"
        return out
    if row.get("cloud"):
        if measured:
            out.update(workers=measured["runs"], basis="measured")
            out["line"] = (f"{name}: a cloud model (no memory here); it ran {measured['runs']} at once "
                           f"(measured) → {_workers(measured['runs'])}")
        else:
            out["line"] = f"{name}: a cloud model (no memory here); Test measures how many run at once"
        return out
    # Servers that set their memory aside up front: what they say is the answer.
    slots = found.get("slots") if isinstance(found.get("slots"), int) and found["slots"] > 0 else 0
    kv_tokens = found.get("kv_tokens") if isinstance(found.get("kv_tokens"), int) and found["kv_tokens"] > 0 else 0
    if server == "llamacpp" and slots:
        slot_context = int(found.get("slot_context") or row.get("loaded_context") or 0)
        if slot_context and context != slot_context:
            out["context"] = slot_context
            out["note"] = (f"llama-server was started with {_k(slot_context)} per slot; a bigger context needs its "
                           "--ctx-size raised")
        out.update(workers=min(slots, ROUTER_MAX_WORKERS), basis="slots")
        out["line"] = (f"{name}: llama-server runs {slots} slot{'s' if slots != 1 else ''}"
                       + (f" of {_k(slot_context)} each" if slot_context else "") + f" → {_workers(out['workers'])}"
                       + (f" at {_k(slot_context)}" if slot_context else ""))
        return out
    if server in ("vllm", "sglang") and kv_tokens:
        fits = kv_tokens // context
        if server == "sglang" and slots:
            fits = min(fits, slots)
        what = "vLLM" if server == "vllm" else "SGLang"
        if fits < 1:
            out["line"] = (f"{name}: {what} holds {kv_tokens:,} tokens of context, less than one {_k(context)} "
                           f"request; use {_k(_fit_context(kv_tokens, 1) or 2048)} or less")
            return out
        out.update(workers=min(fits, ROUTER_MAX_WORKERS), basis="kv_tokens")
        out["line"] = f"{name}: {what} holds {kv_tokens:,} tokens of context → {_workers(out['workers'])} at {_k(context)}"
        return out
    if server in ("tgi", "sglang") and slots:
        out.update(workers=min(slots, ROUTER_MAX_WORKERS), basis="slots")
        out["line"] = f"{name}: the server takes {slots} requests at once → {_workers(out['workers'])}"
        return out
    # Ollama, LM Studio and the rest: the memory arithmetic, and what the parallel test measured.
    weights = _weights(row)
    kv_per_token = row.get("kv_bytes_per_token")
    fit = None
    arithmetic = ""
    if mem and weights is not None and kv_per_token:
        total = float(mem["total_bytes"])
        keep = headroom(total, bool(mem.get("unified")))
        budget = (total - keep - weights - others) / max(1, share)
        per_worker = float(kv_per_token) * context
        fit = max(0, min(ROUTER_MAX_WORKERS, int(budget // per_worker))) if budget > 0 else 0
        out.update(weights_gb=round(weights / GB, 2), kv_gb_per_worker=round(per_worker / GB, 2),
                   memory_gb=round(total / GB, 1))
        beside = f" beside the other models ({_gb(others)} GB)" if others else ""
        if fit >= 1:
            arithmetic = (f"{label} ≈ {_gb(weights)} GB + {fit} × {_k(context)} context ≈ {_gb(fit * per_worker)} GB "
                          f"→ {_workers(fit)} fit{'s' if fit == 1 else ''} in {_gb(total)} GB{beside} "
                          f"({_gb(keep)} GB kept free)")
        elif weights + others + keep >= total:
            arithmetic = (f"{label} ≈ {_gb(weights)} GB doesn't fit in {_gb(total)} GB{beside} "
                          f"({_gb(keep)} GB kept free)")
        else:
            smaller = _fit_context(budget, float(kv_per_token))
            arithmetic = (f"{label} ≈ {_gb(weights)} GB + one {_k(context)} context ≈ {_gb(per_worker)} GB doesn't fit "
                          f"in {_gb(total)} GB{beside} ({_gb(keep)} GB kept free)"
                          + (f"; {_k(smaller)} fits one" if smaller else ""))
    if fit is not None and row.get("kv_upper_bound"):
        arithmetic += "; its context is counted high (the server doesn't say its KV heads)"
    runs = measured.get("runs") if measured else None
    same_context = bool(measured) and int(measured.get("context") or 0) == context
    if fit is None and runs is None:
        missing = []
        if not mem:
            missing.append("its memory (a hardware readout, or its memory in GB)")
        elif weights is None:
            missing.append("the model's size")
        elif not kv_per_token:
            missing.append("how much memory its context takes (the server doesn't say)")
        missing.append("how many it runs at once (Test measures it)")
        out["line"] = f"{name}: DGC can't back a number yet: it doesn't know " + " or ".join(missing)
        return out
    if fit is None:
        out.update(workers=runs, basis="measured")
        why = ("memory unknown" if not mem else "its context's memory unknown" if not kv_per_token else
               "its size unknown")
        out["line"] = (f"{name}: {why}; it ran {runs}{' or more' if runs >= PROBE_WIDEST else ''} at once "
                       f"(measured) → {_workers(runs)}")
        return out
    workers, basis = fit, "memory"
    tail = ""
    if runs is not None:
        if runs < PROBE_WIDEST and fit > runs:
            workers, basis = runs, "measured"
            tail = f"; the server runs {runs} at once (measured), so {runs}"
        elif same_context and runs > fit:
            workers, basis = runs, "measured"
            tail = f"; it ran {runs} at once at {_k(context)} (measured), so {runs}"
    elif fit:
        tail = "; Test checks how many it really runs at once"
    out.update(workers=workers if workers >= 1 else None, basis=basis if workers >= 1 else "none")
    out["line"] = f"{name}: {arithmetic}{tail}"
    return out


def suggest(config, system_name: str, *, context: int | None = None) -> dict:
    """Workers per model for one system at ``context`` (default: each model's own), from what DGC already knows (no
    network read). Raises SuggestError when there is no such system."""
    block = router_mod.settings(config)
    system = router_mod.find_system(block, system_name)
    if system is None:
        raise SuggestError(f"there is no system {system_name!r}")
    if context is not None and not 2048 <= int(context) <= 16_777_216:
        raise SuggestError("context must be between 2,048 and 16,777,216 tokens")
    found, rows = _found(system["id"])
    used = [entry for entry in system["models"] if entry.get("use") is not False]
    if not used:
        from .router_tools import suggest_models
        used = suggest_models(found)
    mem = memory(system)
    mixed = not system.get("one_model_at_a_time") and len(used) > 1
    weights = {entry["name"]: _weights(rows.get(entry["name"], {})) for entry in used}
    plans = []
    for entry in used:
        row = {**rows.get(entry["name"], {}), **{k: entry[k] for k in ("params_b",) if entry.get(k)}}
        others = sum(value or 0.0 for name, value in weights.items() if name != entry["name"]) if mixed else 0.0
        plans.append(_plan_model(system, found, row, entry["name"], int(context or entry.get("context")
                                                                      or ROUTER_DEFAULT_CONTEXT),
                                 mem, others, len(used) if mixed else 1))
    numbers = [plan["workers"] for plan in plans if plan["workers"]]
    total = (min(ROUTER_MAX_WORKERS, sum(numbers)) if mixed else max(numbers)) if numbers else None
    notes = []
    if mem:
        notes.append(f"Memory: {_gb(mem['total_bytes'])} GB, from {mem['source']}"
                     + (" (shared with the computer)" if mem.get("unified") else "") + ".")
    else:
        notes.append("Memory: unknown. A hardware readout, or its memory in GB, makes Suggest exact.")
    if mixed:
        notes.append("Its models run side by side, so they share the memory: each gets an even part.")
    return {"system": system["id"], "name": system["name"], "context": int(context) if context else None,
            "memory": ({"total_gb": round(mem["total_bytes"] / GB, 1), "source": mem["source"],
                        "unified": bool(mem.get("unified"))} if mem else None),
            "models": plans, "workers": total, "notes": notes,
            "line": f"{system['name']}: " + (f"{_workers(total)} in all" if total else "no number DGC can back yet"),
            "applicable": bool(numbers)}


def text(result: dict, *, surface: str = "tool") -> str:
    """Suggest in words, for the model's tools (``surface`` "tool") or a terminal ("cli"): each says how to apply it,
    and how to give DGC the memory it lacks, in that surface's own terms. Settings draws ``result`` itself."""
    system = result["system"]
    terminal = surface != "tool"
    lines = [result["line"] + (f" at {_k(result['context'])}" if result.get("context") else "") + "."]
    for plan in result["models"]:
        lines.append("- " + plan["line"] + (f" ({plan['note']})" if plan.get("note") else ""))
    lines += result["notes"]
    if not result.get("memory"):
        lines.append(f"Give it: dgc router hardware {system} ADDRESS, or dgc router edit {system} --memory-gb N."
                     if terminal else "Give it: router_update set_hardware, or edit_system memory_gb.")
    if result.get("applicable"):
        lines.append(f"Apply it: dgc router suggest {system} --apply" if terminal
                     else "Apply it with router_update apply_suggestion.")
    return "\n".join(lines)


def applied(system: dict, result: dict) -> tuple[dict, list[str]]:
    """The system with the suggestion applied (a copy) and what changed, in words."""
    import copy
    after = copy.deepcopy(system)
    by_name = {entry["name"]: entry for entry in after["models"]}
    changed = []
    for plan in result["models"]:
        if not plan.get("workers"):
            continue
        entry = by_name.get(plan["name"])
        if entry is None:
            entry = {"name": plan["name"], "workers": 1, "context": plan["context"]}
            after["models"].append(entry)
            by_name[plan["name"]] = entry
        if entry.get("workers") != plan["workers"] or entry.get("context") != plan["context"]:
            changed.append(f"{plan['name']} · {_workers(int(plan['workers']))} at {_k(plan['context'])}")
        entry["workers"] = int(plan["workers"])
        entry["context"] = int(plan["context"])
    if result.get("workers") and after.get("workers") != result["workers"]:
        after["workers"] = int(result["workers"])
        backed = [plan for plan in result["models"] if plan.get("workers")]
        if len(backed) > 1:
            changed.append(f"{_workers(int(result['workers']))} in all")
        elif not changed:                       # one model, already so: the system's own count is what changes
            changed.append(f"{backed[0]['name']} · {_workers(int(backed[0]['workers']))} at {_k(backed[0]['context'])}")
    return after, changed


__all__ = ["suggest", "text", "applied", "memory", "headroom", "SuggestError"]
