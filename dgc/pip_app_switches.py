"""A Pip's apps, each with a switch (pips-09, decision D5: every app on, a switch to turn one off; Pips API 88).

An app is a plugin turned on in Settings → Plugins (Airtable, Composio...) or an app a Pip reaches through Composio
(Gmail, Google Calendar...). Switched off on one Pip's page, it is gone for that Pip alone: the plugin isn't listed or
callable, the app's reads, Composio calls and sends are refused in plain words, and the Pip can't ask for it. Its link
stays, so switching it back on needs no new sign-in. Only the user, on this computer, changes a switch.
"""
from __future__ import annotations

import json
import re

from .workspace_registry import RegistryError

KEY = "pip_apps_off:"                    # metadata: a Pip's apps switched off, a JSON list of app ids
NAME = re.compile(r"[a-z0-9][a-z0-9_-]{1,39}\Z")
LOCAL = ("editor-user", "local-console")
MOST = 200


def off(registry, pip_id) -> set:
    """The apps switched off for this Pip (every other app is on)."""
    row = registry.db.execute("SELECT value FROM metadata WHERE key=?", (KEY + pip_id,)).fetchone()
    try:
        value = json.loads(row[0]) if row is not None else []
    except ValueError:
        value = []
    return {v for v in value if isinstance(v, str) and NAME.fullmatch(v)} if isinstance(value, list) else set()


def name(app) -> str:
    from .pip_app_links import app_name
    return app_name(app)


def require_on(registry, pip_id, app, shown=None) -> None:
    """Refused in words when this app is switched off for this Pip."""
    if str(app or "").lower() in off(registry, pip_id):
        raise RegistryError("app_off", f"{shown or name(app)} is switched off for this Pip on its page, so nothing ran. "
                                       "The user can switch it back on there.")


def set_app(registry, pip_id, app, on, actor) -> dict:
    if actor not in LOCAL:
        raise RegistryError("local_only", "Only you can choose a Pip's apps, on this computer.")
    if not isinstance(app, str) or not NAME.fullmatch(app):
        raise RegistryError("invalid_request", "Choose one of the apps on this Pip's page.")
    if type(on) is not bool:
        raise RegistryError("invalid_request", "Switch an app on or off: on is true or false.")
    from .pips import PipStore
    PipStore(registry)._job(pip_id)                 # a Pip that exists
    now = off(registry, pip_id)
    if on:
        now.discard(app)
    else:
        now.add(app)
    if len(now) > MOST:
        raise RegistryError("limit", "Too many apps are switched off on this Pip.")
    workspace = registry.db.execute("SELECT workspace_id FROM pips WHERE id=?", (pip_id,)).fetchone()
    with registry.transaction():
        if now:
            registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (KEY + pip_id, json.dumps(sorted(now))))
        else:
            registry.db.execute("DELETE FROM metadata WHERE key=?", (KEY + pip_id,))
        if workspace is not None:
            registry.event(workspace[0], "pip_app_switched", pip_id=pip_id, payload={"app": app, "on": on, "actor": actor})
    return {"app": app, "on": on}


def listing(registry, pip_id, config) -> dict:
    """This Pip's apps for its page: every plugin turned on in Settings, every app it is linked to (with its accounts),
    and any app switched off, each with its switch."""
    from .pip_app_links import app_name, connected
    from .pip_plugins import installed
    gone = off(registry, pip_id)
    apps = [{"id": plugin, "name": str(info.get("display_name") or plugin)[:80], "kind": "plugin", "on": plugin not in gone}
            for plugin, info in sorted(installed(config).items())]
    seen = {a["id"] for a in apps}
    accounts = {}
    for link in connected(registry, pip_id):
        accounts.setdefault(link["toolkit"], []).append(str(link.get("label") or link["account"])[:160])
    for toolkit, labels in accounts.items():
        if toolkit not in seen:
            seen.add(toolkit)
            apps.append({"id": toolkit, "name": app_name(toolkit), "kind": "app", "on": toolkit not in gone, "accounts": labels})
    for app in sorted(gone - seen):
        apps.append({"id": app, "name": app_name(app), "kind": "app", "on": False})
    return {"pip_id": pip_id, "apps": apps[:MOST]}
