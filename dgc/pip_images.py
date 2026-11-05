"""Image generation for a Personal Pip: generate_image and list_image_generators in its chat and its tasks.

The worker never holds a generator's key: its calls go through the run's app socket (pip_app_links.RunSocket) to the
controller, which makes the image with the user's generators exactly as Work does (dgc/image_tools.py) and keeps it:

- in ``~/.dgc/images/pips/<pip id>/`` with its sidecar (the Library's index lists it, made by a Pip), and
- with the Pip's reply in its chat (the chat's own image store, as a photo the user sends is kept), so the reply
  shows it.

**Money:** a generator that asks before each image (a paid one the user hasn't allowed) is never used on the Pip's
own say-so. The Pip asks in its reply, with the price; only a later turn that answers the user's own message may make
it, with ``confirm: true``. A routine's run (nobody there) never makes a paid image; it says what it would make. A
generator the user allowed (Always allow, or "asks" off), or a free one, makes the image at once.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import time
from pathlib import Path

from . import image_tools, pip_media_confirmation
from . import images as images_mod

TOOLS = ("generate_image", "list_image_generators")
PENDING_S = 30 * 60
MAX_PER_RUN = 4

GENERATE = copy.deepcopy(image_tools.GENERATE_SCHEMA)
GENERATE["function"]["description"] = (
    "Make images with one of the user's image generators (list_image_generators shows them). Each image is kept with "
    "your reply and shows in your chat. One that costs money is never made on your say-so: you're told its price, ask "
    "the user in your reply, and only when they answer yes call this again with the same prompt and confirm: true.")
for _name in ("save_to", "images", "mask"):
    GENERATE["function"]["parameters"]["properties"].pop(_name, None)
GENERATE["function"]["parameters"]["properties"]["confirm"] = {
    "type": "boolean", "description": "Only after the user answered yes to a priced image you asked them about"}
LIST = copy.deepcopy(image_tools.LIST_SCHEMA)


def schemas() -> list[dict]:
    return [GENERATE, LIST]


def folder(pip_id: str) -> Path:
    return images_mod.directory() / "pips" / pip_id


def _digest(prompt: str) -> str:
    return hashlib.sha256(" ".join(str(prompt or "").split()).lower().encode("utf-8")).hexdigest()[:24]


class Session:
    """One run's image calls, in the controller."""

    def __init__(self, directory, config, pip_id: str, workspace_id: str, run_id: str, *, unattended: bool = False):
        self.directory, self.config = Path(directory), config
        self.pip_id, self.workspace_id, self.run_id = pip_id, workspace_id, run_id
        self.unattended = unattended
        self.user_turn = False            # set by the controller: this run answers the user's own message
        self.user_message = ""             # exact text of that message, never a model-authored paraphrase
        self.made: list[dict] = []
        self.calls = 0

    def _surface(self) -> image_tools.Surface:
        return image_tools.Surface(name="pip", root=folder(self.pip_id), project_root=None, interactive=False,
                                   save_dir=".", where={"pip": self.pip_id, "run": self.run_id},
                                   owner=f"images for Pip run {self.run_id}")

    def _pending_path(self) -> Path:
        return folder(self.pip_id) / "pending.json"

    def _pending(self) -> dict:
        try:
            value = json.loads(self._pending_path().read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _ask(self, plan) -> str:
        if self.unattended:
            return (f"Not made: {plan.summary()}. It costs money and asks first, and nobody is here to answer in this "
                    "run. Tell the user what you'd make and its price; they can ask you in your chat, or allow that "
                    "generator in DGC (Always allow on its card).")
        folder(self.pip_id).mkdir(parents=True, exist_ok=True)
        self._pending_path().write_text(json.dumps({
            "run_id": self.run_id, "generator": plan.generator["id"], "prompt": _digest(plan.request.prompt),
            "request": pip_media_confirmation.request_identity(plan),
            "total": plan.total, "count": plan.request.count, "model": plan.card()["model"], "at": time.time(),
            "card": plan.card()}), encoding="utf-8")
        note = f" Tell them too: {plan.card()['note']}" if plan.card().get("note") else ""
        return (f"Not made yet: {plan.summary()}. It costs money, so ask the user in your reply whether to make it, "
                f"with that price.{note} If they answer yes, call generate_image again with the same prompt and "
                "confirm: true. Don't make it otherwise.")

    def _confirmed(self, plan, args: dict) -> tuple[bool, str]:
        """(made it, why not): the user answered yes in their own message after this Pip asked, in an earlier reply,
        about an image with this generator; and this one costs no more than what they said yes to."""
        if args.get("confirm") is not True:
            return False, ""
        pending = self._pending()
        if not self.user_turn or self.unattended:
            return False, "only your reply to the user's own message can make a paid image"
        if pending.get("run_id") in (None, self.run_id):
            return False, "the user hasn't answered yet: ask in your reply, with the price, and wait for their yes"
        if not pip_media_confirmation.user_said_yes(self.user_message):
            return False, "the user's message did not explicitly say yes to making the image"
        if time.time() - float(pending.get("at") or 0) >= PENDING_S:
            return False, "that question was too long ago: ask again, with the price"
        if pending.get("generator") != plan.generator["id"]:
            return False, "the user said yes to another generator: ask again for this one, with its price"
        allowed = pending.get("total")
        if plan.total is None or allowed is None:
            # A price DGC doesn't know is bounded by nothing the user said yes to, unless they said yes to that same
            # unknown price: this generator and model, asked about as such.
            if allowed is not None:
                return False, ("DGC doesn't know what this one costs, so the user's yes to "
                               f"{images_mod.money(allowed)} doesn't cover it: ask again, and say its price is unknown")
            if plan.total is not None:
                return False, (f"the user said yes to a price DGC didn't know: ask again with this one's price "
                               f"({images_mod.money(plan.total)})")
            if pending.get("model") != plan.card()["model"] or plan.request.count > int(pending.get("count") or 0):
                return False, "the user said yes to another model or fewer images: ask again, saying its price is unknown"
        elif plan.total > float(allowed) + 1e-9:
            return False, ("this costs more than what the user said yes to "
                           f"({images_mod.money(allowed)}): ask again with the new price")
        if plan.over_limit and not (pending.get("card") or {}).get("over_limit"):
            return False, "this would now pass this month's limit, which the user wasn't asked about: ask again"
        if plan.unpriced and not (pending.get("card") or {}).get("price_unknown"):
            return False, "DGC can't hold this to this month's limit, which the user wasn't told: ask again"
        if pending.get("request") != pip_media_confirmation.request_identity(plan):
            return False, "the image request changed since the user was asked: ask again for this exact image"
        return True, ""

    def call(self, op: str, args: dict) -> str:
        surface = self._surface()
        if op == "list_image_generators":
            return image_tools.list_text(self.config, args, surface)
        self.calls += 1
        if self.calls > MAX_PER_RUN:
            return "error: this run has made enough images. Finish your reply."
        try:
            plan = image_tools.prepare(self.config, {k: v for k, v in args.items() if k != "confirm"}, surface)
        except image_tools.Refused as exc:
            return f"error: {exc}"
        if plan.asks:
            if args.get("confirm") is not True and self._confirmed(plan, {**args, "confirm": True})[0]:
                # The question it asked earlier is still waiting, and this message may be the user's answer: keep that
                # question (asking again here would make the yes it got not count) and say how to use the yes.
                return (f"This needs the user's yes: you asked them about it earlier "
                        f"({images_mod.money(self._pending().get('total'))} with {plan.generator['name']}). If their "
                        "message says yes, call generate_image again with confirm: true now; if it doesn't, ask them.")
            confirmed, why = self._confirmed(plan, args)
            if not confirmed:
                # Not this time: this request becomes the question waiting for the user's yes (a stale or different
                # one never blocks the next), and the Pip is told why.
                asked = self._ask(plan)
                return f"Not made: {why}. {asked}" if why else asked
            plan.asks = False
            try:
                self._pending_path().unlink()
            except OSError:
                pass
        surface.approve = None             # a fallback to another paid generator is never automatic for a Pip
        outcome = image_tools.execute(self.config, plan, surface)
        if outcome.result is None:
            return outcome.text
        for item in outcome.result.saved:
            self._keep(item)
        return outcome.text.replace("The user sees it in the chat.", "It shows with your reply in your chat.") \
            .replace("The user sees them in the chat.", "They show with your reply in your chat.")

    def _keep(self, item) -> None:
        """Into the Pip chat's own image store (as a sent photo is kept, by its digest), for this run's reply."""
        from .pip_chat import _IMAGE_EXT, image_directory
        if item.mime not in _IMAGE_EXT or len(self.made) >= 16:
            return
        digest = hashlib.sha256(item.data).hexdigest()
        target = image_directory(self.directory, self.pip_id)
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = target / f"{digest}.{_IMAGE_EXT[item.mime]}"
        if not path.exists():
            staging = target / f".{digest}.{os.getpid()}.{os.urandom(4).hex()}"
            fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(item.data)
            os.replace(staging, path)
        self.made.append({"sha256": digest, "mime": item.mime, "bytes": item.bytes})
        record = self.directory / "runs" / self.run_id
        record.mkdir(parents=True, exist_ok=True)
        (record / "generated-images.json").write_text(json.dumps(self.made), encoding="utf-8")


def attach(store, run, reply_id: str) -> int:
    """The images this run made, on its reply in the Pip's chat (pip_chat.commit). Returns how many."""
    path = Path(store.registry.directory) / "runs" / run["id"] / "generated-images.json"
    try:
        made = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    from .pip_chat import image_paths, validate_images, widen_tables
    from .workspace_registry import RegistryError
    try:
        items = validate_images(made)
        image_paths(store.registry.directory, run["pip_id"], items)
    except RegistryError:
        return 0
    widen_tables(store.db)
    for index, item in enumerate(items):
        store.db.execute("INSERT INTO pip_chat_images VALUES(?,?,?,?,?)",
                         (reply_id, index, item["sha256"], item["mime"], item["bytes"]))
    return len(items)
