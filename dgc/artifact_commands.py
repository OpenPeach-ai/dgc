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
# comments: artifact_comment_* and artifact_suggestion_* are understood, answered by artifact_comments
# (dgc/artifact_comments; Ask DGC runs dgc/artifact_comment_turn).
# designs: the "design" type (a canvas of artboards, dgc/artifact_design): artifact_design_edit is understood,
# artifact_export takes `board`, and artifact_detail's `state` carries a design's drawn artboards.
CAPABILITY = {"artifacts": {"version": 1, "types": list(TYPES), "outputs": list(service.OUTPUTS),
                            "exports": {t: list(f) for t, f in service.EXPORTS.items()}, "present": 1, "compare": 1,
                            "source_consent_version": 1, "comments": 1, "designs": 1}}


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
        # Ask DGC's model (a test hands one in): None is the user's own, from config (artifact_comment_turn).
        self.comment_client = None
        self._asking: set[tuple[str, str]] = set()
        self._asking_lock = threading.Lock()

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
        if view["type"] == "checklist":
            # Its proof pictures, for the panel that draws it (the data names each by its file in the version).
            fields["state"] = {"pictures": service.checklist_pictures(aid, cmd.get("version", view["version"]))}
        if view["type"] == "design" and cmd.get("content"):
            # Its drawn artboards' pages, for the canvas that shows them (the index names each by its id).
            fields["state"] = {"boards": service.design_boards(aid, cmd.get("version", view["version"]))}
        self._reply(cmd, "artifact_detail", **fields)

    def _artifact_update(self, cmd):
        view = service.edit(cmd["id"], content=cmd["content"], author="you", note=cmd.get("note") or "Your edits",
                            base_version=cmd["base_version"], title=cmd.get("title"))
        self.changed(view, "changed", surface="editor", request_id=cmd["request_id"])

    def _artifact_design_edit(self, cmd):
        """The person's own change to a design in its canvas: ops, as the model's edits are, a version by "you". A
        whole-page artboard's measured height is remembered beside the versions and is no version."""
        edits = [e for e in cmd["edits"] if isinstance(e, dict)]
        measured = [e for e in edits if e.get("op") == "measured"]
        for e in measured:
            service.design_measured(cmd["id"], str(e.get("board") or ""), e.get("h"))
        edits = [e for e in edits if e.get("op") != "measured"]
        if not edits:
            return self._reply(cmd, "artifact_detail", artifact=service.view(cmd["id"]))
        if len(edits) == 1 and edits[0].get("op") == "title":
            # (Its name alone, from the Library: a version that differs only in its title.)
            view = service.edit(cmd["id"], title=str(edits[0].get("title") or ""), author="you")
        else:
            view = service.edit(cmd["id"], edits=edits, author="you", note=cmd.get("note") or "")
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
            path = service.export(cmd["id"], cmd["format"], n=cmd.get("version"), config=self.config,
                                  board=cmd.get("board"))
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

    # comments (dgc/artifact_comments): each answer is the artifact's threads, as every screen draws them -----------
    def comments(self, aid: str, request_id: str = "") -> None:
        """The threads of one artifact, to the screen that asked (request_id) or to every screen (none)."""
        from . import artifact_comments as comments
        from .artifact_store import store
        threads = comments.wire(comments.threads(aid))
        self.emit("artifact_comments", id=aid, version=store().get(aid).version, threads=threads,
                  **({"request_id": request_id} if request_id else {}))

    def _ask(self, aid: str, tid: str) -> None:
        """Ask DGC on a thread: answered on a thread of its own (one answer per thread at a time)."""
        from . import artifact_comment_turn as turn
        key = (aid, tid)
        with self._asking_lock:
            if key in self._asking:
                return
            self._asking.add(key)
        from . import artifact_comments as comments
        comments.answering(aid, tid, True)                  # said at once, in the answer to this command

        def run():
            try:
                client = self.comment_client() if callable(self.comment_client) else None
                turn.answer(aid, tid, config=self.config, client=client,
                            on_change=lambda view, op: self.changed(view, op, surface="comment"),
                            on_threads=lambda: self.comments(aid))
            except Exception:                              # noqa: BLE001 -- the thread says it (or was deleted)
                try:
                    self.comments(aid)
                except Exception:                          # noqa: BLE001
                    pass
            finally:
                with self._asking_lock:
                    self._asking.discard(key)
        threading.Thread(target=run, name="dgc-comment-answer", daemon=True).start()

    def _artifact_comment_list(self, cmd):
        self.comments(cmd["id"], cmd["request_id"])

    def _artifact_comment_add(self, cmd):
        from . import artifact_comments as comments
        thread = comments.add(cmd["id"], cmd["anchor"], cmd["text"])
        if cmd.get("ask"):
            self._ask(cmd["id"], thread["id"])
        self.comments(cmd["id"], cmd["request_id"])

    def _artifact_comment_reply(self, cmd):
        from . import artifact_comments as comments
        comments.reply(cmd["id"], cmd["thread"], cmd["text"])
        if cmd.get("ask"):
            self._ask(cmd["id"], cmd["thread"])
        self.comments(cmd["id"], cmd["request_id"])

    def _artifact_comment_resolve(self, cmd):
        from . import artifact_comments as comments
        comments.resolve(cmd["id"], cmd["thread"], cmd["resolved"])
        self.comments(cmd["id"], cmd["request_id"])

    def _artifact_comment_delete(self, cmd):
        from . import artifact_comments as comments
        comments.delete(cmd["id"], cmd["thread"])
        self.comments(cmd["id"], cmd["request_id"])

    def _artifact_comment_ask(self, cmd):
        from . import artifact_comments as comments
        comments.get(cmd["id"], cmd["thread"])              # (there, or said why not)
        self._ask(cmd["id"], cmd["thread"])
        self.comments(cmd["id"], cmd["request_id"])

    def _artifact_suggestion_accept(self, cmd):
        from . import artifact_comments as comments
        view = comments.accept(cmd["id"], cmd["thread"], cmd["suggestion"])
        self.comments(cmd["id"], cmd["request_id"])
        self.changed(view, "changed", surface="comment")

    def _artifact_suggestion_reject(self, cmd):
        from . import artifact_comments as comments
        comments.reject(cmd["id"], cmd["thread"], cmd["suggestion"])
        self.comments(cmd["id"], cmd["request_id"])
