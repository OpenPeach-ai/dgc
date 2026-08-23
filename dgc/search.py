"""Web search — pluggable providers, same menu as a full assistant would offer.

DuckDuckGo (keyless, the default floor) · Brave · Tavily (API key) · SearXNG (self-hosted URL).
All are plain HTTP through `requests` (no new dependency). Configured in ~/.dgc/config.json via
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


def _duckduckgo(query: str, n: int) -> list[tuple[str, str, str]]:
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
        raise SearchError("Brave needs an API key — set it with `/search brave <key>` or `dgc setup`.")
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
        raise SearchError("Tavily needs an API key — set it with `/search tavily <key>` or `dgc setup`.")
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
