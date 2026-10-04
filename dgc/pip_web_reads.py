"""Reviewed web reads for Personal Pips: fixed public pages and fixed searches, read by DGC.

A Personal Pip's reviewed job may name up to four exact reads. The controller performs them before
the Pip's model runs, as it performs reviewed app reads, and hands the text to the model as
untrusted reference data. The model never chooses a URL or a query, so nothing it read elsewhere
-- an email, a page -- can send a request somewhere of its choosing or carry data out in one.
"""
from __future__ import annotations

import json
import re
import time
from urllib.parse import urlsplit

from .workspace_registry import RegistryError

SCHEMA_VERSION = 1
MAX_READS = 4
MAX_URL = 2048
MAX_QUERY = 300
MAX_PAGE_CHARS = 8000          # the same cap as the main chat's web_fetch
MAX_ERROR_CHARS = 300
READ_SECONDS = 90              # all reads of one run, checked before each read starts

_INVALID = "Review up to four exact web reads: public https pages or search queries."


def _page(url) -> str:
    if not isinstance(url, str) or not 1 <= len(url) <= MAX_URL or url != url.strip():
        raise RegistryError("invalid_web_plan", "Each page must be one https URL of up to 2,048 characters.")
    try:
        parts = urlsplit(url)
        parts.port
    except ValueError as exc:
        raise RegistryError("invalid_web_plan", "That page URL is not valid.") from exc
    host = (parts.hostname or "").rstrip(".").lower()
    if parts.scheme != "https" or not host or parts.username is not None or parts.password is not None:
        raise RegistryError("invalid_web_plan", "Pages must be https URLs with a host and no sign-in details.")
    # A dotted number or an IPv6 literal (urlsplit drops its brackets) names an address, not a site.
    if host == "localhost" or host.endswith(".localhost") or re.fullmatch(r"[0-9.]+", host) or ":" in host:
        raise RegistryError("invalid_web_plan", "Pages must be public sites named by host, not local or numeric addresses.")
    if re.search(r"[\x00-\x20\x7f]", url):
        raise RegistryError("invalid_web_plan", "Page URLs cannot contain spaces or control characters.")
    return url


def _query(query) -> str:
    if (not isinstance(query, str) or not 1 <= len(query.strip()) <= MAX_QUERY or query != query.strip()
            or re.search(r"[\x00-\x1f\x7f]", query)):
        raise RegistryError("invalid_web_plan", "Each search is one line of up to 300 characters.")
    return query


def validate(plan):
    """The canonical reviewed plan, or None for no web access. Refuses anything else whole."""
    if plan is None:
        return None
    if (not isinstance(plan, dict) or set(plan) != {"schema_version", "reads"}
            or type(plan["schema_version"]) is not int or plan["schema_version"] != SCHEMA_VERSION
            or not isinstance(plan["reads"], list) or not 1 <= len(plan["reads"]) <= MAX_READS):
        raise RegistryError("invalid_web_plan", _INVALID)
    seen = set()
    reads = []
    for read in plan["reads"]:
        if isinstance(read, dict) and set(read) == {"kind", "url"} and read["kind"] == "page":
            row = {"kind": "page", "url": _page(read["url"])}
        elif isinstance(read, dict) and set(read) == {"kind", "query"} and read["kind"] == "search":
            row = {"kind": "search", "query": _query(read["query"])}
        else:
            raise RegistryError("invalid_web_plan", _INVALID)
        key = json.dumps(row, sort_keys=True)
        if key in seen:
            raise RegistryError("invalid_web_plan", "Each web read appears once.")
        seen.add(key)
        reads.append(row)
    return {"schema_version": SCHEMA_VERSION, "reads": reads}


def _fetch_page(url: str) -> tuple[str, str]:
    from .tools import _fetch_public_text, page_text
    final_url, raw = _fetch_public_text(url, https_only=True)   # a reviewed https page stays https
    return final_url, page_text(raw)


def _search(query: str, config) -> str:
    from .search import search
    return search(query, provider=str(config.get("search_provider", "duckduckgo")),
                  api_key=str(config.get("search_api_key", "")), url=str(config.get("search_url", "")))


def _bounded(text: str, limit: int) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[:limit] + "\n… (truncated)"


def execute(config, plan, *, authorize, fetch_page=None, search=None, clock=time.monotonic):
    """Perform the reviewed reads in order. A page that cannot be read is reported, not fatal."""
    plan = validate(plan)
    if plan is None:
        return []
    fetch_page = fetch_page or _fetch_page
    search = search or _search
    import requests
    from .redaction import redact_text, secret_values
    secrets = secret_values(config)
    deadline = clock() + READ_SECONDS
    results = []
    for read in plan["reads"]:
        authorize()
        if clock() >= deadline:
            raise RegistryError("web_read_timeout", "The reviewed web reads ran out of time.")
        row = dict(read)
        try:
            if read["kind"] == "page":
                final_url, text = fetch_page(read["url"])
                row["final_url"] = _bounded(final_url, MAX_URL)
            else:
                text = search(read["query"], config)
                if isinstance(text, str) and text.startswith("error:"):
                    raise ValueError(text[len("error:"):].strip())
            # Redact the whole text first: a secret cut in half by the bound would escape redaction.
            row["text"] = _bounded(redact_text(str(text or ""), secrets), MAX_PAGE_CHARS) or "(empty page)"
        except (requests.RequestException, ValueError, OSError) as exc:
            row["error"] = _bounded(redact_text(str(exc), secrets), MAX_ERROR_CHARS) or "could not be read"
        row["untrusted"] = True
        results.append(row)
    authorize()
    return results
