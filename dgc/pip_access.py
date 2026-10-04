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


def tools_available(config):
    return config.get("pips_enabled", False) is True and not restricted(config)
