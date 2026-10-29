"""A mod's manifest, ``dgc-mod.json``: who it is, what it runs, and everything it may touch.

    {
      "name": "tally", "version": "1.0.0", "entry": "main.py",
      "title": "Tally", "description": "Tool calls this session.",
      "capabilities": {
        "events": ["tool.call", "turn.complete"],
        "draws": ["status", "pane"],
        "commands": [{"name": "tally", "description": "Show the tally"}],
        "reads": ["usage"],
        "network": ["api.example.com"],
        "model": false,
        "rewrites_prompt": false
      }
    }

Nothing a mod didn't declare is ever given to it: an event it didn't ask for isn't sent, a slot it didn't declare isn't
drawn, a host it didn't name isn't reached. ``describe`` says it all in plain words for the one-time Allow, and
``grows`` says whether an update asks for more than was allowed (then it asks again).
"""
from __future__ import annotations

import json
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

MANIFEST = "dgc-mod.json"
NAME = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")
VERSION = re.compile(r"\d{1,6}\.\d{1,6}\.\d{1,6}([-+][0-9A-Za-z.-]{1,40})?\Z")
COMMAND = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
HOST = re.compile(r"(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\Z|localhost\Z")
ENTRY_KINDS = {".py": "python", ".js": "node", ".mjs": "node", ".ts": "node", ".mts": "node"}

EVENTS = ("session.start", "session.end", "prompt.submit", "tool.call", "tool.result", "turn.start", "turn.complete")
DRAWS = ("pane", "band", "status", "toast")
READS = ("usage", "transcript", "project", "git")
MAX_COMMANDS = 8
MAX_HOSTS = 16

# Plain words for the Allow card, in the order they are shown.
_SAY_EVENTS = {
    "session.start": "know when a session starts", "session.end": "know when a session ends",
    "prompt.submit": "see what you send", "tool.call": "see each step DGC is about to take, and stop it or ask you first",
    "tool.result": "see what each step returned", "turn.start": "know when DGC starts working",
    "turn.complete": "know when DGC finishes, with the tokens it used",
}
_SAY_READS = {"usage": "read this session's token use", "transcript": "read this conversation",
              "project": "read files in your project", "git": "read your project's git status and changes"}
_SAY_DRAWS = {"pane": "a panel beside the chat", "band": "a band above the prompt", "status": "a line in the status bar",
              "toast": "short notices"}


class ManifestError(ValueError):
    """The manifest is wrong; the text says what to fix."""


@dataclass(frozen=True)
class Manifest:
    name: str
    version: str
    entry: str
    runtime: str                       # "python" or "node"
    title: str
    description: str
    folder: Path
    events: tuple[str, ...] = ()
    draws: tuple[str, ...] = ()
    commands: tuple[dict, ...] = ()
    reads: tuple[str, ...] = ()
    network: tuple[str, ...] = ()
    model: bool = False
    rewrites_prompt: bool = False
    builtin: bool = False
    extra: dict = field(default_factory=dict, compare=False)

    @property
    def entry_path(self) -> Path:
        return self.folder / self.entry

    def capabilities(self) -> dict:
        return {"events": list(self.events), "draws": list(self.draws),
                "commands": [dict(c) for c in self.commands], "reads": list(self.reads),
                "network": list(self.network), "model": self.model, "rewrites_prompt": self.rewrites_prompt}

    def grants(self) -> set[str]:
        """Every single thing it may do, as tokens: what an Allow covers."""
        out = {f"event:{e}" for e in self.events} | {f"draw:{d}" for d in self.draws}
        out |= {f"command:{c['name']}" for c in self.commands} | {f"read:{r}" for r in self.reads}
        out |= {f"net:{h}" for h in self.network}
        if self.model:
            out.add("model")
        if self.rewrites_prompt:
            out.add("rewrite")
        return out

    def review_id(self) -> str:
        """Bind an Allow to the exact manifest and folder whose capabilities were shown."""
        value = {"name": self.name, "version": self.version, "title": self.title, "description": self.description,
                 "folder": str(self.folder), "entry": self.entry, "runtime": self.runtime,
                 "capabilities": self.capabilities()}
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _strings(value, allowed, label) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ManifestError(f"capabilities.{label} is a list of names.")
    unknown = [v for v in value if v not in allowed]
    if unknown:
        raise ManifestError(f"capabilities.{label}: {', '.join(unknown)} isn't one of {', '.join(allowed)}.")
    return tuple(dict.fromkeys(value))


def parse(data, folder: Path, *, builtin: bool = False) -> Manifest:
    """A manifest from its JSON, checked."""
    if not isinstance(data, dict):
        raise ManifestError(f"{MANIFEST} is a JSON object.")
    name = data.get("name")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ManifestError("name is 1–40 lower-case letters, digits and dashes, starting with a letter.")
    version = data.get("version")
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ManifestError("version is like 1.0.0.")
    entry = data.get("entry")
    if (not isinstance(entry, str) or not entry or len(entry) > 1024 or "\\" in entry
            or any(ord(c) < 32 for c in entry) or entry.startswith("/") or ":" in entry.split("/", 1)[0]
            or ".." in Path(entry).parts):
        raise ManifestError("entry is the mod's file, inside its folder (main.py, index.ts …).")
    runtime = ENTRY_KINDS.get(Path(entry).suffix.lower())
    if runtime is None:
        raise ManifestError("entry is a .py, .js, .mjs or .ts file.")
    try:
        (folder / entry).resolve(strict=True).relative_to(folder.resolve())
    except (OSError, ValueError, RuntimeError):
        raise ManifestError("entry must stay inside the mod's folder.") from None
    if not (folder / entry).is_file():
        raise ManifestError(f"entry {entry} isn't in the mod's folder.")
    title = data.get("title", name)
    description = data.get("description", "")
    if not isinstance(title, str) or not isinstance(description, str):
        raise ManifestError("title and description are text.")
    if not title.isprintable() or not description.isprintable():
        raise ManifestError("title and description use plain text without control characters.")
    caps = data.get("capabilities") or {}
    if not isinstance(caps, dict):
        raise ManifestError("capabilities is an object.")
    unknown = set(caps) - {"events", "draws", "commands", "reads", "network", "model", "rewrites_prompt"}
    if unknown:
        raise ManifestError(f"capabilities has no {', '.join(sorted(unknown))}.")
    commands = caps.get("commands") or []
    if not isinstance(commands, list) or len(commands) > MAX_COMMANDS:
        raise ManifestError(f"capabilities.commands is a list of at most {MAX_COMMANDS}.")
    cleaned = []
    for c in commands:
        if not isinstance(c, dict) or not isinstance(c.get("name"), str) or not COMMAND.fullmatch(c["name"]):
            raise ManifestError("each command has a name: lower-case letters, digits and dashes.")
        command_description = str(c.get("description") or "")
        if not command_description.isprintable():
            raise ManifestError("command descriptions use plain text without control characters.")
        cleaned.append({"name": c["name"], "description": command_description[:120]})
    network = caps.get("network") or []
    if not isinstance(network, list) or len(network) > MAX_HOSTS or not all(
            isinstance(h, str) and HOST.fullmatch(h.lower()) for h in network):
        raise ManifestError(f"capabilities.network is at most {MAX_HOSTS} host names (api.example.com, *.example.com).")
    for key in ("model", "rewrites_prompt"):
        if not isinstance(caps.get(key, False), bool):
            raise ManifestError(f"capabilities.{key} is true or false.")
    draws = _strings(caps.get("draws"), DRAWS, "draws")
    events = _strings(caps.get("events"), EVENTS, "events")
    if caps.get("rewrites_prompt") and "prompt.submit" not in events:
        raise ManifestError("A mod that rewrites prompts hooks prompt.submit.")
    return Manifest(name=name, version=version, entry=entry, runtime=runtime, title=title.strip()[:60] or name,
                    description=description.strip()[:300], folder=folder, events=events, draws=draws,
                    commands=tuple(cleaned), reads=_strings(caps.get("reads"), READS, "reads"),
                    network=tuple(dict.fromkeys(h.lower() for h in network)), model=bool(caps.get("model")),
                    rewrites_prompt=bool(caps.get("rewrites_prompt")), builtin=builtin)


def load(folder, *, builtin: bool = False) -> Manifest:
    folder = Path(folder).resolve()
    path = folder / MANIFEST
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ManifestError(f"There's no {MANIFEST} in {folder}.") from None
    except (OSError, ValueError) as error:
        raise ManifestError(f"{MANIFEST} couldn't be read: {error}") from None
    return parse(data, folder, builtin=builtin)


def describe(m: Manifest) -> list[str]:
    """What it may do, in plain words, one line each: the Allow card's body."""
    lines = [f"Run {m.runtime == 'python' and 'Python' or 'JavaScript'} code from {m.title}, in a sandbox."]
    lines += [f"It can {_SAY_EVENTS[e]}." for e in m.events]
    if m.rewrites_prompt:
        lines.append("It can change what you send before DGC reads it (always marked, and you can see the original).")
    lines += [f"It can {_SAY_READS[r]}." for r in m.reads]
    if m.draws:
        lines.append("It can show " + ", ".join(_SAY_DRAWS[d] for d in m.draws) + ".")
    if m.commands:
        lines.append("It adds " + ", ".join(f"/{c['name']}" for c in m.commands) + ".")
    if m.network:
        lines.append("It can reach " + ", ".join(m.network) + " on the internet, and nothing else.")
    else:
        lines.append("It can't reach the internet.")
    if m.model:
        lines.append("It can ask your model questions, which uses your tokens.")
    lines.append("It can never approve anything for you.")
    return lines


def grows(old_grants: set[str], new: Manifest) -> set[str]:
    """What an update asks for that wasn't allowed before (empty: no need to ask again)."""
    return new.grants() - set(old_grants)
