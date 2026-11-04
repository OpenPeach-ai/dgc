"""Token usage by system: which computer or cloud service each counted request ran on.

The usage ledger keeps one row per request with the endpoint host it was really sent to, and (since 0.51) the DGC
Router system that sent it. This module names each row's *system* for Settings -> Token usage, `dgc usage` and
`/usage`, without changing what is counted:

* a row the Router sent (its stored system id), or whose host is a Router system's address, is that system ("NAS");
* a request to this computer's own server is "This computer", or the name the person gave this computer in the
  Router when exactly one system is this computer;
* an Ollama cloud model (``:cloud`` / ``-cloud``) runs on Ollama's servers, even when it was sent through a local
  Ollama, so it counts as "Ollama Cloud", never as the computer it passed through;
* everything else is grouped by service ("Anthropic", "OpenAI", "DeepSeek", ...), or by its host when the service
  is not known.

A system id stored with a row keeps that row with its system after the system's address changes. A row whose
system was removed falls back to its address. Nothing here reads a key or sends a packet.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import time

COMPUTER = "computer:this"          # this computer, when no Router system names it
OLLAMA_CLOUD = "service:ollama-cloud"
KINDS = ("system", "computer", "service")
KIND_ORDER = {"system": 0, "computer": 1, "service": 2}
THIS_COMPUTER = "This computer"
MAX_KEY = 300

# Host suffix -> (slug, name). A host matches a suffix when it is that suffix or ends with "." + it.
_SERVICES = (
    ("anthropic.com", "anthropic", "Anthropic"),
    ("openai.azure.com", "azure-openai", "Azure OpenAI"),
    ("openai.com", "openai", "OpenAI"),
    ("deepseek.com", "deepseek", "DeepSeek"),
    ("ollama.com", "ollama-cloud", "Ollama Cloud"),
    ("openrouter.ai", "openrouter", "OpenRouter"),
    ("groq.com", "groq", "Groq"),
    ("together.xyz", "together", "Together AI"),
    ("together.ai", "together", "Together AI"),
    ("mistral.ai", "mistral", "Mistral"),
    ("googleapis.com", "google", "Google"),
    ("x.ai", "xai", "xAI"),
    ("moonshot.ai", "moonshot", "Moonshot"),
    ("moonshot.cn", "moonshot", "Moonshot"),
    ("z.ai", "zai", "Z.ai"),
    ("bigmodel.cn", "zai", "Z.ai"),
    ("fireworks.ai", "fireworks", "Fireworks"),
    ("cerebras.ai", "cerebras", "Cerebras"),
    ("huggingface.co", "huggingface", "Hugging Face"),
    ("perplexity.ai", "perplexity", "Perplexity"),
    ("cohere.com", "cohere", "Cohere"),
    ("cohere.ai", "cohere", "Cohere"),
    ("nvidia.com", "nvidia", "NVIDIA"),
    ("aliyuncs.com", "alibaba", "Alibaba Cloud"),
    ("minimax.io", "minimax", "MiniMax"),
    ("minimaxi.com", "minimax", "MiniMax"),
    ("sambanova.ai", "sambanova", "SambaNova"),
    ("deepinfra.com", "deepinfra", "DeepInfra"),
)
_SYSTEM_ID = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\Z")


def clean_system_id(value) -> str | None:
    """A Router system id fit to store with a request, else None."""
    text = str(value or "").strip()
    return text if _SYSTEM_ID.fullmatch(text) else None


def _host_only(host: str) -> str:
    """"nas.local:11434" -> "nas.local", "[::1]:8080" -> "::1"."""
    text = str(host or "").strip().lower()
    if text.startswith("["):
        return text[1:text.find("]")] if "]" in text else text[1:]
    return text.rsplit(":", 1)[0] if text.count(":") == 1 else text


def _port(host: str) -> str:
    text = str(host or "")
    match = re.search(r":(\d{1,5})\Z", text)
    return match.group(1) if match and (text.count(":") == 1 or text.startswith("[")) else ""


def _private(host: str) -> bool:
    name = _host_only(host)
    if not name:
        return False
    if name == "localhost" or name.endswith((".local", ".lan", ".home", ".internal", ".localdomain")) or "." not in name:
        return True
    try:
        address = ipaddress.ip_address(name)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


_OWN: tuple[float, frozenset] = (0.0, frozenset())


def own_hosts() -> frozenset:
    """This computer's own names and addresses (no packet is sent): loopback, its host name, its main private IPv4.
    Read again every five minutes."""
    global _OWN
    stamp, names = _OWN
    if names and time.monotonic() - stamp < 300:
        return names
    found = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "localhost.localdomain"}
    try:
        name = socket.gethostname().strip().lower()
        if name:
            found.update({name, name.split(".")[0], name.split(".")[0] + ".local"})
    except OSError:
        pass
    probe = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("10.255.255.255", 1))           # UDP connect: picks the route, sends nothing
        found.add(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        if probe is not None:
            probe.close()
    _OWN = (time.monotonic(), frozenset(found))
    return _OWN[1]


def _this_computer(host: str) -> bool:
    name = _host_only(host)
    if not name:
        return False
    if name.startswith("127."):
        return True
    return name in own_hosts()


def service_of(host: str) -> tuple[str, str] | None:
    """(slug, name) of the cloud service a host belongs to, else None."""
    name = _host_only(host)
    for suffix, slug, label in _SERVICES:
        if name == suffix or name.endswith("." + suffix):
            return slug, label
    return None


def _ollama_cloud_model(model: str) -> bool:
    return str(model or "").lower().endswith((":cloud", "-cloud"))


def router_systems(config=None) -> list[dict]:
    """The DGC Router's systems ({id, name, base_url, server}), from ``config`` or else the user's own config.json.
    Every system counts, on or off and with the Router on or off: its past usage is still its own."""
    try:
        if config is not None:
            from . import router
            block = router.settings(config)
        else:
            from . import config as config_mod
            payload = config_mod._read_config_payload(config_mod.USER_CONFIG) or {}
            block = config_mod.validate_router(payload.get("router"))[0]
    except Exception:                      # noqa: BLE001 -- a name is presentation; never fail a report
        return []
    rows = []
    for system in block.get("systems") or []:
        if isinstance(system, dict) and system.get("id"):
            rows.append({"id": str(system["id"]), "name": str(system.get("name") or system["id"]),
                         "base_url": str(system.get("base_url") or ""), "server": str(system.get("server") or "")})
    return rows


def system_for_url(config, base_url) -> str | None:
    """The id of the Router system whose address is ``base_url``'s host, else None (stored with each request)."""
    from .usage_ledger import endpoint_host
    host = endpoint_host(base_url)
    if not host:
        return None
    try:
        from . import router
        block = router.settings(config)
    except Exception:                      # noqa: BLE001
        return None
    for system in block.get("systems") or []:
        if isinstance(system, dict) and endpoint_host(system.get("base_url")) == host:
            return clean_system_id(system.get("id"))
    return None


class Classifier:
    """Names the system of ledger rows against one snapshot of the Router's systems."""

    def __init__(self, systems=None):
        from .usage_ledger import endpoint_host
        self.systems = [s for s in (systems or []) if isinstance(s, dict) and s.get("id")]
        self.by_id = {s["id"]: s for s in self.systems}
        self.by_host: dict[str, dict] = {}
        for system in self.systems:
            host = endpoint_host(system.get("base_url"))
            if host and host not in self.by_host:
                self.by_host[host] = system
        local = {s["id"]: s for s in self.systems if _this_computer(endpoint_host(s.get("base_url")))}
        # A request to this computer that no system's address names belongs to the system the person named this
        # computer by -- only when that is one system, not two Router entries for the same box.
        self.local = next(iter(local.values())) if len(local) == 1 else None
        self._cloud: dict[tuple, bool] = {}
        self._cache: dict[tuple, dict] = {}

    @staticmethod
    def _system(system: dict) -> dict:
        return {"system_id": system["id"], "system": system["name"], "system_kind": "system"}

    def _runs_elsewhere(self, system: dict, model: str) -> bool:
        """Whether ``model`` on an Ollama ``system`` is one of Ollama's cloud models (a stub its discovery found)."""
        key = (system["id"], model)
        if key not in self._cloud:
            value = False
            if system.get("server") == "ollama":
                try:
                    from . import router
                    value = bool(router.runs_elsewhere(system, model))
                except Exception:          # noqa: BLE001
                    value = False
            self._cloud[key] = value
        return self._cloud[key]

    def classify(self, model, provider, host, system_id=None) -> dict:
        """{system_id, system, system_kind} for one row."""
        key = (str(model or ""), str(provider or ""), str(host or ""), str(system_id or ""))
        found = self._cache.get(key)
        if found is None:
            found = self._classify(*key)
            self._cache[key] = found
        return dict(found)

    def _classify(self, model: str, provider: str, host: str, system_id: str) -> dict:
        system = self.by_id.get(system_id) if system_id else None
        if system is None:
            system = self.by_host.get(host)
        if system is None and self.local is not None and _this_computer(host):
            system = self.local
        through_ollama = (provider == "ollama" or _port(host) == "11434"
                          or (system is not None and system.get("server") == "ollama"))
        if _ollama_cloud_model(model) and through_ollama:
            return {"system_id": OLLAMA_CLOUD, "system": "Ollama Cloud", "system_kind": "service"}
        if system is not None and model and self._runs_elsewhere(system, model):
            return {"system_id": OLLAMA_CLOUD, "system": "Ollama Cloud", "system_kind": "service"}
        if system is not None:
            return self._system(system)
        if _this_computer(host):
            return {"system_id": COMPUTER, "system": THIS_COMPUTER, "system_kind": "computer"}
        service = service_of(host)
        if service is not None:
            return {"system_id": f"service:{service[0]}", "system": service[1], "system_kind": "service"}
        if not host:
            return {"system_id": "host:", "system": "Unknown", "system_kind": "service"}
        return {"system_id": f"host:{host}"[:MAX_KEY], "system": host,
                "system_kind": "computer" if _private(host) else "service"}


def matches(row: dict, wanted: str) -> bool:
    """Whether a classified row is the system ``wanted`` (a system id, or a system's name in any case)."""
    return row.get("system_id") == wanted or str(row.get("system") or "").lower() == wanted.lower()


def pick(rows, wanted) -> str | None:
    """The system id ``wanted`` names among classified ``rows``: an exact id first, then a name in any case."""
    text = str(wanted or "").strip()
    if not text:
        return None
    ids = {row.get("system_id") for row in rows}
    if text in ids:
        return text
    for row in rows:
        if str(row.get("system") or "").lower() == text.lower():
            return row.get("system_id")
    return None


def by_system(rows) -> list[dict]:
    """By-model rows summed per system, most tokens first: {system_id, system, system_kind, requests,
    unmetered_requests, input_tokens, output_tokens, cached_input_tokens}."""
    out: dict[str, dict] = {}
    for row in rows or []:
        if not isinstance(row, dict) or not row.get("system_id"):
            continue
        entry = out.setdefault(row["system_id"], {
            "system_id": row["system_id"], "system": row.get("system") or row["system_id"],
            "system_kind": row.get("system_kind") or "service", "requests": 0, "unmetered_requests": 0,
            "input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0})
        for name in ("requests", "unmetered_requests", "input_tokens", "output_tokens", "cached_input_tokens"):
            entry[name] += int(row.get(name) or 0)
    return sorted(out.values(), key=lambda r: (-(r["input_tokens"] + r["output_tokens"]), -r["requests"],
                                               KIND_ORDER.get(r["system_kind"], 3), r["system"].lower()))
