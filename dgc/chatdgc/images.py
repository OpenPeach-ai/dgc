"""Image generation in ChatDGC: generate_image and list_image_generators in a chat's reply, as in Work.

- **Where images go:** the chat's folder, ``~/.dgc/images/chats/<chat id>/``, each with its sidecar, and kept with
  the chat as a file it made: a card under the reply shows it, and the Library lists it (Images, Made by ChatDGC).
- **Which generator:** the one the user names, else the chat's remembered choice, else the default (free ones first).
  The first one a chat uses by name is remembered for it.
- **Money:** a generator that asks before each image puts a card under the reply with its price; nothing is made
  until the user sends it. One the user allowed (Always allow in Work, or "asks" off) makes the image at once.
"""
from __future__ import annotations

import copy

from .. import image_tools
from .. import images as images_mod
from ..image_providers import sniff

GENERATE_TOOL = copy.deepcopy(image_tools.GENERATE_SCHEMA)
GENERATE_TOOL["function"]["description"] = (
    "Make images with one of the user's image generators (list_image_generators shows them). With `images` it edits "
    "the chat's own images (their file names) or uses them as references. Each image shows under your reply and is "
    "kept in the Library. A generator that costs money shows the user a card with its price first, and makes nothing "
    "until they send it. Leave `generator` out unless the user named one.")
GENERATE_TOOL["function"]["parameters"]["properties"].pop("save_to", None)
GENERATE_TOOL["function"]["parameters"]["properties"]["images"]["description"] = (
    "Images of this chat to edit or use as references: their file names")
LIST_TOOL = copy.deepcopy(image_tools.LIST_SCHEMA)
TOOLS = (GENERATE_TOOL, LIST_TOOL)
NAMES = frozenset({"generate_image", "list_image_generators"})
MAX_CALLS = 4


def folder(chat_id: str):
    return images_mod.directory() / "chats" / chat_id


def _inputs(engine, chat):
    """An image the chat keeps, by its file name or id: (bytes, mime, name)."""
    def find(name: str):
        for message in reversed(chat.get("messages") or []):
            for meta in [*(message.get("attachments") or []), *(message.get("files") or [])]:
                if meta.get("kind") == "image" and name in (meta.get("name"), meta.get("id")):
                    found = engine._file(chat, meta["id"])
                    if found is not None and sniff(found[0]):
                        return found[0], sniff(found[0]), str(meta.get("name") or "image.png")
        return None
    return find


def surface(engine, chat: dict, cancel=None) -> image_tools.Surface:
    def remember(generator_id: str) -> None:
        chat["image_generator"] = generator_id
    return image_tools.Surface(name="chat", root=folder(chat["id"]), project_root=None,
                               chat_choice=str(chat.get("image_generator") or ""), interactive=False,
                               remember=remember, inputs=_inputs(engine, chat), cancel=cancel, save_dir=".",
                               where={"chat": chat["id"], "chat_title": str(chat.get("title") or "")[:120]},
                               owner=f"images for chat {chat['id']}")


def _quote(plan) -> dict:
    """The effective image and exact estimate the user reviewed, apart from editable prompt text."""
    shown = plan.card()
    return {"generator": plan.generator["id"], "provider": plan.generator["provider"],
            "model": shown["model"], "size": shown["size"], "count": plan.request.count,
            "total_usd": plan.total}


def _keep(engine, chat: dict, result, at: int, files: list, on_file) -> list[dict]:
    """Each image kept with the chat as a file it made (the Library lists it), and its card under the reply."""
    from . import attachments as attached
    from .store import now
    kept = []
    for item in result.saved:
        meta = {"id": attached.new_attachment_id(), "kind": "image", "name": item.path.name, "mime": item.mime,
                "size": item.bytes, "chars": 0, "format": item.path.suffix.lstrip("."), "made": True, "at": at,
                "created_at": now(), "width": item.width, "height": item.height,
                "generated": {"generator": result.generator["id"], "generator_name": result.generator["name"],
                              "model": result.model, "seed": item.seed, "path": str(item.path),
                              "cost_usd": None if result.cost is None else round(result.cost / len(result.saved), 4)}}
        engine._keep_file(chat, {"meta": meta, "raw": item.data, "text": None})
        with engine._lock:
            # Shown while the reply is still being written: the screen asks for the picture as its card appears,
            # before the reply (and so this file) is saved with the chat.
            engine._live_pictures[(chat["id"], meta["id"])] = meta
        files.append(meta)
        kept.append(meta)
        if on_file is not None:
            on_file(meta)
    return kept


def call(engine, chat: dict, tool_call, files: list, at: int, on_file, actions: list, on_action, cancel=None) -> str:
    """One generate_image or list_image_generators call in a reply: what the model is told."""
    from .store import now
    import uuid
    args = tool_call.arguments if isinstance(tool_call.arguments, dict) else {}
    place = surface(engine, chat, cancel)
    if tool_call.name == "list_image_generators":
        return image_tools.list_text(engine.config, args, place)
    try:
        plan = image_tools.prepare(engine.config, args, place)
    except image_tools.Refused as exc:
        return f"error: {exc}"
    if plan.asks:
        card = {"kind": "image", "plugin": "images", "plugin_name": plan.generator["name"], "money": True,
                "tool": "generate_image", "price": plan.card()["price"], "card": plan.card(),
                "quote": _quote(plan),
                "arguments": {"prompt": plan.request.prompt, "generator": plan.generator["id"],
                              "size": f"{plan.request.width}x{plan.request.height}", "count": plan.request.count,
                              **({"seed": plan.request.seed} if plan.request.seed is not None else {}),
                              **({"model": plan.request.model} if plan.request.model else {}),
                              **({"negative_prompt": plan.request.negative} if plan.request.negative else {}),
                              **({"images": list(args.get("images") or [])} if args.get("images") else {})},
                "recurring": False, "status": "waiting", "id": "act_" + uuid.uuid4().hex, "at": at,
                "created_at": now()}
        actions.append(card)
        if on_action is not None:
            on_action(card)
        return (f"A card is in the chat now: {plan.summary()}. Nothing is made until the user sends it. Say in one "
                "sentence what it will make and what it costs, and don't say where the card is.")
    outcome = image_tools.execute(engine.config, plan, place)
    if outcome.result is None:
        return outcome.text
    _keep(engine, chat, outcome.result, at, files, on_file)
    return outcome.text + " Don't paste a link or the path."


def run_card(engine, chat: dict, card: dict, arguments: dict | None, cancel=None) -> dict:
    """The user sent an image card: make it now. {status, answer | error, files}."""
    args = dict(card.get("arguments") or {})
    if isinstance(arguments, dict):
        args.update({key: value for key, value in arguments.items() if key in ("prompt", "size", "count", "seed")})
    place = surface(engine, chat, cancel)
    try:
        plan = image_tools.prepare(engine.config, args, place)
    except image_tools.Refused as exc:
        return {"status": "failed", "error": str(exc)}
    if card.get("quote") != _quote(plan):
        return {"status": "failed", "error": "Not made: the image options or price changed since this card was "
                "shown. Ask again to review a new card before spending."}
    if plan.unpriced and not (card.get("card") or {}).get("price_unknown"):
        return {"status": "failed", "error": f"Not made: DGC doesn't know what {plan.generator['name']} charges, and "
                "its card didn't say so. Ask again to see the new card."}
    if plan.over_limit and not (card.get("card") or {}).get("over_limit"):
        # The card was sent for a picture within this month's limit; something else used that room since.
        return {"status": "failed", "error": f"Not made: {plan.generator['name']} would now pass this month's limit "
                "(another picture or video on its key was made meanwhile). Ask again to see the new card."}
    plan.asks = False                                  # sending the card is the user's yes
    outcome = image_tools.execute(engine.config, plan, place)
    if outcome.result is None:
        return {"status": "failed", "error": outcome.text.removeprefix("error: ")}
    files: list = []
    _keep(engine, chat, outcome.result, int(card.get("at") or 0), files, None)
    return {"status": "done", "answer": outcome.text, "files": files}
