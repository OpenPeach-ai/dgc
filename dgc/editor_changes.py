"""Bounded chat/workspace inspection workers, independent of the model/approval stdin loop."""
from __future__ import annotations

from pathlib import Path
import json
import threading
import time

from .workspace_changes import collect_changes, read_change


class EditorChanges:
    def __init__(self, root: Path, emit):
        self.roots = (root.resolve(),)
        self.emit = emit
        self.lock = threading.RLock()
        self.generation = 0
        self.workers: dict[str, dict] = {}
        self.closed = False

    def _reject(self, command: dict, reason: str, message: str):
        self.emit("command_rejected", command=command["type"], request_id=command["request_id"],
                  reason=reason, message=message)

    def _cancel(self):
        for job in self.workers.values():
            job["cancel"].set()
            if not job["replied"]:
                self._reject(job["command"], "inspection_cancelled", "Workspace inspection was cancelled.")
                job["replied"] = True

    def set_roots(self, roots: list[Path]):
        with self.lock:
            self.generation += 1
            self.roots = tuple(dict.fromkeys(root.resolve() for root in roots))[:16]
            self._cancel()

    def request(self, command: dict, *, journal=None, session_id=""):
        kind = "list" if command["type"] in ("get_workspace_changes", "get_chat_changes") else "read"
        worker_key = ("chat-" if journal is not None else "") + kind
        with self.lock:
            if self.closed:
                self._reject(command, "inspection_cancelled", "DGC is closing.")
                return
            if worker_key in self.workers:
                self._reject(command, "inspection_in_progress", "A workspace inspection is already running. Try again when it finishes.")
                return
            roots = self.roots
            root = None
            if kind == "read":
                try:
                    root = Path(command["root"]).resolve(strict=True)
                except (OSError, ValueError, RuntimeError):
                    pass
                if root not in roots or (journal is not None and (root != journal.root or command.get("session_id") != session_id)):
                    self._reject(command, "workspace_unavailable", "That change is outside the current editor workspace.")
                    return
            job = {"command": command, "cancel": threading.Event(), "generation": self.generation,
                   "replied": False}

            def work():
                value, error = None, ""
                try:
                    if journal is not None:
                        view = journal.view()
                        if kind == "read":
                            value = view.read(command["path"])
                        else:
                            value = {"roots": [view.report()] if journal.root in roots else []}
                        value["session_id"] = session_id
                    elif kind == "read":
                        value = read_change(root, command["path"], job["cancel"])
                    else:
                        deadline = time.monotonic() + 20
                        reports = []
                        retained_bytes, retained_files = 0, 0
                        scopes = [folder for folder in roots
                                  if not any(other in folder.parents for other in roots)]
                        for folder in scopes:
                            if job["cancel"].is_set():
                                raise ValueError("Workspace inspection was cancelled.")
                            if time.monotonic() >= deadline:
                                reports.append({"root": str(folder), "files": [], "total": 0, "complete": False,
                                                "notices": ["Workspace inspection reached its time limit."]})
                            else:
                                report = collect_changes(folder, job["cancel"], deadline=deadline)
                                kept = []
                                for row in report["files"]:
                                    cost = len(json.dumps(row, ensure_ascii=True))
                                    if retained_files >= 500 or retained_bytes + cost > 2 * 1024 * 1024:
                                        break
                                    kept.append(row)
                                    retained_bytes += cost
                                    retained_files += 1
                                if len(kept) < len(report["files"]):
                                    report["notices"].append("The combined workspace display limit was reached; some files are omitted.")
                                    report["complete"] = False
                                report["files"] = kept
                                reports.append(report)
                        value = {"roots": reports}
                except (OSError, ValueError) as exc:
                    error = str(exc)[:1000]
                except Exception as exc:
                    error = f"Workspace inspection failed ({type(exc).__name__})."
                with self.lock:
                    if self.workers.get(worker_key) is job:
                        del self.workers[worker_key]  # release before the acknowledgement permits a next query
                    if job["replied"]:
                        return
                    job["replied"] = True
                    if self.closed or job["cancel"].is_set() or self.generation != job["generation"]:
                        self._reject(command, "inspection_cancelled", "Workspace inspection was cancelled.")
                    elif error:
                        self._reject(command, "inspection_failed", error)
                    else:
                        self.emit(("chat_changes" if kind == "list" else "chat_change") if journal is not None
                                  else ("workspace_changes" if kind == "list" else "workspace_change"),
                                  request_id=command["request_id"], **value)

            thread = threading.Thread(target=work, name="dgc-editor-changes-" + kind, daemon=True)
            job["thread"] = thread
            self.workers[worker_key] = job
            thread.start()

    def close(self):
        with self.lock:
            self.closed = True
            self._cancel()
            workers = [job["thread"] for job in self.workers.values()]
        for worker in workers:
            if worker is not threading.current_thread():
                worker.join(timeout=2)
