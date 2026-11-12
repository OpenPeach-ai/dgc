"""The user's own tunnel for webhooks (pips-22): Tailscale Funnel, turned on and off by DGC for one path.

Decided 12 Nov: a service on the internet reaches the computer running DGC only through the user's own tunnel, with
no service of ours. With Tailscale installed and signed in to the user's own account, DGC asks it to serve one path,
``/dgc-hooks``, on the internet, proxied to the webhook listener on 127.0.0.1, and nothing else:

    tailscale funnel --bg --https=<port> --set-path=/dgc-hooks http://127.0.0.1:<listener port>/hooks

Funnel serves on 443, 8443 or 10000. DGC takes the first of those where the user serves nothing of their own, so it
never makes anything of theirs public (Funnel is turned on per port), and turning it off removes only DGC's path. When
Tailscale asks the user to allow Funnel first, DGC shows the link Tailscale gives. On Linux, changing Funnel needs
Tailscale's operator: DGC says the one command to run when the user isn't. Cloudflare Tunnel and the rest are an
"address of your own" the user types in (pip_webhooks.set_reach); DGC only says whether cloudflared is installed.
"""
from __future__ import annotations

import getpass
import json
import os
import re
import shutil
import subprocess
import sys

from .workspace_registry import RegistryError

MOUNT = "/dgc-hooks"
PORTS = (443, 8443, 10000)
MAC_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
OPENS = ("Turning it on makes only DGC's webhook path reachable from the internet, at this computer's Tailscale name "
         "followed by /dgc-hooks/, and only a routine's secret address gets an answer. Nothing else on this computer, "
         "and nothing else you serve with Tailscale, is opened. You can turn it off here at any time.")
LINK = re.compile(r"https://login\.tailscale\.com/\S+")


def tailscale_cli() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    return MAC_CLI if os.path.exists(MAC_CLI) else None


def cloudflared_installed() -> bool:
    return shutil.which("cloudflared") is not None


def _run(args, timeout=15) -> tuple[int, str]:
    cli = tailscale_cli()
    if cli is None:
        return 127, ""
    try:
        done = subprocess.run([cli, *args], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired as exc:
        said = exc.stdout or b""
        said = said.decode("utf-8", "replace") if isinstance(said, bytes) else said
        err = exc.stderr or b""
        err = err.decode("utf-8", "replace") if isinstance(err, bytes) else err
        return 124, said + err
    except OSError as exc:
        return 126, str(exc)
    return done.returncode, (done.stdout or "") + (done.stderr or "")


def _json(args):
    code, said = _run(args)
    if code != 0:
        return None
    try:
        start = said.index("{")
        return json.loads(said[start:said.rindex("}") + 1])
    except ValueError:
        return None


def _allowed(capmap) -> tuple:
    for key in capmap:
        if key.startswith("https://tailscale.com/cap/funnel-ports?ports="):
            return tuple(int(p) for p in key.split("=", 1)[1].split(",") if p.strip().isdigit())
    return PORTS if "funnel" in capmap else ()


def _target(listen_port) -> str:
    return f"http://127.0.0.1:{listen_port}/hooks"


def _ours(config, dns) -> tuple[int | None, bool, str | None]:
    """The port DGC's path is on, whether Funnel is on for it, and where it points."""
    for hostport, web in (config.get("Web") or {}).items():
        host, _, port = hostport.rpartition(":")
        handler = ((web or {}).get("Handlers") or {}).get(MOUNT)
        if host == dns and handler and port.isdigit():
            return int(port), bool((config.get("AllowFunnel") or {}).get(hostport)), handler.get("Proxy")
    return None, False, None


def _choose(config, dns, allowed) -> int | None:
    for port in [p for p in PORTS if p in allowed]:
        web = (config.get("Web") or {}).get(f"{dns}:{port}") or {}
        tcp = (config.get("TCP") or {}).get(str(port)) or {}
        if tcp and not tcp.get("HTTPS"):
            continue                          # a raw TCP forward of theirs
        if not set(web.get("Handlers") or {}) - {MOUNT}:
            return port
    return None


def _base(dns, port) -> str:
    return f"https://{dns}{'' if port == 443 else ':' + str(port)}{MOUNT}"


def _and(items) -> str:
    items = [str(i) for i in items]
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def tailscale_state(listen_port) -> dict:
    """Whether Tailscale can carry calls here, whether DGC's path is on, and words for what is missing."""
    out = {"installed": False, "running": False, "funnel_allowed": False, "operator": True, "ready": False, "on": False,
           "public_base": None, "port": None, "opens": OPENS, "words": ""}
    if tailscale_cli() is None:
        out["words"] = ("Install Tailscale from tailscale.com and sign in with your own account. Then DGC can turn on "
                        "Tailscale Funnel for your routines' addresses with one click.")
        return out
    out["installed"] = True
    status = _json(["status", "--json"]) or {}
    me = status.get("Self") or {}
    dns = str(me.get("DNSName") or "").rstrip(".")
    if status.get("BackendState") != "Running" or not dns:
        out["words"] = "Tailscale is installed but isn't running or signed in. Open Tailscale and sign in, then try again."
        return out
    out["running"] = True
    capmap = me.get("CapMap") or {cap: [] for cap in (me.get("Capabilities") or [])}
    allowed = _allowed(capmap)
    out["funnel_allowed"] = bool(allowed) and "https" in capmap
    if sys.platform.startswith("linux") and os.geteuid() != 0:
        prefs = _json(["debug", "prefs"]) or {}
        out["operator"] = prefs.get("OperatorUser") == getpass.getuser()
    config = _json(["funnel", "status", "--json"]) or {}
    port, public, _ = _ours(config, dns)
    out.update(on=port is not None and public, port=port, public_base=_base(dns, port) if port and public else None)
    out["ready"] = out["funnel_allowed"] and out["operator"]
    if not out["funnel_allowed"]:
        out["words"] = ("Tailscale Funnel isn't allowed for this computer in your Tailscale account yet. Turn it on and "
                        "Tailscale shows a link to allow Funnel and HTTPS; or allow them in its admin console.")
    elif not out["operator"]:
        out["words"] = ("On this computer Tailscale lets only its operator change Funnel. Run this once in a terminal: "
                        "sudo tailscale set --operator=$USER")
    return out


def turn_on(listen_port) -> dict:
    state = tailscale_state(listen_port)
    if not state["installed"] or not state["running"] or not state["operator"]:
        raise RegistryError("tunnel_unavailable", state["words"])
    if state["on"]:
        return state
    status = _json(["status", "--json"]) or {}
    me = status.get("Self") or {}
    dns = str(me.get("DNSName") or "").rstrip(".")
    allowed = _allowed(me.get("CapMap") or {}) or PORTS
    config = _json(["funnel", "status", "--json"]) or {}
    port = _choose(config, dns, allowed)
    if port is None:
        raise RegistryError("tunnel_busy", f"Tailscale Funnel serves on {_and(sorted(allowed))}, and you already serve "
                                           "something on each, so DGC won't share one and make yours public. Free one "
                                           "of them, or use an address of your own.")
    code, said = _run(["funnel", "--bg", f"--https={port}", f"--set-path={MOUNT}", _target(listen_port)], timeout=30)
    link = LINK.search(said)
    if link:
        raise RegistryError("tunnel_needs_you", f"Tailscale asks you to allow Funnel first: open {link.group(0).rstrip('.')} "
                                                "and allow it, then turn it on here again.")
    if code != 0:
        raise RegistryError("tunnel_failed", "Tailscale didn't turn on Funnel: " + (said.strip()[:200] or f"exit {code}."))
    after = tailscale_state(listen_port)
    if not after["on"]:
        raise RegistryError("tunnel_failed", "Tailscale took the request, but DGC's path isn't on the internet. Check "
                                             "Funnel in Tailscale, then try again.")
    return after


def turn_off() -> None:
    """Remove DGC's path, and only it. Nothing to do when it isn't there."""
    if tailscale_cli() is None:
        return
    status = _json(["status", "--json"]) or {}
    dns = str((status.get("Self") or {}).get("DNSName") or "").rstrip(".")
    config = _json(["funnel", "status", "--json"]) or {}
    port, _, _ = _ours(config, dns)
    if port is None:
        return
    code, said = _run(["funnel", f"--https={port}", f"--set-path={MOUNT}", "off"])
    if code != 0:
        raise RegistryError("tunnel_failed", "Tailscale didn't turn off DGC's path: " + (said.strip()[:200] or f"exit {code}."))
