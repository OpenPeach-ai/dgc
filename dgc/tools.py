"""Tool schemas (OpenAI function-calling format) and their executors."""
from __future__ import annotations

import difflib
import glob as globmod
import html
import os
import re
import subprocess
from pathlib import Path

import requests

MAX_READ_LINES = 2000
MAX_LINE_LEN = 2000
MAX_BASH_OUT = 30000
MAX_GREP_MATCHES = 200
MAX_GLOB_RESULTS = 100
MAX_FETCH_CHARS = 8000

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next",
             "dist", "build", ".pytest_cache", ".mypy_cache", "target"}

# ---------------------------------------------------------------- schemas ---

def _fn(name, description, properties, required):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required}}}


TOOL_SCHEMAS = [
    _fn("read_file", "Read a text file. Returns numbered lines. Use offset/limit to page.",
        {"path": {"type": "string", "description": "File path (relative to project root or absolute)"},
         "offset": {"type": "integer", "description": "1-based start line"},
         "limit": {"type": "integer", "description": "Max lines to read"}}, ["path"]),
    _fn("write_file", "Create or completely overwrite a file. Parent dirs are created.",
        {"path": {"type": "string"}, "content": {"type": "string", "description": "Full file content"}},
        ["path", "content"]),
    _fn("edit_file", "Replace an exact string in a file. old_string must match exactly once unless replace_all is true.",
        {"path": {"type": "string"},
         "old_string": {"type": "string"},
         "new_string": {"type": "string"},
         "replace_all": {"type": "boolean", "default": False}},
        ["path", "old_string", "new_string"]),
    _fn("bash", "Run a bash command on the user's machine. Returns stdout+stderr.",
        {"command": {"type": "string"},
         "timeout": {"type": "integer", "description": "Seconds (default from config)"}}, ["command"]),
    _fn("glob", "Find files by glob pattern, e.g. 'src/**/*.py'. Sorted by modification time.",
        {"pattern": {"type": "string"},
         "path": {"type": "string", "description": "Directory to search (default: project root)"}}, ["pattern"]),
    _fn("grep", "Search file contents with a regex. Returns file:line: content matches.",
        {"pattern": {"type": "string", "description": "Regex"},
         "path": {"type": "string", "description": "File or directory (default: project root)"},
         "glob": {"type": "string", "description": "Only search files matching this glob, e.g. '*.py'"}},
        ["pattern"]),
    _fn("web_fetch", "Fetch a URL and return its text content (HTML stripped).",
        {"url": {"type": "string"}}, ["url"]),
    _fn("todo", "Replace the session todo list. Use it to track multi-step work.",
        {"todos": {"type": "array", "items": {"type": "object", "properties": {
            "content": {"type": "string"},
            "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}},
            "required": ["content", "status"]}}}, ["todos"]),
    _fn("skill", "Load a skill (reusable instruction package) by name. Use when a listed skill matches the task.",
        {"name": {"type": "string"}, "args": {"type": "string", "default": ""}}, ["name"]),
    _fn("save_memory", "Save a durable fact/preference to DGC.md memory.",
        {"memory": {"type": "string"},
         "scope": {"type": "string", "enum": ["project", "user"], "default": "project"}}, ["memory"]),
    _fn("present_plan", "Plan mode only: present the finished implementation plan for user approval.",
        {"plan": {"type": "string", "description": "The full plan, markdown"}}, ["plan"]),
    _fn("propose_options", "Ask the user to CHOOSE between options when the decision is genuinely theirs "
        "(two valid approaches, an ambiguous request). Presents the choices and waits for their pick. "
        "Don't use it for things you can decide yourself.",
        {"question": {"type": "string", "description": "What you're asking them to decide"},
         "options": {"type": "array", "items": {"type": "string"},
                     "description": "The choices, most-recommended first"}},
        ["question", "options"]),
]

SCHEMAS_BY_NAME = {t["function"]["name"] for t in TOOL_SCHEMAS}

# ------------------------------------------------------------- executors ---

def _resolve(path: str, root: Path) -> Path:
    p = Path(path).expanduser()
    return p if p.is_absolute() else (root / p).resolve()


def _trunc_line(line: str) -> str:
    return line[:MAX_LINE_LEN] + "…" if len(line) > MAX_LINE_LEN else line


def read_file(args: dict, ctx) -> str:
    p = _resolve(str(args.get("path", "")), ctx.project_root)
    if not p.exists():
        return f"error: no such file: {p}"
    if p.is_dir():
        try:
            entries = sorted(os.listdir(p))[:200]
        except OSError as e:
            return f"error: {e}"
        return f"directory listing of {p}:\n" + "\n".join(entries)
    try:
        raw = p.read_bytes()
    except OSError as e:
        return f"error: {e}"
    if b"\x00" in raw[:8192]:
        return f"error: {p} looks like a binary file"
    lines = raw.decode("utf-8", errors="replace").splitlines()
    offset = max(1, int(args.get("offset") or 1))
    limit = min(int(args.get("limit") or MAX_READ_LINES), MAX_READ_LINES)
    chunk = lines[offset - 1: offset - 1 + limit]
    out = [f"{i}\t{_trunc_line(l)}" for i, l in enumerate(chunk, start=offset)]
    if offset - 1 + limit < len(lines):
        out.append(f"… ({len(lines) - (offset - 1 + limit)} more lines)")
    return "\n".join(out) if out else "(empty)"


def write_file(args: dict, ctx) -> str:
    p = _resolve(str(args.get("path", "")), ctx.project_root)
    content = str(args.get("content", ""))
    old = ""
    if p.exists():
        try:
            old = p.read_text()
        except (OSError, UnicodeDecodeError):
            old = ""
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    diff = _diff(old, content, str(p))
    return f"wrote {len(content)} bytes to {p}\n{diff}"


def edit_file(args: dict, ctx) -> str:
    p = _resolve(str(args.get("path", "")), ctx.project_root)
    if not p.exists():
        return f"error: no such file: {p} (use write_file to create it)"
    old_string, new_string = str(args.get("old_string", "")), str(args.get("new_string", ""))
    replace_all = bool(args.get("replace_all"))
    try:
        content = p.read_text()
    except (OSError, UnicodeDecodeError) as e:
        return f"error: {e}"
    if old_string not in content and "\n" in old_string:
        # tolerate LF/CRLF mismatch
        norm = content.replace("\r\n", "\n")
        if old_string.replace("\r\n", "\n") in norm:
            content = norm
            old_string = old_string.replace("\r\n", "\n")
    count = content.count(old_string)
    if count == 0:
        return "error: old_string not found in file — read the file again and match exactly"
    if count > 1 and not replace_all:
        return f"error: old_string matches {count} times — add more context or set replace_all"
    updated = content.replace(old_string, new_string) if replace_all \
        else content.replace(old_string, new_string, 1)
    p.write_text(updated)
    return f"edited {p} ({count if replace_all else 1} replacement(s))\n{_diff(content, updated, str(p))}"


def _diff(old: str, new: str, path: str) -> str:
    if old == new:
        return "(no changes)"
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(),
                                      f"a/{path}", f"b/{path}", lineterm="", n=2))
    if len(lines) > 80:
        lines = lines[:80] + [f"… diff truncated ({len(lines) - 80} more lines)"]
    return "\n".join(lines)


def bash(args: dict, ctx) -> str:
    command = str(args.get("command", ""))
    timeout = int(args.get("timeout") or ctx.config.get("bash_timeout", 120))
    try:
        proc = subprocess.run(command, shell=True, capture_output=True, text=True,
                              timeout=timeout, cwd=str(ctx.project_root),
                              executable="/bin/bash")
    except subprocess.TimeoutExpired:
        return f"error: command timed out after {timeout}s"
    out = (proc.stdout or "") + (proc.stderr or "")
    if len(out) > MAX_BASH_OUT:
        half = MAX_BASH_OUT // 2
        out = out[:half] + f"\n… output truncated ({len(out)} chars total) …\n" + out[-half:]
    return f"exit code: {proc.returncode}\n{out.strip() or '(no output)'}"


def glob_tool(args: dict, ctx) -> str:
    pattern = str(args.get("pattern", ""))
    base = _resolve(str(args.get("path", "")), ctx.project_root) if args.get("path") else ctx.project_root
    matches = [p for p in globmod.glob(str(base / "**" / pattern) if not pattern.startswith("/")
                                       else pattern, recursive=True)
               if os.path.isfile(p)]
    matches = [m for m in matches if not any(part in SKIP_DIRS for part in Path(m).parts)]
    matches.sort(key=lambda m: -os.path.getmtime(m))
    rel = [os.path.relpath(m, ctx.project_root) for m in matches[:MAX_GLOB_RESULTS]]
    if len(matches) > MAX_GLOB_RESULTS:
        rel.append(f"… ({len(matches) - MAX_GLOB_RESULTS} more)")
    return "\n".join(rel) or "no matches"


def grep_tool(args: dict, ctx) -> str:
    pattern = str(args.get("pattern", ""))
    target = _resolve(str(args.get("path", "")), ctx.project_root) if args.get("path") else ctx.project_root
    file_glob = args.get("glob")
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return f"error: bad regex: {e}"
    if target.is_file():
        files = [target]
    else:
        files = []
        for dirpath, dirnames, filenames in os.walk(target):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                if file_glob and not globmod.fnmatch.fnmatch(fn, str(file_glob)):
                    continue
                files.append(Path(dirpath) / fn)
    matches, files_hit = [], set()
    for f in files:
        if len(matches) >= MAX_GREP_MATCHES:
            break
        try:
            if f.stat().st_size > 2_000_000:
                continue
            text = f.read_text(errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                rel = os.path.relpath(f, ctx.project_root)
                matches.append(f"{rel}:{i}: {_trunc_line(line.strip())}")
                files_hit.add(rel)
                if len(matches) >= MAX_GREP_MATCHES:
                    break
    header = f"{len(matches)} match(es) in {len(files_hit)} file(s)\n" if matches else ""
    return header + "\n".join(matches) if matches else "no matches"


_TAG = re.compile(r"<[^>]+>")


def web_fetch(args: dict, ctx) -> str:
    url = str(args.get("url", ""))
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": "dgc/0.1"})
        r.raise_for_status()
    except requests.RequestException as e:
        return f"error: {e}"
    text = r.text
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    text = _TAG.sub(" ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    if len(text) > MAX_FETCH_CHARS:
        text = text[:MAX_FETCH_CHARS] + "\n… (truncated)"
    return text or "(empty page)"


def todo(args: dict, ctx) -> str:
    ctx.todos = [{"content": str(t.get("content", "")),
                  "status": t.get("status", "pending")} for t in args.get("todos", [])]
    if ctx.on_todo:
        ctx.on_todo(ctx.todos)
    return "todo list updated:\n" + "\n".join(
        f"[{'x' if t['status'] == 'done' else '~' if t['status'] == 'in_progress' else ' '}] {t['content']}"
        for t in ctx.todos) or "todo list cleared"


def skill_tool(args: dict, ctx) -> str:
    name = str(args.get("name", ""))
    sk = ctx.skills.get(name)
    if not sk:
        return f"error: unknown skill {name!r}. Available: {', '.join(ctx.skills) or '(none)'}"
    return f"<skill name={sk.name!r}>\n{sk.render(str(args.get('args', '')))}\n</skill>"


def save_memory(args: dict, ctx) -> str:
    from .memory import add_memory
    scope = str(args.get("scope", "project"))
    path = add_memory(str(args.get("memory", "")), ctx.project_root, scope)
    return f"memory saved to {path}"


EXECUTORS = {
    "read_file": read_file, "write_file": write_file, "edit_file": edit_file,
    "bash": bash, "glob": glob_tool, "grep": grep_tool, "web_fetch": web_fetch,
    "todo": todo, "skill": skill_tool, "save_memory": save_memory,
}


def execute(name: str, args: dict, ctx) -> str:
    fn = EXECUTORS.get(name)
    if not fn:
        return f"error: unknown tool {name!r}"
    if "_unparsed" in args:
        return f"error: could not parse tool arguments as JSON: {args['_unparsed'][:200]}"
    try:
        return fn(args, ctx)
    except Exception as e:  # never let a tool crash the loop
        return f"error: {type(e).__name__}: {e}"
