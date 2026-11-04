"""Changing the image generators: the one path `dgc images`, `/images`, the editor's images_update and the SDK share,
so a change reads and validates the same everywhere. A key is set only with set_key and never read back."""
from __future__ import annotations

import copy
import json
import re

from . import image_providers as P
from . import images
from .config import IMAGE_PROVIDERS, router_base_url, router_slug

ACTIONS = ("add_generator", "edit_generator", "remove_generator", "set_default", "set_project_choice",
           "set_auto_fallback", "set_save_dir", "set_key", "test")
_EDITABLE = ("name", "base_url", "model", "size", "steps", "negative_prompt", "asks", "good_for", "enabled",
             "monthly_limit_usd", "system", "mapping", "makes", "video_asks", "video_pips")
_KEY_WORDS = ("key", "api_key", "token", "secret", "password")


class ChangeError(ValueError):
    pass


def _block(config) -> dict:
    return copy.deepcopy(images.settings(config))


def _save(config, block: dict) -> dict:
    try:
        return config.set_images(block)
    except ValueError as exc:
        raise ChangeError(str(exc)) from None


def _generator(block: dict, name: str) -> dict:
    found = images.find(block, name)
    if found is None:
        raise ChangeError(f"there is no image generator {name!r}; there are: "
                          + (", ".join(g["id"] for g in block["generators"]) or "none yet"))
    return found


def _workflow(value) -> dict:
    try:
        return P.load_workflow(value)
    except P.WorkflowError as exc:
        raise ChangeError(str(exc)) from None


def add(config, fields: dict, *, confirm: bool = False, check: bool = True) -> dict:
    """Add a generator. A ComfyUI workflow comes back first with the inputs DGC found (``pending``), and is saved
    once the mapping is confirmed (``confirm`` or a ``mapping`` given). With no workflow and no checkpoint, DGC
    picks the server's first checkpoint."""
    if any(word in str(key).lower() for key in fields for word in _KEY_WORDS):
        raise ChangeError("a key is set with set_key, never with the generator's settings")
    provider = str(fields.get("provider") or "").strip().lower().replace("-", "_")
    provider = {"automatic1111": "a1111", "forge": "a1111", "sdnext": "a1111", "draw_things": "a1111",
                "google": "gemini", "black_forest_labs": "bfl", "fal_ai": "fal", "comfy": "comfyui",
                "openai_compat": "openai_compatible"}.get(provider, provider)
    if provider not in IMAGE_PROVIDERS:
        raise ChangeError(f"provider must be one of {', '.join(IMAGE_PROVIDERS)}")
    block = _block(config)
    makes = str(fields.get("makes") or "images")
    if makes not in ("images", "videos", "both"):
        raise ChangeError("makes is images, videos or both")
    if makes != "images" and provider not in ("comfyui", "gemini", "fal", "replicate"):
        raise ChangeError("DGC makes videos with fal.ai, Gemini, Replicate or a ComfyUI workflow")
    if makes == "images":
        new = images.describe_new(provider, str(fields.get("base_url") or ""), str(fields.get("model") or ""),
                                  str(fields.get("name") or ""))
    else:
        from . import videos
        new = videos.describe_new(provider, str(fields.get("base_url") or ""), str(fields.get("model") or ""),
                                  str(fields.get("name") or ""))
        new["makes"] = makes
    taken = {g["id"] for g in block["generators"]}
    wanted = str(fields.get("id") or "").strip().lower()
    short = provider.replace("_", "-")
    new["id"] = wanted or (short if short not in taken and provider not in ("comfyui", "a1111", "openai_compatible")
                           and makes == "images" else router_slug(new["name"])[:32].strip("-")) or short
    if new["id"] in taken:
        base, serial = new["id"][:28], 2
        while any(g["id"] == f"{base}-{serial}" for g in block["generators"]):
            serial += 1
        new["id"] = f"{base}-{serial}"
    for key in ("size", "steps", "negative_prompt", "asks", "good_for", "enabled", "monthly_limit_usd", "system",
                *(("video_asks", "video_pips") if makes != "images" else ())):
        if fields.get(key) is not None and fields.get(key) != "":
            new[key] = fields[key]
    out: dict = {"pending": False, "notes": []}
    if provider == "comfyui":
        workflow = fields.get("workflow")
        if workflow:
            parsed = _workflow(workflow)
            mapping = fields.get("mapping")
            if makes == "images":
                detected, notes = P.detect_mapping(parsed)
            else:
                from .video_providers import detect_video_mapping
                detected, notes = detect_video_mapping(parsed)
            if not mapping:
                mapping = detected
                out.update(mapping=detected, mapping_lines=P.mapping_lines(parsed, detected), notes=notes)
                if not confirm:
                    out.update(pending=True, summary=f"Found these inputs in the workflow for {new['name']}: "
                               "confirm them to add it", generator=new)
                    return out
            if "prompt" not in mapping:
                raise ChangeError("the workflow has no prompt input DGC could find: give mapping.prompt as NODE.text")
            new.update(workflow=images.save_workflow(new["id"], parsed), mapping=mapping)
            new.pop("model", None)
        elif makes != "images":
            raise ChangeError("a ComfyUI video generator needs its workflow (exported from ComfyUI in API format)")
        elif not new.get("model"):
            try:
                found = P.ComfyUI().checkpoints({"base_url": router_base_url(new.get("base_url") or
                                                                             "http://localhost:8188")[0]})
            except P.ImageError as exc:
                raise ChangeError(f"ComfyUI didn't answer: {exc.message}") from None
            if not found:
                raise ChangeError("ComfyUI has no checkpoint to use: add one, or add a workflow")
            new["model"] = found[0]
            out["notes"].append(f"Uses the checkpoint {found[0]} (the server has {len(found)}).")
        model_name = str(new.get("model") or "").lower()
        if makes == "images" and not fields.get("size") and model_name and ("turbo" in model_name or not re.search(r"xl|flux|qwen|sd3|"
                                                                                               r"z-image|hidream",
                                                                                               model_name)):
            new["size"] = "512x512"               # SD 1.5 and the Turbo models are made at 512
    block["generators"].append(new)
    if fields.get("default") or not block.get("default"):
        block["default"] = new["id"]
    saved = _save(config, block)
    generator = next(g for g in saved["generators"] if g["id"] == new["id"])
    out["generator"] = generator
    out["summary"] = (f"Added {generator['name']} ({images.PROVIDER_LABELS[provider]} at {generator['base_url']}"
                      + (f", {generator['model']}" if generator.get("model") else "") + ")")
    if images.needs_key(generator) and not images.key_source(config, generator):
        out["notes"].append(f"It needs a key: paste it in Settings → Models → Images & video, or /images key {generator['id']}.")
    if images.makes_videos(generator):
        out["notes"].append("It asks before each video, with its price; only Settings can turn that off.")
    elif generator["asks"]:
        out["notes"].append("It asks before each image (it costs money); Always allow on its card stops that.")
    if check:
        out["check"] = images.check(config, generator)
    return out


def edit(config, name: str, fields: dict) -> dict:
    if any(word in str(key).lower() for key in fields for word in _KEY_WORDS):
        raise ChangeError("a key is set with set_key, never with the generator's settings")
    block = _block(config)
    target = _generator(block, name)
    was_paid = images.is_paid(target)
    changed = []
    for key in _EDITABLE:
        if key in fields and fields[key] is not None:
            value = fields[key]
            if key == "monthly_limit_usd" and value in ("", -1):
                target.pop(key, None)
            elif key == "system" and value == "":
                target.pop(key, None)
            else:
                target[key] = value
            changed.append(key)
    if fields.get("workflow"):
        parsed = _workflow(fields["workflow"])
        if images.makes_videos(target):
            from .video_providers import detect_video_mapping
            mapping = fields.get("mapping") or detect_video_mapping(parsed)[0]
        else:
            mapping = fields.get("mapping") or P.detect_mapping(parsed)[0]
        target.update(workflow=images.save_workflow(target["id"], parsed), mapping=mapping)
        target.pop("model", None)
        changed.append("workflow")
    if not changed:
        raise ChangeError("nothing to change")
    if "base_url" in changed and "asks" not in changed and not was_paid and images.is_paid(
            {**target, "base_url": router_base_url(target["base_url"])[0]}):
        # A free server's "doesn't ask" never carries to an address that charges (an OpenAI-compatible server moved
        # off the local network): it asks again, unless this same change says otherwise.
        target["asks"] = True
    _save(config, block)
    if "base_url" in changed:
        images.forget(target["id"])
    return {"summary": f"Changed {target['name']}: {', '.join(changed)}", "generator": _generator(
        images.settings(config), target["id"])}


def remove(config, name: str) -> dict:
    block = _block(config)
    target = _generator(block, name)
    block["generators"] = [g for g in block["generators"] if g["id"] != target["id"]]
    if block.get("default") == target["id"]:
        block["default"] = block["generators"][0]["id"] if block["generators"] else ""
    _save(config, block)
    images.forget(target["id"])
    return {"summary": f"Removed {target['name']} (its saved key goes too)"}


def set_default(config, name: str) -> dict:
    block = _block(config)
    if not name:
        block["default"] = ""
        _save(config, block)
        return {"summary": "No default generator"}
    target = _generator(block, name)
    block["default"] = target["id"]
    _save(config, block)
    return {"summary": f"{target['name']} is the default generator"}


def set_project_choice(config, name: str, project_root) -> dict:
    if not name:
        images.remember_project_choice(project_root, "")
        return {"summary": "This project has no choice now (DGC asks when several fit)"}
    target = _generator(images.settings(config), name)
    images.remember_project_choice(project_root, target["id"])
    return {"summary": f"This project uses {target['name']}"}


def set_option(config, key: str, value) -> dict:
    block = _block(config)
    block[key] = value
    if key == "save_dir":
        block["save_dir_set"] = bool(str(value or "").strip())     # chosen: kept, even the first builds' default
    _save(config, block)
    if key == "auto_fallback":
        return {"summary": "Automatic fallback is " + ("on: DGC may use another generator when one needs credit "
                                                       "(a paid one still asks)" if value else "off")}
    return {"summary": save_place(config)}


def save_place(config) -> str:
    """Where pictures are saved, in a line."""
    folder = images.settings(config).get("save_dir") or ""
    if folder:
        return f"Images are saved in {folder}/ in the project"
    return ("Images are saved in DGC's own folder (~/.dgc/images), one folder per chat; in the project only when "
            "you ask")


def key_shape_note(provider: str, key: str) -> str:
    """A plain warning when ``key`` doesn't look like a whole key of ``provider`` (only where the shape is documented),
    else "". Never says the key. Seen in testing (2026-11-02): a fal key pasted in part (40 characters, no ':') was
    saved, and every picture then failed as "Authentication is required"."""
    key = str(key or "").strip()
    if not key:
        return ""
    if provider == "fal":
        left, sep, right = key.partition(":")
        if not sep or not left or not right:
            return ("This doesn't look like a whole fal key: fal keys have two parts with a ':' between them (key ID : "
                    "secret). Copy the whole key from fal.ai → API keys.")
    if provider == "replicate" and not key.startswith("r8_"):
        return "This doesn't look like a Replicate key: Replicate keys start with r8_. Copy it from replicate.com → API tokens."
    if provider == "gemini" and not (key.startswith("AIza") and len(key) == 39):
        return ("This doesn't look like a Gemini key: Google AI Studio keys start with AIza and are 39 characters. "
                "Copy it from aistudio.google.com → Get API key.")
    return ""


def set_key(config, name: str, key: str) -> dict:
    target = _generator(images.settings(config), name)
    try:
        config.set_image_key(target["id"], str(key or ""))
    except ValueError as exc:
        raise ChangeError(str(exc)) from None
    images.forget(target["id"])
    if not key:
        return {"summary": f"Removed the key for {target['name']}"}
    note = key_shape_note(target.get("provider", ""), key)
    return {"summary": f"Saved the key for {target['name']}" + (f". {note}" if note else ""),
            **({"note": note} if note else {})}


def test(config, names=None) -> dict:
    block = images.settings(config)
    ids = None if not names else [_generator(block, name)["id"] for name in names]
    return images.check_all(config, ids)


def apply(config, action: str, fields: dict, *, project_root=None) -> dict:
    """One change by name (the editor's images_update, the SDK): {summary, ...}."""
    if action not in ACTIONS:
        raise ChangeError(f"action must be one of {', '.join(ACTIONS)}")
    if "key" in fields and action != "set_key":
        raise ChangeError("a key goes only with set_key")
    name = str(fields.get("generator") or fields.get("id") or "")
    if action == "add_generator":
        return add(config, {k: v for k, v in fields.items() if k not in ("generator", "confirm")},
                   confirm=bool(fields.get("confirm")))
    if action == "edit_generator":
        return edit(config, name, {k: v for k, v in fields.items() if k not in ("generator", "id")})
    if action == "remove_generator":
        return remove(config, name)
    if action == "set_default":
        return set_default(config, name)
    if action == "set_project_choice":
        if project_root is None:
            raise ChangeError("there is no project here")
        return set_project_choice(config, name, project_root)
    if action == "set_auto_fallback":
        return set_option(config, "auto_fallback", bool(fields.get("auto_fallback")))
    if action == "set_save_dir":
        return set_option(config, "save_dir", str(fields.get("save_dir") or ""))
    if action == "set_key":
        return set_key(config, name, str(fields.get("key") or ""))
    found = test(config, [name] if name else None)
    return {"summary": "Tested " + ", ".join(f"{gid}: {'works' if row.get('ok') else row.get('kind', 'failed')}"
                                             for gid, row in found.items()), "tested": found}


def as_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)
