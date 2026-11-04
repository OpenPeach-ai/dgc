"""The model's video tools, the same on every surface: ``generate_video`` and ``list_video_generators``.

They follow dgc/image_tools.py and use its ``Surface`` (where files go, who can be asked) and its rules for a start
image and for ``save_to``. What differs is the money and the time:

- ``prepare`` works out the call before anyone is asked: which generator (one that makes videos), the length,
  resolution and shape it offers nearest to what was asked, the price, this month's spend on the generator's key
  against its limit, and whether it asks. Every video asks unless the user turned that off for the generator in
  Settings; one that would pass the monthly limit says so on its card and is never sent.
- ``start`` submits the job and comes back at once: the video is made in the background (dgc/videos.py) and the
  surface hears when it is ready. There is never an automatic fallback to another generator.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import image_providers as P
from . import image_tools
from . import images, videos
from . import video_providers as V

TOOL_NAMES = frozenset({"generate_video", "list_video_generators"})
ASPECTS = ("16:9", "9:16", "1:1")
RESOLUTIONS = ("480p", "720p", "1080p")
_VIDEO_EXT = re.compile(r"\.(mp4|webm|mov)\Z", re.I)
Refused = image_tools.Refused


def _fn(name, description, properties, required):
    return {"type": "function", "function": {"name": name, "description": description,
                                             "parameters": {"type": "object", "properties": properties,
                                                            "required": required}}}


GENERATE_SCHEMA = _fn(
    "generate_video",
    "Make a short video clip with one of the user's video generators (list_video_generators shows them: fal.ai, "
    "Gemini, Replicate, or ComfyUI on their own computer). It is EXPENSIVE and SLOW: a clip costs about $0.10-$2 and "
    "takes one to several minutes, so make ONE at a time unless the user asked for more. Every video shows the user "
    "an Allow card with its length, resolution and price before anything is sent. The call starts the job and comes "
    "back at once; the video is made in the background, you are told when it's ready, and it shows under your reply "
    "with a player. Don't wait, poll or call it again for the same clip. It is saved in DGC's own folder "
    "(~/.dgc/videos); give save_to only when the clip belongs in the project. To animate a picture (one DGC made, or "
    "one in the project), give its path as `image`. Leave `generator` out unless the user named one.",
    {"prompt": {"type": "string", "description": "What happens in the clip, in detail: subject, motion, camera, light, "
                "style, and any sound or speech"},
     "duration_s": {"type": "integer", "minimum": 1, "maximum": 20, "description": "Length in seconds; leave out for "
                    "the model's default (usually 5)"},
     "aspect": {"type": "string", "enum": list(ASPECTS), "description": "Shape: 16:9 (wide), 9:16 (tall) or 1:1"},
     "resolution": {"type": "string", "enum": list(RESOLUTIONS), "description": "720p (the default) or 1080p, as the "
                    "model offers"},
     "image": {"type": "string", "description": "A start image to animate: a picture DGC made (its path) or a project "
               "path"},
     "audio": {"type": "boolean", "description": "Sound with the picture, where the model can make it"},
     "generator": {"type": "string", "description": "A generator's id or name, only when the user named one"},
     "model": {"type": "string", "description": "A model of that generator, only when the user asked for one"},
     "seed": {"type": "integer", "description": "A seed, to make the same clip again where the model takes one"},
     "negative_prompt": {"type": "string", "description": "What to keep out, where the model takes it"},
     "save_to": {"type": "string", "description": "Only when the clip belongs in the project: a folder or file name "
                 "in the project (e.g. assets/intro.mp4). Leave out to keep it in DGC's own folder"},
     "replace": {"type": "boolean", "description": "With save_to naming a file that exists: replace it. Only after "
                 "the user said to"}},
    ["prompt"])
LIST_SCHEMA = _fn(
    "list_video_generators",
    "The user's video generators: what each makes (lengths, resolutions, shapes, sound, a start image), its price per "
    "second, how long a clip takes, whether it works now, this month's spend, and the video jobs running or just "
    "finished. Read it before choosing one, or when the user asks what they can make videos with.",
    {"refresh": {"type": "boolean", "description": "Test each generator now (a few seconds, no video made)"}},
    [])
SCHEMAS = [GENERATE_SCHEMA, LIST_SCHEMA]


@dataclass
class Plan:
    generator: dict
    request: V.VideoRequest
    folder: Path
    name: str = ""
    why: str = ""
    estimate: float | None = None
    asks: bool = True
    over_limit: bool = False
    # Its price is unknown and the generator has a monthly limit: DGC can't hold it to the limit, so it is made only
    # after a yes to a card that says so (never because asking is off, never on a routine's say-so).
    unpriced: bool = False
    spent: float = 0.0
    notes: list = field(default_factory=list)
    into_project: bool = False
    replace: bool = False
    root: Path | None = None
    file: str = ""
    image_name: str = ""

    @property
    def label(self) -> str:
        return videos.label(self.generator, self.request.model)

    def facts(self) -> str:
        """"5 s · 720p · about $0.15"."""
        length = f"{self.request.duration_s} s" if self.request.duration_s else "about 8 s (the model chooses)"
        return " · ".join([length, self.request.resolution, images.money(self.estimate)])

    def card(self) -> dict:
        generator = self.generator
        cap = generator.get("monthly_limit_usd")
        card = {"generator": generator["name"], "label": self.label,
                "provider": images.PROVIDER_LABELS.get(generator["provider"], ""),
                "model": videos.model_of(generator, self.request.model),
                "length": f"{self.request.duration_s} s" if self.request.duration_s else "the model's length",
                "duration_s": self.request.duration_s, "resolution": self.request.resolution,
                "aspect": self.request.aspect, "audio": bool(self.request.audio), "price": images.money(self.estimate),
                "facts": self.facts(), "minutes": videos.minutes_words(generator, self.request.model),
                "prompt": self.request.prompt[:300], "video": True}
        if cap is not None:
            card["this_month"] = f"{images.dollars(self.spent)} of your {images.dollars(cap)} limit"
        elif self.spent:
            card["this_month"] = f"{images.dollars(self.spent)} so far"
        if self.image_name:
            card["start_image"] = self.image_name
        if self.over_limit:
            card["over_limit"] = True
            card["note"] = (f"This would pass this month's {images.dollars(cap)} limit on this key, so it can't be "
                            "made. Raise the limit in Settings → Models → Images & video to make it.")
        elif self.unpriced:
            card["price_unknown"] = True
            card["note"] = " ".join([f"DGC doesn't know what {self.label} charges, so it can't keep this within your "
                                     f"{images.dollars(cap)} monthly limit: it may cost more. Make it only if that's "
                                     "all right.", *self.notes])
        elif self.notes:
            card["note"] = " ".join(self.notes)
        if self.into_project:
            card["saves_to"] = image_tools._shown_place(self.target(), self.root) + (
                "" if self.file or self.name else "/")
            if self.replace:
                card["replaces"] = True
        return card

    def target(self) -> Path:
        return self.folder / (self.file or self.name) if (self.file or self.name) else self.folder

    def summary(self) -> str:
        return f"a video with {self.label}: {self.facts()}"


def _args(args) -> dict:
    if not isinstance(args, dict):
        raise Refused("generate_video takes an object of arguments")
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        raise Refused("say what happens in the clip in prompt")
    if len(prompt) > videos.MAX_PROMPT:
        raise Refused(f"the prompt is longer than {videos.MAX_PROMPT:,} characters")
    duration = args.get("duration_s")
    if duration is not None and (isinstance(duration, bool) or not isinstance(duration, (int, float))
                                 or not 1 <= int(duration) <= 60):
        raise Refused("duration_s is a length in seconds, 1-60")
    for key, allowed in (("aspect", ASPECTS), ("resolution", RESOLUTIONS + ("580p", "768p", "4k"))):
        if args.get(key) not in (None, "") and args[key] not in allowed:
            raise Refused(f"{key} is one of {', '.join(allowed[:3])}")
    seed = args.get("seed")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, (int, float))):
        raise Refused("seed is a whole number")
    if args.get("audio") is not None and not isinstance(args.get("audio"), bool):
        raise Refused("audio is true or false")
    if "replace" in args and not isinstance(args["replace"], bool):
        raise Refused("replace is true or false")
    return {**args, "prompt": prompt, "duration_s": None if duration is None else int(duration),
            "seed": None if seed is None else int(seed) % (2**31)}


# ---- which generator --------------------------------------------------------------------------------------------------
def remembered(surface: image_tools.Surface) -> str:
    if surface.project_root is None:
        return ""
    import json
    try:
        value = json.loads((Path(surface.project_root) / ".dgc" / "images.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str(value.get("video_generator") or "") if isinstance(value, dict) else ""


def remember(surface: image_tools.Surface, generator_id: str) -> None:
    if surface.project_root is None:
        return
    import json
    folder = Path(surface.project_root) / ".dgc"
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "images.json"
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            value = value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            value = {}
        value["video_generator"] = generator_id
        path.write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8")
    except OSError:
        pass


def _usable(generator: dict) -> bool:
    return generator.get("enabled", True)


def choose(config, block: dict, args: dict, surface: image_tools.Surface) -> tuple[dict, str]:
    rows = [g for g in videos.generators(block)]
    if not rows:
        raise Refused("no video generator is set up yet. The user adds one in Settings → Models → Images & video "
                      "(+ Add generator: a video model of fal.ai, Gemini or Replicate, or a ComfyUI video workflow), "
                      "or with `dgc videos add`. Runway and Higgsfield make videos through their plugins, if added.")
    wanted = str(args.get("generator") or "").strip()
    if wanted:
        exact = next((g for g in block.get("generators") or [] if g["id"] == wanted.lower()
                      or g["name"].lower() == " ".join(wanted.split()).lower()), None)
        found = exact if exact is not None and images.makes_videos(exact) else \
            None if exact is not None else images.find({"generators": rows}, wanted)
        if found is None:
            other = images.find(block, wanted)
            if other is not None:
                raise Refused(f"{other['name']} makes pictures, not videos. Video generators: "
                              + ", ".join(f"{g['id']} ({g['name']})" for g in rows))
            raise Refused(f"there is no video generator {wanted!r}; there are: "
                          + ", ".join(f"{g['id']} ({g['name']})" for g in rows))
        if not _usable(found):
            raise Refused(f"{found['name']} is turned off")
        if surface.project_root is not None and not remembered(surface):
            remember(surface, found["id"])
        return found, "named"
    usable = [g for g in rows if _usable(g)]
    if not usable:
        raise Refused("every video generator is turned off")
    chosen = surface.chat_choice if surface.project_root is None else remembered(surface)
    found = images.find({"generators": usable}, chosen) if chosen else None
    if found is not None:
        return found, "remembered"
    if len(usable) == 1:
        return usable[0], "only"
    ranked = sorted(usable, key=lambda g: (0 if g["provider"] == "comfyui" else 1,
                                           videos.describe_video(g).get("price_usd_default") or 99,
                                           0 if g["id"] == block.get("default") else 1))
    if surface.interactive and callable(surface.ask):
        options = ranked[:4]
        picked = surface.ask("Which video generator should " + ("this chat" if surface.project_root is None else
                                                                "this project") + " use?",
                             [(g["name"], _option(g)) for g in options], 0)
        if picked is None or not 0 <= picked < len(options):
            raise Refused("The user didn't choose a video generator, so no video was made. Ask what they'd like.")
        generator = options[picked]
        remember(surface, generator["id"])
        return generator, "asked"
    return ranked[0], "first"


def _option(generator: dict) -> str:
    about = videos.describe_video(generator)
    return " · ".join(bit for bit in (about["price_per_s"], about["minutes"], about.get("label", "")) if bit)[:200]


def _nearest(value, allowed, default):
    if not allowed:
        return value if value is not None else default
    if value is None:
        return default if default in allowed else allowed[0]
    if value in allowed:
        return value
    if isinstance(value, int):
        return min(allowed, key=lambda option: abs(option - value))
    order = ("480p", "580p", "720p", "768p", "1080p", "4k")
    rank = {name: index for index, name in enumerate(order)}
    return min(allowed, key=lambda option: abs(rank.get(option, 2) - rank.get(value, 2)))


def _folder(args: dict, surface: image_tools.Surface) -> tuple[Path, str, bool, str]:
    """(folder, file stem or "", whether that's in the project, the file name save_to named). save_to puts it in the
    project; otherwise DGC's own folder for this surface."""
    raw = str(args.get("save_to") or "").strip()
    if raw:
        if surface.project_root is None:
            raise Refused("this chat has no project to save into; the clip stays in DGC's own folder")
        target = image_tools._resolve(surface.root, raw)
        inside = target.relative_to(Path(surface.root).resolve(strict=False)).parts \
            if target != Path(surface.root).resolve(strict=False) else ()
        if any(part.lower() in (".git", ".dgc") for part in inside):
            raise Refused(f"{raw} is inside .git or .dgc; choose a folder of the project itself")
        if _VIDEO_EXT.search(target.name):
            if target.is_dir():
                raise Refused(f"{raw} is a folder; name a file in it, or the folder alone")
            if (target.exists() or target.with_suffix(".json").exists()) and args.get("replace") is not True:
                raise Refused(f"{raw} already exists, and DGC doesn't replace a file without asking. Ask the user; if "
                              "they say to replace it, call again with replace: true, else choose another name")
            return target.parent, target.stem, True, target.name
        return target, "", True, ""
    if surface.video_home is not None:
        return Path(surface.video_home), "", False, ""
    return videos.session_folder(surface.name or "work"), "", False, ""


def prepare(config, args, surface: image_tools.Surface) -> Plan:
    """The call worked out before anyone is asked. Raises Refused with what to say to the model."""
    args = _args(args)
    block = images.settings(config)
    generator, why = choose(config, block, args, surface)
    model = str(args.get("model") or "").strip()
    about = videos.info(generator, model)
    base = videos.defaults(generator, model)
    notes = []
    duration = _nearest(args.get("duration_s"), tuple(about.get("durations") or ()), base["duration_s"])
    if args.get("duration_s") is not None and duration != args["duration_s"]:
        notes.append(f"{videos.label(generator, model)} makes {', '.join(f'{d} s' for d in about['durations'])} "
                     f"clips, so this one is {duration} s.")
    if generator["provider"] == "gemini" and not about.get("durations"):
        duration = None                    # Gemini Omni Flash chooses the length itself
    resolution = _nearest(args.get("resolution") or None, tuple(about.get("resolutions") or ()), base["resolution"])
    if args.get("resolution") and resolution != args["resolution"]:
        notes.append(f"It makes {', '.join(about['resolutions'])}, so this one is {resolution}.")
    aspect = args.get("aspect") or base["aspect"]
    if about.get("aspects") and aspect not in about["aspects"]:
        notes.append(f"It makes {', '.join(about['aspects'])}, so this one is {about['aspects'][0]}.")
        aspect = about["aspects"][0]
    audio = args.get("audio")
    if about.get("audio") == "no" and audio:
        notes.append("It makes no sound.")
        audio = False
    elif about.get("audio") == "always":
        audio = True
    image = None
    image_name = ""
    if args.get("image"):
        if not videos.describe_video(generator)["start_image"]:
            raise Refused(f"{generator['name']} takes no start image")
        image = image_tools._input_image(surface, args["image"])
        image_name = image.name
    request = V.VideoRequest(prompt=args["prompt"], duration_s=duration, aspect=aspect, resolution=resolution,
                             audio=audio, image=image, model=model, seed=args.get("seed"),
                             negative=str(args.get("negative_prompt") or "").strip()[:2000])
    folder, name, into_project, file = _folder(args, surface)
    estimate = videos.price(generator, duration_s=duration or base["duration_s"], resolution=resolution, audio=audio,
                            model=model)
    plan = Plan(generator, request, folder, name=name, why=why, estimate=estimate, notes=notes,
                into_project=into_project, replace=bool(name and args.get("replace") is True), root=surface.root,
                file=file, image_name=image_name)
    plan.spent = images.key_spent(config, generator)
    cap = generator.get("monthly_limit_usd")
    # Everything on this key this month, with the videos still running and the pictures being made (any DGC).
    if cap is not None and images.committed(config, generator) + (estimate or 0) > cap + 1e-9:
        plan.over_limit = True
    plan.unpriced = cap is not None and estimate is None
    plan.asks = bool(generator.get("video_asks", True) or plan.over_limit or plan.unpriced)
    return plan


# ---- starting it --------------------------------------------------------------------------------------------------------
@dataclass
class Started:
    text: str
    job: dict | None = None
    error: P.ImageError | None = None


_STOP_HERE = " Stop here and tell the user what to fix. Don't make the clip some other way unless the user asks."


def _fix(error: P.ImageError, generator: dict) -> str:
    if error.kind == "bad_key":
        return (f" Its key wasn't accepted: the user pastes the whole key again in Settings → Models → Images & video "
                f"→ {generator['name']} → Edit (or `dgc images edit {generator['id']} --key`).")
    if error.kind == "needs_credit":
        return " It needs credit or billing on the provider's site."
    if error.kind == "refused":
        return " The provider's policy refused it: offer to change the prompt."
    return ""


def start(config, plan: Plan, surface: image_tools.Surface, *, target: dict | None = None) -> Started:
    """Submit the job and come back at once. The text is what the model is told."""
    generator = plan.generator
    if plan.over_limit:
        cap = generator.get("monthly_limit_usd")
        return Started(f"error: not sent: {plan.summary()} would pass this month's {images.dollars(cap)} limit on "
                       f"{generator['name']}'s key ({images.dollars(plan.spent)} spent). No video was made." + _STOP_HERE)
    key = images.key_for(config, generator)
    if images.needs_key(generator) and not key:
        error = P.ImageError("bad_key", "no key yet", provider=generator["provider"])
        return Started(f"error: {generator['name']} has no key yet, so no video was made. The user adds it in "
                       f"Settings → Models → Images & video, or with /images key {generator['id']}. Stop here and "
                       "tell the user.", error=error)
    adapter = V.adapter_for(generator["provider"], workflow_reader=images.read_workflow)
    request = plan.request
    if not request.model:
        request.model = videos.model_of(generator)
    import time
    job = {"id": videos.new_id(), "state": "sending", "status": "sending", "generator": generator["id"],
           "generator_name": generator["name"], "provider": generator["provider"], "model": request.model,
           "label": plan.label, "prompt": request.prompt, "negative": request.negative,
           "duration_s": request.duration_s, "resolution": request.resolution, "aspect": request.aspect,
           "audio": bool(request.audio), "image": plan.image_name or None, "seed": request.seed,
           "estimate_usd": plan.estimate, "minutes": videos.minutes_words(generator, request.model),
           "surface": surface.name, "where": dict(surface.where or {}), "target": dict(target or {}),
           "folder": str(plan.folder), "name": plan.name, "replace": plan.replace,
           "root": str(surface.root) if plan.into_project else None, "into_project": plan.into_project,
           "handle": None, "started": time.time(), "finished": None, "told": False}
    # The final check, just before it is sent: under the one spend lock, the room under the limit is read and this
    # job's record (its estimate on the way) is written, so two windows or two plans can't both use the same room.
    fd = videos.JOBS.claim(job["id"])          # this DGC follows it from the start; no other takes it on meanwhile
    with images.budget():
        room = images.room_left(config, generator)
        fits = room is None or (plan.estimate or 0) <= room + 1e-9
        if fits:
            videos.save(job)
    if not fits:
        videos.JOBS.unclaim(fd)
        cap = generator.get("monthly_limit_usd")
        error = P.ImageError("over_limit", f"would pass the {images.dollars(cap)} monthly limit",
                             provider=generator["provider"])
        return Started(f"error: not sent: {plan.summary()} would pass this month's {images.dollars(cap)} limit on "
                       f"{generator['name']}'s key now: another video or picture on it started meanwhile "
                       f"({images.dollars(images.committed(config, generator))} spent or on its way). No video was "
                       "made." + _STOP_HERE, error=error)
    try:
        with P.charge_watch() as watch:
            try:
                handle = adapter.submit(generator, key, request)
            except P.ImageError:
                raise
            except Exception as exc:            # noqa: BLE001 -- an answer DGC couldn't read is a failed submit
                raise P.ImageError("failed", f"{type(exc).__name__}: {exc}", provider=generator["provider"]) from None
    except P.ImageError as error:
        # Nothing to follow. Its estimate goes, unless the provider may have taken the job (it accepted the request,
        # or never answered it): then it stays in this month's spend.
        counted = bool(watch.maybe and plan.estimate and generator["provider"] != "comfyui")
        with images.budget():
            videos.discard(job["id"])
            if counted:
                images._charge(job["id"], generator["id"], float(plan.estimate))
        videos.JOBS.unclaim(fd)
        images.record_check(generator["id"], {"ok": False, "kind": error.kind, "detail": error.message})
        said = f"{generator['name']} {error.words()}: {error.message}".rstrip(". ")
        return Started(f"error: {said}. No video was made, and DGC never switches to another paid generator by itself."
                       + (f" The provider may still charge for it ({images.money(plan.estimate)}): DGC counts it in "
                          "this month's spend." if counted else "")
                       + _fix(error, generator) + _STOP_HERE, error=error)
    except BaseException:
        # Interrupted while it was being sent: its record stays, and the next DGC to look ends it (it may be made).
        videos.JOBS.unclaim(fd)
        raise
    job.update(handle=handle, state="queued", status="sent")
    videos.JOBS.start(config, job, fd=fd)
    if job.get("state") == "cancelled":
        # Stopped while it was being sent: now that the provider has it, it is stopped there too.
        videos.JOBS.stopped_while_sending(config, job, generator, adapter, key)
    length = f"{request.duration_s} s video" if request.duration_s else "video"
    text = (f"Started a {length} with {plan.label} ({request.resolution}, {images.money(plan.estimate)}), "
            f"{job['minutes']} (job {job['id']}). It's made in the background: the chat can carry on, and DGC tells "
            "you when it's ready" + (" (the player shows under this reply)" if surface.name != "sdk" else "")
            + ". Don't wait or poll for it, and don't start another unless the user asked for more.")
    if plan.notes:
        text += " Note: " + " ".join(plan.notes)
    return Started(text, job=job)


def ready_text(job: dict) -> str:
    """What the model is told when its video is ready (or failed, or was stopped)."""
    if job.get("state") == "done":
        result = job.get("result") or {}
        where = result.get("rel") or result.get("path") or ""
        return (f"{videos.line(job)}: {where}. Its sidecar (prompt, provider, model, seed, length, cost) is beside it. "
                "The user sees the player under the reply that asked for it. Tell them in a sentence; don't paste the "
                "path or start another video unless they ask.")
    if job.get("state") == "failed":
        error = job.get("error") or {}
        generator = {"id": job.get("generator"), "name": job.get("generator_name") or job.get("generator")}
        return (videos.line(job) + ". No video was made." + _fix(P.ImageError(error.get("kind", "failed"),
                                                                             error.get("message", "")), generator)
                + _STOP_HERE)
    return videos.line(job) + " The user stopped it: don't start it again unless they ask."


def list_text(config, args, surface: image_tools.Surface) -> str:
    refresh = bool((args or {}).get("refresh")) if isinstance(args, dict) else False
    block = images.settings(config)
    rows = videos.generators(block)
    if refresh and rows:
        images.check_all(config, [g["id"] for g in rows])
    if not rows:
        return ("No video generator is set up. The user adds one in Settings → Models → Images & video (+ Add "
                "generator: a video model of fal.ai, Gemini or Replicate, with the key they already use for pictures, "
                "or a ComfyUI video workflow), or with `dgc videos add`. Runway and Higgsfield make videos through "
                "their plugins, if added.")
    chosen = surface.chat_choice if surface.project_root is None else remembered(surface)
    lines = [f"Video generators ({len(rows)}). Every video asks the user first (its card has the price) unless they "
             "turned that off for a generator in Settings. A clip takes minutes; make one at a time."
             + (f" This {'chat' if surface.project_root is None else 'project'} uses {chosen}." if chosen else "")]
    for generator in rows:
        row = images.describe(config, generator, block=block)
        about = row["video"]
        lengths = (", ".join(f"{d}" for d in about["durations"]) + " s") if about["durations"] else "the model's length"
        bits = [f"{row['provider_name']} · {about['model'] or 'its workflow'}", about["price_per_s"], about["minutes"],
                f"lengths {lengths}", "resolutions " + ", ".join(about["resolutions"] or ["as the workflow has it"]),
                *(["shapes " + ", ".join(about["aspects"])] if about["aspects"] else []),
                {"no": "no sound", "option": "sound if asked", "always": "with sound"}.get(about["audio"], ""),
                "takes a start image" if about["start_image"] else "no start image",
                "asks before each video" if about["asks"] else "makes videos without asking (the user's setting)",
                images.state_words(row) if row.get("has_key") or not images.needs_key(row) else
                f"no key yet (Settings → Models → Images & video, or /images key {row['id']})"]
        if row.get("monthly_limit_usd") is not None:
            bits.append(f"this month {images.dollars(row['key_spent_this_month_usd'])} of "
                        f"{images.dollars(row['monthly_limit_usd'])} on its key")
        if about.get("note"):
            bits.append(about["note"])
        if not row["enabled"]:
            bits.insert(0, "TURNED OFF")
        lines.append(f"- {row['id']} \"{row['name']}\": " + " · ".join(bit for bit in bits if bit))
    jobs = [job for job in videos.all_jobs(limit=20) if job.get("state") not in videos.TERMINAL][:5]
    for job in jobs:
        lines.append(f"Running: {job['id']} · {videos.line(job)}")
    lines.append("Runway and Higgsfield make videos through their plugins (if the user added them), not here.")
    return "\n".join(lines)
