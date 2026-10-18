"""Authoritative Pip characters and the reviewed roles implemented by this runner.

Characters are presentation identities, not permission bundles. Inspection roles are
read-only. Patch/Pulse require an explicit per-run handoff; their chats remain read-only.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass

from .workspace_registry import RegistryError


@dataclass(frozen=True)
class PipType:
    id: str
    name: str
    role: str
    description: str
    available: bool
    unavailable_reason: str | None
    character_index: int
    default_name: str
    default_goal: str
    engine: str | None
    instructions: str = ""


_TYPES = (
    # "Core" is two things to a user: DGC's main chat, and the Pip named Core on the Pips page. Both are one
    # character, so the catalog says so (ERP session review, 2026-10-18: the user had to ask what the Core Pip was).
    PipType("core", "Core", "Main chat",
            "The character of DGC's main chat, which coordinates the conversation and its specialist work. Your "
            "Primary Pip (the Personal Pip named Core on the Pips page) uses this character too.", False,
            "Core is the main chat's character, and your Primary Pip uses it too: a Personal Pip for everyday tasks, "
            "with no project files or shell. It can't be created as a project Pip; choose another character for "
            "project work.", 0, "Core", "", None),
    PipType("scout", "Scout", "Repository exploration", "Reads the code to map out a project before a review. It doesn’t run commands.", True,
            None, 1, "Repository scout", "Explore the approved source structure and identify source-backed areas that deserve closer review.", "source_audit",
            "Your role is Scout: repository exploration. Orient the review using repository layout, entry points and component boundaries. "
            "Describe useful orientation in the summary; include findings only for specific source-backed concerns. "
            "This is source inspection, not a complete dependency inventory or command execution."),
    PipType("lens", "Lens", "Repository research", "Answers a question from the project’s code. It doesn’t search the web.", True,
            None, 2, "Repository researcher", "Research the approved question using approved source files and explain what the inspected source establishes and leaves uncertain.", "source_audit",
            "Your role is Lens: repository research. Trace the approved question through the committed source and explain the relevant behavior in the summary. "
            "Separate evidence from inference; findings remain specific source-backed concerns. Do not browse the web or claim external research."),
    PipType("patch", "Patch", "File fixes", "Edits only the files you approve, in a private copy. You approve each fix in a handoff.", True,
            None, 3, "File fixer", "Prepare a bounded fix for an approved source finding, preserve unrelated code, and report the resulting diff for user review.", "patch",
            "Your role is Patch: isolated file fixes. During conversation, only inspect and discuss source. "
            "During an explicitly approved patch run, edit only the paths allowed by that handoff. "
            "Never apply changes to the user's workspace, commit, merge, deploy, install dependencies or run commands. "
            "Report what changed and what remains uncertain. Test results come from the runner, not your own assertion."),
    PipType("rook", "Rook", "Code review", "Reviews the code for bugs and for code that will be hard to maintain.", True,
            None, 4, "Code reviewer", "Review the approved source for correctness and maintainability concerns, citing exact source evidence and inspection limits.", "source_audit",
            "Your role is Rook: code review. Inspect the approved scope for correctness, edge cases and maintainability concerns. "
            "Prioritize specific, source-backed findings. Do not claim that a suspected issue is reproduced or that tests passed."),
    PipType("pulse", "Pulse", "Test execution", "Runs the exact test commands you approve, from a handoff or its own command plan.", True,
            None, 5, "Test runner", "Inspect an approved finding and interpret the runner's recorded test results, keeping source evidence and test evidence distinct.", "test",
            "Your role is Pulse: reviewed test execution. Your model tools remain read-only in conversation and execution. "
            "The runner executes only the exact commands approved in a handoff. Do not execute or invent extra commands, "
            "change files, install dependencies, or infer that a test passed from source alone. "
            "Describe inspection limits and distinguish recorded command results from model assessments."),
    PipType("lock", "Lock", "Security review", "Reviews the code for possible security problems. It never runs attacks.", True,
            None, 6, "Security reviewer", "Review the approved source for potential security issues at trust boundaries, with exact source evidence and explicit uncertainty.", "source_audit",
            "Your role is Lock: source security review. Inspect trust boundaries, input validation, authorization and sensitive-data handling in the approved scope. "
            "Report potential vulnerabilities as source-based assessments, not verified exploits. Do not execute code, attack services, or claim complete security coverage."),
    PipType("quill", "Quill", "Documentation drafts", "Writes a private documentation draft from the code for you to review. It never changes project files.", True,
            None, 7, "Documentation writer", "Draft documentation from approved source, cite exact source excerpts, and distinguish assumptions from established behavior.", "documentation_draft",
            "Your role is Quill: documentation drafts. Inspect the approved source and write clear draft prose with exact source citations. "
            "Separate observed behavior from assumptions. The controller saves a private artifact for review; you cannot write files, "
            "execute commands, apply changes, publish, or assert that draft prose has been independently verified."),
)
_BY_ID = {item.id: item for item in _TYPES}


def catalog() -> list[dict]:
    return [{key: value for key, value in asdict(item).items() if key != "instructions"} for item in _TYPES]


def require_type(value: str) -> PipType:
    if not isinstance(value, str) or value not in _BY_ID:
        raise RegistryError("invalid_pip_type", "Choose a supported Pip type from the type directory.")
    item = _BY_ID[value]
    if not item.available and item.id != "core":
        raise RegistryError("unavailable_pip_type", item.unavailable_reason or "This Pip type is not available.")
    return item


def role_pin(value: str) -> dict:
    item = require_type(value)
    return {"pip_type": item.id, "role_instructions": item.instructions,
            "role_digest": hashlib.sha256(item.instructions.encode("utf-8")).hexdigest()}


def validated_role(manifest: dict) -> PipType:
    if not isinstance(manifest, dict) or not isinstance(manifest.get("job"), dict):
        raise RegistryError("role_mismatch", "The run has no valid pinned job identity.")
    job = manifest["job"]
    fields = {"pip_type", "role_instructions", "role_digest"}
    if not fields.intersection(manifest) and "pip_type" not in job:
        return require_type("rook")  # Only genuinely pre-type manifests use the legacy default.
    item = require_type(manifest.get("pip_type"))
    if job.get("pip_type") != item.id or any(manifest.get(key) != value for key, value in role_pin(item.id).items()):
        raise RegistryError("role_mismatch", "The pinned Pip role changed or is incomplete. Start a new run with the current role.")
    return item
