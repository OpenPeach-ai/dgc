"""``dgc watch-github <link>``: follow a GitHub pull request or Actions run, one line per new thing.

A chat watches a pull request and CI (work-watch-events, asked 8 Nov: a pull request's activity and CI results as
notices). The model runs this as a monitor (``monitor {command: "dgc watch-github <link>",
persistent: true}``), so each line it prints reaches the chat as a notice and wakes it when idle; stopping the monitor
stops watching, and it ends by itself when the pull request closes or the run finishes.

A pull request: a first line says what is there already (none of it is news); then a review, a comment, a comment on
code, new commits, the checks finishing (with what failed), and the pull request being merged or closed. An Actions
run: one line when it starts being watched, one when it finishes, with the jobs and steps that failed.

What people wrote is their text, never instructions: each line is one line, control characters removed, clipped.
With the GitHub CLI signed in (``gh auth status``) DGC asks through ``gh api``, so private repositories work and gh keeps
its own sign-in; DGC never reads a token. Without it, GitHub's public API answers for public repositories; unchanged
answers come back as 304 (ETags), which GitHub doesn't count against its hourly limit for calls without a sign-in.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

USAGE = "Usage: dgc watch-github <a pull request's or an Actions run's link> [--every SECONDS]"
PR = re.compile(r"https://github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})/pull/(\d{1,9})(?:/[A-Za-z]*)?/?\Z")
RUN = re.compile(r"https://github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})/actions/runs/(\d{1,15})"
                 r"(?:/job/\d{1,15})?/?\Z")
EVERY = (30, 900)
TEXT = 240
CONTROL = re.compile(r"[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e\u2066-\u2069]")
REVIEW_WORDS = {"APPROVED": "approved", "CHANGES_REQUESTED": "changes requested", "COMMENTED": "commented",
                "DISMISSED": "dismissed"}


class NotFound(Exception):
    pass


class Limited(Exception):
    def __init__(self, reset):
        super().__init__("rate limited")
        self.reset = reset


def parse(link):
    """("pr" | "run", owner, repo, number) for a link it knows, else None."""
    if not isinstance(link, str):
        return None
    link = link.strip().split("#")[0].split("?")[0]
    for kind, pattern in (("pr", PR), ("run", RUN)):
        found = pattern.fullmatch(link)
        if found:
            return kind, found.group(1), found.group(2), int(found.group(3))
    return None


def clip(text, limit=TEXT) -> str:
    flat = " ".join(CONTROL.sub(" ", str(text or "")).split())
    return flat if len(flat) <= limit else flat[:limit - 1].rstrip() + "…"


def gh_signed_in() -> bool:
    gh = shutil.which("gh")
    if not gh:
        return False
    try:
        return subprocess.run([gh, "auth", "status"], stdin=subprocess.DEVNULL, capture_output=True, timeout=15).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


class Client:
    def __init__(self):
        self.base = os.environ.get("DGC_GITHUB_API", "https://api.github.com").rstrip("/")
        self.gh = gh_signed_in()
        self.tags, self.kept = {}, {}

    def get(self, path):
        if self.gh:
            done = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github+json", path],
                                  stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
            if done.returncode != 0:
                said = (done.stderr or b"").decode("utf-8", "replace")
                if "404" in said or "Not Found" in said:
                    raise NotFound(path)
                if "rate limit" in said.lower():
                    raise Limited(time.time() + 600)
                raise OSError(clip(said, 160) or "gh api failed")
            return json.loads(done.stdout or b"null")
        request = urllib.request.Request(self.base + path, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "dgc-watch-github",
            **({"If-None-Match": self.tags[path]} if path in self.tags else {})})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                value = json.loads(response.read() or b"null")
                if response.headers.get("ETag"):
                    self.tags[path], self.kept[path] = response.headers["ETag"], value
                return value
        except urllib.error.HTTPError as exc:
            if exc.code == 304 and path in self.kept:
                return self.kept[path]
            if exc.code == 404:
                raise NotFound(path) from exc
            if exc.code in (403, 429):
                reset = exc.headers.get("X-RateLimit-Reset") if exc.headers else None
                raise Limited(float(reset) if reset and reset.isdigit() else time.time() + 600) from exc
            raise OSError(f"GitHub answered {exc.code}") from exc


def _plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


# --------------------------------------------------------------------------------------------- a pull request

def _pull(client, owner, repo, number) -> dict:
    base = f"/repos/{owner}/{repo}"
    pull = client.get(f"{base}/pulls/{number}")
    sha = ((pull or {}).get("head") or {}).get("sha") or ""
    reviews = client.get(f"{base}/pulls/{number}/reviews?per_page=100") or []
    comments = client.get(f"{base}/issues/{number}/comments?per_page=100") or []
    code = client.get(f"{base}/pulls/{number}/comments?per_page=100") or []
    checks = (client.get(f"{base}/commits/{sha}/check-runs?per_page=100") or {}).get("check_runs", []) if sha else []
    who = lambda item: clip(((item or {}).get("user") or {}).get("login") or "someone", 40)
    return {"state": pull.get("state"), "merged": bool(pull.get("merged")), "title": clip(pull.get("title"), 120),
            "sha": sha,
            "reviews": {r["id"]: (who(r), r.get("state"), r.get("body")) for r in reviews if isinstance(r, dict) and "id" in r},
            "comments": {c["id"]: (who(c), c.get("body")) for c in comments if isinstance(c, dict) and "id" in c},
            "code": {c["id"]: (who(c), c.get("path"), c.get("line") or c.get("original_line"), c.get("body"))
                     for c in code if isinstance(c, dict) and "id" in c},
            "checks": {clip(c.get("name"), 80): (c.get("status"), c.get("conclusion")) for c in checks if isinstance(c, dict)}}


def _checks_line(checks) -> str | None:
    if not checks or any(status != "completed" for status, _ in checks.values()):
        return None
    failed = sorted(name for name, (_, end) in checks.items() if end not in ("success", "neutral", "skipped"))
    passed = len(checks) - len(failed)
    if not failed:
        return f"Checks finished: all {_plural(passed, 'check')} passed."
    return f"Checks finished: {passed} passed, {len(failed)} failed ({', '.join(failed[:6])})."


def _pull_news(before, now) -> list:
    lines = []
    if now["sha"] and now["sha"] != before["sha"]:
        lines.append(f"New commits: the pull request is now at {now['sha'][:7]}.")
    for key in sorted(set(now["reviews"]) - set(before["reviews"]), key=str):
        login, state, body = now["reviews"][key]
        words = REVIEW_WORDS.get(state, clip(str(state).lower(), 30))
        lines.append(f"Review from {login}: {words}" + (f": {clip(body)}" if clip(body) else "."))
    for key in sorted(set(now["comments"]) - set(before["comments"]), key=str):
        login, body = now["comments"][key]
        lines.append(f"Comment from {login}: {clip(body)}")
    for key in sorted(set(now["code"]) - set(before["code"]), key=str):
        login, path, line, body = now["code"][key]
        where = clip(path, 120) + (f" line {line}" if isinstance(line, int) else "")
        lines.append(f"Comment from {login} on {where}: {clip(body)}")
    finished = _checks_line(now["checks"])
    if finished and (now["sha"] != before["sha"] or _checks_line(before["checks"]) != finished):
        lines.append(finished)
    return lines


def _watch_pull(client, owner, repo, number, every, out, sleep) -> int:
    now = _call(client, out, sleep, lambda: _pull(client, owner, repo, number))
    if now is None:
        return 2
    running = sum(1 for status, _ in now["checks"].values() if status != "completed")
    _say(out, f"Watching {owner}/{repo}#{number} \"{now['title']}\": {_plural(len(now['reviews']), 'review')}, "
              f"{_plural(len(now['comments']) + len(now['code']), 'comment')} so far"
              + (f", {_plural(running, 'check')} running." if running else "."))
    if now["state"] == "closed":
        _say(out, "The pull request is already " + ("merged" if now["merged"] else "closed") + ". Watching ends.")
        return 0
    while True:
        sleep(every)
        later = _call(client, out, sleep, lambda: _pull(client, owner, repo, number))
        if later is None:
            return 2
        for line in _pull_news(now, later):
            _say(out, line)
        now = later
        if now["state"] == "closed":
            _say(out, "The pull request was merged. Watching ends." if now["merged"]
                 else "The pull request was closed without merging. Watching ends.")
            return 0


# --------------------------------------------------------------------------------------------- an Actions run

def _watch_run(client, owner, repo, number, every, out, sleep) -> int:
    base = f"/repos/{owner}/{repo}/actions/runs/{number}"
    run = _call(client, out, sleep, lambda: client.get(base))
    if run is None:
        return 2
    label = f"{clip(run.get('name') or 'CI', 60)} run #{run.get('run_number') or number}"
    _say(out, f"Watching {label} on {clip(run.get('head_branch'), 60)}: {clip(run.get('status'), 20).replace('_', ' ')}.")
    while run.get("status") != "completed":
        sleep(every)
        run = _call(client, out, sleep, lambda: client.get(base))
        if run is None:
            return 2
    failed, jobs = [], None
    if run.get("conclusion") not in ("success", "neutral", "skipped"):
        jobs = (_call(client, out, sleep, lambda: client.get(base + "/jobs?per_page=100")) or {}).get("jobs", [])
        for job in jobs:
            if isinstance(job, dict) and job.get("conclusion") not in ("success", "neutral", "skipped", None):
                steps = [clip(s.get("name"), 60) for s in job.get("steps") or []
                         if isinstance(s, dict) and s.get("conclusion") == "failure"]
                failed.append(clip(job.get("name"), 60) + (f" ({', '.join(steps[:3])})" if steps else ""))
    _say(out, f"{label} on {clip(run.get('head_branch'), 60)} ({str(run.get('head_sha') or '')[:7]}) finished: "
              f"{clip(run.get('conclusion'), 20)}." + (f" Failed: {'; '.join(failed[:6])}." if failed else
                                                        " GitHub lists no jobs for it: it stopped before any started."
                                                        if jobs == [] else "")
              + " Watching ends.")
    return 0


# --------------------------------------------------------------------------------------------- shared

def _say(out, line) -> None:
    out.write(line + "\n")
    out.flush()


def _call(client, out, sleep, ask, tries=6):
    """One round of asking, through GitHub's limit and short outages. None: not found (said, and the watch ends)."""
    failures, told = 0, set()
    while True:
        try:
            return ask()
        except NotFound:
            _say(out, "GitHub doesn't show this (it isn't there, or it's private). For a private repository, sign in "
                      "once in a terminal with: gh auth login. Watching ends.")
            return None
        except Limited as limited:
            if "limit" not in told:
                told.add("limit")
                at = time.strftime("%H:%M", time.localtime(limited.reset))
                _say(out, f"GitHub's limit for calls without a sign-in is used up; checking again after {at}. "
                          "Signing in once with gh auth login raises it.")
            sleep(max(30, min(3600, limited.reset - time.time())))
        except (OSError, ValueError) as exc:
            failures += 1
            if failures == 3:
                _say(out, f"Can't reach GitHub ({clip(exc, 120)}); still trying.")
            if failures >= tries * 10:
                _say(out, "GitHub has been unreachable for a long time. Watching ends.")
                return None
            sleep(60)


def watch(link, *, every=60, out=None, sleep=time.sleep) -> int:
    out = out or sys.stdout
    found = parse(link)
    if found is None:
        _say(out, USAGE)
        return 2
    every = max(EVERY[0], min(EVERY[1], int(every)))
    kind, owner, repo, number = found
    client = Client()
    try:
        if kind == "pr":
            return _watch_pull(client, owner, repo, number, every, out, sleep)
        return _watch_run(client, owner, repo, number, every, out, sleep)
    except KeyboardInterrupt:
        return 130


def main(argv) -> int:
    args = list(argv or [])
    every = 60
    if "--every" in args:
        at = args.index("--every")
        try:
            every = int(args[at + 1])
        except (IndexError, ValueError):
            print(USAGE)
            return 2
        del args[at:at + 2]
    if len(args) != 1:
        print(USAGE)
        return 2
    return watch(args[0], every=every)
