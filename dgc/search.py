"""Web search — pluggable providers, same menu as a full assistant would offer.

DuckDuckGo (keyless, the default floor) · Brave · Tavily (API key) · SearXNG (self-hosted URL) ·
Ollama (this computer's signed-in Ollama, else an ollama.com API key).
DuckDuckGo is tried three ways: the bundled `ddgs` client, then DGC's own parse of the HTML
endpoint, then the lite endpoint. The other providers are plain HTTP through `requests`. Configured in ~/.dgc/config.json via
`search_provider` / `search_api_key` / `search_url`, set by `dgc setup` or the `/search` command.
"""
from __future__ import annotations

import html
import os
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
        "with `/search brave|tavily|searxng|ollama`.")


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


# Ollama's web search (docs.ollama.com/capabilities/web-search): POST {query, max_results} answers {results: [{title,
# url, content}]}. Two ways in. A signed-in Ollama on this computer serves it at /api/experimental/web_search (Ollama
# 0.18 and later, server/routes.go) and signs the request to ollama.com with its own sign-in, so no key is needed: DGC
# never reads Ollama's private key, Ollama signs. Otherwise ollama.com takes an API key as a Bearer token.
OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search"
OLLAMA_LOCAL_PATH = "/api/experimental/web_search"
OLLAMA_MAX_RESULTS = 10                 # the API's own limit
OLLAMA_MAX_BYTES = 8 * 1024 * 1024      # each result carries its whole page (one was 198 KB), so ten fit with room
OLLAMA_SNIPPET_CHARS = 500
OLLAMA_KEY_HELP = ("Run `ollama signin` on this computer, or create a key at ollama.com → Settings → API keys "
                   "(https://ollama.com/settings/keys) and paste it in Settings → Web search (or `/search ollama`, "
                   "`dgc setup`, DGC_SEARCH_API_KEY).")


class _NoLocalOllama(Exception):
    """This computer's Ollama can't search for DGC (not running, too old, not signed in, cloud off); the text says
    which, for the message when there is no key to fall back on."""


def _ollama_daemon() -> str:
    """The Ollama the `ollama` command talks to: OLLAMA_HOST read the way Ollama reads it (envconfig.Host, with 0.0.0.0
    meaning this computer), else http://127.0.0.1:11434. Empty when OLLAMA_HOST names ollama.com itself."""
    from urllib.parse import urlsplit
    raw = os.environ.get("OLLAMA_HOST", "").strip()
    scheme, sep, rest = raw.partition("://")
    scheme, rest = (scheme.lower(), rest) if sep else ("http", raw)
    default = {"http": 80, "https": 443}.get(scheme, 11434) if sep else 11434
    hostport, _, path = rest.partition("/")
    try:
        parts = urlsplit(f"http://{hostport}")
        host, port = parts.hostname or "", parts.port
    except ValueError:                  # a bare IPv6 address, or a port out of range (Ollama then uses its default)
        host = hostport.strip("[]") if hostport.count(":") > 1 else hostport.partition(":")[0]
        port = None
    host = {"": "127.0.0.1", "0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
    if host.lower() == "ollama.com":
        return ""
    scheme = scheme if scheme in ("http", "https") else "http"
    path = path.strip("/")
    return f"{scheme}://{f'[{host}]' if ':' in host else host}:{port or default}" + (f"/{path}" if path else "")


def _ollama_post(url: str, body: dict, headers: dict) -> tuple[int, object, str]:
    """One POST, its answer read up to OLLAMA_MAX_BYTES: (status, the JSON or None, its `error` text)."""
    import json
    r = requests.post(url, json=body, headers={"Accept": "application/json", **_UA, **headers},
                      timeout=(5, 30), stream=True)
    try:
        raw = bytearray()
        for chunk in r.iter_content(65536):
            raw += chunk
            if len(raw) > OLLAMA_MAX_BYTES:
                raise SearchError(f"Ollama web search sent more than {OLLAMA_MAX_BYTES // (1024 * 1024)} MB.")
    finally:
        r.close()
    try:
        payload = json.loads(bytes(raw).decode("utf-8", "replace"))   # ollama.com labels it text/html; it is JSON
    except ValueError:
        payload = None
    said = payload.get("error") if isinstance(payload, dict) else None
    return r.status_code, payload, " ".join(str(said or "").split())[:200]


def _ollama_failed(status: int, said: str, where: str, key: str = ""):
    """Any other failure (a rate limit, a server error) goes as the other providers' do: a requests error, which the
    web_search tool reports and Deep Research asks again once."""
    from http import HTTPStatus
    try:
        phrase = " " + HTTPStatus(status).phrase
    except ValueError:
        phrase = ""
    if key:
        said = said.replace(key, "[redacted]")
    raise requests.HTTPError(f"HTTP {status}{phrase} from {where}" + (f": {said}" if said else ""))


def _ollama_rows(payload, n: int) -> list[tuple[str, str, str]]:
    rows = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise SearchError("Ollama web search answered without results.")
    out: list[tuple[str, str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        link = str(row.get("url") or "").strip()
        if not link.startswith(("http://", "https://")):
            continue
        title = " ".join(str(row.get("title") or "").split())
        out.append((title or link, link, _ollama_snippet(row.get("content"), title)))
        if len(out) >= n:
            break
    return out


def _ollama_snippet(content, title: str) -> str:
    """Ollama sends a result's whole page as markdown; its start, as plain words, is the snippet."""
    text = str(content or "")[:20_000]
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)                    # pictures
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)                 # links keep their words
    text = re.sub(r"(?m)^[ \t]{0,3}(?:#{1,6}|[-*+>])[ \t]+", "", text)    # heading, list and quote marks
    text = " ".join(text.replace("**", "").replace("__", "").replace("`", "").split())
    if title and text.casefold().startswith(title.casefold()):          # most pages start with their own title
        text = text[len(title):].lstrip(" ·|:-–—")
    if len(text) > OLLAMA_SNIPPET_CHARS:
        text = text[:OLLAMA_SNIPPET_CHARS].rsplit(" ", 1)[0].rstrip(" ,;:·|-") + "…"
    return text


def _ollama(query: str, n: int, key: str) -> list[tuple[str, str, str]]:
    """Ollama web search: this computer's signed-in Ollama first (no key), then ollama.com with the saved key."""
    body = {"query": query, "max_results": max(1, min(n, OLLAMA_MAX_RESULTS))}
    local = _ollama_daemon()
    why_not = "OLLAMA_HOST names ollama.com rather than an Ollama on this computer"
    if local:
        try:
            return _ollama_local(local, body)
        except _NoLocalOllama as exc:
            why_not = str(exc)
    if not key:
        raise SearchError(f"Ollama web search can't run: {why_not}, and no ollama.com API key is saved. "
                          + OLLAMA_KEY_HELP)
    status, payload, said = _ollama_post(OLLAMA_SEARCH_URL, body, {"Authorization": f"Bearer {key}"})
    if status == 401:
        raise SearchError(f"ollama.com refused the API key saved for web search (HTTP 401), and {why_not}. Check the "
                          "key at ollama.com → Settings → API keys and paste it again in Settings → Web search (or "
                          "`/search ollama`), or run `ollama signin` on this computer.")
    if status != 200:
        _ollama_failed(status, said, "ollama.com", key)
    return _ollama_rows(payload, body["max_results"])


def _ollama_local(base: str, body: dict) -> list[tuple[str, str, str]]:
    where = f"the Ollama at {base}"
    try:
        status, payload, said = _ollama_post(base + OLLAMA_LOCAL_PATH, body, {})
    except requests.ConnectionError:                    # refused, or no answer to connect (a ReadTimeout is not one)
        raise _NoLocalOllama(f"no Ollama answered at {base}") from None
    if status == 404:
        raise _NoLocalOllama(f"{where} has no web search (Ollama 0.18 and later has it)")
    if status == 401:
        raise _NoLocalOllama(f"{where} isn't signed in to ollama.com")
    if status == 403 and "cloud is disabled" in said.lower():
        raise _NoLocalOllama(f"{where} has its cloud features turned off")
    if status != 200:
        _ollama_failed(status, said, where)
    return _ollama_rows(payload, body["max_results"])


def _run(query: str, provider: str, api_key: str, url: str, n: int) -> list[tuple[str, str, str]]:
    if provider == "brave":
        return _brave(query, n, api_key)
    if provider == "tavily":
        return _tavily(query, n, api_key)
    if provider == "searxng":
        return _searxng(query, n, url)
    if provider == "ollama":
        return _ollama(query, n, api_key)
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
        elif provider == "ollama":
            raise SearchError("Ollama web search finds pages, not pictures.")
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
