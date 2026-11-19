"""DGC's own settings, changed by asking (0.52).

`dgc_settings_read` (read-only) lists what DGC may change with its value now and one line each, the permission rules,
and Dev Mode with its limits and what raising each costs. `dgc_settings` changes one: an ordinary setting, a permission
rule (a tool and a pattern, `Bash(npm test:*)`), or a Dev Mode limit — that last only while Dev Mode is on AND the user's
own "Let DGC change Dev Mode settings" switch is on. The ordinary permission engine decides each call (auto mode: no
card, his call; the other modes ask). Every change is recorded so Undo can put it back while the setting still holds what
the change wrote. Never through it: keys and secrets, the sandbox, redaction, hooks, MCP server commands, language
servers, browser paths, network-facing ports and hosts, provider addresses, worktree roots, Dev Mode itself and the
switch that lets DGC change its limits: those are the user's, in Settings.
"""
from __future__ import annotations

import json
import os
import secrets as _secrets
import threading
import time
from pathlib import Path

# key -> (kind, rule, what it is). kind: bool | int (lo, hi) | float (lo, hi) | choice (values) | text (max) | list (max)
ORDINARY: dict[str, tuple] = {
    "model": ("text", 200, "The model Work sessions use"),
    "mode": ("choice", ("default", "acceptEdits", "plan", "auto"), "How much DGC asks before it acts"),
    "thinking": ("choice", ("off", "low", "medium", "high", "xhigh"), "How much the model thinks before it answers"),
    "ultra_mode": ("bool", None, "Ultra mode: helpers work in parallel"),
    "max_tokens": ("int", (256, 1_000_000), "The longest answer the model may write, in tokens"),
    "context_size": ("int", (2048, 10_000_000), "The model's context window, in tokens"),
    "max_turns": ("int", (0, 100_000), "Steps a turn may take (0: no limit)"),
    "turn_budget_s": ("int", (0, 86_400), "Seconds a turn may run (0: no limit)"),
    "tool_profile": ("choice", ("minimal", "standard", "full"), "Which tools the model is offered"),
    "verify_before_done": ("bool", None, "Check the work before saying it is done"),
    "verify_command": ("text", 500, "The command that checks the work"),
    "finish_on_verified": ("bool", None, "Finish as soon as the check passes"),
    "bash_timeout": ("int", (5, 86_400), "Seconds a shell command may run"),
    "search_timeout": ("int", (1, 600), "Seconds a web search may take"),
    "request_timeout": ("int", (10, 86_400), "Seconds a model request may take"),
    "model_idle_timeout_s": ("int", (10, 86_400), "Seconds the model may stay silent mid-answer"),
    "compact_threshold": ("float", (0.3, 0.98), "How full the context gets before DGC compacts it"),
    "notes": ("bool", None, "Session notes"),
    "memory": ("bool", None, "Memory across sessions"),
    "memory_review_idle_s": ("int", (10, 86_400), "Seconds idle before memory is reviewed"),
    "chatdgc_web": ("bool", None, "ChatDGC may search the web"),
    "chatdgc_followups": ("bool", None, "ChatDGC suggests follow-ups"),
    "search_provider": ("choice", ("duckduckgo", "brave", "tavily", "searxng", "ollama"), "The web search DGC uses"),
    "disabled_skills": ("list", 200, "Skills turned off"),
    "disabled_mcp_servers": ("list", 200, "MCP servers turned off"),
    "fallback_model": ("text", 200, "The model DGC falls back to when its own doesn't answer"),
    "subagent_model": ("text", 200, "The model helpers use"),
    "subagent_fallback_model": ("text", 200, "The model helpers fall back to when theirs doesn't answer"),
    "trash_mode": ("choice", ("dgc", "system", "off"), "Where deleted files go"),
    "eta": ("bool", None, "Show how long a turn will take"),
    "notify": ("choice", ("off", "done", "always"), "Desktop notifications"),
    "monitor_wake": ("bool", None, "A monitor's event may wake the session"),
    "logo_animation": ("bool", None, "The DGC logo moves while it works"),
    "theme": ("choice", ("auto", "dark", "light"), "The terminal's theme"),
    "suggest": ("bool", None, "Suggestions under the prompt"),
    "plan_artifact": ("bool", None, "A plan is shown as a page"),
    "artifact_in_plan": ("bool", None, "Plan mode may make pages"),
    "show_reasoning": ("bool", None, "Show the model's reasoning"),
    "thinking_inline": ("bool", None, "Reasoning shown inline"),
    "preserve_thinking": ("bool", None, "Keep reasoning between turns"),
    "pips_enabled": ("bool", None, "Pips are on"),
    "pips_model": ("text", 200, "The model every Pip on Default uses (\"\": DGC's own)"),
}
# Never changed by DGC, with where the user changes it.
NEVER = {
    "dev_mode": "Settings › Dev Mode (only you turn it on)",
    "dev_mode_tools": "Settings › Dev Mode (only you let DGC change its limits)",
    "sandbox": "Settings › Safety", "sandbox_network": "Settings › Safety", "sandbox_env_allow": "Settings › Safety",
    "browser_allow_unsandboxed": "Settings › Safety", "session_redaction": "Settings › Safety",
    "hooks": "your settings file, by hand", "mcp_servers": "Settings › Plugins", "language_servers": "your settings file",
    "browser_path": "Settings › Browser", "artifact_bind": "Settings › Pages", "artifact_hostname": "Settings › Pages",
    "artifact_port": "Settings › Pages", "base_url": "Settings › Models", "fallback_base_url": "Settings › Models",
    "subagent_base_url": "Settings › Models", "subagent_worktree_root": "your settings file",
    "fleet_worktree_root": "your settings file", "plugin_credentials_store": "Settings › Plugins",
    "github_sign_in_client_id": "your settings file",
}
SECRET_WORDS = ("api_key", "token", "secret", "password", "credential")
RULE_ACTIONS = ("allow", "ask", "deny")
MAX_RECORD = 50
_LOCK = threading.Lock()


class SettingsError(ValueError):
    pass


def _never(key: str) -> str | None:
    if key in NEVER:
        return NEVER[key]
    if any(word in key for word in SECRET_WORDS):
        return "Settings › Models (keys are only ever typed by you)"
    return None


def _check(key: str, value):
    kind, rule, _ = ORDINARY[key]
    if kind == "bool":
        if type(value) is not bool:
            raise SettingsError(f"{key} is true or false.")
    elif kind == "int":
        if type(value) is not int or not rule[0] <= value <= rule[1]:
            raise SettingsError(f"{key} is a whole number from {rule[0]:,} to {rule[1]:,}.")
    elif kind == "float":
        if type(value) not in (int, float) or not rule[0] <= float(value) <= rule[1]:
            raise SettingsError(f"{key} is a number from {rule[0]} to {rule[1]}.")
        value = float(value)
    elif kind == "choice":
        if value not in rule:
            raise SettingsError(f"{key} is one of: {', '.join(rule)}.")
    elif kind == "text":
        if not isinstance(value, str) or len(value) > rule or "\n" in value:
            raise SettingsError(f"{key} is one line of text, up to {rule} characters.")
        value = value.strip()
    elif kind == "list":
        if not isinstance(value, list) or len(value) > rule or not all(isinstance(v, str) and 0 < len(v) <= 200 for v in value):
            raise SettingsError(f"{key} is a list of names.")
    return value


def _shown(value) -> str:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else (value or '""')
    return text if len(text) <= 120 else text[:117] + "…"


def _record_path(config) -> Path:
    from .config import USER_CONFIG
    return Path(USER_CONFIG).parent / "settings-changes.json"


def _records(config) -> list:
    try:
        value = json.loads(_record_path(config).read_text())
    except (OSError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _remember(config, entry: dict) -> str:
    entry = {"id": "setchg_" + _secrets.token_hex(8), "at": time.time(), **entry}
    path = _record_path(config)
    with _LOCK:
        kept = (_records(config) + [entry])[-MAX_RECORD:]
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temp = path.with_suffix(f".{os.getpid()}.tmp")
        temp.write_text(json.dumps(kept))
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    return entry["id"]


def read(config, topic: str = "") -> str:
    """What DGC may change, as it is now; the rules; Dev Mode and its limits. Keys never shown."""
    from . import dev_mode
    topic = str(topic or "").strip().lower()
    lines = ["DGC's settings you may change with dgc_settings (key: value now — what it is):"]
    for key, (kind, rule, words) in ORDINARY.items():
        if topic and topic not in key and topic not in words.lower():
            continue
        lines.append(f"- {key}: {_shown(config.get(key))} — {words}")
    perms = getattr(config, "permissions", {}) or {}
    if not topic or topic in ("rules", "permissions", "allow", "deny", "ask"):
        lines.append("Permission rules (change one with action \"rule\"; a tool and a pattern, e.g. Bash(npm test:*)):")
        for action in RULE_ACTIONS:
            lines.append(f"- {action}: {', '.join(perms.get(action) or []) or '(none)'}")
    if not topic or "dev" in topic or "limit" in topic:
        tools = config.get("dev_mode_tools") is True
        lines.append(f"Dev Mode: {'on' if dev_mode.on(config) else 'off'}; DGC may change its limits: "
                     f"{'yes' if dev_mode.on(config) and tools else 'no (only the user turns Dev Mode and that switch on, in Settings › Dev Mode)'}.")
        for limit in dev_mode.listing(config):
            lines.append(f"- {limit['name']}: {limit['value']} (default {limit['default']}"
                         + (f", most without Dev Mode {limit['ceiling']}" if limit['ceiling'] is not None else "")
                         + f") — {limit['label']}."
                         + (f" DGC may set it up to {limit['ceiling']} without Dev Mode (action dev_limit)."
                            if limit['name'] in ORDINARY_LIMITS and limit['ceiling'] is not None else "")
                         + f" Raising it: {limit['cost']}")
    lines.append("Never changed by DGC (the user's, in Settings): keys, the sandbox, redaction, hooks, MCP servers, "
                 "provider addresses, Dev Mode itself.")
    return "\n".join(lines)


def change(config, key, value, reason: str = "") -> str:
    """One ordinary setting. Returns what changed and the change's id (for Undo)."""
    if not isinstance(key, str) or not key:
        raise SettingsError("Name the setting to change (dgc_settings_read lists them).")
    where = _never(key)
    if where:
        raise SettingsError(f"DGC never changes {key}: it is yours to change, in {where}.")
    if key not in ORDINARY:
        raise SettingsError(f"{key} isn't a setting DGC may change; dgc_settings_read lists the ones it may.")
    value = _check(key, value)
    before = config.get(key)
    if before == value:
        return f"{key} is already {_shown(value)}: nothing changed."
    config.set(key, value)
    change_id = _remember(config, {"kind": "setting", "key": key, "before": before, "after": value,
                                   "reason": str(reason or "")[:300]})
    label = ORDINARY[key][2]
    label = label[:1].lower() + label[1:] if label[1:2].islower() else label      # "How full…" → "how full…"; DGC stays
    return f"Changed {label} ({key}): {_shown(before)} → {_shown(value)}. Undo: {change_id}"


def rule(config, action, text, remove: bool = False, reason: str = "") -> str:
    """Add (or remove) one permission rule (a tool and a pattern), after it parses."""
    from .permissions import Rule
    if action not in RULE_ACTIONS:
        raise SettingsError("A rule is allow, ask or deny.")
    if not isinstance(text, str) or not text.strip() or len(text) > 500:
        raise SettingsError("Write the rule as Tool or Tool(pattern), e.g. Bash(npm test:*).")
    try:
        Rule.parse(text, action)
    except ValueError as exc:
        raise SettingsError(str(exc)) from None
    rules = list(config.permissions.get(action) or [])
    if remove:
        if text not in rules:
            return f"{action} has no rule {text}: nothing changed."
        rules.remove(text)
    else:
        if text in rules:
            return f"{action} already has {text}: nothing changed."
        rules.append(text)
    config.permissions[action] = rules
    config.save()
    change_id = _remember(config, {"kind": "rule", "action": action, "rule": text, "removed": bool(remove),
                                   "reason": str(reason or "")[:300]})
    return (f"{'Removed' if remove else 'Added'} {text} {'from' if remove else 'to'} {action} rules. Undo: {change_id}")


# The limits that are an ordinary setting below their ceiling: the setting each one reads with Dev Mode off.
ORDINARY_LIMITS = {"pips_parallel_runs": "pips_parallel_runs", "work_helpers": "max_parallel_tasks",
                   "helper_depth": "max_subagent_depth"}


def _within(name, value):
    """The ordinary setting a limit's value goes to with Dev Mode off, or None when it needs Dev Mode."""
    from . import dev_mode
    limit = dev_mode._BY_NAME.get(name) if isinstance(name, str) else None
    key = ORDINARY_LIMITS.get(name) if limit is not None else None
    if key and type(value) is int and limit.ceiling is not None and 1 <= value <= limit.ceiling:
        return key
    return None


def dev_limit(config, name, value, reason: str = "") -> str:
    """A limit. Up to its ceiling it is an ordinary setting (with Undo), Dev Mode or not: the live test of 14 Nov found
    "Let my Pips run up to 8 at once" refused as Dev Mode only, with 32 the most without it. Past the ceiling only while
    Dev Mode is on and the user let DGC change its limits."""
    from . import dev_mode
    if not dev_mode.on(config) or config.get("dev_mode_tools") is not True:
        key = _within(name, value)
        if key:
            before = config.get(key)
            if before == value:
                return f"{name} is already {value}: nothing changed."
            config.set(key, value)
            change_id = _remember(config, {"kind": "setting", "key": key, "before": before, "after": value,
                                           "reason": str(reason or "")[:300]})
            label = dev_mode._BY_NAME[name].label
            return f"Changed {label[:1].lower() + label[1:]} ({name}): {_shown(before)} → {value}. Undo: {change_id}"
        limit = dev_mode._BY_NAME.get(name) if isinstance(name, str) else None
        most = (f" {name} goes up to {limit.ceiling} without Dev Mode." if limit is not None and name in ORDINARY_LIMITS
                and limit.ceiling is not None else "")
        raise SettingsError(f"That needs Dev Mode.{most} Past that, DGC may change Dev Mode limits only when you have "
                            "turned on Dev Mode and \"Let DGC change Dev Mode settings\" in Settings › Dev Mode. Say which "
                            "limit and value, and you can set it there.")
    kept, refused = dev_mode.clean_limits({name: value})
    if refused:
        raise SettingsError(refused[0])
    limits = dict(config.get("dev_limits") or {})
    before = limits.get(name)
    limits.update(kept)
    config.set("dev_limits", limits)
    change_id = _remember(config, {"kind": "dev_limit", "key": name, "before": before, "after": kept[name],
                                   "reason": str(reason or "")[:300]})
    return f"Changed the Dev Mode limit {name}: {before if before is not None else 'default'} → {kept[name]}. Undo: {change_id}"


def undo(config, change_id) -> str:
    """Put one change back, while what it changed still holds what it wrote."""
    entry = next((e for e in _records(config) if e.get("id") == change_id), None)
    if entry is None:
        raise SettingsError("That change isn't recorded any more (DGC keeps the last 50).")
    if entry.get("undone"):
        return "That change was already undone."
    kind = entry.get("kind")
    if kind == "setting":
        if config.get(entry["key"]) != entry["after"]:
            raise SettingsError(f"{entry['key']} changed again since; nothing was undone.")
        config.set(entry["key"], entry["before"])
    elif kind == "rule":
        rules = list(config.permissions.get(entry["action"]) or [])
        if entry.get("removed"):
            rules.append(entry["rule"])
        elif entry["rule"] in rules:
            rules.remove(entry["rule"])
        config.permissions[entry["action"]] = rules
        config.save()
    elif kind == "dev_limit":
        limits = dict(config.get("dev_limits") or {})
        if limits.get(entry["key"]) != entry["after"]:
            raise SettingsError(f"{entry['key']} changed again since; nothing was undone.")
        if entry["before"] is None:
            limits.pop(entry["key"], None)
        else:
            limits[entry["key"]] = entry["before"]
        config.set("dev_limits", limits)
    with _LOCK:
        records = _records(config)
        for e in records:
            if e.get("id") == change_id:
                e["undone"] = True
        _record_path(config).write_text(json.dumps(records))
    return "Undone."


def _sections(body: str) -> list[str]:
    """A page in its ## sections (the part before the first one is its opening)."""
    parts, current = [], []
    for line in body.splitlines():
        if line.startswith("## ") and current:
            parts.append("\n".join(current))
            current = []
        current.append(line)
    if current:
        parts.append("\n".join(current))
    return [part for part in parts if part.strip()]


def docs(query: str) -> str:
    """DGC's own docs (dgc/docs.py), the best sections first wherever they sit in a page, each under its page's title,
    bounded: how DGC works, never a guess. (It answered with the first 4,000 characters of the best pages, so a section
    far down a long page was never seen.)"""
    from .docs import DOCS
    words = [w for w in str(query or "").lower().split() if len(w) > 2][:12]
    scored = []
    for page in DOCS:
        title, description, body = (str(page[0]), str(page[1]), str(page[2])) if isinstance(page, (tuple, list)) else (
            str(page.get("title", "")), str(page.get("description", "")), str(page.get("markdown", page.get("body", ""))))
        in_title = sum(3 * (w in title.lower()) + (w in description.lower()) for w in words)
        for section in _sections(body):
            text = section.lower()
            score = sum(text.count(w) + 4 * (w in text.split("\n", 1)[0]) for w in words) + in_title if words else 1
            if score:
                scored.append((score, title, description, section))
    scored.sort(key=lambda item: -item[0])
    if not scored:
        return "DGC's docs have nothing on that. Say so rather than guess."
    out, used = [], 0
    for _, title, description, section in scored[:4]:
        piece = f"# {title}\n{description}\n\n{section[:3000]}"
        if used + len(piece) > 12000:
            break
        out.append(piece)
        used += len(piece)
    return "\n\n---\n\n".join(out)


TOOL_NAMES = frozenset({"dgc_settings_read", "dgc_settings", "dgc_docs"})


def _schema(name, description, properties, required):
    return {"type": "function", "function": {"name": name, "description": description,
                                             "parameters": {"type": "object", "properties": properties,
                                                            "required": required}}}


SCHEMAS = [
    _schema("dgc_settings_read", "DGC's own settings: what you may change with dgc_settings and each one's value now, "
            "the permission rules, and Dev Mode with each limit, its value and what raising it costs. Read-only. "
            "Use it before changing a setting, and when a DGC limit stopped what the user asked for.",
            {"topic": {"type": "string", "maxLength": 80,
                       "description": "Optional: a word to narrow it (e.g. timeout, rules, dev)."}}, []),
    _schema("dgc_settings", "Change one of DGC's own settings when the user asks you to: an ordinary setting "
            "(action setting), a permission rule in the form Bash(npm test:*) (action rule), a Dev Mode limit (action "
            "dev_limit; only works when the user has turned on Dev Mode and let DGC change its settings), or put a "
            "change back (action undo, with the id its result gave). Never keys, the sandbox, redaction, hooks, MCP "
            "servers, provider addresses or Dev Mode itself: those are the user's, in Settings. Say what changed.",
            {"action": {"type": "string", "enum": ["setting", "rule", "dev_limit", "undo"]},
             "key": {"type": "string", "maxLength": 80, "description": "setting/dev_limit: its name."},
             "value": {"description": "setting/dev_limit: the new value (its type: dgc_settings_read)."},
             "rule": {"type": "string", "maxLength": 500, "description": "rule: e.g. Bash(npm test:*)."},
             "rule_action": {"type": "string", "enum": ["allow", "ask", "deny"]},
             "remove": {"type": "boolean", "description": "rule: remove it instead of adding it."},
             "change_id": {"type": "string", "maxLength": 40, "description": "undo: the change's id."},
             "reason": {"type": "string", "maxLength": 300, "description": "Why, in the user's words."}},
            ["action"]),
    _schema("dgc_docs", "DGC's own documentation: how DGC works (sessions, Pips, settings, slash commands, Dev Mode, "
            "plugins...). Answer how-to questions about DGC from it; never guess. Read-only.",
            {"query": {"type": "string", "minLength": 1, "maxLength": 200}}, ["query"]),
]


def run(agent, name: str, args: dict) -> str:
    """The agent's call of one of these tools (dgc/agent.py dispatch)."""
    config = agent.config
    args = args if isinstance(args, dict) else {}
    try:
        if name == "dgc_settings_read":
            return read(config, args.get("topic") or "")
        if name == "dgc_docs":
            return docs(args.get("query") or "")
        action = args.get("action")
        if action == "setting":
            return change(config, args.get("key"), args.get("value"), args.get("reason") or "")
        if action == "rule":
            return rule(config, args.get("rule_action") or "allow", args.get("rule"), bool(args.get("remove")),
                        args.get("reason") or "")
        if action == "dev_limit":
            return dev_limit(config, args.get("key"), args.get("value"), args.get("reason") or "")
        if action == "undo":
            return undo(config, args.get("change_id"))
        return "error: action is setting, rule, dev_limit or undo."
    except SettingsError as exc:
        return f"error: {exc}"


def card_words(config, args) -> dict:
    """What the Allow card shows beside the model's arguments (the live test of 14 Nov found a raw "Run dgc_settings
    {json}"): the setting's own words and what it holds now. Nothing for a key DGC never changes."""
    if not isinstance(args, dict):
        return {}
    action, key = args.get("action"), args.get("key")
    if not isinstance(key, str) or _never(key):
        return {}
    try:
        if action == "setting" and key in ORDINARY:
            return {"setting_label": ORDINARY[key][2], "before": config.get(key)}
        if action == "dev_limit":
            from . import dev_mode
            limit = dev_mode._BY_NAME.get(key)
            if limit is None:
                return {}
            if not dev_mode.on(config) and key in ORDINARY_LIMITS:
                return {"setting_label": limit.label, "before": config.get(ORDINARY_LIMITS[key], limit.default)}
            return {"setting_label": limit.label, "before": dev_mode.value(key, config)}
    except Exception:                                    # noqa: BLE001 -- the card keeps the model's words
        return {}
    return {}

