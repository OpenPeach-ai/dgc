"""Pip registry fixtures for the panel tests of Pip reports in the chat (pip-report-chat.test.mjs).

Run with the panel session's HOME, so it writes the registry that session's `dgc serve` reads:
    create ROOT NAME TYPE            -> prints the new Pip's id
    attach ROOT SESSION_ID PIP_ID    -> the Pip reports to that chat
    finish ROOT PIP_ID FINDINGS_JSON -> a finished audit run with those findings; prints its run id
    fail ROOT PIP_ID CODE MESSAGE    -> a failed run; prints its run id
Not a test file.
"""
import json
import sys

from dgc import pips
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import WorkspaceRegistry, identifier


def main(command, root, *rest):
    with WorkspaceRegistry() as registry:
        store = pips.PipStore(registry)
        workspace = registry.resolve(root)
        if command == "create":
            name, kind = rest
            print(store.create(workspace["id"], name, "Inspect the code for problems.", "fixture", pip_type=kind)["id"])
            return
        if command == "attach":
            session_id, pip_id = rest
            registry.associate_session(session_id, root)
            with registry.transaction():
                registry.db.execute("INSERT OR IGNORE INTO session_pip_attachments VALUES(?,?,?,?,?,?)",
                                    (session_id, pip_id, workspace["id"], 1, registry.clock(), "fixture"))
            return
        pip = store.get(rest[0])
        run_id = identifier("run")
        manifest = {"pip_id": pip["id"], "workspace_id": workspace["id"], "job_version": pip["current_version"],
                    "source_revision": "a" * 40, "model": "fixture-model", "run_kind": "audit",
                    "workspace_context": ContextStore(registry).snapshot(workspace["id"])}
        now = registry.clock()
        with registry.transaction():
            registry.db.execute("""INSERT INTO pip_runs
                (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at,started_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)""", (run_id, pip["id"], workspace["id"], registry.binding(workspace["id"])["id"],
                                                  run_id, "fixture", json.dumps(manifest), "running", now, now))
        if command == "finish":
            findings = json.loads(rest[1])
            store.finish(run_id, result={"summary": "Review", "findings": findings, "limitations": [], "tests_executed": False})
        else:
            store.finish(run_id, error={"code": rest[1], "message": rest[2]})
        print(run_id)


if __name__ == "__main__":
    main(*sys.argv[1:])
