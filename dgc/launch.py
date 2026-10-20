"""Where `dgc` starts, before the CLI loads (the standard library only, so this costs next to nothing).

`dgc -p "<prompt>"` used to keep the prompt on its own command line for as long as it ran. A command the model
ran with `pkill -f <a word of the prompt>` then matched DGC itself and stopped it mid-task (found on
Terminal-Bench, 2026-10), and anyone on the machine could read the prompt with `ps`. So a one-shot DGC first runs
itself again in the same process (exec: same pid, same terminal and pipes) with a placeholder where the prompt was.
The prompt crosses in a temporary file that has no name on disk, open on a descriptor the new image reads and
closes before it reads a setting or starts a command: the environment carries only that descriptor's number, and
no command DGC runs inherits either. On Linux the process is also named `dgc`, so `pkill python` passes it by.

A `-p` whose value isn't on the command line (`-p -`, stdin) needs none of this; neither does Windows, which has no
exec (DGC on Windows runs in WSL, which is Linux). Anything that goes wrong before the exec leaves DGC running as it
always did.
"""
from __future__ import annotations

import os
import secrets
import sys

HANDOFF = "DGC_PROMPT_HANDOFF"


def _prompt_at(args: list[str]) -> tuple[int, str] | None:
    """Where the prompt is in the top-level arguments, read as argparse reads them: (index, the text before the
    prompt in that argument: "" for `-p VALUE`, "-p" for `-pVALUE`, "--prompt=" for `--prompt=VALUE`)."""
    if not args or not args[0].startswith("-"):
        return None                          # a subcommand: it reads its own arguments
    for index, arg in enumerate(args):
        if arg == "--":
            return None
        if arg in ("-p", "--prompt"):
            return (index + 1, "") if index + 1 < len(args) else None
        if arg.startswith("--prompt="):
            return index, "--prompt="
        if arg.startswith("-p") and not arg.startswith("--") and len(arg) > 2:
            return index, "-p"
    return None


def _hand_off() -> None:
    """Run again without the prompt on the command line. Returns only when that can't be done."""
    args = sys.argv[1:]
    found = _prompt_at(args)
    if found is None:
        return
    index, lead = found
    prompt = args[index][len(lead):]
    if prompt in ("", "-"):
        return                               # nothing to hide: stdin carries it
    original = list(getattr(sys, "orig_argv", None) or [])
    if not sys.executable or len(original) < len(args) or original[len(original) - len(args):] != args:
        return                               # can't tell how this interpreter was started
    import tempfile
    token = secrets.token_hex(8)
    again = [*original[:len(original) - len(args)], *args[:index], f"{lead}<dgc-prompt:{token}>", *args[index + 1:]]
    try:
        with tempfile.TemporaryFile() as handed:         # unlinked from the start: no name anyone can open
            handed.write(prompt.encode("utf-8", "surrogateescape"))
            handed.flush()
            os.set_inheritable(handed.fileno(), True)
            env = dict(os.environ)
            env[HANDOFF] = f"{handed.fileno()}:{token}"
            sys.stdout.flush()
            sys.stderr.flush()
            os.execve(sys.executable, again, env)
    except (OSError, ValueError):
        return                               # the prompt stays where it was, and DGC runs as before


def _take_back() -> bool:
    """In the image _hand_off started: the prompt goes back where its placeholder is, in this process's own argument
    list only. The variable and the descriptor go first, so nothing DGC starts inherits them. True when it was put
    back; a placeholder that can't be filled stops DGC rather than send it to a model as the task."""
    value = os.environ.pop(HANDOFF, "")
    number, _, token = value.partition(":")
    mark = f"<dgc-prompt:{token}>"
    place = next(((position, lead) for position, arg in enumerate(sys.argv) for lead in ("", "-p", "--prompt=")
                  if token and arg == lead + mark), None)
    if place is None:
        return False                         # not ours (an inherited or stray variable): nothing to fill
    try:
        descriptor = int(number)
        if descriptor < 3:
            raise ValueError(number)
        with os.fdopen(descriptor, "rb") as handed:
            handed.seek(0)
            prompt = handed.read().decode("utf-8", "surrogateescape")
    except (OSError, ValueError) as exc:
        raise SystemExit(f"dgc: couldn't read the prompt back after starting ({exc}); run the command again") from None
    position, lead = place
    sys.argv[position] = lead + prompt
    return True


def _name_process() -> None:
    """`dgc`, not `python3`, in the process table (Linux), so `pkill python` from a command doesn't stop it."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        ctypes.CDLL(None).prctl(15, b"dgc", 0, 0, 0)    # PR_SET_NAME
    except (OSError, AttributeError, TypeError):
        pass


def main() -> int | None:
    if HANDOFF in os.environ:
        if _take_back():
            _name_process()
    elif os.name == "posix":
        _hand_off()
    if sys.argv[1:2] == ["serve"]:
        # An editor reopening a session that kept running with no window: relay to it (dgc/serve_relay.py).
        # Before the CLI loads, so a relay costs a few imports, not an agent.
        from .serve_relay import run as relay
        relayed = relay()
        if relayed is not None:
            return relayed
    from .cli import main as cli_main
    return cli_main()
