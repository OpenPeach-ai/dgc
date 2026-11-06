"""`dgc images`: the image generators from the command line (and the text `/images` shows in the terminal).

    dgc images [list] [--refresh] [--json]
    dgc images add PROVIDER [ADDRESS] [--name NAME] [--id ID] [--model M] [--size WxH] [--workflow FILE] [--yes]
                   [--asks|--no-asks] [--good-for TEXT] [--limit USD] [--system ID] [--key] [--default] [--json]
    dgc images edit ID [--name N] [--address A] [--model M] [--size WxH] [--asks|--no-asks] [--enable|--disable]
                   [--good-for TEXT] [--limit USD|--no-limit] [--system ID] [--workflow FILE] [--key|--remove-key]
    dgc images remove ID [--json]
    dgc images test [ID ...] [--json]
    dgc images default [ID] [--project] [--clear] [--json]
    dgc images generate PROMPT [--generator ID] [--size WxH] [--count N] [--seed N] [--out DIR] [--yes] [--json]

A key is read from the terminal (or a pipe) with --key, never from the command line. A change or a key from the
agent's own shell is refused: those are the user's to make (the model has generate_image, which asks).
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

from . import image_providers as P
from . import image_tools, images
from . import images_admin as admin

CHANGES = ("add", "edit", "remove", "default")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dgc images", description="Your image generators: ComfyUI, Automatic1111, "
                                     "OpenAI, Gemini, Black Forest Labs, fal.ai, Replicate, xAI, Together and others")
    sub = parser.add_subparsers(dest="command")
    listing = sub.add_parser("list", help="every generator, what it costs and whether it works")
    listing.add_argument("--refresh", action="store_true", help="test each one first (no image is made)")
    listing.add_argument("--json", action="store_true")
    add = sub.add_parser("add", help="add a generator")
    add.add_argument("provider", help=", ".join(images.PROVIDER_LABELS))
    add.add_argument("address", nargs="?", default="", help="its address (a local server's; a cloud one has its own)")
    add.add_argument("--name", default="")
    add.add_argument("--id", default="")
    add.add_argument("--model", default="")
    add.add_argument("--size")
    add.add_argument("--workflow", help="a ComfyUI workflow exported in API format")
    add.add_argument("--yes", action="store_true", help="use the inputs DGC finds in the workflow without asking")
    asks = add.add_mutually_exclusive_group()
    asks.add_argument("--asks", dest="asks", action="store_true", default=None)
    asks.add_argument("--no-asks", dest="asks", action="store_false")
    add.add_argument("--good-for", default="")
    add.add_argument("--limit", type=float, help="most to spend a month, in US dollars")
    add.add_argument("--system", default="", help="a DGC Router system with the images job")
    add.add_argument("--key", action="store_true", help="read its key from the terminal or a pipe")
    add.add_argument("--default", action="store_true")
    add.add_argument("--json", action="store_true")
    edit = sub.add_parser("edit", help="change a generator")
    edit.add_argument("generator")
    for flag in ("--name", "--address", "--model", "--size", "--good-for", "--system", "--workflow"):
        edit.add_argument(flag)
    asks = edit.add_mutually_exclusive_group()
    asks.add_argument("--asks", dest="asks", action="store_true", default=None)
    asks.add_argument("--no-asks", dest="asks", action="store_false")
    enabled = edit.add_mutually_exclusive_group()
    enabled.add_argument("--enable", dest="enabled", action="store_true", default=None)
    enabled.add_argument("--disable", dest="enabled", action="store_false")
    limit = edit.add_mutually_exclusive_group()
    limit.add_argument("--limit", type=float)
    limit.add_argument("--no-limit", action="store_true")
    keys = edit.add_mutually_exclusive_group()
    keys.add_argument("--key", action="store_true")
    keys.add_argument("--remove-key", action="store_true")
    edit.add_argument("--json", action="store_true")
    remove = sub.add_parser("remove", help="remove a generator (and its saved key)")
    remove.add_argument("generator")
    remove.add_argument("--json", action="store_true")
    test = sub.add_parser("test", help="test generators now (no image is made)")
    test.add_argument("generators", nargs="*")
    test.add_argument("--json", action="store_true")
    default = sub.add_parser("default", help="the default generator, or this project's choice")
    default.add_argument("generator", nargs="?", default="")
    default.add_argument("--project", action="store_true", help="this project's choice instead of the default")
    default.add_argument("--clear", action="store_true")
    default.add_argument("--json", action="store_true")
    make = sub.add_parser("generate", help="make an image now")
    make.add_argument("prompt")
    make.add_argument("--generator", default="")
    make.add_argument("--size")
    make.add_argument("--count", type=int, default=1)
    make.add_argument("--seed", type=int)
    make.add_argument("--out", default="",
                      help="a folder or file in this project (default: DGC's own folder, ~/.dgc/images)")
    make.add_argument("--yes", action="store_true", help="a paid generator goes ahead without asking")
    make.add_argument("--json", action="store_true")
    return parser


def _say(args, payload, text: str) -> None:
    if getattr(args, "json", False):
        print(admin.as_json(payload))
    else:
        print(text)


def _read_key() -> str:
    if sys.stdin.isatty():
        return getpass.getpass("Key (not shown): ").strip()
    return sys.stdin.readline().strip()


def _project_root() -> Path:
    from .config import find_project_root
    return Path(find_project_root())


def check_line(row: dict) -> str:
    if row.get("ok"):
        return "works" + (f" ({row['detail']})" if row.get("detail") else "")
    return f"{P.KIND_WORDS.get(row.get('kind'), row.get('kind') or 'failed')}: {row.get('detail', '')}"


def main(argv: list[str]) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv or ["list"])
    except SystemExit as exc:
        return int(exc.code or 0)
    command = args.command or "list"
    wants_key = bool(getattr(args, "key", False) or getattr(args, "remove_key", False))
    if os.environ.get("DGC_AGENT_SHELL") == "1" and (command in CHANGES or wants_key or command == "generate"):
        print("dgc images: changing your image generators, their keys, or spending on one is your decision; run it "
              "in your own terminal (the model uses generate_image, which asks).", file=sys.stderr)
        return 2
    from .config import Config
    config = Config()
    root = _project_root()
    try:
        if command == "list":
            value = images.listing(config, project_root=root, refresh=args.refresh)
            _say(args, value, images.listing_text(value))
            return 0
        if command == "add":
            fields = {"provider": args.provider, "base_url": args.address, "name": args.name, "id": args.id,
                      "model": args.model, "size": args.size, "asks": args.asks, "good_for": args.good_for,
                      "monthly_limit_usd": args.limit, "system": args.system, "default": args.default}
            if args.workflow:
                fields["workflow"] = Path(args.workflow).expanduser().read_text(encoding="utf-8")
            key = _read_key() if args.key else None
            out = admin.add(config, fields, confirm=args.yes)
            if out.get("pending"):
                lines = ["DGC found these inputs in the workflow:", *("  " + line for line in out["mapping_lines"]),
                         *("  note: " + note for note in out.get("notes") or [])]
                if args.json or not sys.stdin.isatty():
                    _say(args, out, "\n".join(lines + ["Run again with --yes to use them."]))
                    return 3
                print("\n".join(lines))
                if input("Use these? [Y/n] ").strip().lower() not in ("", "y", "yes"):
                    print("Not added.")
                    return 1
                out = admin.add(config, fields, confirm=True)
            if key is not None:
                admin.set_key(config, out["generator"]["id"], key)
                out["notes"] = [n for n in out.get("notes") or [] if "needs a key" not in n]
                out["check"] = images.check(config, images.settings(config)["generators"][-1])
            text = "\n".join([out["summary"] + ".", *(out.get("notes") or []),
                              *(["Test: " + check_line(out["check"])] if out.get("check") else [])])
            _say(args, out, text)
            return 0
        if command == "edit":
            status = 0
            if args.key or args.remove_key:
                print(admin.set_key(config, args.generator, "" if args.remove_key else _read_key())["summary"] + ".")
            fields = {"name": args.name, "base_url": args.address, "model": args.model, "size": args.size,
                      "good_for": args.good_for, "system": args.system, "asks": args.asks, "enabled": args.enabled,
                      "monthly_limit_usd": -1 if args.no_limit else args.limit}
            if args.workflow:
                fields["workflow"] = Path(args.workflow).expanduser().read_text(encoding="utf-8")
            fields = {k: v for k, v in fields.items() if v is not None}
            if fields:
                out = admin.edit(config, args.generator, fields)
                _say(args, out, out["summary"] + ".")
            elif not (args.key or args.remove_key):
                print("dgc images edit: nothing to change", file=sys.stderr)
                status = 2
            return status
        if command == "remove":
            out = admin.remove(config, args.generator)
            _say(args, out, out["summary"] + ".")
            return 0
        if command == "test":
            found = admin.test(config, args.generators or None)
            _say(args, found, "\n".join(f"{gid}: {check_line(row)}" for gid, row in found.items()) or
                 "No image generator is set up (dgc images add).")
            return 0 if all(row.get("ok") for row in found.values()) else 1
        if command == "default":
            if args.project:
                out = admin.set_project_choice(config, "" if args.clear else args.generator, root)
            elif args.generator or args.clear:
                out = admin.set_default(config, "" if args.clear else args.generator)
            else:
                block = images.settings(config)
                out = {"default": block.get("default", ""), "project_choice": images.project_choice(root)}
                _say(args, out, f"default: {out['default'] or 'none'} · this project: "
                                f"{out['project_choice'] or 'none chosen'}")
                return 0
            _say(args, out, out["summary"] + ".")
            return 0
        if command == "generate":
            return _generate(config, args, root)
    except admin.ChangeError as exc:
        print(f"dgc images: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"dgc images: {exc}", file=sys.stderr)
        return 1
    parser.print_usage(sys.stderr)
    return 2


def _generate(config, args, root: Path) -> int:
    def ask(title, options, recommended):
        if not sys.stdin.isatty():
            return None
        print(title)
        for index, (label, description) in enumerate(options, 1):
            print(f"  {index}. {label} ({description})" + ("  [recommended]" if index - 1 == recommended else ""))
        answer = input("Choose a number: ").strip()
        return int(answer) - 1 if answer.isdigit() else None

    def approve(card):
        if args.yes:
            return "once"
        if not sys.stdin.isatty():
            return "no"
        note = f"\n  {card['note']}" if card.get("note") else ""
        answer = input(f"{card['generator']} ({card['provider']}, {card['model']}), {card['count']} × {card['size']}, "
                       f"{card['price']}.{note}\nMake it? [y/N/always] ").strip().lower()
        return "always" if answer == "always" else "once" if answer in ("y", "yes") else "no"
    from .images import session_folder
    surface = image_tools.Surface(name="cli", root=root, project_root=root, interactive=sys.stdin.isatty(),
                                  ask=ask, approve=approve, where={"project": str(root)},
                                  progress=None if args.json else (lambda text, v, t: print(text, file=sys.stderr)),
                                  home=session_folder("cli"))
    call = {"prompt": args.prompt, "generator": args.generator, "count": args.count, "seed": args.seed}
    if args.size:
        call["size"] = args.size
    if args.out:
        call["save_to"] = args.out
    try:
        plan = image_tools.prepare(config, call, surface)
    except image_tools.Refused as exc:
        print(f"dgc images: {exc}", file=sys.stderr)
        return 1
    if plan.asks:
        verdict = approve(plan.card())
        if verdict == "no":
            print("Not made.", file=sys.stderr)
            return 1
        if verdict == "always":
            image_tools.allow_always(config, plan.generator["id"])
    outcome = image_tools.execute(config, plan, surface)
    payload = {"text": outcome.text, "images": [{"path": str(s.path), "sidecar": str(s.sidecar), "width": s.width,
                                                 "height": s.height, "seed": s.seed}
                                                for s in (outcome.result.saved if outcome.result else [])],
               **({"error": outcome.error.as_dict()} if outcome.error else {})}
    _say(args, payload, outcome.text)
    return 0 if outcome.result else 1


# ---- /images in the terminal --------------------------------------------------------------------------------------
SLASH_USAGE = ("/images · /images add PROVIDER [ADDRESS] [NAME] · /images test [ID] · /images default ID · "
               "/images use ID (this project) · /images key ID")


def slash(config, rest: str, *, ask_key=None, project_root=None) -> tuple[str, str]:
    """What `/images REST` does in the TUI or the classic terminal: (markdown to show, a short flash line)."""
    words = rest.split()
    sub = words[0].lower() if words else "list"
    try:
        if sub in ("list", "status"):
            refresh = len(words) > 1 and words[1] in ("refresh", "--refresh")
            value = images.listing(config, project_root=project_root, refresh=refresh)
            return "```\n" + images.listing_text(value) + "\n```", ""
        if sub == "add":
            if len(words) < 2:
                return "", "usage: /images add PROVIDER [ADDRESS] [NAME]  (e.g. /images add comfyui gpu-box.local:8188)"
            provider = words[1]
            address = words[2] if len(words) > 2 and ("." in words[2] or ":" in words[2] or "/" in words[2]) else ""
            name = " ".join(words[3:] if address else words[2:])
            out = admin.add(config, {"provider": provider, "base_url": address, "name": name})
            body = "\n".join([f"**{out['summary']}.**", *(out.get("notes") or []),
                              *(["Test: " + check_line(out["check"])] if out.get("check") else [])])
            return body, out["summary"]
        if sub == "test":
            found = admin.test(config, words[1:] or None)
            return "```\n" + ("\n".join(f"{gid}: {check_line(row)}" for gid, row in found.items()) or
                              "No image generator is set up.") + "\n```", "tested"
        if sub == "default":
            if len(words) < 2:
                return "", "usage: /images default ID"
            return "", admin.set_default(config, words[1])["summary"]
        if sub == "use":
            if project_root is None:
                return "", "no project here"
            return "", admin.set_project_choice(config, words[1] if len(words) > 1 else "", project_root)["summary"]
        if sub == "key":
            if len(words) < 2:
                return "", "usage: /images key ID"
            generator = images.find(images.settings(config), words[1])
            if generator is None:
                return "", f"there is no image generator {words[1]!r}"
            if ask_key is not None:
                ask_key(generator["id"], lambda text, gid=generator["id"]: admin.set_key(config, gid, text))
            return "", ""
    except admin.ChangeError as exc:
        return "", f"Images: {exc}"
    return "", "usage: " + SLASH_USAGE
