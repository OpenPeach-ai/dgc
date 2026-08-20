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

from dataclasses import dataclass
from pathlib import Path

from .config import USER_SKILLS, BUILTIN_SKILLS


@dataclass
class Skill:
    name: str
    description: str
    body: str
    path: Path

    def render(self, arguments: str = "") -> str:
        body = self.body.replace("$ARGUMENTS", arguments).replace("${ARGUMENTS}", arguments)
        return body.strip()


def _parse_skill(path: Path) -> Skill | None:
    try:
        text = path.read_text()
    except OSError:
        return None
    name, description, body = path.parent.name, "", text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
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
    return Skill(name=name, description=description, body=body, path=path)


def discover_skills(project_root: Path) -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    # precedence low→high: bundled defaults, then user, then project (later wins on name clash)
    for base in (BUILTIN_SKILLS, USER_SKILLS, project_root / ".dgc" / "skills"):
        if not base.is_dir():
            continue
        for skill_md in sorted(base.glob("*/SKILL.md")):
            skill = _parse_skill(skill_md)
            if skill:
                skills[skill.name] = skill  # later (project) wins
    return skills
