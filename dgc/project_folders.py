"""The Project Folder dropdown (his calls, 12 Nov, for 0.52), what the editor needs for it (Pips API 93).

One shared choice, "All projects" or one folder, filters the Work sessions, Home's recent sessions, the Pips view's
Project tab and Needs Attention for Project Pips. A session or a Project Pip from another folder opens here and keeps
running in its own folder. This module answers:

- ``listing``: the folders that have a Work session or a Project Pip, newest first, this window's marked and a gone
  one marked; never DGC's own folders (a helper's worktree, a fix's copy, anything under ~/.dgc).
- ``pips_everywhere``: every project's Pips, each with its workspace, paged across them (a computer has few).
- ``add``: a folder the user picked ("Add a folder…") becomes a project, so a Project Pip can be made there. It must
  exist and be a folder, and is never /, the home folder or DGC's own.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .workspace_registry import RegistryError

MAX_FOLDERS = 200


def _home() -> Path:
    return Path.home()


def _own(folder: Path) -> bool:
    from .config import dgc_home
    own = dgc_home().expanduser().resolve(strict=False)
    return folder == own or own in folder.parents


def _unlisted(folder: Path, here: Path) -> bool:
    """Left out of the list: DGC's own folders, and temporary or DGC-home ones (sessions.not_a_project), except this
    window's own folder, which is always there."""
    from .sessions import not_a_project
    return _own(folder) or (folder != here and not_a_project(folder))


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _seconds(stamp) -> float:
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def listing(registry, config) -> dict:
    """list_project_folders: {folders: [{folder, name, here, exists, sessions, pips, workspace_id, updated_at}]}."""
    from . import sessions
    here = Path(config.project_root).expanduser().resolve(strict=False)
    found: dict[str, dict] = {}

    def row(folder: Path) -> dict:
        return found.setdefault(str(folder), {"sessions": 0, "pips": 0, "updated": 0.0, "workspace_id": None})
    try:
        buckets = [b for b in sessions.SESSIONS_DIR.iterdir() if b.is_dir() and not b.is_symlink()]
    except OSError:
        buckets = []
    for bucket in buckets:
        project = sessions._bucket_project(bucket)
        if not project:
            continue
        folder = Path(project).expanduser().resolve(strict=False)
        if _unlisted(folder, here):
            continue
        try:
            stamps = [p.stat().st_mtime for p in bucket.glob("*.json") if p.is_file() and not p.is_symlink()]
        except OSError:
            continue
        if not stamps:
            continue
        place = row(folder)
        place["sessions"] += len(stamps)
        place["updated"] = max(place["updated"], max(stamps))
    for workspace_id, root, count, latest in registry.db.execute(
            "SELECT w.id,b.canonical_root,count(p.id),max(p.updated_at) FROM workspaces w "
            "JOIN bindings b ON b.workspace_id=w.id AND b.runner_id=? JOIN pips p ON p.workspace_id=w.id "
            "WHERE w.kind<>'personal' AND p.status<>'archived' GROUP BY w.id", (registry.runner_id,)):
        folder = Path(root).expanduser().resolve(strict=False)
        if _unlisted(folder, here):
            continue
        place = row(folder)
        place["pips"] += count
        place["workspace_id"] = workspace_id
        place["updated"] = max(place["updated"], _seconds(latest))
    for key, place in found.items():
        if place["workspace_id"] is None:
            bound = registry.db.execute("SELECT workspace_id FROM bindings WHERE runner_id=? AND canonical_root=?",
                                        (registry.runner_id, key)).fetchone()
            place["workspace_id"] = bound[0] if bound else None
    rows = [{"folder": key, "name": Path(key).name or key, "here": Path(key) == here, "exists": Path(key).is_dir(),
             "sessions": place["sessions"], "pips": place["pips"], "workspace_id": place["workspace_id"],
             "updated_at": _iso(place["updated"]) if place["updated"] else None}
            for key, place in found.items()]
    rows.sort(key=lambda item: (item["updated_at"] or ""), reverse=True)
    return {"folders": rows[:MAX_FOLDERS]}


def pips_everywhere(store, *, limit=100, offset=0, query="", order="created") -> dict:
    """list_pips {scope: "projects"}: every project's Pips (each carries its workspace_id), paged across them."""
    registry = store.registry
    from .sessions import not_a_project
    # (A temporary or DGC-home folder's Pips are left out too, as list_project_folders leaves out the folder.)
    spaces = [r[0] for r in registry.db.execute(
        "SELECT w.id,b.canonical_root FROM workspaces w JOIN bindings b ON b.workspace_id=w.id AND b.runner_id=? "
        "WHERE w.kind<>'personal'", (registry.runner_id,)) if not not_a_project(r[1])]
    found = []
    for workspace_id in spaces:
        found += store.list(workspace_id, limit=100, query=query, order=order)
    if order == "recent":
        found.sort(key=lambda p: str(p.get("updated_at") or ""), reverse=True)
    else:
        found.sort(key=lambda p: (str(p.get("created_at") or ""), p["id"]))
    page = found[offset:offset + limit]
    return {"pips": page, "total": len(found), "next_offset": offset + limit if offset + limit < len(found) else None}


def add(registry, folder) -> dict:
    """add_project_folder: the folder the user picked, as a project of DGC's (its workspace)."""
    if not isinstance(folder, str) or not folder.strip() or not Path(folder).is_absolute():
        raise RegistryError("invalid_request", "Choose a folder on this computer by its full path.")
    path = Path(folder).expanduser()
    if not path.exists():
        raise RegistryError("not_found", "That folder doesn't exist on this computer.")
    if not path.is_dir():
        raise RegistryError("invalid_request", "That is a file, not a folder.")
    resolved = path.resolve(strict=True)
    if resolved == Path(resolved.anchor) or resolved == _home().expanduser().resolve(strict=False):
        raise RegistryError("invalid_request", "Choose a project's own folder, not the whole computer or your home folder.")
    if _own(resolved):
        raise RegistryError("invalid_request", "That folder is DGC's own. Choose one of your projects.")
    return {"workspace": registry.resolve(resolved)}
