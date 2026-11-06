"""`dgc videos`: video generation from the command line (and the text `/videos` shows in the terminal).

    dgc videos [list] [--refresh] [--json]          the generators that make videos, and the jobs running
    dgc videos add PROVIDER [ADDRESS] [--model M] [--name N] [--workflow FILE] [--limit USD] [--yes] [--json]
    dgc videos make PROMPT [--generator ID] [--duration S] [--aspect A] [--resolution R] [--image PATH] [--audio]
                    [--out PATH] [--yes] [--no-wait] [--json]
    dgc videos jobs [--json] · dgc videos show JOB [--json] · dgc videos stop JOB [--json]
    dgc videos library [--query TEXT] [--json] · dgc videos open JOB

A video costs money, so ``make`` asks first in a terminal; ``--yes`` makes it without asking (for a script). Making
one, or adding a generator, from the agent's own shell is refused: that is the user's call (the model has
generate_video, which asks).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import image_tools, images, video_tools, videos
from . import images_admin as admin


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dgc videos", description="Video generation with your generators: fal.ai, "
                                     "Gemini, Replicate, or a ComfyUI video workflow")
    sub = parser.add_subparsers(dest="command")
    listing = sub.add_parser("list", help="the generators that make videos, and the jobs running")
    listing.add_argument("--refresh", action="store_true")
    listing.add_argument("--json", action="store_true")
    add = sub.add_parser("add", help="add a video generator (it uses the key its provider already has)")
    add.add_argument("provider", help="fal, gemini, replicate or comfyui")
    add.add_argument("address", nargs="?", default="")
    add.add_argument("--model", default="")
    add.add_argument("--name", default="")
    add.add_argument("--id", default="")
    add.add_argument("--workflow", help="a ComfyUI video workflow exported in API format")
    add.add_argument("--limit", type=float, help="most to spend a month on its key, in US dollars")
    add.add_argument("--yes", action="store_true", help="use the inputs DGC finds in the workflow without asking")
    add.add_argument("--json", action="store_true")
    make = sub.add_parser("make", help="make a video now (it asks first; --yes for a script)")
    make.add_argument("prompt")
    make.add_argument("--generator", default="")
    make.add_argument("--duration", type=int)
    make.add_argument("--aspect", choices=video_tools.ASPECTS)
    make.add_argument("--resolution")
    make.add_argument("--image", help="a start image to animate")
    make.add_argument("--audio", action="store_true")
    make.add_argument("--out", default="", help="a folder or file in this project (default: DGC's own folder)")
    make.add_argument("--yes", action="store_true", help="make it without asking (it costs money)")
    make.add_argument("--no-wait", action="store_true", help="start it and come back; dgc videos show JOB follows it")
    make.add_argument("--json", action="store_true")
    jobs = sub.add_parser("jobs", help="the video jobs, newest first")
    jobs.add_argument("--json", action="store_true")
    for name, words in (("show", "one job"), ("stop", "stop a job (at the provider where it can)"),
                        ("open", "open a finished video in the system player")):
        one = sub.add_parser(name, help=words)
        one.add_argument("job")
        one.add_argument("--json", action="store_true")
    library = sub.add_parser("library", help="every video DGC made")
    library.add_argument("--query", default="")
    library.add_argument("--json", action="store_true")
    return parser


def _say(args, payload, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    else:
        print(text)


def _project_root() -> Path:
    from .config import find_project_root
    return Path(find_project_root())


def job_lines(job: dict) -> list[str]:
    """A job as the terminal shows it: its line, where the file is, and how to open it."""
    lines = [f"{job['id']} · {videos.line(job)}"]
    result = job.get("result") or {}
    if result.get("path"):
        lines.append(f"  {result.get('rel') or result['path']}")
        lines.append(f"  Open: dgc videos open {job['id']}")
    elif job.get("state") not in videos.TERMINAL:
        lines.append(f"  {job.get('minutes') or ''} · started {int(time.time() - float(job.get('started') or 0))} s ago"
                     f" · Stop: dgc videos stop {job['id']}")
    return lines


def open_file(path: str) -> bool:
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    if not shutil.which(opener):
        return False
    try:
        subprocess.Popen([opener, path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return False
    return True


def main(argv: list[str]) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv or ["list"])
    except SystemExit as exc:
        return int(exc.code or 0)
    command = args.command or "list"
    if os.environ.get("DGC_AGENT_SHELL") == "1" and command in ("add", "make"):
        print("dgc videos: adding a video generator or spending on a video is your decision; run it in your own "
              "terminal (the model uses generate_video, which asks).", file=sys.stderr)
        return 2
    from .config import Config
    config = Config()
    root = _project_root()
    try:
        if command == "list":
            surface = image_tools.Surface(name="cli", root=root, project_root=root)
            _say(args, {"generators": [images.describe(config, g) for g in videos.generators(images.settings(config))],
                        "jobs": [videos.view(j) for j in videos.all_jobs(limit=20)]},
                 video_tools.list_text(config, {"refresh": args.refresh}, surface))
            return 0
        if command == "add":
            fields = {"provider": args.provider, "base_url": args.address, "name": args.name, "id": args.id,
                      "model": args.model, "monthly_limit_usd": args.limit, "makes": "videos"}
            if args.workflow:
                fields["workflow"] = Path(args.workflow).expanduser().read_text(encoding="utf-8")
            out = admin.add(config, fields, confirm=args.yes)
            if out.get("pending"):
                _say(args, out, "\n".join(["DGC found these inputs in the workflow:",
                                           *("  " + line for line in out["mapping_lines"]),
                                           *("  note: " + note for note in out.get("notes") or []),
                                           "Run again with --yes to use them."]))
                return 3
            _say(args, out, "\n".join([out["summary"] + ".", *(out.get("notes") or [])]))
            return 0
        if command == "make":
            return _make(config, args, root)
        if command == "jobs":
            rows = videos.all_jobs(limit=50)
            _say(args, [videos.view(j) for j in rows],
                 "\n".join(line for job in rows for line in job_lines(job)) or "No video jobs yet.")
            return 0
        if command == "library":
            found = videos.library(query=args.query)
            _say(args, found, "\n".join(f"{row.get('created_at', '')[:16]} · {row.get('generator_name')} · "
                                        f"{row.get('seconds') or '?'} s · {row['path']}" for row in found["videos"])
                 or "No videos yet.")
            return 0
        job = videos.load(args.job)
        if job is None:
            print(f"dgc videos: there is no video job {args.job}", file=sys.stderr)
            return 1
        if command == "show":
            _say(args, videos.view(job), "\n".join(job_lines(job)))
            return 0
        if command == "stop":
            stopped = videos.JOBS.stop(config, args.job)
            _say(args, videos.view(stopped), videos.line(stopped))
            return 0
        if command == "open":
            path = (job.get("result") or {}).get("path")
            if not path:
                print(f"dgc videos: {args.job} has no video yet ({job.get('state')})", file=sys.stderr)
                return 1
            if not open_file(path):
                print(path)
            return 0
    except admin.ChangeError as exc:
        print(f"dgc videos: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"dgc videos: {exc}", file=sys.stderr)
        return 1
    parser.print_usage(sys.stderr)
    return 2


def _make(config, args, root: Path) -> int:
    surface = image_tools.Surface(name="cli", root=root, project_root=root, interactive=False,
                                  where={"project": str(root)}, video_home=videos.session_folder("cli"))
    call = {"prompt": args.prompt, "generator": args.generator, "duration_s": args.duration, "aspect": args.aspect,
            "resolution": args.resolution, "image": args.image, "audio": True if args.audio else None,
            "save_to": args.out}
    call = {k: v for k, v in call.items() if v not in (None, "")}
    try:
        plan = video_tools.prepare(config, call, surface)
    except video_tools.Refused as exc:
        print(f"dgc videos: {exc}", file=sys.stderr)
        return 1
    card = plan.card()
    if plan.over_limit:
        print(f"dgc videos: {card['note']}", file=sys.stderr)
        return 1
    if plan.asks and not args.yes:
        if not sys.stdin.isatty():
            print(f"dgc videos: {plan.summary()} costs money: run it with --yes to make it.", file=sys.stderr)
            return 1
        month = f" · this month {card['this_month']}" if card.get("this_month") else ""
        note = f"  {card['note']}\n" if card.get("note") else ""
        answer = input(f"Make this video with {card['label']}? {card['facts']}{month}\n  \"{card['prompt']}\"\n"
                       f"{note}[y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Not made.", file=sys.stderr)
            return 1
    started = video_tools.start(config, plan, surface, target={"cli": True})
    if started.job is None:
        _say(args, {"text": started.text, **({"error": started.error.as_dict()} if started.error else {})},
             started.text)
        return 1
    job = started.job
    if not args.json:
        print(f"Started a {job['duration_s'] or ''} s video with {job['label']} ({job['resolution']}, "
              f"{videos.money(job['estimate_usd'])}), {job['minutes']} · {job['id']}".replace("a  s ", "a "), flush=True)
    if args.no_wait:
        _say(args, videos.view(job), f"Follow it: dgc videos show {job['id']} · Stop: dgc videos stop {job['id']}")
        return 0
    last = ""
    try:
        while True:
            now = videos.load(job["id"]) or job
            if now.get("state") in videos.TERMINAL:
                break
            words = now.get("status") or ""
            if words != last and not args.json:
                print(f"  {words} · {int(time.time() - float(now.get('started') or time.time()))} s", file=sys.stderr)
                last = words
            time.sleep(1.0)
    except KeyboardInterrupt:
        now = videos.JOBS.stop(config, job["id"])
    _say(args, videos.view(now), "\n".join(job_lines(now)))
    return 0 if now.get("state") == "done" else 1


# ---- /videos in the terminal ---------------------------------------------------------------------------------------
SLASH_USAGE = "/videos · /videos jobs · /videos stop JOB · /videos open JOB"


def slash(config, rest: str, *, project_root=None) -> tuple[str, str]:
    """What `/videos REST` does in the TUI or the classic terminal: (markdown to show, a short flash line)."""
    words = rest.split()
    sub = words[0].lower() if words else "list"
    root = Path(project_root or config.project_root)
    try:
        if sub in ("list", "status"):
            surface = image_tools.Surface(name="cli", root=root, project_root=root)
            return "```\n" + video_tools.list_text(config, {}, surface) + "\n```", ""
        if sub == "jobs":
            rows = videos.all_jobs(limit=20)
            text = "\n".join(line for job in rows for line in job_lines(job)).replace("dgc videos", "/videos")
            return "```\n" + (text or "No video jobs yet.") + "\n```", ""
        if sub in ("stop", "open", "show") and len(words) > 1:
            job = videos.load(words[1])
            if job is None:
                return "", f"there is no video job {words[1]}"
            if sub == "stop":
                return "", videos.line(videos.JOBS.stop(config, words[1]))
            if sub == "show":
                return "```\n" + "\n".join(job_lines(job)).replace("dgc videos", "/videos") + "\n```", ""
            path = (job.get("result") or {}).get("path")
            if not path:
                return "", f"{words[1]} has no video yet ({job.get('state')})"
            return "", ("opened " if open_file(path) else "") + path
    except ValueError as exc:
        return "", f"Videos: {exc}"
    return "", "usage: " + SLASH_USAGE
