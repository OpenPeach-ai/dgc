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
    # `read_url` is not a DGC tool and never has been. Naming it here sent the model looking for
    # a tool it was never offered, which now gets a refusal from the offered-name gate.
    out.append("\nUse web_fetch on a result URL to read the full page.")
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


def _run(query: str, provider: str, api_key: str, url: str, n: int) -> list[tuple[str, str, str]]:
    if provider == "brave":
        return _brave(query, n, api_key)
    if provider == "tavily":
        return _tavily(query, n, api_key)
    if provider == "searxng":
        return _searxng(query, n, url)
    return _duckduckgo(query, n)  # duckduckgo — keyless default


def search(query: str, provider: str, api_key: str = "", url: str = "", n: int = 6) -> str:
    """Run a web search with the configured provider; returns a formatted result string."""
    query = (query or "").strip()
    if not query:
        return "error: empty search query"
    try:
        results = _run(query, provider, api_key, url, n)
    except SearchError as e:
        return f"error: {e}"
    except requests.RequestException as e:
        return f"error: web search failed ({provider}): {e}"
    return _fmt(results, query)


def shared_settings(config) -> tuple[str, str, str]:
    """The one web search set in Settings (founder, 2026-10-09: Work, ChatDGC and Pips share it): provider, key
    and address, read fresh from the files Settings and `dgc setup` write (a process started before a change has
    not seen it), else this process's config."""
    import json
    from .config import USER_CONFIG, USER_SECRETS
    found = {"search_provider": config.get("search_provider", "duckduckgo"), "search_url": config.get("search_url", ""),
             "search_api_key": config.get("search_api_key", "")}
    for path, names in ((USER_CONFIG, ("search_provider", "search_url")), (USER_SECRETS, ("search_api_key",))):
        try:
            raw = json.loads(path.read_text(encoding="utf-8")) if path.stat().st_size <= 2 * 1024 * 1024 else None
        except (OSError, ValueError):
            continue
        for name in names:
            if isinstance(raw, dict) and isinstance(raw.get(name), str):
                found[name] = raw[name]
    return str(found["search_provider"] or "duckduckgo"), str(found["search_api_key"] or ""), str(found["search_url"] or "")


def _site(link: str) -> str:
    from urllib.parse import urlsplit
    host = (urlsplit(link).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def _size(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _picture(title, image, thumbnail, page, width=0, height=0) -> dict | None:
    """One image result, the same from every provider: what it is, the picture, a small copy to show, and the page
    it's on (where "Open page" goes; the picture itself when a provider names no page)."""
    image, thumbnail, page = (str(x or "").strip() for x in (image, thumbnail, page))
    thumbnail = thumbnail or image
    page = page if page.startswith(("http://", "https://")) else image
    if not thumbnail.startswith("https://") or not page.startswith(("http://", "https://")):
        return None
    return {"title": " ".join(str(title or "").split())[:200], "image": image[:2000], "thumbnail": thumbnail[:2000],
            "url": page[:2000], "site": _site(page), "width": _size(width), "height": _size(height)}


def _ddgs_images(query: str, n: int) -> list[dict]:
    try:
        from ddgs import DDGS                                   # type: ignore[import-not-found]
    except ImportError:
        try:
            from duckduckgo_search import DDGS                  # type: ignore[import-not-found,no-redef]
        except ImportError:
            raise SearchError("image search with DuckDuckGo needs the ddgs package, which this install lacks") from None
    with DDGS() as client:
        rows = list(client.images(query, max_results=n, safesearch="moderate") or [])
    return [_picture(r.get("title"), r.get("image"), r.get("thumbnail"), r.get("url"), r.get("width"), r.get("height"))
            for r in rows if isinstance(r, dict)]


def _brave_images(query: str, n: int, key: str) -> list[dict]:
    if not key:
        raise SearchError("Brave needs an API key — use `/search brave` (masked prompt), `DGC_SEARCH_API_KEY`, or `dgc setup`.")
    r = requests.get("https://api.search.brave.com/res/v1/images/search",
                     params={"q": query, "count": n, "safesearch": "strict"},
                     headers={"Accept": "application/json", "X-Subscription-Token": key, **_UA}, timeout=20)
    r.raise_for_status()
    out = []
    for x in r.json().get("results") or []:
        props = x.get("properties") or {}
        out.append(_picture(x.get("title"), props.get("url"), (x.get("thumbnail") or {}).get("src"), x.get("url"),
                            props.get("width"), props.get("height")))
    return out


def _tavily_images(query: str, n: int, key: str) -> list[dict]:
    if not key:
        raise SearchError("Tavily needs an API key — use `/search tavily` (masked prompt), `DGC_SEARCH_API_KEY`, or `dgc setup`.")
    r = requests.post("https://api.tavily.com/search", timeout=25,
                      json={"api_key": key, "query": query, "max_results": 1, "include_images": True,
                            "include_image_descriptions": True})
    r.raise_for_status()
    out = []
    for x in r.json().get("images") or []:
        link, about = (x, "") if isinstance(x, str) else (x.get("url"), x.get("description"))
        out.append(_picture(about, link, link, ""))
    return out


def _searxng_images(query: str, n: int, base_url: str) -> list[dict]:
    if not base_url:
        raise SearchError("SearXNG needs a base URL — set it with `/search searxng <url>` or `dgc setup`.")
    r = requests.get(base_url.rstrip("/") + "/search", headers=_UA, timeout=20,
                     params={"q": query, "format": "json", "categories": "images", "safesearch": 1})
    r.raise_for_status()
    out = []
    for x in r.json().get("results") or []:
        width, _, height = str(x.get("resolution") or "").replace("×", "x").partition("x")
        thumb = x.get("thumbnail_src") or x.get("img_src")
        if str(thumb or "").startswith("//"):
            thumb = "https:" + thumb
        out.append(_picture(x.get("title"), x.get("img_src"), thumb, x.get("url"), width.strip(), height.strip()))
    return out


def images(query: str, provider: str, api_key: str = "", url: str = "", n: int = 8) -> list[dict]:
    """An image search with the configured provider, for a chat reply that shows pictures: [{"title", "image",
    "thumbnail", "url" (the page it's on), "site", "width", "height"}], only results with an https thumbnail.
    Raises SearchError saying why when it fails."""
    query = (query or "").strip()
    if not query:
        raise SearchError("empty image search query")
    try:
        if provider == "brave":
            found = _brave_images(query, n, api_key)
        elif provider == "tavily":
            found = _tavily_images(query, n, api_key)
        elif provider == "searxng":
            found = _searxng_images(query, n, url)
        else:
            found = _ddgs_images(query, n)
    except requests.RequestException as e:
        raise SearchError(f"image search failed ({provider}): {e}") from e
    except SearchError:
        raise
    except Exception as e:                      # noqa: BLE001 -- a client library's own failure, said plainly
        raise SearchError(f"image search failed ({provider}): {' '.join(str(e).split())[:200]}") from e
    return [x for x in found if x][:n]


def results(query: str, provider: str, api_key: str = "", url: str = "", n: int = 6) -> list[dict]:
    """The same search as data, for a reply that cites its sources: [{"title", "url", "snippet"}].
    Raises SearchError saying why when it fails."""
    query = (query or "").strip()
    if not query:
        raise SearchError("empty search query")
    try:
        found = _run(query, provider, api_key, url, n)
    except requests.RequestException as e:
        raise SearchError(f"web search failed ({provider}): {e}") from e
    return [{"title": title, "url": link, "snippet": snippet} for title, link, snippet in found]
