"""Guard: before a command that can't be undone (deleting files, rewriting git history, throwing away changes,
piping a download into a shell), DGC asks you first, and Guard says in words what it would change. It never stops
anything by itself and never allows anything: it only asks."""
import re

import dgc_mod as dm

mod = dm.Mod()
RULES = [
    (r"\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+", "deletes {target} and everything in it, with no way back"),
    (r"\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease\b)", "replaces the remote branch's history with yours"),
    (r"\bgit\s+reset\s+--hard\b", "throws away every uncommitted change"),
    (r"\bgit\s+clean\s+-[a-zA-Z]*f", "deletes every file git doesn't track"),
    (r"\bgit\s+checkout\s+(--\s+)?\.(\s|$)|\bgit\s+restore\s+(\S+\s+)*\.(\s|$)", "throws away your uncommitted edits"),
    (r"\bgit\s+branch\s+-D\b", "deletes a branch even if its work isn't merged"),
    (r"(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|)sh\b", "runs a script straight from the internet"),
    (r"\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE)\b", "deletes a database table and its data"),
    (r"\bchmod\s+(-R\s+)?0?777\b", "lets anyone on this computer change these files"),
    (r"\b(mkfs(\.\w+)?|dd\s+.*\bof=/dev/)", "overwrites a disk"),
    (r"\bsudo\b", "runs as the administrator"),
]


def target(command):
    m = re.search(r"\brm\s+(?:-\S+\s+)+(\S+)", command)
    return m.group(1) if m else "the files named"


def uncommitted():
    try:
        status = mod.git().get("status", "")
    except dm.ModError:
        return []
    return [line[3:] for line in status.splitlines() if line and not line.startswith("##")]


@mod.on("tool.call")
def check(event):
    if event.get("tool") not in ("bash", "monitor"):
        return None
    command = str((event.get("args") or {}).get("command") or "")
    for pattern, says in RULES:
        if re.search(pattern, command, flags=re.IGNORECASE):
            reason = says.format(target=target(command))
            if "uncommitted" in says or "edits" in says:
                files = uncommitted()
                if files:
                    shown = ", ".join(files[:5]) + (f" and {len(files) - 5} more" if len(files) > 5 else "")
                    reason += f" ({len(files)} file{'s' if len(files) != 1 else ''}: {shown})"
            return dm.ask(f"This {reason}.")
    return None


mod.run()
