"""Skills — reusable prompt packages.

A skill is a directory containing SKILL.md:

    ---
    name: commit
    description: Write a conventional commit message for the staged changes
    ---

    Instructions for the model... $ARGUMENTS is replaced with invocation args.

Discovery (project overrides user):
  <project>/.dgc/skills/<name>/SKILL.md
  ~/.dgc/skills/<name>/SKILL.md
"""
from __future__ import annotations

import os
import re
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .config import USER_SKILLS, BUILTIN_SKILLS
from .workspace import WorkspaceBoundaryError, is_within, read_regular_bytes, scan_directory_entries


MAX_SKILL_FILE_BYTES = 65_536
MAX_SKILL_BODY_CHARS = 30_000
MAX_SKILL_RENDER_CHARS = 32_000
MAX_SKILL_ARGUMENT_CHARS = 4_096
MAX_SKILL_DESCRIPTION_CHARS = 320
MAX_SKILLS = 64
MAX_SKILLS_PER_ROOT = 64
MAX_SKILL_SCAN_ENTRIES = 4_096

_NAME_CLEAN_RE = re.compile(r"[^a-z0-9._-]+")
_ALL_SKILLS_RE = re.compile(
    r"\b(?:use|invoke|load|run|choose|show|list|available|which)\b.{0,24}\bskills?\b|"
    r"/(?:skills?|skill)(?:\s|$)", re.IGNORECASE | re.DOTALL)
_BUILTIN_SKILL_PATTERNS = {
    "batch": re.compile(r"\b(?:batch|fan[- ]?out|repetitive change|many[- ]file change)\b", re.I),
    "code-review": re.compile(r"\b(?:code review|review (?:the )?(?:diff|changes|pr)|pull request review)\b", re.I),
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


def parse_skill_text(text: str, path: Path) -> Skill | None:
    """Parse already-bounded UTF-8 skill text into safe prompt metadata and instructions."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_SKILL_FILE_BYTES:
        return None
    name, description, body = path.parent.name, "", text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end == -1:
            return None
        front = text[3:end].strip()
        body = text[end + 4:].strip()
        for line in front.splitlines():
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            key, value = key.strip().lower(), value.strip()
            if key == "name" and value:
                name = value
            elif key == "description":
                description = value
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
    return parse_skill_text(text, path)


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


def discover_skills(project_root: Path) -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    # Highest-precedence roots are visited first. setdefault preserves project > user > bundled
    # without allowing a lower-priority catalog to consume the global count bound first.
    roots = (project_root / ".dgc" / "skills", USER_SKILLS, BUILTIN_SKILLS)
    for base in roots:
        for skill_md in _skill_paths(base):
            skill = _parse_skill(skill_md)
            if skill and (skill.name in skills or len(skills) < MAX_SKILLS):
                skills.setdefault(skill.name, skill)
    return dict(sorted(skills.items()))


def skill_catalog(skills: dict[str, Skill], project_root: Path) -> list[dict[str, str]]:
    """Return bounded public metadata, including which precedence layer supplied each skill."""
    project_skills = _frozen(Path(project_root) / ".dgc" / "skills")
    rows = []
    for index, skill in enumerate(skills.values()):
        if index >= MAX_SKILLS:
            break
        if not isinstance(skill, Skill):
            continue
        source = ("project" if is_within(skill.path, project_skills) else
                  "user" if is_within(skill.path, USER_SKILLS) else
                  "builtin" if is_within(skill.path, BUILTIN_SKILLS) else "unknown")
        rows.append({"name": normalize_skill_name(skill.name),
                     "description": _clean_description(skill.description),
                     "source": source})
    return rows


def matching_skill_names(skills: dict[str, Skill], text: str) -> set[str]:
    """Select prompt-visible skills from explicit names and narrow task-class signals."""
    source = str(text or "")
    editor_end = "</editor-context-json>\n\n"
    if source.startswith("<editor-context-json ") and editor_end in source:
        source = source.split(editor_end, 1)[1]
    if len(source) > 40_000:
        source = source[:20_000] + "\n" + source[-20_000:]
    lower = source.lower()
    explicit: set[str] = set()
    for name in skills:
        alias = re.escape(name).replace(r"\-", r"[- _]").replace(r"\_", r"[- _]")
        if re.search(rf"(?<![a-z0-9]){alias}(?![a-z0-9])", lower, re.I):
            explicit.add(name)
    if explicit:
        return explicit
    if _ALL_SKILLS_RE.search(source):
        return set(skills)
    source_terms = set(_WORD_RE.findall(lower)) - _MATCH_STOPWORDS
    matched: set[str] = set()
    for name, skill in skills.items():
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
