"""Skills — reusable prompt packages.

A skill is a directory containing SKILL.md:

    ---
    name: commit
    description: Write a conventional commit message for the staged changes
    ---

    Instructions for the model... $ARGUMENTS is replaced with invocation args.

Discovery (earlier locations override later ones):
  <project>/.dgc/skills/<name>/SKILL.md
  <project>/.agents/skills/<name>/SKILL.md
  ~/.dgc/skills/<name>/SKILL.md
  ~/.agents/skills/<name>/SKILL.md
  bundled skills
"""
from __future__ import annotations

import os
import json
import re
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .config import USER_SKILLS, BUILTIN_SKILLS, PORTABLE_USER_SKILLS
from .workspace import WorkspaceBoundaryError, is_within, read_regular_bytes, scan_directory_entries


MAX_SKILL_FILE_BYTES = 65_536
MAX_SKILL_BODY_CHARS = 30_000
MAX_SKILL_RENDER_CHARS = 32_000
MAX_SKILL_ARGUMENT_CHARS = 4_096
MAX_SKILL_DESCRIPTION_CHARS = 320
MAX_SKILLS = 256
MAX_SKILLS_PER_ROOT = 256
MAX_SKILL_SCAN_ENTRIES = 4_096
MAX_EXPLICIT_SKILLS = 8
MAX_EXPLICIT_SKILL_CHARS = 96_000

_NAME_CLEAN_RE = re.compile(r"[^a-z0-9._-]+")
_ALL_SKILLS_RE = re.compile(
    r"\b(?:use|invoke|load|run|choose|show|list|available|which)\b.{0,24}\bskills?\b|"
    r"/(?:skills?|skill)(?:\s|$)", re.IGNORECASE | re.DOTALL)
_BUILTIN_SKILL_PATTERNS = {
    "browser-test": re.compile(r"\b(?:browser|playwright) (?:tests?|testing|automation)\b|\btest (?:the |this )?(?:browser|web app)\b", re.I),
    "fix-ci": re.compile(r"\b(?:fix|debug|diagnose) (?:the |this )?ci\b|\b(?:ci|continuous integration|github actions) (?:fail\w*|job failure)\b|\bfail\w* ci\b", re.I),
    "pr-feedback": re.compile(r"\b(?:address|resolve|implement) (?:the |this )?(?:(?:pr|review|pull request) )?(?:feedback|comments)\b|\bpr feedback\b", re.I),
    "skill-author": re.compile(r"\b(?:create|author|write|build|revise|update) (?:a |the |this |an? existing )?(?:dgc |portable )?skill\b|\bskill (?:authoring|package development)\b", re.I),
    "mcp-builder": re.compile(r"\b(?:build|implement|develop|extend) (?:an? |the |this )?mcp server\b|\bmcp server development\b", re.I),
    "batch": re.compile(r"\b(?:batch|fan[- ]?out|repetitive change|many[- ]file change)\b", re.I),
    "code-review": re.compile(r"\b(?:code review|review (?:the )?(?:diff|changes|pr)|pull request review)\b", re.I),
    "ui-review": re.compile(
        r"\b(?:ui|interface|visual|accessibility) (?:audit|review)\b|"
        r"\b(?:audit|review) (?:the |this |our )?(?:ui|interface|visuals|accessibility)\b", re.I),
    "dataviz": re.compile(r"\b(?:data ?viz|visuali[sz]ation|chart|plot|graph)\b", re.I),
    "debug": re.compile(
        r"\b(?:debug|diagnos(?:e|is)|investigate|fix)\b.{0,32}"
        r"\b(?:failing tests?|regression|crash|wrong behavior)\b|"
        r"\btests? (?:still )?fail(?:s|ing)?\b|\b(?:regression|crash)\b", re.I),
    "deep-research": re.compile(r"\b(?:deep research|research (?:online|the web)|cross[- ]check sources|cited research)\b", re.I),
    "dgc-design": re.compile(r"\b(?:dgc design|web ui|front[- ]?end design|artifact|dashboard|mockup)\b", re.I),
    "handoff": re.compile(r"\b(?:handoff|hand[- ]off|resume context|continuation document)\b", re.I),
    "loop": re.compile(r"\b(?:use (?:the )?loop|loop until|convergence loop)\b", re.I),
    "onboard": re.compile(r"\b(?:onboard|understand (?:this|the) codebase|codebase mental model|familiarize)\b", re.I),
    "plan": re.compile(r"\b(?:plan mode|implementation plan|plan (?:this|the) change)\b", re.I),
    "refactor": re.compile(r"\b(?:refactor|extract (?:a )?(?:method|function|class)|behavior[- ]preserving|deduplicat)\w*\b", re.I),
    "security-review": re.compile(r"\b(?:security review|security audit|audit (?:for )?(?:security|vulnerabilit)|threat model)\w*\b", re.I),
    "setup": re.compile(r"\b(?:set ?up dgc|connect dgc|model endpoint|provider setup|permission friction)\b", re.I),
    "ship": re.compile(r"\b(?:ship (?:the|this) change|open (?:a )?pr|create (?:a )?pull request|commit and push)\b", re.I),
    "verify": re.compile(r"\b(?:verify (?:the|this|my) change|end[- ]to[- ]end verification|validate the implementation)\b", re.I),
    "write-tests": re.compile(r"\b(?:write|add|author) (?:the )?(?:unit |integration )?tests?\b|\btest coverage\b", re.I),
}
_MATCH_STOPWORDS = {
    "about", "after", "again", "against", "before", "build", "change", "code", "does",
    "from", "have", "into", "make", "more", "only", "other", "should", "skill", "task",
    "that", "their", "then", "these", "this", "through", "user", "using", "when", "where",
    "which", "while", "with", "without", "write", "your",
}
_WORD_RE = re.compile(r"[a-z][a-z0-9]{3,}")


def _frozen(path: Path | str) -> Path:
    return Path(os.path.abspath(os.path.normpath(os.fspath(path))))


def normalize_skill_name(value: str) -> str:
    name = _NAME_CLEAN_RE.sub("-", str(value or "").strip().lower()).strip("-._")
    return name[:64].rstrip("-._")


def _clean_description(value: str) -> str:
    clean = "".join(
        " " if unicodedata.category(ch) in ("Cc", "Cf") else ch
        for ch in str(value or ""))
    clean = " ".join(clean.split())
    return clean[:MAX_SKILL_DESCRIPTION_CHARS].rstrip()


@dataclass
class Skill:
    name: str
    description: str
    body: str
    path: Path
    display_name: str = ""
    short_description: str = ""
    default_prompt: str = ""
    allow_implicit_invocation: bool = True
    enabled: bool = True
    source: str = ""
    diagnostics: tuple[str, ...] = ()

    def render(self, arguments: str = "") -> str:
        raw_args = str(arguments or "")[:MAX_SKILL_ARGUMENT_CHARS]
        marker_count = self.body.count("$ARGUMENTS") + self.body.count("${ARGUMENTS}")
        if marker_count:
            base_chars = (len(self.body) - self.body.count("$ARGUMENTS") * len("$ARGUMENTS")
                          - self.body.count("${ARGUMENTS}") * len("${ARGUMENTS}"))
            per_marker = max(0, (MAX_SKILL_RENDER_CHARS - base_chars) // marker_count)
            raw_args = raw_args[:per_marker]
        body = self.body.replace("${ARGUMENTS}", raw_args).replace("$ARGUMENTS", raw_args)
        return body[:MAX_SKILL_RENDER_CHARS].strip()


def _scalar(value: str) -> str:
    """Read the string scalar forms used by skill metadata; never evaluate YAML tags/objects."""
    value = value.strip()
    if value.startswith('"'):
        parsed, end = json.JSONDecoder().raw_decode(value)
        if not isinstance(parsed, str) or (value[end:].strip() and not value[end:].lstrip().startswith("#")):
            raise ValueError("invalid quoted metadata string")
        return parsed
    if value.startswith("'"):
        match = re.fullmatch(r"'((?:[^']|'')*)'\s*(?:#.*)?", value)
        if not match:
            raise ValueError("invalid quoted metadata string")
        return match[1].replace("''", "'")
    if value.startswith(("!", "&", "*", "[", "{")):
        raise ValueError("metadata requires a plain, quoted, folded, or literal string")
    return re.split(r"\s+#", value, maxsplit=1)[0].rstrip()


def metadata_fields(text: str, wanted: set[str]) -> dict[str, str]:
    """Extract known scalar paths from bounded YAML without adding a runtime YAML dependency.

    Unknown maps/lists are left uninterpreted. Known fields support quoted, plain, literal and
    folded values; tags, anchors and container values cannot masquerade as executable metadata.
    """
    lines = text.splitlines()
    parents: list[tuple[int, str]] = []
    fields = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        match = re.match(r"^( *)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$", line)
        if not match:
            continue
        indent, key, value = len(match[1]), match[2], match[3]
        while parents and parents[-1][0] >= indent:
            parents.pop()
        if indent and not parents:
            continue
        qualified = ".".join([*(part for _, part in parents), key])
        if qualified in fields:
            raise ValueError("duplicate skill metadata field")
        if not value or value.startswith("#"):
            parents.append((indent, key))
            continue
        if re.fullmatch(r"[>|][+-]?[1-9]?(?:\s+#.*)?", value):
            block = []
            while index < len(lines):
                current = lines[index]
                if current.strip() and len(current) - len(current.lstrip(" ")) <= indent:
                    break
                block.append(current)
                index += 1
            if qualified in wanted:
                nonblank = [len(row) - len(row.lstrip(" ")) for row in block if row.strip()]
                margin = min(nonblank) if nonblank else 0
                rows = [row[margin:] for row in block]
                fields[qualified] = (" ".join(rows) if value.startswith(">") else "\n".join(rows)).strip()
        elif qualified in wanted:
            fields[qualified] = _scalar(value)
    return fields


def parse_skill_text(text: str, path: Path) -> Skill | None:
    """Parse already-bounded UTF-8 skill text into safe prompt metadata and instructions."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_SKILL_FILE_BYTES:
        return None
    text = text.removeprefix("\ufeff").replace("\r\n", "\n")
    name, description, body = path.parent.name, "", text
    if text.startswith("---"):
        frontmatter = re.match(r"\A---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)", text)
        if frontmatter is None:
            return None
        try:
            metadata = metadata_fields(frontmatter[1], {"name", "description"})
        except (ValueError, RecursionError):
            return None
        name, description = metadata.get("name") or name, metadata.get("description", "")
        body = text[frontmatter.end():].strip()
    name = normalize_skill_name(name)
    body = body.strip()
    if not name or not body or len(body) > MAX_SKILL_BODY_CHARS:
        return None
    return Skill(name=name, description=_clean_description(description), body=body,
                 path=_frozen(path))


def _parse_skill(path: Path) -> Skill | None:
    try:
        captured = read_regular_bytes(_frozen(path), maximum=MAX_SKILL_FILE_BYTES)
        assert captured is not None
        text = captured[0].decode("utf-8", errors="strict")
    except (OSError, UnicodeError, WorkspaceBoundaryError):
        return None
    skill = parse_skill_text(text, path)
    if skill is None:
        return None
    sidecar = path.parent / "agents" / "openai.yaml"
    try:
        captured = read_regular_bytes(_frozen(sidecar), maximum=16_384)
        metadata = metadata_fields(captured[0].decode("utf-8"), {
            "interface.display_name", "interface.short_description", "interface.default_prompt",
            "policy.allow_implicit_invocation"})
    except FileNotFoundError:
        return skill
    except (OSError, ValueError, UnicodeError, WorkspaceBoundaryError):
        skill.allow_implicit_invocation = False
        skill.diagnostics = ("Optional agents/openai.yaml could not be read safely; explicit invocation only.",)
        return skill
    skill.display_name = _clean_description(metadata.get("interface.display_name", ""))[:100]
    skill.short_description = _clean_description(metadata.get("interface.short_description", ""))
    skill.default_prompt = metadata.get("interface.default_prompt", "")[:4096]
    policy = metadata.get("policy.allow_implicit_invocation", "true").lower()
    skill.allow_implicit_invocation = policy == "true"
    if policy not in ("true", "false"):
        skill.diagnostics = ("Invalid allow_implicit_invocation policy; explicit invocation only.",)
    return skill


def _skill_paths(base: Path) -> list[Path]:
    root = _frozen(base)
    try:
        rows, truncated, _scanned = scan_directory_entries(
            root, maximum=MAX_SKILL_SCAN_ENTRIES)
    except (FileNotFoundError, NotADirectoryError, OSError, WorkspaceBoundaryError):
        return []
    if truncated:
        return []
    directories = [name for name, info in rows
                   if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)]
    return [root / name / "SKILL.md" for name in directories[:MAX_SKILLS_PER_ROOT]]


def discover_skills(project_root: Path, *, disabled_names=()) -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    # Highest-precedence roots are visited first. setdefault preserves project > user > bundled
    # without allowing a lower-priority catalog to consume the global count bound first.
    disabled = {name for name in disabled_names if isinstance(name, str)} if isinstance(disabled_names, (list, tuple, set)) else set()
    roots = ((project_root / ".dgc" / "skills", "project"),
             (project_root / ".agents" / "skills", "project"),
             (USER_SKILLS, "user"), (PORTABLE_USER_SKILLS, "user"), (BUILTIN_SKILLS, "builtin"))
    for base, source in roots:
        for skill_md in _skill_paths(base):
            skill = _parse_skill(skill_md)
            if skill and (skill.name in skills or len(skills) < MAX_SKILLS):
                skill.source, skill.enabled = source, skill.name not in disabled
                skills.setdefault(skill.name, skill)
    return dict(sorted(skills.items()))


def set_skill_enabled(config, name: str, enabled: bool) -> dict[str, Skill]:
    if (not isinstance(name, str) or normalize_skill_name(name) != name
            or not isinstance(enabled, bool)):
        raise ValueError("Choose a valid skill and enabled state.")
    disabled = config.get("disabled_skills", [])
    disabled = {item for item in disabled if isinstance(item, str)} if isinstance(disabled, list) else set()
    catalog = discover_skills(config.project_root, disabled_names=disabled)
    if name not in catalog:
        raise ValueError(f"Skill ${name} is no longer installed.")
    if enabled:
        disabled.discard(name)
    else:
        disabled.add(name)
    if len(disabled) > MAX_SKILLS:
        raise ValueError("Too many disabled skill names; enable or remove obsolete entries first.")
    config.set("disabled_skills", sorted(disabled))
    catalog[name].enabled = enabled
    return catalog


def skill_catalog(skills: dict[str, Skill], project_root: Path) -> list[dict]:
    """Return bounded public metadata, including which precedence layer supplied each skill."""
    project_skills = _frozen(Path(project_root) / ".dgc" / "skills")
    rows = []
    for index, skill in enumerate(skills.values()):
        if index >= MAX_SKILLS:
            break
        if not isinstance(skill, Skill):
            continue
        source = skill.source or ("project" if is_within(skill.path, project_skills) else
                  "user" if is_within(skill.path, USER_SKILLS) else
                  "builtin" if is_within(skill.path, BUILTIN_SKILLS) else "unknown")
        rows.append({"name": normalize_skill_name(skill.name),
                     "description": _clean_description(skill.description),
                     "source": source, "enabled": skill.enabled,
                     "display_name": skill.display_name, "short_description": skill.short_description,
                     "default_prompt": skill.default_prompt,
                     "allow_implicit_invocation": skill.allow_implicit_invocation,
                     "diagnostics": list(skill.diagnostics)})
    return rows


def manage_skills(config, arguments: str = "") -> str:
    """Shared terminal management commands; returns text rather than rendering or running a model."""
    import shlex
    parts = shlex.split(arguments)
    action = parts[0].lower() if parts else "list"
    catalog = discover_skills(config.project_root, disabled_names=config.get("disabled_skills", []))
    if action in ("enable", "disable") and len(parts) == 2:
        set_skill_enabled(config, parts[1], action == "enable")
        return f"Skill ${parts[1]} {'enabled' if action == 'enable' else 'disabled'}."
    if action == "show" and len(parts) == 2:
        skill = catalog.get(parts[1])
        if skill is None:
            raise ValueError("Unknown skill. Use /skills list to see installed names.")
        return f"${skill.name} · {skill.source} · {'enabled' if skill.enabled else 'disabled'}\n{skill.path}\n\n{skill.body}"
    if action in ("list", "reload") and len(parts) <= 1:
        return "\n".join(f"${s.name} [{s.source} · {'enabled' if s.enabled else 'disabled'}"
                         f"{' · explicit only' if not s.allow_implicit_invocation else ''}] {s.description}"
                         + ("\n  " + "; ".join(s.diagnostics) if s.diagnostics else "")
                         for s in catalog.values()) or "No installed skills."
    if action in ("create", "install"):
        from .skill_packages import create_skill, install_skill
        scope = "user" if "--user" in parts else "project"
        external = "--allow-external" in parts
        args = [part for part in parts[1:] if part not in ("--user", "--allow-external")]
        if len(args) == 1 and not args[0].startswith("--"):
            result = (create_skill(config, args[0], scope=scope) if action == "create" else
                      install_skill(config, args[0], scope=scope, allow_external=external))
            return f"{'Created' if action == 'create' else 'Installed'} ${result['name']} · {result['files']} files\n{result['path']}"
    raise ValueError("Usage: /skills [list|reload|show NAME|enable NAME|disable NAME|create NAME [--user]|install DIR [--user] [--allow-external]]")


def explicit_skill_names(skills: dict[str, Skill], text: str) -> list[str]:
    """Recognize exact `$name` mentions in user prose, excluding code and editor attachments."""
    source = str(text or "")
    editor_end = "</editor-context-json>\n\n"
    while source.startswith("<editor-context-json ") and editor_end in source:
        source = source.split(editor_end, 1)[1]
    selection_line, separator, _rest = source.partition("\n\n")
    if separator and re.fullmatch(r"\$[a-z0-9][a-z0-9._-]{0,63}(?: \$[a-z0-9][a-z0-9._-]{0,63})*", selection_line):
        for name in selection_line.split():
            if name[1:] not in skills:
                raise ValueError(f"Selected skill {name} is no longer installed. Reload Skills before retrying.")
    source = re.sub(r"```[\s\S]*?```|`[^`\n]*`", " ", source)
    names = re.findall(r"(?<!\S)\$([a-z0-9][a-z0-9._-]{0,63})(?![\w.-])", source)
    # Preserve an exact dotted package name when installed; otherwise a sentence-ending period
    # or ellipsis is prose punctuation, not part of the invocation.
    names = [name if name in skills else name.rstrip(".") for name in names]
    selected = list(dict.fromkeys(name for name in names if name in skills))
    if len(selected) > MAX_EXPLICIT_SKILLS:
        raise ValueError(f"Select at most {MAX_EXPLICIT_SKILLS} explicit skills per turn.")
    return selected


def explicit_skill_instructions(skills: dict[str, Skill], text: str) -> dict[str, dict]:
    """Materialize selected instructions before model execution, including resource provenance."""
    rows = {}
    for name in explicit_skill_names(skills, text):
        skill = skills[name]
        if getattr(skill, "enabled", True) is False:
            raise ValueError(f"Skill ${name} is disabled. Enable it in Skills before using it.")
        rows[name] = {"name": name, "source": str(skill.path),
                      "instructions": skill.render(text)}
    return rows


def format_skill_instructions(rows: dict[str, dict], maximum: int = MAX_EXPLICIT_SKILL_CHARS) -> str:
    if not rows:
        return ""
    if len(rows) > MAX_EXPLICIT_SKILLS:
        raise ValueError(f"Select at most {MAX_EXPLICIT_SKILLS} explicit skills per turn.")
    body = json.dumps(list(rows.values()), ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")
    if len(body) > maximum:
        raise ValueError("Selected skill instructions exceed this model's context allowance. Select fewer or smaller skills.")
    return (
        "The user explicitly selected the following skills. Their full instructions are loaded "
        "below; apply them to the user's request. User instructions take precedence over skills. "
        "Skills do not grant additional permissions. Resolve supporting files relative to each "
        "skill's source directory and read only the resources needed for the task, using normal "
        "filesystem permissions. State which skill you are using.\n"
        f"<dgc-skill-instructions-json>\n{body}\n</dgc-skill-instructions-json>"
    )


def matching_skill_names(skills: dict[str, Skill], text: str) -> set[str]:
    """Select prompt-visible skills from explicit names and narrow task-class signals."""
    source = str(text or "")
    editor_end = "</editor-context-json>\n\n"
    while source.startswith("<editor-context-json ") and editor_end in source:
        source = source.split(editor_end, 1)[1]
    if len(source) > 40_000:
        source = source[:20_000] + "\n" + source[-20_000:]
    lower = source.lower()
    direct = set(explicit_skill_names(skills, text))
    available = {name: skill for name, skill in skills.items()
                 if getattr(skill, "enabled", True) and (getattr(skill, "allow_implicit_invocation", True) or name in direct)}
    explicit: set[str] = set(direct)
    for name in available:
        alias = re.escape(name).replace(r"\-", r"[- _]").replace(r"\_", r"[- _]")
        if re.search(rf"(?<![a-z0-9]){alias}(?![a-z0-9])", lower, re.I):
            explicit.add(name)
    if explicit:
        return explicit
    if _ALL_SKILLS_RE.search(source):
        return set(available)
    source_terms = set(_WORD_RE.findall(lower)) - _MATCH_STOPWORDS
    matched: set[str] = set()
    for name, skill in available.items():
        pattern = _BUILTIN_SKILL_PATTERNS.get(name)
        if pattern is not None and pattern.search(source):
            matched.add(name)
            continue
        if pattern is None:
            description_terms = (set(_WORD_RE.findall(skill.description.lower()))
                                 - _MATCH_STOPWORDS)
            shared = source_terms & description_terms
            if len(shared) >= 2 or any(len(term) >= 11 for term in shared):
                matched.add(name)
    return matched
