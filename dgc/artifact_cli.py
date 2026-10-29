"""`dgc artifacts`: everything DGC made that you keep, from the terminal.

    dgc artifacts [list] [--type doc|slides|sheet|dashboard|page] [--from chat|work|pip] [--json]
    dgc artifacts show ID                 its versions: who made each, when, and what changed
    dgc artifacts open ID                 in your browser
    dgc artifacts export ID FORMAT [--to PATH]
    dgc artifacts restore ID VERSION
    dgc artifacts rm ID                   to DGC's trash (~/.dgc/artifacts/.trash), where it can be put back

A one-off command can't keep a server running after it ends, so `open` writes the artifact's page into its own folder
and opens that file; a running DGC (the terminal, the editor) serves it at an address of its own instead.
"""
from __future__ import annotations

import json
import shutil
import sys
import webbrowser
from pathlib import Path

from . import artifact_service as service
from .artifact_store import TYPES, ArtifactError

USAGE = __doc__.split("\n\n")[1]


def _short(text: str, n: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _when(stamp: str) -> str:
    """The store's UTC time, as this computer's local time."""
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(stamp or "")[:16]


def _list(args: list[str], out) -> int:
    kind = where = None
    as_json = "--json" in args
    rest = [a for a in args if a != "--json"]
    while rest:
        flag = rest.pop(0)
        if flag in ("--type", "-t") and rest:
            kind = rest.pop(0)
        elif flag == "--from" and rest:
            where = rest.pop(0)
        elif flag == "list":
            continue
        else:
            print(f"dgc artifacts: unknown option {flag}\n{USAGE}", file=sys.stderr)
            return 2
    if kind and kind not in TYPES:
        print(f"dgc artifacts: --type is one of {', '.join(TYPES)}", file=sys.stderr)
        return 2
    items = service.listing(type=kind, surface=where)
    if as_json:
        out(json.dumps(items, indent=1, ensure_ascii=False))
        return 0
    if not items:
        out("No artifacts yet. Ask DGC for a document, slides, a spreadsheet, a dashboard or a page.")
        return 0
    for item in items:
        origin = item.get("origin", {}).get("surface", "")
        out(f"{item['id']}  {item['label']:<11} v{item['version']:<3} {_when(item['updated'])}  "
            f"{origin:<4}  {_short(item['title'], 60)}")
    return 0


def _show(aid: str, out) -> int:
    view = service.view(aid)
    out(f"{view['label']} “{view['title']}”  {view['id']}  (from {view['origin'].get('surface', '?')})")
    for v in view.get("versions", []):
        out(f"  v{v['n']:<3} {_when(v['at'])}  {_short(v['author'], 14):<14} {_short(v['summary'], 70)}")
    out(f"  exports: {', '.join(view['exports'])}")
    if view.get("file"):
        out(f"  edit: {view['file']}")
    return 0


def _open(aid: str, out) -> int:
    files, entry = service.render(aid)
    folder = service.write_view(aid, files)
    url = (folder / entry).as_uri()
    opened = webbrowser.open(url)
    out(("Opened " if opened else "Open this in your browser: ") + url)
    return 0


def _export(aid: str, fmt: str, to: str | None, out) -> int:
    path = service.export(aid, fmt)
    if to:
        target = Path(to).expanduser()
        if target.is_dir():
            target = target / path.name
        shutil.copyfile(path, target)
        path = target
    out(str(path))
    return 0


def main(argv: list[str], out=print) -> int:
    args = list(argv or [])
    if args and args[0] in ("-h", "--help", "help"):
        out(USAGE)
        return 0
    command = args[0] if args and not args[0].startswith("-") else "list"
    try:
        if command == "list":
            return _list(args[1:] if args and args[0] == "list" else args, out)
        if command in ("show", "open", "rm", "remove") and len(args) == 2:
            if command == "show":
                return _show(args[1], out)
            if command == "open":
                return _open(args[1], out)
            view = service.view(args[1], versions=False)
            service.remove(args[1])
            out(f"Moved {view['label'].lower()} “{view['title']}” to DGC's trash (~/.dgc/artifacts/.trash).")
            return 0
        if command == "export" and len(args) >= 3:
            to = args[args.index("--to") + 1] if "--to" in args and args.index("--to") + 1 < len(args) else None
            return _export(args[1], args[2], to, out)
        if command == "restore" and len(args) == 3:
            view = service.restore(args[1], int(args[2]))
            out(f"Restored version {args[2]} as version {view['version']} of “{view['title']}”.")
            return 0
    except (service.ArtifactUseError, ArtifactError, ValueError, OSError) as exc:
        print(f"dgc artifacts: {exc}", file=sys.stderr)
        return 1
    print(USAGE, file=sys.stderr)
    return 2
