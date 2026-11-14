"""A Pip makes pages, sheets, documents, decks and dashboards (0.52; his call 15 Nov: "pips should have these all tools",
with no cap: better instructions instead).

The worker never writes DGC's artifact store (it runs in its own home): its ``make_artifact`` and ``edit_artifact`` go
through the run's socket (pip_app_links.RunSocket) to the controller, which writes the user's Library exactly as Work
does (artifact_tools), with the Pip as its maker: origin ``{"surface": "pip", "pip": <id>}`` and the Pip's name as
author. A Pip edits what it made and the dashboards the user gave it to keep current (artifact_pips settings), nothing
else: someone else's document is never changed by a Pip.
"""
from __future__ import annotations

import copy

TOOLS = ("make_artifact", "edit_artifact")

# What the Pip is told, on each tool: one item per purpose, kept current, never a flood (his call: instructions, no cap).
KEEP_ONE = (" As a Pip: keep ONE page, sheet, document or dashboard per purpose. When one you made already covers it, "
            "update that one with edit_artifact (each update is a new version the user can go back to) instead of "
            "making another. Make one only when the user asked for it or your job needs it to be kept; never several "
            "at once, and never one just to show a short answer (say that in your reply).")


def schemas() -> list:
    """Work's own make_artifact / edit_artifact, with what a Pip is told about keeping one per purpose."""
    from .artifact_tools import TOOLS as WORK_SCHEMAS
    out = []
    for schema in WORK_SCHEMAS:
        name = schema.get("function", {}).get("name")
        if name in TOOLS:
            item = copy.deepcopy(schema)
            item["function"]["description"] = str(item["function"].get("description") or "") + KEEP_ONE
            out.append(item)
    return out


class Session:
    """The controller's side: one per run, writing the user's artifact store with the Pip as maker."""

    def __init__(self, directory, config, pip_id, workspace_id=None, run_id=None):
        self.directory, self.config, self.pip_id, self.run_id = directory, config, pip_id, run_id
        self.name = self._name() or "A Pip"

    def _name(self) -> str:
        try:
            from .workspace_registry import WorkspaceRegistry
            from .pips import PipStore
            with WorkspaceRegistry(self.directory) as registry:
                return str(PipStore(registry).get(self.pip_id).get("name") or "")[:80]
        except Exception:                                  # noqa: BLE001 -- the name is only its byline
            return ""

    def _may_edit(self, aid: str) -> bool:
        """Its own (it made it), or a dashboard the user gave it to keep current."""
        from .artifact_store import store
        try:
            art = store().get(aid)
        except Exception:                                  # noqa: BLE001 -- not there: the store says so on the call
            return True
        if art.origin.get("surface") == "pip" and art.origin.get("pip") == self.pip_id:
            return True
        try:
            from . import artifact_pips
            from .workspace_registry import WorkspaceRegistry
            with WorkspaceRegistry(self.directory) as registry:
                return aid in artifact_pips.settings(registry.db, self.pip_id).get("dashboards", [])
        except Exception:                                  # noqa: BLE001 -- unknown: not its to change
            return False

    def call(self, op: str, args) -> str:
        from . import artifact_tools
        if op not in TOOLS:
            return f"error: {op} isn't one of a Pip's artifact tools."
        if not isinstance(args, dict):
            return "error: give the tool's arguments as an object."
        if op == "edit_artifact" and not self._may_edit(str(args.get("id") or "")):
            return ("error: that one isn't yours to change. A Pip edits what it made and the dashboards the user gave it "
                    "to keep current; make your own instead, or tell the user what you'd change.")
        return artifact_tools.run(op, args, origin={"surface": "pip", "pip": self.pip_id}, author=self.name)


# ---- DGC's own docs, read-only (0.52): read in the worker itself, from the package ------------------------------------
DOCS_TOOL = "dgc_docs"


def doc_schemas() -> list:
    from .settings_tool import SCHEMAS
    return [copy.deepcopy(s) for s in SCHEMAS if s.get("function", {}).get("name") == DOCS_TOOL]


def docs(args) -> str:
    from .settings_tool import docs as read_docs
    return read_docs(str((args or {}).get("query") or "") if isinstance(args, dict) else "")

