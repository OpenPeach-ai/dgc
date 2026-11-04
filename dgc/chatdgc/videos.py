"""Video generation in ChatDGC: generate_video and list_video_generators in a chat's reply.

- **The card:** every video puts a card under the reply with its length, resolution, price and this month's spend
  (unless the user turned asking off for that generator in Settings). Nothing is sent until the user sends it.
- **The job:** sending the card starts it and the card says so ("running", the provider's state, the time so far).
  The card is kept with the chat (its job id with it), so a reload shows it again and the job is polled again
  (dgc/videos.py). When the video is ready the card becomes its player; a failure or a Stop says what happened.
- **Where it goes:** ``~/.dgc/videos/chats/<chat id>/`` with its sidecar; the Library's Videos lists it.
"""
from __future__ import annotations

import copy
import time
import uuid

from .. import image_tools, video_tools, videos

GENERATE_TOOL = copy.deepcopy(video_tools.GENERATE_SCHEMA)
GENERATE_TOOL["function"]["description"] = (
    "Make a short video clip with one of the user's video generators (list_video_generators shows them). It is "
    "EXPENSIVE and SLOW (about $0.10-$2 a clip, one to several minutes), so make ONE at a time unless the user asked "
    "for more. A card with its length and price shows in the chat, and nothing is made until the user sends it; "
    "then the card shows the video's progress and becomes its player. To animate one of this chat's pictures, give "
    "its file name as `image`. Leave `generator` out unless the user named one.")
for _name in ("save_to", "replace"):
    GENERATE_TOOL["function"]["parameters"]["properties"].pop(_name, None)
GENERATE_TOOL["function"]["parameters"]["properties"]["image"]["description"] = (
    "One of this chat's pictures to animate: its file name")
LIST_TOOL = copy.deepcopy(video_tools.LIST_SCHEMA)
TOOLS = (GENERATE_TOOL, LIST_TOOL)
NAMES = frozenset({"generate_video", "list_video_generators"})
MAX_CALLS = 2


def surface(engine, chat: dict) -> image_tools.Surface:
    from . import images as chat_images
    place = chat_images.surface(engine, chat)
    place.video_home = videos.chat_folder(chat["id"])
    place.chat_choice = str(chat.get("video_generator") or "")
    return place


def _arguments(plan, args: dict) -> dict:
    request = plan.request
    return {"prompt": request.prompt, "generator": plan.generator["id"],
            **({"duration_s": request.duration_s} if request.duration_s else {}),
            "resolution": request.resolution, "aspect": request.aspect,
            **({"audio": bool(request.audio)} if request.audio is not None else {}),
            **({"model": request.model} if request.model else {}),
            **({"seed": request.seed} if request.seed is not None else {}),
            **({"negative_prompt": request.negative} if request.negative else {}),
            **({"image": str(args.get("image"))} if args.get("image") else {})}


def call(engine, chat: dict, tool_call, at: int, actions: list, on_action, message_id: str = "") -> str:
    """One generate_video or list_video_generators call in a reply: what the model is told."""
    from .store import now
    args = tool_call.arguments if isinstance(tool_call.arguments, dict) else {}
    place = surface(engine, chat)
    if tool_call.name == "list_video_generators":
        return video_tools.list_text(engine.config, args, place)
    try:
        plan = video_tools.prepare(engine.config, args, place)
    except video_tools.Refused as exc:
        return f"error: {exc}"
    card = {"kind": "video", "plugin": "videos", "plugin_name": plan.generator["name"], "money": True,
            "tool": "generate_video", "price": plan.card()["price"], "card": plan.card(),
            "arguments": _arguments(plan, args), "recurring": False, "status": "waiting",
            "id": "act_" + uuid.uuid4().hex, "at": at, "created_at": now()}
    if not plan.asks:
        # The user turned asking off for this generator in Settings: it starts now, and the card shows it.
        started = video_tools.start(engine.config, plan, place, target={"chat": chat["id"], "message": message_id,
                                                                          "action": card["id"]})
        if started.job is None:
            return started.text
        card.update(status="running", job=started.job["id"], job_view=videos.view(started.job))
        actions.append(card)
        if on_action is not None:
            on_action(card)
        return started.text.replace("(the player shows under this reply)", "(its card in the chat shows it)")
    actions.append(card)
    if on_action is not None:
        on_action(card)
    note = f" Note: {plan.card()['note']}" if plan.card().get("note") else ""
    return (f"A card is in the chat now: {plan.summary()}, {plan.card()['minutes']}. Nothing is made until the user "
            f"sends it. Say in one sentence what it will make and what it costs, and don't say where the card is.{note}")


def run_card(engine, chat: dict, card: dict, arguments: dict | None, message_id: str) -> dict:
    """The user sent a video card: start the job now. {status: running | failed, job?, job_view?, error?}."""
    args = dict(card.get("arguments") or {})
    if isinstance(arguments, dict):
        args.update({key: value for key, value in arguments.items()
                     if key in ("prompt", "duration_s", "resolution", "aspect", "audio")})
    place = surface(engine, chat)
    try:
        plan = video_tools.prepare(engine.config, args, place)
    except video_tools.Refused as exc:
        return {"status": "failed", "error": str(exc)}
    if plan.unpriced and not (card.get("card") or {}).get("price_unknown"):
        return {"status": "failed", "error": f"Not made: DGC doesn't know what {plan.label} charges, and its card "
                "didn't say so. Ask again to see the new card."}
    started = video_tools.start(engine.config, plan, place,
                                target={"chat": chat["id"], "message": message_id, "action": card["id"]})
    if started.job is None:
        return {"status": "failed", "error": started.text.removeprefix("error: ")}
    if plan.generator["id"] and not chat.get("video_generator"):
        chat["video_generator"] = plan.generator["id"]
    return {"status": "running", "job": started.job["id"], "job_view": videos.view(started.job),
            "answer": started.text}


def apply(engine, job: dict) -> tuple[dict, str, dict] | None:
    """A chat job changed: its card, as it is now, written to the chat (conversation id, message id, card), or
    None when the chat or its card is gone. A finished card is never changed again."""
    target = job.get("target") or {}
    chat_id, message_id, action_id = target.get("chat"), target.get("message"), target.get("action")
    if not chat_id or not action_id:
        return None
    with engine._card_lock:
        try:
            chat = engine._chat(chat_id)
        except Exception:                       # noqa: BLE001 -- a chat deleted meanwhile
            return None
        found = None
        for message in chat.get("messages") or []:
            if message_id and message.get("id") != message_id:
                continue
            for card in message.get("actions") or []:
                if card.get("id") == action_id:
                    found = (message, card)
        if found is None:
            return None
        message, card = found
        if card.get("status") in ("done", "failed", "cancelled"):
            return chat_id, message["id"], dict(card)
        view = videos.view(job)
        state = job.get("state")
        card["job"] = job["id"]
        card["job_view"] = view
        if state == "done":
            card.update(status="done", video=view.get("result") or {}, answer=videos.line(job))
        elif state == "failed":
            card.update(status="failed", error=videos.line(job))
        elif state == "cancelled":
            card.update(status="cancelled", answer=videos.line(job))
        else:
            card["status"] = "running"
        if state in videos.TERMINAL:
            from .store import now
            card["decided_at"] = card.get("decided_at") or now()
            card["ended_at"] = time.time()
        engine._save(chat)
        return chat_id, message["id"], dict(card)
