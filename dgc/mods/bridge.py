"""A session's mods inside the agent (dgc/agent.py): the few places the agent calls them, and what DGC gives them.

The agent has ``mods`` (a ModHost, or None until a screen starts them: the terminal, the editor's backend, an SDK
session that names mods). Every call here is a no-op without one, and none can fail a turn.
"""
from __future__ import annotations

from pathlib import Path

from .host import ModHost


def start(agent, on_ui=None, *, extra=(), surface: str = "work") -> ModHost | None:
    """Start the mods this session may run (built-in, installed, allowed; plus ``extra`` dev folders). A folder named
    by ``dgc mods dev`` (DGC_MODS_DEV) is the user's own, run for this session and reloaded when it changes."""
    import os
    if getattr(agent, "mods", None) is not None:
        return agent.mods
    dev = os.environ.get("DGC_MODS_DEV", "").strip()
    # An SDK session's mods (session(mods=[...])): named in the developer's code, their Allow, for this session.
    named = tuple(p for p in os.environ.get("DGC_MODS_EXTRA", "").split(os.pathsep) if p.strip())
    folders = tuple(extra) + named + ((dev,) if dev else ())
    host = ModHost(project_root=agent.config.project_root, session_id=str(getattr(agent, "session_id", "") or ""),
                   surface=surface, on_ui=on_ui, providers=providers(agent), extra=folders, config=agent.config,
                   redact=lambda value: agent._safe_value(value))
    agent.mods = host
    for folder in named:
        try:
            from .manifest import load
            host.grant_session(load(folder))
        except Exception:                                # noqa: BLE001 -- a broken one shows in the mods list
            pass
    if dev:
        try:
            from .manifest import load
            manifest = load(dev)
            name = manifest.name
            host.grant_session(manifest)               # `dgc mods dev` is the user's own Allow, for this session
            _watch(host, dev, name)
        except Exception:                                # noqa: BLE001 -- a broken manifest shows in /mods
            pass
    try:
        host.start()
    except Exception:                                    # noqa: BLE001 -- a mod's trouble never stops the session
        pass
    return host


def _watch(host: ModHost, folder: str, name: str) -> None:
    """Reload a dev mod when a file in its folder changes (ModHost.watch: one watcher a folder)."""
    host.watch(folder, name)


def stop(agent) -> None:
    host = getattr(agent, "mods", None)
    if host is not None:
        host.stop()


def providers(agent) -> dict:
    """What a mod may read, through DGC, when it declared it."""
    def usage():
        size = int(agent.context_size()) if callable(getattr(agent, "context_size", None)) else 0
        try:
            threshold = float(agent.config.get("compact_threshold", 0.85) or 0.85)
        except (TypeError, ValueError, AttributeError):
            threshold = 0.85
        try:
            breakdown = agent.context_breakdown(size, threshold) if size else {}
        except Exception:                                # noqa: BLE001
            breakdown = {}
        return {"window": size, "used": int(agent.estimate_tokens()), "breakdown": breakdown}

    def transcript(limit):
        out = []
        for m in [m for m in agent.messages if m.get("role") in ("user", "assistant")][-limit:]:
            content = m.get("content")
            text = content if isinstance(content, str) else " ".join(
                str(p.get("text") or "") for p in content or [] if isinstance(p, dict))
            out.append({"role": m["role"], "text": agent._safe_text(text)[:4000]})
        return out

    def complete(prompt, max_tokens):
        client = agent._aux_client(max_tokens=max_tokens, read_timeout=120)
        result = client.chat([{"role": "user", "content": prompt}], tools=None, reasoning_effort="off",
                             on_text=None, on_thinking=None, cancel=agent.cancelled)
        agent._record_usage(getattr(result, "usage", {}), "other")
        return agent._safe_text(str(getattr(result, "content", "") or ""))[:20_000]

    return {"usage": usage, "transcript": transcript, "complete": complete}


def prompt(agent, text: str) -> str:
    """What the user sent, as the mods leave it; a rewrite is said and kept beside the original."""
    host = getattr(agent, "mods", None)
    if host is None or not text:
        return text
    host.fire("turn.start", {"source": "prompt"})
    try:
        new, edit = host.prompt(text)
    except Exception:                                    # noqa: BLE001
        return text
    if edit is None:
        return text
    agent._mod_prompt_edit = edit
    note = f" ({edit['note']})" if edit.get("note") else ""
    agent.ui.info(f"Edited by {edit['mod']}{note}. What you typed: {agent._safe_text(edit['original'])[:300]}")
    return new


def tool_call(agent, name: str, args) -> dict:
    host = getattr(agent, "mods", None)
    if host is None:
        return {"decision": "observe", "mod": "", "reason": ""}
    try:
        return host.tool_call(name, args)
    except Exception:                                    # noqa: BLE001
        return {"decision": "observe", "mod": "", "reason": ""}


def fire(agent, event: str, data: dict) -> None:
    host = getattr(agent, "mods", None)
    if host is not None:
        try:
            host.fire(event, data)
        except Exception:                                # noqa: BLE001
            pass


# How far up from a written file DGC looks for the dgc-mod.json it belongs to (mods/NAME/src/main.ts is three).
_MOD_DEPTH = 4
_NOT_MODS = {".git", "node_modules", "__pycache__", ".dgc"}


def mod_folder(project_root, path) -> str | None:
    """The mod folder (holding dgc-mod.json) a file the model wrote belongs to, inside the project; None if none."""
    from .manifest import MANIFEST
    if not project_root or not path:
        return None
    try:
        root = Path(project_root).resolve()
        target = Path(path) if Path(path).is_absolute() else root / path
        target = target.resolve()
        rel = target.relative_to(root)
    except (OSError, ValueError):
        return None
    if _NOT_MODS & set(rel.parts):
        return None
    folder = target if target.is_dir() else target.parent
    for _ in range(_MOD_DEPTH):
        if (folder / MANIFEST).is_file():
            return str(folder)
        if folder == root:
            break
        folder = folder.parent
    return None


def wrote(agent, path) -> None:
    """The model wrote a file: when it is part of a mod's folder in the project, the session's mods hear of it (the
    first time, the user is asked whether to turn on the mods DGC writes). Never fails a step."""
    host = getattr(agent, "mods", None)
    if host is None or getattr(agent, "depth", 0):
        return
    try:
        folder = mod_folder(getattr(agent.config, "project_root", None), path)
        if folder:
            host.wrote(folder)
    except Exception:                                    # noqa: BLE001 -- a mod's trouble never stops a step
        pass


def turn_complete(agent) -> None:
    host = getattr(agent, "mods", None)
    if host is None:
        return
    # A mod written some other way this turn (a shell command, a helper's work brought in): its files are on the
    # turn's Edited card.
    for row in (getattr(agent, "last_turn_files", None) or {}).get("files") or []:
        if isinstance(row, dict) and str(row.get("path") or "").strip():
            wrote(agent, str(row["path"]))
    usage = getattr(agent, "usage_totals", None) or {}
    fire(agent, "turn.complete", {"usage": {k: v for k, v in dict(usage).items() if isinstance(v, (int, float))},
                                  "used": int(agent.estimate_tokens())})
