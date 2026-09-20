"""Web search — pluggable providers, same menu as a full assistant would offer.

DuckDuckGo (keyless, the default floor) · Brave · Tavily (API key) · SearXNG (self-hosted URL).
DuckDuckGo is tried three ways: the bundled `ddgs` client, then DGC's own parse of the HTML
endpoint, then the lite endpoint. The other providers are plain HTTP through `requests`. Configured in ~/.dgc/config.json via
`search_provider` / `search_api_key` / `search_url`, set by `dgc setup` or the `/search` command.
"""
from __future__ import annotations

import html
import re

import requests

_UA = {"User-Agent": "Mozilla/5.0 (compatible; dgc/1.0)"}


class SearchError(Exception):
    pass


def _fmt(results: list[tuple[str, str, str]], query: str) -> str:
    if not results:
        return f'No web results for "{query}".'
    out = [f'Web results for "{query}":\n']
    for i, (title, url, snippet) in enumerate(results, 1):
        out.append(f"{i}. {title}\n   {url}")
        if snippet:
            out.append(f"   {snippet}")
    out.append("\nUse read_url/web_fetch on a result URL to read the full page.")
    return "\n".join(out)


def _ddgs_package(query: str, n: int) -> list[tuple[str, str, str]]:
    """The maintained `ddgs` client, which DGC installs (see requirements.lock).

    It impersonates a browser's TLS fingerprint, so it keeps working where a plain scrape is
    refused. DGC still carries its own two fallbacks below, for an install that lacks the package
    (an older tree, a stripped environment) or a version that breaks.
    """
    try:
        from ddgs import DDGS                                   # type: ignore[import-not-found]
    except ImportError:
        try:
            from duckduckgo_search import DDGS                  # type: ignore[import-not-found,no-redef]
        except ImportError:
            raise LookupError("no ddgs package installed") from None
    with DDGS() as client:
        rows = list(client.text(query, max_results=n) or [])
    out: list[tuple[str, str, str]] = []
    for row in rows[:n]:
        if not isinstance(row, dict):
            continue
        title = str(row.get("title") or "").strip()
        url = str(row.get("href") or row.get("url") or row.get("link") or "").strip()
        body = str(row.get("body") or row.get("snippet") or row.get("description") or "").strip()
        if title and url.startswith("http"):
            out.append((title, url, body))
    return out


def _ddg_lite(query: str, n: int) -> list[tuple[str, str, str]]:
    """DuckDuckGo's lite endpoint: a plain results table, served when the HTML one blocks us."""
    r = requests.post("https://lite.duckduckgo.com/lite/", data={"q": query}, headers=_UA, timeout=20)
    r.raise_for_status()
    results: list[tuple[str, str, str]] = []
    rows = re.split(r"<tr[^>]*>", r.text)
    pending: tuple[str, str] | None = None
    for row in rows:
        # The lite page writes its attributes in either order and quotes them either way.
        link = re.search(r"<a[^>]*class=['\"]result-link['\"][^>]*>(?P<t>.*?)</a>", row, re.S)
        if link:
            href = re.search(r"href=['\"](?P<u>[^'\"]+)['\"]", link.group(0))
            url = html.unescape(href.group("u")) if href else ""
            wrapped = re.search(r"uddg=([^&]+)", url)
            if wrapped:
                url = requests.utils.unquote(wrapped.group(1))
            title = html.unescape(re.sub(r"<[^>]+>", "", link.group("t"))).strip()
            pending = (title, url) if title and url.startswith("http") else None
            continue
        snippet = re.search(r"class=['\"]result-snippet['\"][^>]*>(?P<s>.*?)</td>", row, re.S)
        if snippet and pending:
            text = html.unescape(re.sub(r"<[^>]+>", "", snippet.group("s"))).strip()
            results.append((pending[0], pending[1], text))
            pending = None
            if len(results) >= n:
                break
    if pending and len(results) < n:
        results.append((pending[0], pending[1], ""))
    return results


def _duckduckgo(query: str, n: int) -> list[tuple[str, str, str]]:
    """Keyless DuckDuckGo, tried three ways: the `ddgs` package if installed, then the HTML
    endpoint DGC parses itself, then the lite endpoint. Only an empty result from all three, or
    the last error, reaches the user."""
    problems: list[str] = []
    for label, attempt in (("ddgs package", _ddgs_package),
                           ("html endpoint", _ddg_html),
                           ("lite endpoint", _ddg_lite)):
        try:
            results = attempt(query, n)
        except LookupError:
            continue                                   # no package in this environment: fall through
        except Exception as exc:                       # network, parse, or a package's own error
            problems.append(f"{label}: {type(exc).__name__}: {str(exc)[:120]}")
            continue
        if results:
            return results
        problems.append(f"{label}: no results")
    raise SearchError(
        "DuckDuckGo returned nothing (" + "; ".join(problems) + "). Try again, or switch provider "
        "with `/search brave|tavily|searxng`.")


def _ddg_html(query: str, n: int) -> list[tuple[str, str, str]]:
    r = requests.post("https://html.duckduckgo.com/html/", data={"q": query}, headers=_UA, timeout=20)
    r.raise_for_status()
    text = r.text
    results: list[tuple[str, str, str]] = []
    # each result block has a result__a link and (usually) a result__snippet
    for m in re.finditer(
        r'result__a[^>]*href="(?P<u>[^"]+)"[^>]*>(?P<t>.*?)</a>.*?'
        r'(?:result__snippet[^>]*>(?P<s>.*?)</a>|result__snippet[^>]*>(?P<s2>.*?)</div>)?',
        text, re.S,
    ):
        url = html.unescape(m.group("u"))
        mu = re.search(r"uddg=([^&]+)", url)  # DDG wraps the real url
        if mu:
            url = requests.utils.unquote(mu.group(1))
        title = html.unescape(re.sub(r"<[^>]+>", "", m.group("t"))).strip()
        snip = html.unescape(re.sub(r"<[^>]+>", "", (m.group("s") or m.group("s2") or ""))).strip()
        if title and url.startswith("http"):
            results.append((title, url, snip))
        if len(results) >= n:
            break
    return results


def _brave(query: str, n: int, key: str) -> list[tuple[str, str, str]]:
    if not key:
        raise SearchError("Brave needs an API key — use `/search brave` (masked prompt), `DGC_SEARCH_API_KEY`, or `dgc setup`.")
    r = requests.get(
        "https://api.search.brave.com/res/v1/web/search",
        params={"q": query, "count": n},
        headers={"Accept": "application/json", "X-Subscription-Token": key, **_UA}, timeout=20,
    )
    r.raise_for_status()
    web = (r.json().get("web") or {}).get("results") or []
    return [(w.get("title", ""), w.get("url", ""), w.get("description", "")) for w in web[:n]]


def _tavily(query: str, n: int, key: str) -> list[tuple[str, str, str]]:
    if not key:
        raise SearchError("Tavily needs an API key — use `/search tavily` (masked prompt), `DGC_SEARCH_API_KEY`, or `dgc setup`.")
    r = requests.post("https://api.tavily.com/search",
                      json={"api_key": key, "query": query, "max_results": n}, timeout=25)
    r.raise_for_status()
    return [(x.get("title", ""), x.get("url", ""), x.get("content", "")) for x in (r.json().get("results") or [])[:n]]


def _searxng(query: str, n: int, base_url: str) -> list[tuple[str, str, str]]:
    if not base_url:
        raise SearchError("SearXNG needs a base URL — set it with `/search searxng <url>` or `dgc setup`.")
    r = requests.get(base_url.rstrip("/") + "/search",
                     params={"q": query, "format": "json"}, headers=_UA, timeout=20)
    r.raise_for_status()
    return [(x.get("title", ""), x.get("url", ""), x.get("content", "")) for x in (r.json().get("results") or [])[:n]]


def search(query: str, provider: str, api_key: str = "", url: str = "", n: int = 6) -> str:
    """Run a web search with the configured provider; returns a formatted result string."""
    query = (query or "").strip()
    if not query:
        return "error: empty search query"
    try:
        if provider == "brave":
            results = _brave(query, n, api_key)
        elif provider == "tavily":
            results = _tavily(query, n, api_key)
        elif provider == "searxng":
            results = _searxng(query, n, url)
        else:  # duckduckgo — keyless default
            results = _duckduckgo(query, n)
    except SearchError as e:
        return f"error: {e}"
    except requests.RequestException as e:
        return f"error: web search failed ({provider}): {e}"
    return _fmt(results, query)
