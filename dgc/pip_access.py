"""An independent Pip runner cannot inherit a foreground policy's data scope."""
from .workspace_registry import RegistryError

MESSAGE = ("Pips use an independent runner and cannot inherit this session's runtime policy or sandbox. "
           "Use a separate explicitly authorized local controller.")


def restricted(config):
    from .permissions import session_policy
    from . import sandbox
    return session_policy() is not None or sandbox.requested(config)


def require_unrestricted(config):
    if restricted(config):
        raise RegistryError("session_policy", MESSAGE)


# Pips run on Linux and macOS. Elsewhere (Windows) nothing offers them: no Pips view, no chat tools,
# and `dgc pips` says so, rather than letting a Pip be created that can never run.
PLATFORM_SUPPORTED = __import__("os").name == "posix"
UNSUPPORTED_PLATFORM = ("On Windows, Pips run in DGC inside WSL: install DGC there and open your folder in the "
                        "editor connected to WSL.")


def tools_available(config):
    return PLATFORM_SUPPORTED and config.get("pips_enabled", False) is True and not restricted(config)
