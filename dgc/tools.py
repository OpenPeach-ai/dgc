"""Tool schemas (OpenAI function-calling format) and their executors."""
from __future__ import annotations

import difflib
import glob as globmod
import html
import itertools as _itertools
import os
import re
import subprocess
import threading as _threading
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
    _fn("bash", "Run a bash command on the user's machine. Returns stdout+stderr. "
        "Set background:true for long-running commands (dev servers, watchers) — it returns "
        "immediately with a task id; read its output later with bash_output.",
        {"command": {"type": "string"},
         "timeout": {"type": "integer", "description": "Seconds (default from config)"},
         "background": {"type": "boolean", "default": False}}, ["command"]),
    _fn("bash_output", "Read accumulated output + status of a background bash task.",
        {"id": {"type": "string"}}, ["id"]),
    _fn("bash_kill", "Terminate a background bash task.",
        {"id": {"type": "string"}}, ["id"]),
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
    _fn("web_search", "Search the web for current information (news, docs, versions, facts). Returns titles, "
        "URLs and snippets; follow up with web_fetch on a result URL to read the full page. Uses the user's "
        "configured provider (DuckDuckGo by default; Brave/Tavily/SearXNG if set up).",
        {"query": {"type": "string", "description": "The search query"}}, ["query"]),
    _fn("todo", "Replace the session todo list. Use it to track multi-step work.",
        {"todos": {"type": "array", "items": {"type": "object", "properties": {
            "content": {"type": "string"},
            "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}},
            "required": ["content", "status"]}}}, ["todos"]),
    _fn("skill", "Load a skill (reusable instruction package) by name. Use when a listed skill matches the task.",
        {"name": {"type": "string"}, "args": {"type": "string", "default": ""}}, ["name"]),
    _fn("add_skill", "Install a skill from a URL (a raw SKILL.md, or a GitHub link to one). Use when the "
        "user shares a skill link and asks you to add/install it. After installing, it's available via the "
        "`skill` tool.",
        {"url": {"type": "string", "description": "URL to the SKILL.md (raw or a github.com/.../SKILL.md link)"},
         "name": {"type": "string", "description": "Optional name; inferred from the skill if omitted"}}, ["url"]),
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
    _fn("task", "Delegate a self-contained sub-task to a fresh sub-agent that works autonomously "
        "(its own context, the same tools) and returns a summary. Use for large, independent chunks "
        "of work you want handled end-to-end without cluttering the main conversation.",
        {"description": {"type": "string", "description": "A short label for the sub-task"},
         "prompt": {"type": "string", "description": "Full, self-contained instructions for the sub-agent"},
         "agent": {"type": "string", "description": "Optional: name of a defined sub-agent "
                   "(.dgc/agents/<name>.md) to use its persona, model and host"}},
        ["description", "prompt"]),
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


# Characters local models routinely substitute for their ASCII originals (1:1, so string
# indices are preserved when we normalise both haystack and needle before matching).
_CONFUSABLES = {
    "‘": "'", "’": "'", "‛": "'",          # curly / reversed single quotes
    "“": '"', "”": '"', "‟": '"',          # curly double quotes
    "–": "-", "—": "-", "−": "-",           # en / em dash, minus sign
    " ": " ", " ": " ", " ": " ", " ": " ",  # nbsp / thin-space variants
    "…": "...",                                        # ellipsis (len change → tier skips index map)
}
# only the 1:1 entries are index-preserving; ellipsis (1→3) is excluded from the indexed tier
_CONF_1TO1 = {k: v for k, v in _CONFUSABLES.items() if len(v) == 1}


def _norm1(s: str) -> str:
    return "".join(_CONF_1TO1.get(c, c) for c in s)


class _Ambiguous(Exception):
    def __init__(self, count: int):
        self.count = count


def _occ(hay: str, needle: str) -> list[int]:
    out, i = [], 0
    while needle:
        j = hay.find(needle, i)
        if j < 0:
            break
        out.append(j)
        i = j + len(needle)
    return out


def _apply_edit(content: str, old: str, new: str, replace_all: bool):
    """Tiered match, most-exact first, so a flaky local model's near-miss still lands.
    Returns (updated, count, how) or None; raises _Ambiguous if a tier matches >1 unguarded."""
    if not old:
        return None
    # Tiers 1 & 3 are index-aligned to `content` (identity / 1:1 confusable map), so we can
    # splice replacements straight into the ORIGINAL text and preserve untouched bytes.
    for how, hay, needle in (("exact", content, old),
                             ("normalized quotes/spaces", _norm1(content), _norm1(old))):
        occ = _occ(hay, needle)
        if not occ:
            continue
        if len(occ) > 1 and not replace_all:
            raise _Ambiguous(len(occ))
        idxs = occ if replace_all else occ[:1]
        parts, last = [], 0
        for j in idxs:
            parts.append(content[last:j]); parts.append(new); last = j + len(needle)
        parts.append(content[last:])
        return "".join(parts), len(idxs), how
    # Tier 2: LF/CRLF mismatch (writes back normalised line endings)
    if "\r\n" in content or "\r\n" in old:
        nc, no = content.replace("\r\n", "\n"), old.replace("\r\n", "\n")
        occ = _occ(nc, no)
        if occ:
            if len(occ) > 1 and not replace_all:
                raise _Ambiguous(len(occ))
            updated = nc.replace(no, new) if replace_all else nc.replace(no, new, 1)
            return updated, len(occ) if replace_all else 1, "normalized line endings"
    # Tier 4: whitespace-flexible, line-anchored (indentation / trailing-space differences)
    return _lineflex(content, old, new, replace_all)


def _lineflex(content: str, old: str, new: str, replace_all: bool):
    clines = content.splitlines(keepends=True)
    olines = old.splitlines()
    if len(olines) < 1 or not any(l.strip() for l in olines):
        return None                                # too weak to anchor safely

    def key(s: str) -> str:
        return _norm1(s).strip()

    okeys = [key(l) for l in olines]
    ckeys = [key(l) for l in clines]
    n = len(okeys)
    starts = [i for i in range(len(clines) - n + 1) if ckeys[i:i + n] == okeys]
    if not starts:
        return None
    if len(starts) > 1 and not replace_all:
        raise _Ambiguous(len(starts))
    targets = set(starts if replace_all else starts[:1])

    def indent(s: str) -> str:
        return s[:len(s) - len(s.lstrip())]

    o_ind = indent(next((l for l in olines if l.strip()), ""))   # old_string's own base indent
    out, k = [], 0
    while k < len(clines):
        if k in targets:
            # re-apply the indentation the FILE has beyond old_string, so the replacement
            # doesn't collapse to column 0 when the model under-indented old/new.
            c_ind = next((indent(clines[k + o]) for o in range(n) if clines[k + o].strip()), "")
            extra = c_ind[:len(c_ind) - len(o_ind)] if len(c_ind) >= len(o_ind) else ""
            block = "\n".join(extra + ln if ln.strip() else ln for ln in new.split("\n"))
            end = k + n - 1
            had_nl = clines[end].endswith("\n") if end < len(clines) else True
            if had_nl and not block.endswith("\n"):
                block += "\n"
            out.append(block)
            k += n
        else:
            out.append(clines[k]); k += 1
    return "".join(out), len(targets), "flexible whitespace"


def _edit_error(content: str, old: str) -> str:
    """A self-correcting error: point the model at the closest region so it can retry."""
    olines = old.splitlines() or [old]
    clines = content.splitlines()
    first = _norm1(olines[0]).strip()
    best_i, best_r = None, 0.0
    for i, cl in enumerate(clines):
        r = difflib.SequenceMatcher(None, _norm1(cl).strip(), first).ratio()
        if r > best_r:
            best_r, best_i = r, i
    if best_i is not None and best_r >= 0.6:
        lo, hi = max(0, best_i - 2), min(len(clines), best_i + len(olines) + 2)
        ctx = "\n".join(f"{j + 1:>5}  {clines[j]}" for j in range(lo, hi))
        return ("error: old_string not found. The closest region in the file is below — the "
                "difference is likely whitespace, indentation, or quotes. Copy it verbatim and "
                f"retry:\n{ctx}")
    return "error: old_string not found in file — read the file again and match it exactly"


def edit_file(args: dict, ctx) -> str:
    p = _resolve(str(args.get("path", "")), ctx.project_root)
    if not p.exists():
        return f"error: no such file: {p} (use write_file to create it)"
    old_string, new_string = str(args.get("old_string", "")), str(args.get("new_string", ""))
    replace_all = bool(args.get("replace_all"))
    try:
        raw = p.read_bytes()
        text = raw.decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        return f"error: {e}"
    crlf = raw.count(b"\r\n")                       # remember the file's dominant line ending
    content = text.replace("\r\n", "\n")            # match on LF; restore on write
    try:
        result = _apply_edit(content, old_string.replace("\r\n", "\n"),
                             new_string.replace("\r\n", "\n"), replace_all)
    except _Ambiguous as a:
        return (f"error: old_string matches {a.count} times — add more surrounding context to "
                "make it unique, or set replace_all to change every occurrence")
    if result is None:
        return _edit_error(content, old_string.replace("\r\n", "\n"))
    updated, count, how = result
    out = updated.replace("\n", "\r\n") if crlf and crlf * 2 >= content.count("\n") else updated
    p.write_bytes(out.encode("utf-8"))
    note = "" if how == "exact" else f"  [matched via {how}]"
    return f"edited {p} ({count} replacement(s)){note}\n{_diff(content, updated, str(p))}"


def _diff(old: str, new: str, path: str) -> str:
    if old == new:
        return "(no changes)"
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(),
                                      f"a/{path}", f"b/{path}", lineterm="", n=2))
    if len(lines) > 80:
        lines = lines[:80] + [f"… diff truncated ({len(lines) - 80} more lines)"]
    return "\n".join(lines)


_BG: dict[str, dict] = {}          # background bash tasks: id -> {proc, buf, lock, cmd}
_BG_N = _itertools.count(1)


def bash(args: dict, ctx) -> str:
    command = str(args.get("command", ""))
    if args.get("background"):
        return _bash_background(command, ctx)
    timeout = int(args.get("timeout") or ctx.config.get("bash_timeout", 120))
    from . import sandbox
    argv = sandbox.wrap(command, ctx.project_root) if sandbox.active(ctx.config) else None
    try:
        if argv:                                   # confined: writable project dir + /tmp only
            proc = subprocess.run(argv, capture_output=True, text=True,
                                  timeout=timeout, cwd=str(ctx.project_root))
        else:
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


def _bash_background(command: str, ctx) -> str:
    bid = f"bg{next(_BG_N)}"
    try:
        proc = subprocess.Popen(command, shell=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True,
                                cwd=str(ctx.project_root), executable="/bin/bash")
    except Exception as e:
        return f"error: could not start background command: {e}"
    entry = {"proc": proc, "buf": [], "lock": _threading.Lock(), "cmd": command}
    _BG[bid] = entry

    def reader():
        try:
            for line in proc.stdout:
                with entry["lock"]:
                    entry["buf"].append(line)
        except Exception:
            pass
        proc.wait()

    _threading.Thread(target=reader, daemon=True).start()
    return f"started background task {bid}: {command}\nRead its output with bash_output(id=\"{bid}\")."


def bash_output(args: dict, ctx) -> str:
    bid = str(args.get("id", ""))
    e = _BG.get(bid)
    if not e:
        return f"no background task '{bid}' (active: {', '.join(_BG) or 'none'})"
    with e["lock"]:
        out = "".join(e["buf"])
    rc = e["proc"].poll()
    status = "running" if rc is None else f"exited {rc}"
    if len(out) > MAX_BASH_OUT:
        out = out[-MAX_BASH_OUT:]
    return f"[{bid} · {status}] {e['cmd']}\n{out.strip() or '(no output yet)'}"


def bash_kill(args: dict, ctx) -> str:
    bid = str(args.get("id", ""))
    e = _BG.get(bid)
    if not e:
        return f"no background task '{bid}'"
    try:
        e["proc"].terminate()
    except Exception:
        pass
    return f"killed {bid}"


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


def web_search(args: dict, ctx) -> str:
    from .search import search
    cfg = ctx.config
    return search(str(args.get("query", "")),
                  provider=str(cfg.get("search_provider", "duckduckgo")),
                  api_key=str(cfg.get("search_api_key", "")),
                  url=str(cfg.get("search_url", "")))


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


def add_skill(args: dict, ctx) -> str:
    from .config import USER_SKILLS
    from .skills import discover_skills
    url = str(args.get("url", "")).strip()
    if not url:
        return "error: a url is required"
    raw = url                                    # normalise a GitHub blob link to its raw form
    if "github.com" in raw and "/blob/" in raw:
        raw = raw.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")
    try:
        r = requests.get(raw, timeout=20, headers={"User-Agent": "dgc/skill-install"})
        r.raise_for_status()
        content = r.text
    except requests.RequestException as e:
        return f"error fetching the skill: {e}"
    if re.match(r"\s*(<!doctype|<html)", content, re.I):
        return (f"error: {raw} returned an HTML page, not a SKILL.md. Point me at the RAW file "
                "(e.g. a raw.githubusercontent.com URL or a link ending in /SKILL.md).")
    name = str(args.get("name", "")).strip()
    if not name:                                 # frontmatter `name:` wins, else the URL's folder/file
        m = re.search(r"(?m)^name:\s*(.+)$", content)
        name = m.group(1).strip() if m else raw.rstrip("/").rsplit("/", 1)[-1].removesuffix(".md")
        if name.lower() in ("skill", "skill.md"):
            name = raw.rstrip("/").split("/")[-2] if "/" in raw else name
    name = re.sub(r"[^a-zA-Z0-9_-]+", "-", name).strip("-").lower() or "skill"
    dest = USER_SKILLS / name
    try:
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "SKILL.md").write_text(content)
    except OSError as e:
        return f"error saving the skill: {e}"
    try:
        ctx.skills.clear(); ctx.skills.update(discover_skills(ctx.project_root))  # live, usable now
    except Exception:
        pass
    return (f"installed skill '{name}' → {dest / 'SKILL.md'} ({len(content)} bytes). "
            f"It's available now — call the `skill` tool with name={name!r} to use it.")


def save_memory(args: dict, ctx) -> str:
    from .memory import add_memory
    scope = str(args.get("scope", "project"))
    path = add_memory(str(args.get("memory", "")), ctx.project_root, scope)
    return f"memory saved to {path}"


EXECUTORS = {
    "read_file": read_file, "write_file": write_file, "edit_file": edit_file,
    "bash": bash, "bash_output": bash_output, "bash_kill": bash_kill,
    "glob": glob_tool, "grep": grep_tool, "web_fetch": web_fetch,
    "web_search": web_search, "todo": todo, "skill": skill_tool, "add_skill": add_skill,
    "save_memory": save_memory,
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
