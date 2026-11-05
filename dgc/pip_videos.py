"""Video generation for a Personal Pip: generate_video and list_video_generators in its chat and its routines.

As with pictures (dgc/pip_images.py), the worker never holds a key: its calls come through the run's app socket to the
controller, which starts the job with the user's generators (dgc/video_tools.py). The job runs in the background
(dgc/videos.py) and outlives the run; the reply that asked shows it, as progress and then as a player.

**Money:** every video asks. In the Pip's chat, with the user there, the Pip asks in its reply with the price, and only a
later turn answering the user's own message makes it (``confirm: true``). A routine (nobody there) never makes one
unless the user allowed this Pip for that generator (``video_pips`` in the generator's settings, Settings → Models →
Images & video): that is the Always allow a routine needs.
"""
from __future__ import annotations

import copy
import hashlib
import json
import time
from pathlib import Path

from . import image_tools, video_tools, videos, pip_media_confirmation

TOOLS = ("generate_video", "list_video_generators")
PENDING_S = 30 * 60
MAX_PER_RUN = 1

GENERATE = copy.deepcopy(video_tools.GENERATE_SCHEMA)
GENERATE["function"]["description"] = (
    "Make a short video clip with one of the user's video generators (list_video_generators shows them). It is "
    "EXPENSIVE and SLOW (about $0.10-$2, minutes), so one at a time. It is never made on your say-so: you're told its "
    "price, ask the user in your reply, and only when they answer yes call this again with the same prompt and "
    "confirm: true. It's made in the background and shows with your reply when it's ready.")
for _name in ("save_to", "replace", "image"):
    GENERATE["function"]["parameters"]["properties"].pop(_name, None)
GENERATE["function"]["parameters"]["properties"]["confirm"] = {
    "type": "boolean", "description": "Only after the user answered yes to a priced video you asked them about"}
LIST = copy.deepcopy(video_tools.LIST_SCHEMA)


def schemas() -> list[dict]:
    return [GENERATE, LIST]


def _digest(prompt: str) -> str:
    return hashlib.sha256(" ".join(str(prompt or "").split()).lower().encode("utf-8")).hexdigest()[:24]


def may_make_alone(generator: dict, pip_id: str) -> bool:
    """The user's Always allow for a routine: this Pip is listed on the generator."""
    return pip_id in (generator.get("video_pips") or [])


class Session:
    """One run's video calls, in the controller."""

    def __init__(self, directory, config, pip_id: str, workspace_id: str, run_id: str, *, unattended: bool = False):
        self.directory, self.config = Path(directory), config
        self.pip_id, self.workspace_id, self.run_id = pip_id, workspace_id, run_id
        self.unattended = unattended
        self.user_turn = False
        self.user_message = ""
        self.started: list[str] = []
        self.calls = 0
        try:
            # A Pip's jobs a restart left on disk: polled again here (or watched while another DGC polls them).
            videos.JOBS.resume(config, keep=lambda job: bool((job.get("target") or {}).get("pip")))
        except Exception:                                # noqa: BLE001 -- a job stays on disk for the next try
            pass

    def _surface(self) -> image_tools.Surface:
        folder = videos.pip_folder(self.pip_id)
        return image_tools.Surface(name="pip", root=folder, project_root=None, interactive=False,
                                   where={"pip": self.pip_id, "run": self.run_id}, video_home=folder,
                                   owner=f"video for Pip run {self.run_id}")

    def _pending_path(self) -> Path:
        return videos.pip_folder(self.pip_id) / "pending.json"

    def _pending(self) -> dict:
        try:
            value = json.loads(self._pending_path().read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _ask(self, plan) -> str:
        note = f" {plan.card()['note']}" if plan.unpriced else ""
        if self.unattended:
            return (f"Not made: {plan.summary()}.{note} A routine makes a video only for a Pip the user allowed for "
                    "this generator (Settings → Models → Images & video → its Pips), and only at a price DGC knows; "
                    "nobody is here to ask. Tell the user what you'd make and its price; they can ask you in your chat.")
        self._pending_path().parent.mkdir(parents=True, exist_ok=True)
        self._pending_path().write_text(json.dumps({
            "run_id": self.run_id, "generator": plan.generator["id"], "prompt": _digest(plan.request.prompt),
            "request": pip_media_confirmation.request_identity(plan),
            "total": plan.estimate, "model": videos.model_of(plan.generator, plan.request.model), "at": time.time(),
            "card": plan.card()}), encoding="utf-8")
        return (f"Not made yet: {plan.summary()}, {plan.card()['minutes']}. It costs money, so ask the user in your reply "
                f"whether to make it, with that price.{' Tell them too:' + note if note else ''} If they answer yes, "
                "call generate_video again with the same prompt and confirm: true. Don't make it otherwise.")

    def _confirmed(self, plan, args: dict) -> tuple[bool, str]:
        if args.get("confirm") is not True:
            return False, ""
        pending = self._pending()
        if not self.user_turn or self.unattended:
            return False, "only your reply to the user's own message can make a video"
        if pending.get("run_id") in (None, self.run_id):
            return False, "the user hasn't answered yet: ask in your reply, with the price, and wait for their yes"
        if not pip_media_confirmation.user_said_yes(self.user_message):
            return False, "the user's message did not explicitly say yes to making the video"
        if time.time() - float(pending.get("at") or 0) >= PENDING_S:
            return False, "that question was too long ago: ask again, with the price"
        if pending.get("generator") != plan.generator["id"]:
            return False, "the user said yes to another generator: ask again for this one, with its price"
        allowed = pending.get("total")
        if plan.estimate is None or allowed is None:
            # A price DGC doesn't know is bounded by nothing the user said yes to, unless they said yes to that same
            # unknown price: this generator and model, asked about as such.
            if allowed is not None:
                return False, (f"DGC doesn't know what this one costs, so the user's yes to {videos.money(allowed)} "
                               "doesn't cover it: ask again, and say its price is unknown")
            if plan.estimate is not None:
                return False, (f"the user said yes to a price DGC didn't know: ask again with this one's price "
                               f"({videos.money(plan.estimate)})")
            if pending.get("model") != videos.model_of(plan.generator, plan.request.model):
                return False, "the user said yes to another model: ask again, saying its price is unknown"
            if plan.unpriced and not (pending.get("card") or {}).get("price_unknown"):
                return False, "DGC can't hold this to this month's limit, which the user wasn't told: ask again"
        elif plan.estimate > float(allowed) + 1e-9:
            return False, f"this costs more than what the user said yes to ({videos.money(allowed)}): ask again"
        if pending.get("request") != pip_media_confirmation.request_identity(plan):
            return False, "the video request changed since the user was asked: ask again for this exact video"
        return True, ""

    def call(self, op: str, args: dict) -> str:
        surface = self._surface()
        if op == "list_video_generators":
            return video_tools.list_text(self.config, args, surface)
        self.calls += 1
        if self.calls > MAX_PER_RUN:
            return "error: this run has started a video already. Finish your reply."
        try:
            plan = video_tools.prepare(self.config, {k: v for k, v in args.items() if k != "confirm"}, surface)
        except video_tools.Refused as exc:
            return f"error: {exc}"
        if plan.over_limit:
            return video_tools.start(self.config, plan, surface).text
        if self.unattended:
            if not may_make_alone(plan.generator, self.pip_id) or plan.unpriced:
                return self._ask(plan)
        elif plan.asks:
            confirmed, why = self._confirmed(plan, args)
            if not confirmed:
                asked = self._ask(plan)
                return f"Not made: {why}. {asked}" if why else asked
            try:
                self._pending_path().unlink()
            except OSError:
                pass
        started = video_tools.start(self.config, plan, surface,
                                    target={"pip": self.pip_id, "run": self.run_id, "workspace": self.workspace_id})
        if started.job is None:
            return started.text
        self.started.append(started.job["id"])
        record = self.directory / "runs" / self.run_id
        record.mkdir(parents=True, exist_ok=True)
        (record / "generated-videos.json").write_text(json.dumps(self.started), encoding="utf-8")
        return started.text.replace("(the player shows under this reply)",
                                    "(it shows with your reply in your chat when it's ready)")


def _replies_path(pip_id: str) -> Path:
    return videos.pip_folder(pip_id) / "replies.json"


def attach(store, run, reply_id: str) -> int:
    """The videos this run started, on its reply in the Pip's chat (pip_chat.commit). Returns how many."""
    path = Path(store.registry.directory) / "runs" / run["id"] / "generated-videos.json"
    try:
        started = [job for job in json.loads(path.read_text(encoding="utf-8")) if isinstance(job, str)][:4]
    except (OSError, ValueError, TypeError):
        return 0
    if not started:
        return 0
    replies = _replies_path(run["pip_id"])
    try:
        value = json.loads(replies.read_text(encoding="utf-8"))
        value = value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        value = {}
    value[reply_id] = started
    replies.parent.mkdir(parents=True, exist_ok=True)
    replies.write_text(json.dumps(dict(list(value.items())[-500:])), encoding="utf-8")
    for job_id in started:
        job = videos.load(job_id)
        if job is not None:
            job.setdefault("target", {})["message"] = reply_id
            videos.save(job)
    return len(started)


def message_videos(pip_id: str, reply_id: str) -> list[dict]:
    """A Pip reply's videos, as they are now (running, made, failed or stopped): for its chat (list_messages)."""
    try:
        value = json.loads(_replies_path(pip_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    out = []
    for job_id in (value.get(reply_id) or [])[:4] if isinstance(value, dict) else []:
        try:
            job = videos.load(job_id)
        except ValueError:
            job = None
        if job is not None:
            out.append(videos.view(job))
    return out
