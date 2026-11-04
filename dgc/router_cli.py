"""`dgc router`: DGC Router from the command line (and the text `/router` shows in the terminal).

    dgc router [status] [--refresh] [--json]
    dgc router add ADDRESS [--name NAME] [--id ID] [--jobs subagents,pips] [--models A,B] [--workers N]
                           [--one-model] [--memory-gb N] [--context 16K] [--key] [--json]
    dgc router edit ID [--name NAME] [--address ADDRESS] [--jobs ...] [--workers N] [--one-model|--mixed-models]
                       [--memory-gb N] [--model M [--use|--no-use] [--model-workers N] [--context 16K] [--note TEXT]
                       [--thinking same|off|low|medium|high]]
                       [--when-busy wait|default] [--key|--remove-key] [--json]
    dgc router remove ID [--json]
    dgc router test ID [--model M] [--checks models,speed,parallel,tools] [--json]
    dgc router on|off [--json]
    dgc router find [--json]
    dgc router hardware ID [ADDRESS|off] [--token] [--json]
    dgc router suggest ID [--context N] [--apply] [--json]

A key (or a dgc node's pairing token) is read from the terminal (or a pipe) with --key (--token), never from the
command line. A change, a key or a look
on the network run from the agent's own shell are refused: those are the user's to make.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

from . import router as router_mod
from . import router_tools
from .config import Config

CHANGES = ("add", "edit", "remove", "on", "off", "find")


def context_arg(text) -> int:
    """A context in tokens: 32768, 32,768, 32k or 32K (router_tools.context_tokens, as Settings' box reads it)."""
    try:
        return router_tools.context_tokens(text)
    except router_tools.UpdateError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dgc router", description="DGC Router: your other computers that run "
                                     "models, for sub-agents and Pips")
    sub = parser.add_subparsers(dest="command")
    status = sub.add_parser("status", help="every system, its models and workers")
    status.add_argument("--refresh", action="store_true", help="check every system first")
    status.add_argument("--json", action="store_true")
    add = sub.add_parser("add", help="add a computer by its address")
    add.add_argument("address")
    add.add_argument("--name", default="")
    add.add_argument("--id", default="")
    add.add_argument("--jobs", default="subagents,pips")
    add.add_argument("--models", default="", help="which of its models to use (default: its chat models)")
    add.add_argument("--workers", type=int)
    add.add_argument("--one-model", action="store_true", help="never mix models while it works")
    add.add_argument("--memory-gb", type=float)
    add.add_argument("--context", type=context_arg, help="the context for each model it adds: 16384, 16K or 16k")
    add.add_argument("--key", action="store_true", help="read its key from the terminal or a pipe")
    add.add_argument("--json", action="store_true")
    edit = sub.add_parser("edit", help="change a system")
    edit.add_argument("system")
    edit.add_argument("--name")
    edit.add_argument("--address")
    edit.add_argument("--jobs")
    edit.add_argument("--workers", type=int)
    group = edit.add_mutually_exclusive_group()
    group.add_argument("--one-model", dest="one_model", action="store_true", default=None)
    group.add_argument("--mixed-models", dest="one_model", action="store_false")
    edit.add_argument("--memory-gb", type=float)
    edit.add_argument("--model")
    use = edit.add_mutually_exclusive_group()
    use.add_argument("--use", dest="use", action="store_true", default=None)
    use.add_argument("--no-use", dest="use", action="store_false")
    edit.add_argument("--model-workers", type=int)
    edit.add_argument("--context", type=context_arg, help="--model's context: 16384, 16K or 16k")
    edit.add_argument("--note")
    edit.add_argument("--thinking", choices=["same", "off", "low", "medium", "high"],
                      help="how hard a helper on --model thinks (same: the helper's own level)")
    edit.add_argument("--when-busy", choices=["wait", "default"])
    keys = edit.add_mutually_exclusive_group()
    keys.add_argument("--key", action="store_true", help="read a new key from the terminal or a pipe")
    keys.add_argument("--remove-key", action="store_true")
    edit.add_argument("--json", action="store_true")
    remove = sub.add_parser("remove", help="remove a system (and its saved key)")
    remove.add_argument("system")
    remove.add_argument("--json", action="store_true")
    test = sub.add_parser("test", help="measure a system: models, speed, parallel, tool calls")
    test.add_argument("system")
    test.add_argument("--model", default="")
    test.add_argument("--checks", default="models,speed,parallel,tools")
    test.add_argument("--json", action="store_true")
    for name, words in (("on", "turn DGC Router on"), ("off", "turn DGC Router off")):
        switch = sub.add_parser(name, help=words)
        switch.add_argument("--json", action="store_true")
    find = sub.add_parser("find", help="look for model servers on this computer's own network")
    find.add_argument("--json", action="store_true")
    hardware = sub.add_parser("hardware", help="read a system's GPU and memory from an exporter or a dgc node")
    hardware.add_argument("system")
    hardware.add_argument("address", nargs="?", default="",
                          help="its exporter's or dgc node's address (off stops it); leave out to read it now")
    hardware.add_argument("--token", action="store_true", help="read a dgc node's pairing token from the terminal "
                          "or a pipe")
    hardware.add_argument("--json", action="store_true")
    suggest = sub.add_parser("suggest", help="workers per model, from its memory, the server and what was measured")
    suggest.add_argument("system")
    suggest.add_argument("--context", type=context_arg, help="the context to plan for (default: each model's own)")
    suggest.add_argument("--apply", action="store_true", help="use it (shows the change)")
    suggest.add_argument("--json", action="store_true")
    return parser


def _say(args, payload: dict, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    else:
        print(text)


def _read_key(prompt: str = "Key (not shown): ") -> str:
    if sys.stdin.isatty():
        return getpass.getpass(prompt).strip()
    return sys.stdin.readline().strip()


def _apply(config, args, change: dict, *, key: str | None = None) -> int:
    try:
        plan = router_tools.plan_update(config, change)
        router_tools.apply_plan(config, plan)
    except router_tools.ChooseModels as exc:
        print(f"dgc router: nothing is loaded on {exc.name} now, so DGC didn't choose its models (using one loads it "
              f"on that computer).\nIt serves: {router_tools.choices_text(exc.choices)}\n"
              f"Choose with --models, e.g. --models {exc.choices[0]}", file=sys.stderr)
        return 1
    except router_tools.UpdateError as exc:
        print(f"dgc router: {exc}", file=sys.stderr)
        return 1
    if key is not None and plan.system_id:
        try:
            config.set_router_key(plan.system_id, key)
        except ValueError as exc:
            print(f"dgc router: {exc}", file=sys.stderr)
            return 1
    notes = [] if plan.done else [note for note in plan.notes if not (key and "wants a key" in note)]
    head = plan.done or plan.summary
    _say(args, {"ok": True, "change": head, "notes": notes, "router": plan.after},
         "\n".join([head + ".", *notes, "", plan.diff.rstrip()]).rstrip())
    return 0


def main(argv: list[str]) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv or ["status"])
    except SystemExit as exc:
        return int(exc.code or 0)
    command = args.command or "status"
    wants_key = bool(getattr(args, "key", False) or getattr(args, "remove_key", False) or getattr(args, "token", False))
    changes = command in CHANGES or (command == "hardware" and args.address) or (command == "suggest" and args.apply)
    if os.environ.get("DGC_AGENT_SHELL") == "1" and (changes or wants_key):
        print("dgc router: changing DGC Router, its keys, or looking on the network is your decision; run it in "
              "your own terminal (the model uses router_update, which asks you).", file=sys.stderr)
        return 2
    config = Config()
    if command == "status":
        status = router_mod.status(config, refresh=args.refresh)
        _say(args, status, router_tools.status_text(status))
        return 0
    if command in ("on", "off"):
        return _apply(config, args, {"action": "turn_on" if command == "on" else "turn_off"})
    if command == "add":
        key = _read_key() if args.key else None
        change = {"action": "add_system", "base_url": args.address, "name": args.name, "system": args.id,
                  "jobs": [job.strip() for job in args.jobs.split(",") if job.strip()],
                  "one_model_at_a_time": args.one_model}
        if args.models:
            change["models"] = [name.strip() for name in args.models.split(",") if name.strip()]
        if args.workers:
            change["workers"] = args.workers
        if args.memory_gb:
            change["memory_gb"] = args.memory_gb
        if args.context:
            change["context"] = args.context
        return _apply(config, args, change, key=key)
    if command == "remove":
        return _apply(config, args, {"action": "remove_system", "system": args.system})
    if command == "edit":
        status = 0
        if args.key or args.remove_key:
            system = router_mod.find_system(router_mod.settings(config), args.system)
            if system is None:
                print(f"dgc router: there is no system {args.system!r}", file=sys.stderr)
                return 1
            config.set_router_key(system["id"], "" if args.remove_key else _read_key())
            print(("Removed the key for " if args.remove_key else "Saved the key for ") + system["name"] + ".")
        change = {"action": "edit_system", "system": args.system}
        for key, value in (("name", args.name), ("base_url", args.address), ("workers", args.workers),
                           ("one_model_at_a_time", args.one_model), ("memory_gb", args.memory_gb)):
            if value is not None:
                change[key] = value
        if args.jobs is not None:
            change["jobs"] = [job.strip() for job in args.jobs.split(",") if job.strip()]
        if len(change) > 2:
            status = _apply(config, args, change) or status
        if args.model:
            model_change = {"action": "set_model", "system": args.system, "model": args.model}
            for key, value in (("use", args.use), ("workers", args.model_workers), ("context", args.context),
                               ("note", args.note),
                               ("thinking", None if args.thinking is None else "" if args.thinking == "same"
                                else args.thinking)):
                if value is not None:
                    model_change[key] = value
            status = _apply(config, args, model_change) or status
        if args.when_busy:
            status = _apply(config, args, {"action": "set_when_busy", "when_busy": args.when_busy}) or status
        if len(change) <= 2 and not args.model and not args.when_busy and not (args.key or args.remove_key):
            print("dgc router edit: nothing to change", file=sys.stderr)
            return 2
        return status
    if command == "test":
        checks = [c.strip() for c in args.checks.split(",") if c.strip()]
        try:
            result = router_tools.probe(config, args.system, model=args.model, checks=checks,
                                        on_step=None if args.json else (lambda line: print(line + "…",
                                                                                           file=sys.stderr)))
        except router_tools.UpdateError as exc:
            print(f"dgc router: {exc}", file=sys.stderr)
            return 1
        _say(args, result, router_tools.probe_text(result, surface="cli"))
        return 0
    if command == "hardware":
        return _hardware(config, args)
    if command == "suggest":
        from .router_suggest import SuggestError, suggest, text
        if args.apply:
            change = {"action": "apply_suggestion", "system": args.system}
            if args.context:
                change["context"] = args.context
            return _apply(config, args, change)
        try:
            result = suggest(config, args.system, context=args.context)
        except SuggestError as exc:
            print(f"dgc router: {exc}", file=sys.stderr)
            return 1
        _say(args, result, text(result, surface="cli"))
        return 0
    if command == "find":
        from .router_probe import ProbeError, find
        try:
            result = find()
        except ProbeError as exc:
            print(f"dgc router: {exc}", file=sys.stderr)
            return 1
        _say(args, result, router_tools.find_text(config, result))
        return 0
    parser.print_usage(sys.stderr)
    return 2


def _hardware(config, args) -> int:
    """`dgc router hardware ID [ADDRESS|off] [--token]`: set up (or stop) a system's readout, save a dgc node's
    pairing token, and read it now."""
    from . import router_hardware
    system = router_mod.find_system(router_mod.settings(config), args.system)
    if system is None:
        print(f"dgc router: there is no system {args.system!r}", file=sys.stderr)
        return 1
    plan = None
    if args.address:
        try:
            plan = router_tools.plan_update(config, {"action": "set_hardware", "system": system["id"],
                                                     "hardware_url": args.address})
            router_tools.apply_plan(config, plan)
        except router_tools.UpdateError as exc:
            print(f"dgc router: {exc}", file=sys.stderr)
            return 1
        system = router_mod.find_system(router_mod.settings(config), system["id"])
    readout = system.get("hardware") or {}
    if args.token:
        try:
            config.set_router_hardware_token(system["id"], _read_key("Pairing token (not shown): "))
        except ValueError as exc:
            print(f"dgc router: {exc}", file=sys.stderr)
            return 1
    if readout.get("source", "none") == "none":
        payload = {"ok": True, "system": system["id"], "hardware": {"source": "none"}}
        text = (plan.summary + "." if plan else f"{system['name']} has no hardware readout.") + \
            f" Set one up: dgc router hardware {system['id']} ADDRESS (an exporter, or a dgc node)."
        _say(args, payload, text)
        return 0
    router_hardware.read_system(config, system, max_age=0)
    row = router_hardware.status_row(config, system) or {}
    notes = [note for note in (plan.notes if plan else []) if not (args.token and "pairing token" in note)]
    lines = ([plan.summary + ".", *notes, ""] if plan else []) + [f"{system['name']}: " + router_tools.hardware_text(row)]
    _say(args, {"ok": not row.get("error"), "system": system["id"], "hardware": row,
                **({"change": plan.summary} if plan else {})}, "\n".join(lines))
    return 0 if not row.get("error") else 1


# ---- /router in the terminal --------------------------------------------------------------------------------------
SLASH_USAGE = ("/router · /router add ADDRESS [NAME] · /router test ID · /router on · /router off · /router key ID · "
               "/router hardware ID [ADDRESS|off] · /router token ID · /router suggest ID [CONTEXT]")


def slash(config, rest: str, *, ask_key=None) -> tuple[str, str]:
    """What `/router REST` does in the TUI or the classic terminal: (markdown to show, a short flash line).
    ``ask_key(system_id, done)`` asks for a key without echoing it; done(text) saves it."""
    words = rest.split()
    sub = words[0].lower() if words else "status"
    try:
        if sub == "status":
            refresh = len(words) > 1 and words[1] in ("refresh", "--refresh")
            status = router_mod.status(config, refresh=refresh)
            return "```\n" + router_tools.status_text(status) + "\n```", ""
        if sub in ("on", "off"):
            plan = router_tools.plan_update(config, {"action": "turn_on" if sub == "on" else "turn_off"})
            router_tools.apply_plan(config, plan)
            return "", plan.summary + (" · " + " ".join(plan.notes) if plan.notes else "")
        if sub == "add":
            if len(words) < 2:
                return "", "usage: /router add ADDRESS [NAME]  (e.g. /router add gpu-box.local GPU box)"
            plan = router_tools.plan_update(config, {"action": "add_system", "base_url": words[1],
                                                     "name": " ".join(words[2:])}, pick_later=True)
            router_tools.apply_plan(config, plan)
            notes = list(plan.notes)
            if not router_mod.find_system(plan.after, plan.system_id)["models"] and plan.discovered:
                notes.append(f"Choose with `dgc router edit {plan.system_id} --model NAME --use`, or in Settings.")
            body = "\n".join([f"**{plan.summary}.**", *notes, "", "```diff", plan.diff.rstrip(), "```"])
            if not router_mod.settings(config)["enabled"]:
                body += "\n\nDGC Router is off: `/router on` uses it."
            return body, plan.summary
        if sub == "test":
            if len(words) < 2:
                return "", "usage: /router test ID [MODEL]"
            result = router_tools.probe(config, words[1], model=words[2] if len(words) > 2 else "")
            return router_tools.probe_text(result, surface="tui"), f"tested {words[1]}"
        if sub == "key":
            if len(words) < 2:
                return "", "usage: /router key ID"
            system = router_mod.find_system(router_mod.settings(config), words[1])
            if system is None:
                return "", f"there is no system {words[1]!r}"
            if ask_key is not None:
                ask_key(system["id"], lambda text, sid=system["id"]: config.set_router_key(sid, text))
            return "", ""
        if sub == "token":
            if len(words) < 2:
                return "", "usage: /router token ID  (a dgc node's pairing token)"
            system = router_mod.find_system(router_mod.settings(config), words[1])
            if system is None:
                return "", f"there is no system {words[1]!r}"
            if (system.get("hardware") or {}).get("source") != "node":
                return "", f"{system['name']} reads no dgc node: /router hardware {system['id']} ADDRESS first"
            if ask_key is not None:
                ask_key(system["id"], lambda text, sid=system["id"]: config.set_router_hardware_token(sid, text),
                        what="dgc node pairing token")
            return "", ""
        if sub == "hardware":
            from . import router_hardware
            if len(words) < 2:
                return "", "usage: /router hardware ID [ADDRESS|off]"
            system = router_mod.find_system(router_mod.settings(config), words[1])
            if system is None:
                return "", f"there is no system {words[1]!r}"
            head = []
            if len(words) > 2:
                plan = router_tools.plan_update(config, {"action": "set_hardware", "system": system["id"],
                                                         "hardware_url": words[2]})
                router_tools.apply_plan(config, plan)
                head = [f"**{plan.summary}.**", *plan.notes, ""]
                system = router_mod.find_system(router_mod.settings(config), system["id"])
            else:
                router_hardware.read_system(config, system, max_age=0)
            row = router_hardware.status_row(config, system)
            said = router_tools.hardware_text(row) if row else "no hardware readout (/router hardware ID ADDRESS)"
            return "\n".join([*head, f"{system['name']}: {said}"]), ""
        if sub == "suggest":
            from .router_suggest import SuggestError, suggest, text
            if len(words) < 2:
                return "", "usage: /router suggest ID [CONTEXT]"
            try:
                context = context_arg(words[2]) if len(words) > 2 else None
                result = suggest(config, words[1], context=context)
            except (SuggestError, argparse.ArgumentTypeError) as exc:
                return "", f"DGC Router: {exc}"
            return "```\n" + text(result, surface="cli") + "\n```", ""
    except router_tools.UpdateError as exc:
        return "", f"DGC Router: {exc}"
    return "", "usage: " + SLASH_USAGE
