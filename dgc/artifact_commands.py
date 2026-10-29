"""The editor's artifact_* commands, answered by the process (dgc serve's Host) for every window and chat.

An artifact belongs to the account, not to a folder, so whichever chat a command comes from, the same store answers
it (dgc/artifact_service). Reads are answered at once; anything that may take a while (an export a browser prints, a
dashboard's queries, starting an artifact's own listener) runs on a thread of its own, so the wire never waits on it.
"""
from __future__ import annotations

import threading

from . import artifact_service as service
from .artifact_store import TYPES
from .editor_protocol import command_error

# present: artifact_open takes mode "present" (a deck's present mode at its own address).
CAPABILITY = {"artifacts": {"version": 1, "types": list(TYPES), "outputs": list(service.OUTPUTS),
                            "exports": {t: list(f) for t, f in service.EXPORTS.items()}, "present": 1, "compare": 1,
                            "source_consent_version": 1}}


def _reads_a_plugin(aid: str) -> bool:
    from .artifact_store import store
    try:
        return any(isinstance(s, dict) and s.get("kind") == "plugin" for s in store().source(aid).get("sources") or [])
    except Exception:                                    # noqa: BLE001 -- not a dashboard, or unreadable: no plugins
        return False


class ArtifactCommands:
    def __init__(self, emit, config=None):
        self.emit = emit                  # Emitter.emit(type, **fields)
        self.config = config

    def _reply(self, cmd: dict, kind: str, **fields) -> None:
        self.emit(kind, **fields, **({"request_id": cmd["request_id"]} if cmd.get("request_id") else {}))

    def _reject(self, cmd: dict, reason: str, message: str) -> None:
        self._reply(cmd, "command_rejected", command=str(cmd.get("type") or "")[:128], reason=reason,
                    message=message[:2000])

    def _later(self, cmd: dict, work) -> None:
        def run():
            try:
                work()
            except service.ArtifactUseError as exc:
                self._reject(cmd, "invalid", str(exc))
            except Exception as exc:                      # noqa: BLE001 -- said, never left unanswered
                self._reject(cmd, "failed", f"{type(exc).__name__}: {exc}")
        threading.Thread(target=run, name=f"dgc-{cmd.get('type')}", daemon=True).start()

    def dispatch(self, cmd: dict) -> None:
        problem = command_error(cmd)
        if problem:
            return self._reject(cmd, "invalid_command", f"invalid command: {problem}")
        kind = cmd["type"]
        try:
            handler = getattr(self, "_" + kind)
        except AttributeError:
            return self._reject(cmd, "unknown_command", f"{kind} isn't an artifact command")
        try:
            handler(cmd)
        except service.ArtifactUseError as exc:
            message = str(exc)
            self._reject(cmd, "conflict" if "changed since version" in message else "invalid", message)
        except Exception as exc:                          # noqa: BLE001
            self._reject(cmd, "failed", f"{type(exc).__name__}: {exc}")

    def changed(self, view: dict, op: str, *, surface: str = "", conversation_id: str = "",
                request_id: str = "") -> None:
        """Tell every screen an artifact was made or changed (the model's tools call this too)."""
        fields = {"artifact": view, "op": op}
        if surface:
            fields["surface"] = surface
        if conversation_id:
            fields["conversation_id"] = conversation_id
        if request_id:
            fields["request_id"] = request_id
        self.emit("artifact_changed", **fields)

    def user_saved(self, paths) -> None:
        """The editor saved these files (the process's user_saved): a document's working file among them is the
        user's version now, not only at the model's next change."""
        for path in paths or []:
            try:
                aid = service.doc_for_file(path)
                if aid and service.keep_users_edits(aid):
                    self.changed(service.view(aid), "changed", surface="editor")
            except Exception:                              # noqa: BLE001 -- a save is never refused for this
                continue

    # the commands ------------------------------------------------------------------------------------------
    def _artifact_list(self, cmd):
        self._reply(cmd, "artifact_items", items=service.listing(type=cmd.get("artifact_type"),
                                                                 surface=cmd.get("surface")))

    def _artifact_get(self, cmd):
        aid = cmd["id"]
        view = service.view(aid)
        fields = {"artifact": view}
        if cmd.get("content") and view["type"] != "page":
            from .artifact_store import store
            fields["content"] = store().source(aid, cmd.get("version", view["version"]))
        if view["type"] == "dashboard":
            fields["state"] = service.state(aid, version=cmd.get("version", view["version"]))
        self._reply(cmd, "artifact_detail", **fields)

    def _artifact_update(self, cmd):
        view = service.edit(cmd["id"], content=cmd["content"], author="you", note=cmd.get("note") or "Your edits",
                            base_version=cmd["base_version"], title=cmd.get("title"))
        self.changed(view, "changed", surface="editor", request_id=cmd["request_id"])

    def _artifact_restore(self, cmd):
        view = service.restore(cmd["id"], cmd["version"])
        self.changed(view, "restored", surface="editor", request_id=cmd["request_id"])

    def _artifact_compare(self, cmd):
        self._later(cmd, lambda: self._reply(cmd, "artifact_comparison", comparison=service.compare(
            cmd["id"], cmd["before"], cmd.get("after"))))

    def _artifact_remove(self, cmd):
        view = service.view(cmd["id"], versions=False)
        service.remove(cmd["id"])
        self.changed(view, "removed", surface="editor", request_id=cmd["request_id"])

    def _artifact_export(self, cmd):
        def work():
            path = service.export(cmd["id"], cmd["format"], n=cmd.get("version"), config=self.config)
            self._reply(cmd, "artifact_exported", id=cmd["id"], format=path.suffix.lstrip("."), path=str(path))
        self._later(cmd, work)

    def _artifact_open(self, cmd):
        def work():
            self._reply(cmd, "artifact_served", id=cmd["id"], url=service.serve(cmd["id"], mode=cmd.get("mode") or "view"))
        self._later(cmd, work)

    def _artifact_refresh(self, cmd):
        def work():
            view = service.view(cmd["id"])
            project = (view.get("origin") or {}).get("project")
            call = is_read_only = None
            close = None
            if self.config is not None and _reads_a_plugin(cmd["id"]):
                from .artifact_plugins import hooks
                call, is_read_only, close = hooks(self.config)
            try:
                service.refresh(cmd["id"], project_root=project, call=call, is_read_only=is_read_only)
            finally:
                if close is not None:
                    close()
            self._reply(cmd, "artifact_detail", artifact=service.view(cmd["id"]), state=service.state(cmd["id"]))
        self._later(cmd, work)

    def _artifact_allow_source(self, cmd):
        view = service.allow_source(cmd["id"], cmd["source"], cmd["allowed"], base_version=cmd.get("base_version"))
        self.changed(view, "changed", surface="editor", request_id=cmd["request_id"])
