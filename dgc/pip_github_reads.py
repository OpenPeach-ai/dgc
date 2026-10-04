"""Reviewed GitHub reads for project Pips: open issues, open pull requests and CI, read by DGC.

A project reviewer's reviewed job may name one GitHub repository and up to four fixed reads. The
controller performs them before the Pip's model runs, with the user's own GitHub credential, and
hands the result to the model as untrusted reference data, the way Personal web reads work.

- Reads only. Every request is a GET to api.github.com; nothing can comment, label, merge, push
  or change settings, whatever the credential allows.
- The model never chooses what to read: the repository and the reads are in the reviewed job, and
  the only run-specific input is the commit the run reviews, which DGC pinned.
- The credential (GH_TOKEN, GITHUB_TOKEN or `gh auth token`) stays in the controller. It is never
  given to the worker, and it is redacted from everything the worker sees.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time

from .workspace_registry import RegistryError

SCHEMA_VERSION = 1
MAX_READS = 4
MAX_ITEMS = {"open_issues": 20, "open_pulls": 20, "failed_runs": 10}
MAX_LABELS = 5
MAX_BODY = 500
MAX_TITLE = 300
MAX_READ_CHARS = 8000          # per read, after redaction, like a web page
MAX_RESPONSE_BYTES = 1024 * 1024
READ_SECONDS = 60
API = "https://api.github.com"
KINDS = ("open_issues", "open_pulls", "commit_checks", "failed_runs")
REPOSITORY = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}")
_INVALID = ("Review one GitHub repository (owner/name) and up to four reads: open issues, "
            "open pull requests, checks for the reviewed commit, or failed workflow runs.")


def _fail(message=_INVALID):
    raise RegistryError("invalid_github_plan", message)


def _limit(read, kind):
    value = read.get("limit", MAX_ITEMS[kind])
    if type(value) is not int or not 1 <= value <= MAX_ITEMS[kind]:
        _fail(f"Read 1 to {MAX_ITEMS[kind]} items for {kind.replace('_', ' ')}.")
    return value


def validate(plan):
    """The canonical reviewed plan, or None for no GitHub access. Refuses anything else whole."""
    if plan is None:
        return None
    if (not isinstance(plan, dict) or set(plan) != {"schema_version", "repository", "reads"}
            or type(plan["schema_version"]) is not int or plan["schema_version"] != SCHEMA_VERSION
            or not isinstance(plan["repository"], str) or not REPOSITORY.fullmatch(plan["repository"])
            or plan["repository"].split("/")[1] in (".", "..")
            or not isinstance(plan["reads"], list) or not 1 <= len(plan["reads"]) <= MAX_READS):
        _fail()
    reads, kinds = [], set()
    for read in plan["reads"]:
        if not isinstance(read, dict) or read.get("kind") not in KINDS or read["kind"] in kinds:
            _fail("Each GitHub read is one of the four kinds, at most once.")
        kind = read["kind"]
        kinds.add(kind)
        allowed = {"kind"} | ({"limit"} if kind in MAX_ITEMS else set()) | ({"labels"} if kind == "open_issues" else set())
        if set(read) - allowed:
            _fail()
        row = {"kind": kind}
        if kind in MAX_ITEMS:
            row["limit"] = _limit(read, kind)
        if "labels" in read:
            labels = read["labels"]
            if (not isinstance(labels, list) or not 1 <= len(labels) <= MAX_LABELS or len(set(labels)) != len(labels)
                    or not all(isinstance(x, str) and 1 <= len(x) <= 50 and x == x.strip() and "," not in x
                               and not re.search(r"[\x00-\x1f\x7f]", x) for x in labels)):
                _fail("Filter issues by up to five labels of up to 50 characters, without commas.")
            row["labels"] = list(labels)
        reads.append(row)
    return {"schema_version": SCHEMA_VERSION, "repository": plan["repository"], "reads": reads}


def label(read) -> str:
    """One line a person reviews."""
    kind = read["kind"]
    if kind == "open_issues":
        return f"Up to {read['limit']} open issues" + (f" labelled {', '.join(read['labels'])}" if read.get("labels") else "")
    if kind == "open_pulls":
        return f"Up to {read['limit']} open pull requests"
    if kind == "commit_checks":
        return "CI checks for the commit the run reviews"
    return f"Up to {read['limit']} recent failed workflow runs"


def repository_from_remote(root) -> str | None:
    """owner/name of the project's GitHub `origin`, or None."""
    try:
        out = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "remote", "get-url", "origin"],
                             cwd=str(root), capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    url = out.stdout.strip()
    match = re.fullmatch(r"(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)"
                         r"([^/\s]+/[^/\s]+?)(?:\.git)?/?", url) if out.returncode == 0 else None
    name = match.group(1) if match else None
    return name if name and REPOSITORY.fullmatch(name) else None


def token(config) -> str:
    """The user's GitHub credential, or "" to read public repositories anonymously."""
    for name in ("GH_TOKEN", "GITHUB_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    try:
        out = subprocess.run(["gh", "auth", "token", "--hostname", "github.com"], capture_output=True,
                             text=True, timeout=10, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return ""
    value = out.stdout.strip()
    return value if out.returncode == 0 and re.fullmatch(r"[A-Za-z0-9_]{20,255}", value) else ""


def _get(path, credential, params=None):
    """One bounded GET to api.github.com. Never follows a redirect to another host."""
    import requests
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
               "User-Agent": "DGC-Pips"}
    if credential:
        headers["Authorization"] = "Bearer " + credential
    response = requests.get(API + path, params=params or {}, headers=headers, timeout=15,
                            allow_redirects=False, stream=True)
    try:
        if response.status_code in (401, 403, 404):
            raise ValueError("GitHub refused the read (HTTP %d): the repository may be private or the credential "
                             "may lack access" % response.status_code)
        if response.status_code != 200:
            raise ValueError("GitHub answered HTTP %d" % response.status_code)
        raw = response.raw.read(MAX_RESPONSE_BYTES + 1, decode_content=True)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("GitHub's answer exceeded 1 MiB")
        return json.loads(raw.decode("utf-8"))
    finally:
        response.close()


def _text(value, limit):
    value = " ".join(str(value or "").split()) if limit <= MAX_TITLE else str(value or "").strip()
    return value if len(value) <= limit else value[:limit] + "…"


def _read(kind, read, repository, revision, credential, get):
    base = f"/repos/{repository}"
    if kind == "open_issues":
        params = {"state": "open", "per_page": read["limit"], "sort": "updated"}
        if read.get("labels"):
            params["labels"] = ",".join(read["labels"])
        items = [item for item in get(base + "/issues", credential, params) if "pull_request" not in item]
        return [{"number": i.get("number"), "title": _text(i.get("title"), MAX_TITLE),
                 "labels": [l.get("name") for l in i.get("labels") or () if isinstance(l, dict)][:10],
                 "author": (i.get("user") or {}).get("login"), "updated_at": i.get("updated_at"),
                 "comments": i.get("comments"), "body": _text(i.get("body"), MAX_BODY)} for i in items[:read["limit"]]]
    if kind == "open_pulls":
        items = get(base + "/pulls", credential, {"state": "open", "per_page": read["limit"], "sort": "updated", "direction": "desc"})
        return [{"number": p.get("number"), "title": _text(p.get("title"), MAX_TITLE), "draft": p.get("draft"),
                 "author": (p.get("user") or {}).get("login"), "head": (p.get("head") or {}).get("ref"),
                 "base": (p.get("base") or {}).get("ref"), "updated_at": p.get("updated_at")} for p in items[:read["limit"]]]
    if kind == "commit_checks":
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
            raise ValueError("this run has no pinned commit to look up")
        runs = get(f"{base}/commits/{revision}/check-runs", credential, {"per_page": 50}).get("check_runs") or []
        statuses = get(f"{base}/commits/{revision}/status", credential).get("statuses") or []
        return {"commit": revision,
                "check_runs": [{"name": _text(c.get("name"), 120), "status": c.get("status"),
                                "conclusion": c.get("conclusion")} for c in runs[:50]],
                "statuses": [{"context": _text(s.get("context"), 120), "state": s.get("state"),
                              "description": _text(s.get("description"), 200)} for s in statuses[:30]]}
    items = get(base + "/actions/runs", credential, {"status": "failure", "per_page": read["limit"]}).get("workflow_runs") or []
    return [{"workflow": _text(r.get("name"), 120), "branch": r.get("head_branch"), "commit": (r.get("head_sha") or "")[:12],
             "event": r.get("event"), "run_number": r.get("run_number"), "created_at": r.get("created_at")}
            for r in items[:read["limit"]]]


def execute(config, plan, *, revision, authorize, get=None, credential=None, clock=time.monotonic):
    """Perform the reviewed reads in order. A read that fails is reported, not fatal."""
    plan = validate(plan)
    if plan is None:
        return []
    import requests
    from .redaction import redact_value, redact_text, secret_values
    get = get or _get
    credential = token(config) if credential is None else credential
    secrets = tuple(sorted({*secret_values(config), *((credential,) if credential else ())}, key=len, reverse=True))
    deadline = clock() + READ_SECONDS
    results = []
    for read in plan["reads"]:
        authorize()
        if clock() >= deadline:
            raise RegistryError("github_read_timeout", "The reviewed GitHub reads ran out of time.")
        row = {"repository": plan["repository"], **read, "untrusted": True}
        try:
            items = redact_value(_read(read["kind"], read, plan["repository"], revision, credential, get), secrets)
            # Redacted whole before the bound, and bounded by dropping whole items, never by
            # cutting text: no fragment of a secret survives, and no item is half-shown.
            size = lambda value: len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
            lists = [items] if isinstance(items, list) else [items["check_runs"], items["statuses"]]
            while size(items) > MAX_READ_CHARS and any(lists):
                max(lists, key=len).pop()
                row["truncated"] = True
            row["items"] = items
        except (requests.RequestException, ValueError, OSError, AttributeError, TypeError) as exc:
            row["error"] = redact_text(str(exc), secrets)[:300] or "could not be read"
        results.append(row)
    authorize()
    return results
