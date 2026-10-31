"""Pips write into artifacts: a Quill draft is the newest version of that Pip's own document, by the Pip.

Quill's private draft stays exactly as it is (dgc/pip_drafts: its immutable, checked file and receipt). Once a draft
run has finished, the same Markdown also becomes the newest version of the Pip's document in the artifact store, so
it is in the Library beside everything else with every earlier draft as a version, and the user edits it like any
document. Nothing here can fail the run: a store that can't be written leaves the draft where Quill saved it.
"""
from __future__ import annotations

from . import artifact_service as service
from .artifact_store import store


def pip_doc(pip_id: str) -> str:
    """The id of the Pip's document ("" when it has none yet)."""
    for art in store().list(type="doc", surface="pip"):
        if art.legacy.get("pip") == pip_id:
            return art.id
    return ""


def keep_draft(pip_id: str, pip_name: str, title: str, markdown: str, *, workspace: str = "") -> str:
    """Put a finished Quill draft in the Pip's document (a new version, by the Pip); returns its id, or "" if the store
    couldn't take it."""
    if not isinstance(markdown, str) or not markdown.strip():
        return ""
    author = (pip_name or "Quill").strip()[:60]
    try:
        aid = pip_doc(pip_id)
        if aid:
            service.edit(aid, content=markdown, author=author, note=(title or "New draft")[:200])
            return aid
        view = service.make("doc", title or f"{author}'s draft", {"content": markdown},
                            origin={"surface": "pip", "pip": pip_id, **({"workspace": workspace} if workspace else {})},
                            author=author, summary=(title or "First draft")[:200])
        # Keep the working file make() recorded: a document is edited in its file (artifact_service._doc_file).
        made_file = store().get(view["id"]).legacy.get("file", "")
        store().set_meta(view["id"], legacy={"pip": pip_id, "kind": "quill", **({"file": made_file} if made_file else {})})
        return view["id"]
    except Exception:                                    # noqa: BLE001 -- the run's own draft stands either way
        return ""


# ---- A Pip's report as a Document or a Spreadsheet, and the dashboards a Pip refreshes ---------------------------
# Each Pip's own settings (get_pip_artifacts / set_pip_artifacts in the Pips control API): `report_as` "chat" (the
# report card in its chat, as always), "doc" or "sheet" (the card still comes; each finished review's findings are
# also the newest version of that Pip's own document or sheet, so every run is a version beside the others), and
# `dashboards`, the dashboards it refreshes after every run it finishes (a Pulse keeps one current on its schedule).
REPORT_AS = ("chat", "doc", "sheet")
MAX_DASHBOARDS = 8
SCHEMA = ("CREATE TABLE IF NOT EXISTS pip_artifact_settings(pip_id TEXT PRIMARY KEY, report_as TEXT NOT NULL DEFAULT "
          "'chat', dashboards TEXT NOT NULL DEFAULT '[]')")
SEVERITY_ORDER = ("critical", "high", "medium", "low")


def settings(db, pip_id: str) -> dict:
    """A Pip's artifact settings, and the document or sheet its reports are kept in: its id, title and version ("",
    "" and 0 when none yet), so the Pip's page can say which one and how many reviews it holds, not only "Open"."""
    import json
    db.execute(SCHEMA)
    row = db.execute("SELECT report_as, dashboards FROM pip_artifact_settings WHERE pip_id=?", (pip_id,)).fetchone()
    report_as, dashboards = (row[0], []) if row else ("chat", [])
    if row:
        try:
            decoded = json.loads(row[1] or "[]")
            dashboards = decoded if isinstance(decoded, list) else []
        except (TypeError, ValueError):
            dashboards = []
    out = {"report_as": report_as if report_as in REPORT_AS else "chat",
           "dashboards": [d for d in dashboards if isinstance(d, str)][:MAX_DASHBOARDS]}
    for kind in ("doc", "sheet"):
        art = _report(pip_id, kind)
        out.update({f"report_{kind}": art.id if art else "", f"report_{kind}_title": art.title if art else "",
                    f"report_{kind}_version": art.version if art else 0})
    return out


def set_settings(db, pip_id: str, *, report_as=None, dashboards=None) -> dict:
    """Change them: ``report_as`` one of REPORT_AS; ``dashboards`` ids of dashboards in the artifact store."""
    import json
    from .workspace_registry import RegistryError
    current = settings(db, pip_id)
    if report_as is not None:
        if report_as not in REPORT_AS:
            raise RegistryError("invalid_request", "report_as is chat, doc or sheet.")
        current["report_as"] = report_as
    if dashboards is not None:
        if not isinstance(dashboards, list) or len(dashboards) > MAX_DASHBOARDS or not all(isinstance(d, str) for d in dashboards):
            raise RegistryError("invalid_request", f"dashboards is a list of at most {MAX_DASHBOARDS} dashboard ids.")
        # One the Pip already had and that has since been deleted is dropped, not refused: refusing it made every
        # later change to the list fail (Add and Remove alike) until the page left it out itself.
        had, kept = set(current["dashboards"]), []
        for aid in dashboards:
            try:
                kind = store().get(aid).type
            except Exception:                        # noqa: BLE001 -- an id that isn't in the store
                kind = None
            if kind == "dashboard":
                kept.append(aid)
            elif aid not in had:
                raise RegistryError("invalid_request", f"{aid} isn't a dashboard in your artifacts.")
        current["dashboards"] = list(dict.fromkeys(kept))
    db.execute("INSERT INTO pip_artifact_settings(pip_id, report_as, dashboards) VALUES(?,?,?) ON CONFLICT(pip_id) "
               "DO UPDATE SET report_as=excluded.report_as, dashboards=excluded.dashboards",
               (pip_id, current["report_as"], json.dumps(current["dashboards"])))
    return settings(db, pip_id)


def _report(pip_id: str, kind: str):
    """The document ("doc") or sheet ("sheet") a Pip's reports are kept in, None when none yet."""
    for art in store().list(type=kind, surface="pip"):
        if art.legacy.get("pip") == pip_id and art.legacy.get("kind") == "report":
            return art
    return None


def _ranked(findings) -> list[dict]:
    kept = [f for f in findings or [] if isinstance(f, dict) and str(f.get("title") or "").strip()]
    return sorted(kept, key=lambda f: SEVERITY_ORDER.index(f["severity"]) if f.get("severity") in SEVERITY_ORDER else 9)


def report_markdown(name: str, when: str, findings) -> str:
    """One review's findings as a document: the most serious first, each with where it is and what was seen."""
    ranked = _ranked(findings)
    counts = [f"{sum(1 for f in ranked if f.get('severity') == s)} {s}" for s in SEVERITY_ORDER
              if any(f.get("severity") == s for f in ranked)]
    lines = [f"# {name}: what it found", "",
             f"Review of {when}. " + (f"{len(ranked)} finding{'s' if len(ranked) != 1 else ''} ({', '.join(counts)})."
                                     if ranked else "Nothing found."), ""]
    for n, f in enumerate(ranked, 1):
        where = str(f.get("path") or "")
        if where and type(f.get("line")) is int and f["line"] > 0:
            where += f":{f['line']}"
        lines += [f"## {n}. {str(f['title']).strip()[:200]}", "",
                  f"**{str(f.get('severity') or 'low').title()}**" + (f" · `{where}`" if where else ""), ""]
        evidence = str(f.get("evidence") or "").strip()
        if evidence:
            fence = "````" if "```" in evidence else "```"
            lines += [fence, evidence[:1000], fence, ""]
    return "\n".join(lines).rstrip() + "\n"


def report_sheet(when: str, findings) -> dict:
    """One review's findings as a sheet: a row a finding, the most serious first."""
    rows = []
    for f in _ranked(findings):
        line = f["line"] if type(f.get("line")) is int and f["line"] > 0 else ""
        rows.append([str(f.get("severity") or "low"), str(f["title"]).strip()[:200], str(f.get("path") or ""), line,
                     " ".join(str(f.get("evidence") or "").split())[:500]])
    # Each review's date is its version's note (keep_report), so the sheet holds only the findings.
    return {"sheets": [{"name": "Findings", "columns": [
        {"name": "Severity", "type": "text"}, {"name": "Finding", "type": "text"}, {"name": "File", "type": "text"},
        {"name": "Line", "type": "number"}, {"name": "What it saw", "type": "text"}], "rows": rows}]}


def keep_report(pip_id: str, pip_name: str, kind: str, when: str, findings, *, workspace: str = "") -> str:
    """A finished review's findings as the newest version of the Pip's own document or sheet; its id, or ""."""
    if kind not in ("doc", "sheet"):
        return ""
    author = (pip_name or "Pip").strip()[:60]
    content = report_markdown(author, when, findings) if kind == "doc" else report_sheet(when, findings)
    spec = {"content": content} if kind == "doc" else content
    summary = f"Review of {when}"[:200]
    try:
        kept = _report(pip_id, kind)
        aid = kept.id if kept else ""
        if aid:
            service.edit(aid, content=content, author=author, note=summary)
            return aid
        view = service.make(kind, f"{author}: findings", spec,
                            origin={"surface": "pip", "pip": pip_id, **({"workspace": workspace} if workspace else {})},
                            author=author, summary=summary)
        legacy = {"pip": pip_id, "kind": "report"}
        if kind == "doc":                       # a document keeps its working file (make() recorded it)
            legacy["file"] = store().get(view["id"]).legacy.get("file", "")
        store().set_meta(view["id"], legacy={k: v for k, v in legacy.items() if v})
        return view["id"]
    except Exception:                                    # noqa: BLE001 -- the run's own result stands either way
        return ""


def after_run(db, run: dict, *, status: str, result=None, workspace_root=None, config=None) -> dict:
    """From PipStore.finish: a finished review kept as the Pip's document or sheet, and its dashboards refreshed.
    Never fails the run; says what it did ({report: id, refreshed: [ids]}) for the tests and the log."""
    done = {"report": "", "refreshed": []}
    try:
        if status != "succeeded":
            return done
        pip_id = str(run.get("pip_id") or "")
        chosen = settings(db, pip_id)
        manifest = run.get("manifest") if isinstance(run.get("manifest"), dict) else {}
        if chosen["report_as"] != "chat" and manifest.get("run_kind", "audit") == "audit" and isinstance(result, dict):
            from .pip_report_delivery import _pip
            named = _pip(db, pip_id) or {}
            from datetime import datetime
            when = datetime.now().astimezone().strftime("%d %b %Y, %H:%M")
            done["report"] = keep_report(pip_id, named.get("name", ""), chosen["report_as"], when,
                                         result.get("findings") or [], workspace=str(run.get("workspace_id") or ""))
        for aid in chosen["dashboards"]:
            try:
                origin = (service.view(aid, versions=False).get("origin") or {})
                source = store().source(aid)
                uses_plugin = any(isinstance(item, dict) and item.get("kind") == "plugin"
                                  for item in source.get("sources") or [])
                call = is_read_only = close = None
                if uses_plugin:
                    if config is None:
                        continue
                    from .artifact_plugins import hooks
                    call, is_read_only, close = hooks(config)
                try:
                    service.refresh(aid, project_root=origin.get("project") or workspace_root,
                                    call=call, is_read_only=is_read_only)
                finally:
                    if close is not None:
                        close()
                done["refreshed"].append(aid)
            except Exception:                            # noqa: BLE001 -- a dashboard that can't refresh now waits
                continue
    except Exception:                                    # noqa: BLE001 -- never the run's problem
        pass
    return done
