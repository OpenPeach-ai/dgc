"""The model's image tools, the same on every surface: ``generate_image`` and ``list_image_generators``.

A surface (Work, ChatDGC, a Pip, the SDK) hands over a ``Surface``: where files go, where the remembered choice is
kept, and how to ask the user (a question, an Allow card) when it can. ``prepare`` works out the call before anyone
is asked (which generator, what size, the price and whether it asks); the surface shows its Allow card from
``Plan.card()``; ``execute`` makes the images, and on "needs credit" (or a server that is down, a bad key) switches
by itself only to a free generator, or to another one when the user allowed automatic fallback, and otherwise offers
the others that fit. It never switches silently to a paid one.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import image_providers as P
from . import images
from .config import image_size

TOOL_NAMES = frozenset({"generate_image", "list_image_generators"})
ASPECTS = ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9")
FALLBACK_KINDS = ("needs_credit", "bad_key", "server_down", "rate_limited")
_IMAGE_EXT = re.compile(r"\.(png|jpe?g|webp)\Z", re.I)


def _fn(name, description, properties, required):
    return {"type": "function", "function": {"name": name, "description": description,
                                             "parameters": {"type": "object", "properties": properties,
                                                            "required": required}}}


GENERATE_SCHEMA = _fn(
    "generate_image",
    "Make images with one of the user's image generators (list_image_generators shows them: ComfyUI or Automatic1111 "
    "on their own computers, OpenAI, Gemini, Black Forest Labs, fal.ai, Replicate, xAI, Together). Shows each image to "
    "the user and saves it with a sidecar of its settings in DGC's own folder (~/.dgc/images), not in the project. "
    "When the picture belongs in the project (the user names a place, or the task needs the file there, such as a "
    "hero image for the landing page), give save_to: a path in the project. With `images` it edits them or uses them "
    "as references. A paid generator shows the user an Allow card with its price first. Leave `generator` out unless "
    "the user named one: DGC uses this project's choice, or asks the user once when several fit.",
    {"prompt": {"type": "string", "description": "What the image shows, in detail: subject, style, light, framing, "
                "and any words that must appear in it"},
     "size": {"type": "string", "description": "WIDTHxHEIGHT in pixels, e.g. 1024x1024; leave out for the "
              "generator's own size"},
     "aspect": {"type": "string", "enum": list(ASPECTS), "description": "Instead of size: the shape, at the "
                "generator's own size"},
     "count": {"type": "integer", "minimum": 1, "maximum": images.MAX_COUNT, "description": "How many (1-4, "
               "default 1)"},
     "images": {"type": "array", "items": {"type": "string"}, "description": "Images to edit or to use as "
                "references: project paths (or a chat's file names in ChatDGC)"},
     "mask": {"type": "string", "description": "With images: a mask image's path; white is where it changes"},
     "generator": {"type": "string", "description": "A generator's id or name, only when the user named one"},
     "model": {"type": "string", "description": "A model of that generator, only when the user asked for one"},
     "seed": {"type": "integer", "description": "A seed, to make the same image again"},
     "negative_prompt": {"type": "string", "description": "What to keep out (ComfyUI, Automatic1111 and some "
                         "others use it)"},
     "save_to": {"type": "string", "description": "Only when the picture belongs in the project: a folder or file "
                 "name in the project (e.g. assets/hero.png). Leave out to keep it in DGC's own folder"},
     "replace": {"type": "boolean", "description": "With save_to naming a file that exists: replace it. Only after the "
                 "user said to"}},
    ["prompt"])
LIST_SCHEMA = _fn(
    "list_image_generators",
    "The user's image generators: what each can do (edit, mask, text in the image, largest size), whether it is free "
    "or what an image costs, whether it works right now (key valid, credit left, server up), and which one this "
    "project uses. Read it before choosing one, or when the user asks what they can make images with.",
    {"refresh": {"type": "boolean", "description": "Test each generator now (a few seconds, no image made). Default "
                 "false: what DGC last saw"}},
    [])
SCHEMAS = [GENERATE_SCHEMA, LIST_SCHEMA]


class Refused(ValueError):
    """A call that can't run as written: said to the model before anyone is asked."""


@dataclass
class Surface:
    """Where a call happens. ``ask(title, options, recommended)`` -> the chosen index or None; ``approve(card)`` ->
    "once" | "always" | "no"; ``progress(text, value, total)``; ``inputs(name)`` -> (bytes, mime, name) for an
    input image. ``root`` is where files go and relative paths resolve; ``project_root`` keeps the remembered
    choice (None: the chat keeps it, through ``remember``)."""
    name: str
    root: Path
    project_root: Path | None = None
    chat_choice: str = ""
    interactive: bool = False
    ask: object = None
    approve: object = None
    progress: object = None
    remember: object = None
    inputs: object = None
    unattended: bool = False
    where: dict = field(default_factory=dict)
    save_dir: str = ""            # a chat's own folder ("" = the project's images.save_dir)
    owner: str = ""
    # DGC's own folder for this surface's pictures (~/.dgc/images/sessions/<session>): where they go unless save_to
    # (or the Images setting's save folder) puts them in the project, as Codex keeps its pictures in its home.
    home: Path | None = None
    # DGC's own folder for this surface's videos (~/.dgc/videos/sessions/<session>, chats/<chat>, pips/<pip>).
    video_home: Path | None = None


@dataclass
class Plan:
    generator: dict
    request: P.Request
    folder: Path
    name: str = ""
    why: str = ""
    each: float | None = None
    asks: bool = False
    over_limit: bool = False
    # Its price is unknown and its generator has a monthly limit: DGC can't hold it to the limit, so it is never made
    # without a yes to a card that says so (not by Always allow, not by asking turned off).
    unpriced: bool = False
    approved: bool = False         # chosen by the user in DGC's own question (its price was on it)
    named: bool = False
    notes: list = field(default_factory=list)
    spent: float | None = None     # this month's spend on its key (pictures and videos), when the plan was made
    into_project: bool = False     # save_to (or the Images save folder) puts it in the project: write_file's checks apply
    replace: bool = False          # save_to names a file that exists, and the user said to replace it
    root: Path | None = None       # the project, for the card's "Saves to"
    file: str = ""                 # the file name save_to named (its extension as given)

    def target(self) -> Path:
        """Where the first picture is written (a folder's file name is only known once it is made)."""
        return self.folder / (self.file or self.name) if (self.file or self.name) else self.folder

    @property
    def total(self) -> float | None:
        return None if self.each is None else round(self.each * self.request.count, 4)

    def card(self) -> dict:
        """What the Allow card shows: provider, model, size, count and price."""
        generator = self.generator
        spent = images.spent(generator["id"]) if self.spent is None else self.spent
        cap = generator.get("monthly_limit_usd")
        card = {"generator": generator["name"], "provider": images.PROVIDER_LABELS.get(generator["provider"], ""),
                "model": self.request.model or generator.get("model") or images.DEFAULT_MODELS.get(
                    generator["provider"], ""), "size": f"{self.request.width}x{self.request.height}",
                "count": self.request.count,
                "price": ("free" if self.each == 0 else "price unknown" if self.each is None else
                          f"{images.money(self.total)}" + (f" ({images.money(self.each)} each)"
                                                           if self.request.count > 1 else "")),
                "prompt": self.request.prompt[:300]}
        if cap is not None:
            card["this_month"] = f"{images.dollars(spent)} of your {images.dollars(cap)} limit"
        elif spent:
            card["this_month"] = f"{images.dollars(spent)} so far"
        notes = []
        if self.over_limit:
            card["over_limit"] = True
            notes.append("This would pass this month's limit for this generator, so DGC asks.")
        if self.unpriced:
            card["price_unknown"] = True
            notes.append(f"DGC doesn't know what {card['model'] or generator['name']} charges, so it can't keep this "
                         f"within your {images.dollars(cap)} monthly limit: it may cost more. Make it only if that's "
                         "all right.")
        if notes:
            card["note"] = " ".join(notes)
        if self.into_project:
            card["saves_to"] = _shown_place(self.target(), self.root) + ("" if self.file or self.name else "/")
            if self.replace:
                card["replaces"] = True
        return card

    def summary(self) -> str:
        card = self.card()
        return (f"{card['count']} image{'s' if card['count'] != 1 else ''} with {card['generator']} "
                f"({card['provider']}{', ' + card['model'] if card['model'] else ''}), {card['size']}, {card['price']}")


def _resolve(root: Path, raw: str) -> Path:
    path = Path(str(raw).strip()).expanduser()
    path = (root / path) if not path.is_absolute() else path
    resolved = path.resolve(strict=False)
    base = Path(root).resolve(strict=False)
    if resolved != base and base not in resolved.parents:
        raise Refused(f"{raw} is outside this folder ({base}); use a path inside it")
    return resolved


def _shown_place(path: Path, root: Path | None) -> str:
    """A path as a person reads it: inside the project, from its root; under the home folder, from ~."""
    for base, prefix in ((root, ""), (Path.home(), "~/")):
        if base is None:
            continue
        try:
            return prefix + Path(path).resolve(strict=False).relative_to(Path(base).resolve(strict=False)).as_posix()
        except ValueError:
            continue
    return str(path)


def _own_picture(raw: str) -> Path | None:
    """A picture in DGC's own images folder (one DGC made), by its path: an input the model may edit from there."""
    try:
        path = Path(str(raw).strip()).expanduser().resolve(strict=False)
        path.relative_to(images.directory().resolve(strict=False))
    except (ValueError, OSError):
        return None
    return path if _IMAGE_EXT.search(path.name) else None


def _input_image(surface: Surface, raw) -> P.InputImage:
    text = str(raw or "").strip()
    if not text:
        raise Refused("an input image's path is empty")
    if callable(surface.inputs):
        found = surface.inputs(text)
        if found is not None:
            data, mime, name = found
            return P.InputImage(data, mime, name)
    path = _own_picture(text) or _resolve(surface.root, text)
    try:
        data = path.read_bytes() if path.stat().st_size <= images.MAX_INPUT_BYTES else b""
    except OSError:
        raise Refused(f"there is no image at {text}") from None
    if not data:
        raise Refused(f"{text} is larger than 20 MB")
    mime = P.sniff(data)
    if mime not in ("image/png", "image/jpeg", "image/webp"):
        raise Refused(f"{text} isn't a PNG, JPEG or WebP image")
    return P.InputImage(data, mime, path.name)


def _size(args: dict, generator: dict) -> tuple[int, int]:
    caps = images.capabilities(generator)
    biggest = int(caps.get("max_side") or 2048)
    if args.get("size"):
        found = image_size(args["size"])
        if found is None:
            raise Refused("size must be WIDTHxHEIGHT, e.g. 1024x1024")
        width, height = found
    else:
        width, height = image_size(generator["size"]) or (1024, 1024)
        aspect = str(args.get("aspect") or "")
        if aspect:
            if aspect not in ASPECTS:
                raise Refused(f"aspect must be one of {', '.join(ASPECTS)}")
            a, b = (int(x) for x in aspect.split(":"))
            area = width * height
            width = int(round((area * a / b) ** 0.5 / 64)) * 64
            height = int(round((area * b / a) ** 0.5 / 64)) * 64
    if max(width, height) > biggest:
        scale = biggest / max(width, height)
        width, height = int(width * scale) // 16 * 16, int(height * scale) // 16 * 16
    return max(64, width), max(64, height)


def _folder(config, args: dict, surface: Surface) -> tuple[Path, str, bool, str]:
    """(folder, file stem or "", whether that's in the project, the file name save_to named or ""). save_to, then a
    chat's or Pip's own folder, then the Images setting's save folder; else DGC's own folder for this surface."""
    raw = str(args.get("save_to") or "").strip()
    if raw:
        target = _resolve(surface.root, raw)
        inside = target.relative_to(Path(surface.root).resolve(strict=False)).parts \
            if target != Path(surface.root).resolve(strict=False) else ()
        if any(part.lower() in (".git", ".dgc") for part in inside):
            raise Refused(f"{raw} is inside .git or .dgc; choose a folder of the project itself")
        if _IMAGE_EXT.search(target.name):
            if target.is_dir():
                raise Refused(f"{raw} is a folder; name a file in it, or the folder alone")
            if (target.exists() or target.with_suffix(".json").exists()) and args.get("replace") is not True:
                raise Refused(f"{raw} already exists, and DGC doesn't replace a file without asking. Ask the user; if "
                              "they say to replace it, call again with replace: true, else choose another name")
            return (target.parent, target.stem, surface.home is not None or surface.project_root is not None,
                    target.name)
        return target, "", surface.home is not None or surface.project_root is not None, ""
    if surface.save_dir:
        return _resolve(surface.root, surface.save_dir), "", False, ""
    chosen = images.settings(config).get("save_dir") or ""
    if chosen:
        return _resolve(surface.root, chosen), "", True, ""
    if surface.home is not None:
        return Path(surface.home), "", False, ""
    return _resolve(surface.root, config_old_default()), "", True, ""


def config_old_default() -> str:
    """A surface with no folder of DGC's own (an older caller): the project's assets/generated, as before."""
    from .config import IMAGES_OLD_DEFAULT_DIR
    return IMAGES_OLD_DEFAULT_DIR


def _args(args) -> dict:
    if not isinstance(args, dict):
        raise Refused("generate_image takes an object of arguments")
    prompt = " ".join(str(args.get("prompt") or "").split()) if not isinstance(args.get("prompt"), str) else \
        args["prompt"].strip()
    if not prompt:
        raise Refused("say what the image shows in prompt")
    if len(prompt) > images.MAX_PROMPT:
        raise Refused(f"the prompt is longer than {images.MAX_PROMPT:,} characters")
    if "replace" in args and not isinstance(args["replace"], bool):
        raise Refused("replace is true or false")
    count = args.get("count", 1)
    if isinstance(count, bool) or not isinstance(count, (int, float)) or not 1 <= int(count) <= images.MAX_COUNT:
        raise Refused(f"count is 1 to {images.MAX_COUNT}")
    seed = args.get("seed")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, (int, float))):
        raise Refused("seed is a whole number")
    paths = args.get("images") or []
    if isinstance(paths, str):
        paths = [paths]
    if not isinstance(paths, list) or len(paths) > images.MAX_INPUT_IMAGES:
        raise Refused(f"images is a list of up to {images.MAX_INPUT_IMAGES} paths")
    if args.get("mask") and not paths:
        raise Refused("a mask goes with the image it masks (images)")
    return {**args, "prompt": prompt, "count": int(count), "seed": None if seed is None else int(seed) % (2**31),
            "images": paths}


def prepare(config, args, surface: Surface) -> Plan:
    """The call worked out: which generator (asking the user once when several fit and nothing is chosen), the size,
    the price and whether it asks. Raises Refused with what to say to the model."""
    args = _args(args)
    block = images.settings(config)
    edit, mask = bool(args["images"]), bool(args.get("mask"))
    wanted = str(args.get("generator") or "").strip()
    choice = images.choose(config, block, named=wanted, chat_choice=surface.chat_choice,
                           project_root=surface.project_root, edit=edit, mask=mask, count=args["count"],
                           interactive=surface.interactive and callable(surface.ask))
    approved = False
    if choice.ask:
        options = choice.ask
        default = images.find(block, block.get("default") or "")
        recommended = options.index(default) if default in options else 0
        picked = surface.ask("Which image generator should " + ("this chat" if surface.project_root is None else
                                                                "this project") + " use?",
                             [(images.option_label(g), images.option_description(g)) for g in options], recommended)
        if picked is None or not 0 <= picked < len(options):
            raise Refused("The user didn't choose a generator, so no image was made. Ask what they'd like, or "
                          "carry on without the image.")
        generator = options[picked]
        _remember(surface, generator["id"])
        approved = True
        why = "asked"
    elif choice.generator is None:
        raise Refused(choice.problem + (". The user adds one in Settings → Models → Images & video or with /images add."
                                        if "no image generator" in choice.problem else ""))
    else:
        generator, why = choice.generator, choice.why
        if why == "named" and surface.project_root is not None and not images.project_choice(surface.project_root):
            _remember(surface, generator["id"])
        elif why == "named" and surface.project_root is None and not surface.chat_choice:
            _remember(surface, generator["id"])
    return _plan(config, generator, args, surface, why=why, approved=approved)


def _remember(surface: Surface, generator_id: str) -> None:
    try:
        if callable(surface.remember):
            surface.remember(generator_id)
        elif surface.project_root is not None:
            images.remember_project_choice(surface.project_root, generator_id)
    except OSError:
        pass


def _plan(config, generator: dict, args: dict, surface: Surface, *, why: str, approved: bool) -> Plan:
    width, height = _size(args, generator)
    inputs = [_input_image(surface, raw) for raw in args["images"]]
    mask = _input_image(surface, args["mask"]) if args.get("mask") else None
    request = P.Request(prompt=args["prompt"], width=width, height=height, count=args["count"],
                        model=str(args.get("model") or "").strip(), seed=args.get("seed"),
                        negative=str(args.get("negative_prompt") or "").strip()[:2000], images=inputs, mask=mask)
    folder, name, into_project, file = _folder(config, args, surface)
    each = images.price_for(generator if not request.model else {**generator, "model": request.model}, width, height)
    plan = Plan(generator, request, folder, name=name, why=why, each=each, approved=approved, named=why == "named",
                into_project=into_project, replace=bool(name and args.get("replace") is True), root=surface.root,
                file=file)
    cap = generator.get("monthly_limit_usd")
    plan.spent = images.key_spent(config, generator)        # the limit counts everything made on this key
    # ... and what is on its way: pictures being made now and videos still running, in any DGC.
    if cap is not None and (images.committed(config, generator) + (plan.total or 0)) > cap + 1e-9:
        plan.over_limit = True
    plan.unpriced = cap is not None and plan.each is None
    # A generator chosen in DGC's own question (its price was on it) doesn't ask again; passing the month's limit,
    # or a price DGC can't hold to it, always does, with the card saying so.
    plan.asks = bool((generator.get("asks") and not approved) or plan.over_limit or plan.unpriced)
    return plan


@dataclass
class Outcome:
    text: str
    result: images.Result | None = None
    error: P.ImageError | None = None
    used: dict | None = None
    notes: list = field(default_factory=list)


# The sentences of a result written for the model alone: the person sees the pictures, so their tool row doesn't
# repeat them (shown_text).
_SIDECAR = "A sidecar .json with the prompt, provider, model, seed and cost is beside each file."
# Where it went, for the model: DGC's own folder unless the call (or the Images setting) put it in the project.
_OWN_FOLDER = ("That's DGC's own folder, not the project. If the user wants it in the project, call generate_image "
               "again with save_to (a path in the project), or copy the file there.")
_FOR_MODEL = (_SIDECAR, "The user sees it in the chat.", "The user sees them in the chat.",
              "It shows under your reply, and it's in the Library.",
              "They show under your reply, and they're in the Library.", "Don't paste a link or the path.",
              _OWN_FOLDER)
_REWROTE = "The provider rewrote the prompt as: "
_ALSO_THERE = " Also there, if the user wants it: "


def _made_text(result: images.Result, surface: Surface) -> str:
    generator = result.generator
    count = len(result.saved)
    price = images.money(result.cost)
    where = [item.rel or _shown_place(item.path, surface.root) for item in result.saved]
    sizes = sorted({f"{item.width}×{item.height}" for item in result.saved if item.width})
    seeds = [str(item.seed) for item in result.saved if item.seed is not None]
    lines = [f"Made {count} image{'s' if count != 1 else ''} with {generator['name']} "
             f"({images.PROVIDER_LABELS.get(generator['provider'], '')}{', ' + result.model if result.model else ''}"
             f", {price}) in {result.took_s:g} s: " + ", ".join(where)
             + (f" ({', '.join(sizes)}" + (f"; seed {', '.join(seeds)}" if seeds else "") + ")" if sizes else "")
             + ". " + _SIDECAR]
    if surface.name == "chat":
        lines.append(_FOR_MODEL[3] if count == 1 else _FOR_MODEL[4])
    else:
        lines.append(_FOR_MODEL[1] if count == 1 else _FOR_MODEL[2])
        if surface.home is not None and not any(item.rel for item in result.saved):
            lines.append(_OWN_FOLDER)
    if result.revised_prompt:
        lines.append(_REWROTE + result.revised_prompt[:400])
    return " ".join(lines)


_LABELS = "|".join(re.escape(label) for label in sorted(set(images.PROVIDER_LABELS.values()), key=len, reverse=True))
_MADE = re.compile(r"Made (?P<count>\d+) images? with (?P<name>.+?) \((?:" + _LABELS + r")?(?:, (?P<model>[^\n]*?))?"
                   r", (?P<price>free|price unknown|about \$[0-9.]+)\) in [0-9.]+ s: (?P<where>[^\n]*?)"
                   r"(?: \((?P<sizes>\d+×\d+(?:, \d+×\d+)*)(?:; seed [^)\n]*)?\))?\. " + re.escape(_SIDECAR))
_NOT_MADE = re.compile(r"^(error: .*?[Nn]o image was made(?:, and no other generator fits)?\.)", re.S)
# A fallback's note (_next): "<generator> needs credit: <what the provider said>. So DGC used <other> instead (free)."
_FELL_BACK = re.compile(r"^(?P<who>.+?) (?P<words>" + "|".join(re.escape(P.KIND_WORDS[k]) for k in FALLBACK_KINDS)
                        + r"): .*?\. (?P<then>(?:So DGC used|Automatic fallback is on, so DGC used|The user chose) "
                          r".+? instead(?: \(free\))?\.)$", re.S)


def shown_text(out: str) -> str:
    """generate_image's result as the person reads it in their tool row: "Made 1 image with ComfyUI · 768×320 ·
    free" and where it was saved, instead of the sentences written for the model (the sidecar, "the user sees it",
    which other generators the model may offer). What the model reads is unchanged. A pure function of the saved
    result, so a reopened chat reads the same as the live one; anything it doesn't recognise is left as it is."""
    text = str(out or "")
    failed = _NOT_MADE.match(text)
    if failed:
        return failed.group(1)
    made = _MADE.search(text)
    if not made:
        return text
    count = int(made.group("count"))
    head = " · ".join(part for part in (f"Made {count} image{'s' if count != 1 else ''} with {made.group('name')}",
                                        made.group("sizes") or "", made.group("price")) if part)
    lines = []
    before = text[:made.start()].strip()
    if before:                                  # what happened first (a fallback), without the model's options
        note = before.split(_ALSO_THERE, 1)[0].strip()
        fell = _FELL_BACK.match(note)           # what the provider said in full is on Settings' state line
        lines.append(f"{fell.group('who')}: {fell.group('words')}. {fell.group('then')}" if fell else note)
    lines += [head, made.group("where")]
    after = text[made.end():]
    for sentence in _FOR_MODEL:
        after = after.replace(sentence, "")
    if _REWROTE in after:
        lines.append(_REWROTE + after.split(_REWROTE, 1)[1].strip())
    return "\n".join(line for line in lines if line)


def _alternatives(config, plan: Plan, failed: set) -> list[dict]:
    block = images.settings(config)
    return images.fitting(block, edit=bool(plan.request.images), mask=plan.request.mask is not None,
                          count=plan.request.count, exclude=failed)


def execute(config, plan: Plan, surface: Surface) -> Outcome:
    """Make the images. On needs credit (or a bad key, a server that is down, a rate limit): switch by itself only to
    a free generator, or to the next one when the user allowed automatic fallback (a paid one still asks); else offer
    the others that fit, and say so to the model."""
    failed: set = set()
    notes: list[str] = []
    current = plan
    while True:
        try:
            # The final check is in generate, just before it is sent: a plan the user said yes to passing the
            # limit (its card said so) may pass it; any other finds the room still there, or isn't sent.
            result = images.generate(config, current.generator, _fresh(current.request), folder=current.folder,
                                     root=surface.root, surface=surface.name, where=surface.where,
                                     progress=_progress(surface, current.generator), owner=surface.owner,
                                     name=current.name, replace=current.replace,
                                     may_pass=current.over_limit or current.unpriced)
            text = _made_text(result, surface)
            if notes:
                text = " ".join(notes) + " " + text
            return Outcome(text, result=result, used=current.generator, notes=notes)
        except P.ImageError as error:
            if error.kind == "cancelled":
                return Outcome("Stopped: no image was made.", error=error, notes=notes)
            failed.add(current.generator["id"])
            said = f"{current.generator['name']} {error.words()}: {error.message}".rstrip(". ")
            if error.kind not in FALLBACK_KINDS:
                return Outcome(f"error: {said}. No image was made." + _advice(error) + _SOME_OTHER_WAY, error=error, notes=notes)
            others = _alternatives(config, current, failed)
            nxt = _next(config, current, others, surface, said, notes, kind=error.kind)
            if isinstance(nxt, Plan):
                current = nxt
                continue
            return Outcome(nxt, error=error, notes=notes)


def _fresh(request: P.Request) -> P.Request:
    return P.Request(prompt=request.prompt, width=request.width, height=request.height, count=request.count,
                     model=request.model, seed=request.seed, negative=request.negative, images=list(request.images),
                     mask=request.mask, steps=request.steps)


def _advice(error: P.ImageError) -> str:
    if error.kind == "refused":
        return " The provider's policy refused it: tell the user, and offer to change the prompt."
    if error.kind == "bad_request":
        return " Tell the user what the generator said."
    if error.kind == "over_limit":
        return (" Tell the user: they can raise the limit in Settings → Models → Images & video, or ask again to see "
                "the card with this month's spend.")
    return ""


_SOME_OTHER_WAY = (" Don't make the picture some other way (another tool, a script or a drawing) unless the user "
                   "asks for that.")


def _fix_for(kind: str, generator: dict) -> str:
    """What the user has to do, said to the model in the line that ends a call no generator could answer."""
    if kind == "bad_key":
        return (f": its key wasn't accepted, so they should paste the whole key again in Settings → Models → "
                f"Images → {generator.get('name') or generator.get('id')} → Edit (or `dgc images edit "
                f"{generator.get('id')} --key`)")
    if kind == "needs_credit":
        return ": it needs credit (billing on the provider's site)"
    return " what the generator said"


def _next(config, plan: Plan, others: list, surface: Surface, said: str, notes: list, kind: str = ""):
    """The plan to try next, or the text that ends the call."""
    free = [g for g in others if not images.is_paid(g)]
    block = images.settings(config)
    if free:
        generator = free[0]
        paid = [g for g in others if images.is_paid(g)]
        notes.append(f"{said}. So DGC used {generator['name']} instead (free)."
                     + (" Also there, if the user wants it: " + "; ".join(
                         f"{g['id']} ({g['name']}, {images.option_description(g)})" for g in paid[:3]) + "."
                        if paid else ""))
        return _swap(config, plan, generator, surface, approved=True)
    if others and block.get("auto_fallback"):
        generator = others[0]
        candidate = _swap(config, plan, generator, surface, approved=False)
        if candidate.asks:
            verdict = surface.approve(candidate.card()) if callable(surface.approve) else "no"
            if verdict not in ("once", "always"):
                return (f"{said}. DGC's automatic fallback would use {generator['name']} "
                        f"({images.money(candidate.total)}), and the user didn't allow it. No image was made.")
            if verdict == "always":
                allow_always(config, generator["id"])
        notes.append(f"{said}. Automatic fallback is on, so DGC used {generator['name']} instead.")
        return candidate
    if others and surface.interactive and callable(surface.ask):
        options = others[:3]
        # "Don't make it" is always there: one other generator is still a choice the user makes (and a question
        # needs two options).
        picked = surface.ask(f"{said.split(':')[0]}. Use another generator?",
                             [(images.option_label(g), images.option_description(g)) for g in options]
                             + [("Don't make it", "No image this time")], None)   # no paid one is recommended
        if picked is None or not 0 <= picked < len(options):
            return f"error: {said}. The user chose no other generator, so no image was made." + _SOME_OTHER_WAY
        generator = options[picked]
        _remember(surface, generator["id"])
        notes.append(f"{said}. The user chose {generator['name']} instead.")
        return _swap(config, plan, generator, surface, approved=True)
    if others:
        listed = "; ".join(f"{g['id']} ({g['name']}, {images.option_description(g)})" for g in others[:4])
        return (f"error: {said}. No image was made. Other generators that fit: {listed}. Ask the user which to use "
                f"(propose_options, if you have it), then call generate_image with that generator; never switch to "
                f"a paid one without their answer.")
    # Seen in testing (2026-11-02): with "Tell the user." here, a model in auto mode went on to write and run a 246-line
    # drawing script in a company repository. The tools stay the model's to choose; the line says plainly what's next.
    return (f"error: {said}. No image was made, and no other generator fits. Stop here and tell the user"
            + _fix_for(kind or ("needs_credit" if "needs credit" in said else ""), plan.generator) + "."
            + _SOME_OTHER_WAY)


def _swap(config, plan: Plan, generator: dict, surface: Surface, *, approved: bool) -> Plan:
    args = {"prompt": plan.request.prompt, "count": plan.request.count, "seed": plan.request.seed,
            "size": f"{plan.request.width}x{plan.request.height}", "images": [], "negative_prompt": plan.request.negative}
    swapped = _plan(config, generator, args, surface, why="fallback", approved=approved)
    swapped.request.images, swapped.request.mask = list(plan.request.images), plan.request.mask
    swapped.folder, swapped.name = plan.folder, plan.name
    swapped.into_project, swapped.replace = plan.into_project, plan.replace
    swapped.root, swapped.file = plan.root, plan.file
    return swapped


def _progress(surface: Surface, generator: dict):
    if not callable(surface.progress):
        return None

    def report(value: int, total: int) -> None:
        surface.progress(f"{generator['name']}: step {value} of {total}" if total else f"{generator['name']}: working",
                         value, total)
    return report


def allow_always(config, generator_id: str) -> None:
    """The user's Always allow on a paid generator's card: it stops asking (its monthly limit, if any, still holds)."""
    block = images.settings(config)
    for generator in block["generators"]:
        if generator["id"] == generator_id:
            generator["asks"] = False
    try:
        config.set_images(block)
    except (ValueError, OSError):
        pass


def list_text(config, args, surface: Surface) -> str:
    refresh = bool((args or {}).get("refresh")) if isinstance(args, dict) else False
    value = images.listing(config, project_root=surface.project_root, chat_choice=surface.chat_choice,
                           refresh=refresh)
    return images.listing_text(value)
