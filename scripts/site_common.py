"""Shared, dependency-free site shell for vibedgc.com generators."""
from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "site-src"
SITE = ROOT / "site"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def site_context() -> dict[str, str]:
    brand = load_json(SRC / "data" / "brand.json")
    version = load_json(SITE / "version.json")
    commit = str(version.get("commit", "unknown"))
    asset_revision = site_asset_revision()
    return {
        "PRODUCT": str(brand["product"]),
        "LONG_NAME": str(brand["long_name"]),
        "COMPANY": str(brand["company"]),
        "FOUNDER": str(brand["founder"]),
        "TAGLINE": str(brand["tagline"]),
        "SITE_URL": str(brand["site_url"]),
        "DOCS_URL": str(brand["docs_url"]),
        "GITHUB_URL": str(brand["github_url"]),
        "MARKETPLACE_URL": str(brand["marketplace_url"]),
        "VERSION": f"v{version['version']}",
        "VERSION_NUMBER": str(version["version"]),
        "COMMIT": commit,
        "COMMIT_SHORT": commit[:8],
        "ASSET_REVISION": asset_revision,
    }


def substitute(source: str, values: dict[str, Any]) -> str:
    rendered = source
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", str(value))
    missing = sorted({part.split("}}", 1)[0] for part in rendered.split("{{")[1:] if "}}" in part})
    if missing:
        raise ValueError(f"unresolved site template values: {', '.join(missing)}")
    return rendered


def partial(name: str, context: dict[str, Any]) -> str:
    return substitute((SRC / "partials" / name).read_text(encoding="utf-8"), context)


def json_script(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def canonical_path(path: str) -> str:
    if path == "index.html":
        return "/"
    if path.endswith("/index.html"):
        return "/" + path[:-10].strip("/")
    if path.endswith(".html"):
        return "/" + path[:-5].strip("/")
    return "/" + path.strip("/")


def minify_css(source: str) -> str:
    """Apply conservative CSS minification without rewriting strings or selectors.

    Whitespace adjacent to ``:`` is intentionally retained. Before a pseudo-class
    it can be a descendant combinator (``.card :is(...)``); after a custom-property
    colon it can be part of the property's substituted token stream.
    """
    result: list[str] = []
    pending_space = False
    cursor = 0
    # The asymmetry around ':' is deliberate; see the docstring above.
    spaceless_after = frozenset("{};,>")
    spaceless_before = frozenset("{};,>")

    while cursor < len(source):
        char = source[cursor]

        if char == "/" and cursor + 1 < len(source) and source[cursor + 1] == "*":
            end = source.find("*/", cursor + 2)
            cursor = len(source) if end < 0 else end + 2
            continue

        if char.isspace():
            pending_space = True
            cursor += 1
            continue

        if pending_space:
            previous = result[-1] if result else ""
            if previous and previous not in spaceless_after and char not in spaceless_before:
                result.append(" ")
            pending_space = False

        if char in {'"', "'"}:
            quote = char
            result.append(char)
            cursor += 1
            while cursor < len(source):
                char = source[cursor]
                result.append(char)
                cursor += 1
                if char == "\\" and cursor < len(source):
                    # Preserve the escaped byte exactly, including escaped quotes,
                    # backslashes, and whitespace inside a string.
                    result.append(source[cursor])
                    cursor += 1
                elif char == quote:
                    break
            continue

        if char == "\\":
            # CSS escapes may make punctuation or whitespace part of an identifier.
            # Copy the escaped byte instead of interpreting it as minifiable syntax.
            result.append(char)
            cursor += 1
            if cursor < len(source):
                result.append(source[cursor])
                if source[cursor] == "\r" and cursor + 1 < len(source) \
                        and source[cursor + 1] == "\n":
                    result.append("\n")
                    cursor += 1
                cursor += 1
            continue

        if char == "}" and result and result[-1] == ";":
            result.pop()
        result.append(char)
        cursor += 1

    return "".join(result)


def emitted_asset_revision(css_sources: tuple[str, ...], raw_sources: tuple[bytes, ...], *,
                           css_minifier: Callable[[str], str]) -> str:
    """Hash the bytes browsers receive, not the pre-transform CSS sources."""
    emitted = [css_minifier(source).encode("utf-8") for source in css_sources]
    emitted.extend(raw_sources)
    digest = hashlib.sha256()
    for payload in emitted:
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()[:12]


def _critical_css_source(route_stylesheet: str) -> str:
    return "\n".join(
        (SRC / "assets" / name).read_text(encoding="utf-8")
        for name in ("tokens.css", "critical-base.css", route_stylesheet)
    )


def site_asset_revision(*, css_minifier: Callable[[str], str] | None = None) -> str:
    """Return one revision for every mutable stylesheet/script emitted by the site."""
    transform = css_minifier or minify_css
    css_sources = tuple(
        (SRC / "assets" / name).read_text(encoding="utf-8")
        for name in ("tokens.css", "site.css")
    ) + tuple(
        _critical_css_source(name)
        for name in ("critical-home.css", "critical-page.css", "critical-docs.css")
    )
    raw_sources = (
        (SRC / "assets" / "site.js").read_bytes(),
        (ROOT / "scripts" / "docs-assets" / "docs.js").read_bytes(),
    )
    return emitted_asset_revision(css_sources, raw_sources, css_minifier=transform)


def critical_css_for(path: str) -> str:
    canonical = canonical_path(path)
    if canonical == "/":
        route_stylesheet = "critical-home.css"
    elif (canonical == "/docs" or canonical.startswith("/docs/")) and canonical != "/docs/404":
        route_stylesheet = "critical-docs.css"
    else:
        route_stylesheet = "critical-page.css"
    result = minify_css(_critical_css_source(route_stylesheet))
    if len(result.encode("utf-8")) > 10 * 1024:
        raise ValueError(f"inline critical CSS exceeds 10 KiB for {path}")
    return result


def head(*, title: str, description: str, path: str, image: str = "/og-card.png",
         kind: str = "website", extra_json_ld: list[dict[str, Any]] | None = None,
         canonical_url: str | None = None, noindex: bool = False,
         preload_image: str | None = None,
         preload_mobile_image: str | None = None) -> str:
    ctx = site_context()
    canonical = canonical_url or (ctx["SITE_URL"] + canonical_path(path))
    critical_css = critical_css_for(path)
    if canonical_path(path) == "/":
        style_loader = """<script>(()=>{const l=document.getElementById('site-styles'),r=document.documentElement,events=['wheel','touchstart','pointerdown','keydown','click','dgc:load-styles'];let ready=false,wanted=Boolean(location.hash),applied=false,failed=false,timer,guard;const cleanup=()=>events.forEach(n=>removeEventListener(n,want,true)),reveal=()=>r.classList.remove('defer-styles','fh'),fail=()=>{if(failed||applied)return;failed=true;clearTimeout(timer);r.dataset.stylesFailOpen='true';reveal();dispatchEvent(new Event('dgc:styles-fail-open'))},done=()=>{if(applied)return;applied=true;clearTimeout(timer);clearTimeout(guard);cleanup();l.media='all';delete r.dataset.stylesFailOpen;r.dataset.stylesReady='true';reveal();dispatchEvent(new Event('dgc:styles-ready'))},markReady=()=>{if(ready)return;ready=true;clearTimeout(guard);guard=undefined;if(wanted)done();else timer=setTimeout(done,3600)},want=()=>{wanted=true;l.media='all';if(ready)done();else if(!guard)guard=setTimeout(fail,3000)};guard=setTimeout(fail,3000);if(wanted)l.media='all';events.forEach(n=>addEventListener(n,want,{once:true,passive:true,capture:true}));l.addEventListener('load',markReady,{once:true});l.addEventListener('error',fail,{once:true});if(l.sheet)markReady()})()</script>"""
    else:
        style_loader = """<script>(()=>{const l=document.getElementById('site-styles'),r=document.documentElement;let applied=false,failed=false,guard;const reveal=()=>r.classList.remove('defer-styles','fh'),fail=()=>{if(failed||applied)return;failed=true;r.dataset.stylesFailOpen='true';reveal();dispatchEvent(new Event('dgc:styles-fail-open'))},done=()=>{if(applied)return;applied=true;clearTimeout(guard);delete r.dataset.stylesFailOpen;r.dataset.stylesReady='true';reveal();dispatchEvent(new Event('dgc:styles-ready'))};l.media='all';guard=setTimeout(fail,3000);l.addEventListener('load',done,{once:true});l.addEventListener('error',fail,{once:true});if(l.sheet)done()})()</script>"""
    full_title = title if "DGC" in title else f"{title} · DGC"
    ld: list[dict[str, Any]] = [
        {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": ctx["COMPANY"],
            "url": ctx["SITE_URL"],
            "founder": {"@type": "Person", "name": ctx["FOUNDER"]},
            "sameAs": [ctx["GITHUB_URL"]],
        },
        {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": ctx["LONG_NAME"],
            "alternateName": ctx["PRODUCT"],
            "applicationCategory": "DeveloperApplication",
            "operatingSystem": "Linux, macOS, Windows via WSL",
            "softwareVersion": ctx["VERSION_NUMBER"],
            "url": ctx["SITE_URL"],
            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD", "description": "Free for noncommercial use"},
        },
    ]
    if extra_json_ld:
        ld.extend(extra_json_ld)
    announcement_key = json.dumps(f"dgc-announcement-{ctx['VERSION_NUMBER']}")
    canonical_page = canonical_path(path)
    if canonical_page in {"/404", "/subscription"} or canonical_page == "/docs" or canonical_page.startswith("/docs/"):
        render_guard = "document.documentElement.classList.add('fh');"
    else:
        render_guard = "if(location.hash)document.documentElement.classList.add('fh');"
    return f"""<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">
<script>document.documentElement.classList.add('defer-styles');{render_guard}try{{if(localStorage.getItem({announcement_key})==='dismissed')document.documentElement.classList.add('announcement-dismissed')}}catch{{}}if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&'IntersectionObserver'in window)document.documentElement.classList.add('reveal-ready')</script>
<title>{html.escape(full_title)}</title>
<meta name=\"description\" content=\"{html.escape(description, quote=True)}\">
{'<meta name="robots" content="noindex,nofollow">' if noindex else ''}
<meta name=\"theme-color\" content=\"#0B0B0D\">
<link rel=\"canonical\" href=\"{html.escape(canonical, quote=True)}\">
<meta property=\"og:type\" content=\"{html.escape(kind, quote=True)}\">
<meta property=\"og:site_name\" content=\"{html.escape(ctx['LONG_NAME'], quote=True)}\">
<meta property=\"og:title\" content=\"{html.escape(full_title, quote=True)}\">
<meta property=\"og:description\" content=\"{html.escape(description, quote=True)}\">
<meta property=\"og:url\" content=\"{html.escape(canonical, quote=True)}\">
<meta property=\"og:image\" content=\"{ctx['SITE_URL']}{html.escape(image, quote=True)}\">
<meta property=\"og:image:width\" content=\"1200\"><meta property=\"og:image:height\" content=\"630\">
<meta name=\"twitter:card\" content=\"summary_large_image\"><meta name=\"twitter:title\" content=\"{html.escape(full_title, quote=True)}\"><meta name=\"twitter:description\" content=\"{html.escape(description, quote=True)}\"><meta name=\"twitter:image\" content=\"{ctx['SITE_URL']}{html.escape(image, quote=True)}\">
<link rel=\"icon\" href=\"/favicon.svg\" type=\"image/svg+xml\"><link rel=\"apple-touch-icon\" href=\"/apple-touch-icon.png\"><link rel=\"manifest\" href=\"/site.webmanifest\">
<link rel=\"alternate\" type=\"application/atom+xml\" title=\"DGC engineering\" href=\"/feed.xml\"><link rel=\"alternate\" type=\"application/atom+xml\" title=\"DGC releases\" href=\"/changelog.xml\">
{f'<link rel="preload" href="{html.escape(preload_mobile_image, quote=True)}" as="image" fetchpriority="high" media="(max-width:800px)">' if preload_mobile_image else ''}
{f'<link rel="preload" href="{html.escape(preload_image, quote=True)}" as="image" fetchpriority="high" media="(min-width:801px)">' if preload_image and preload_mobile_image else (f'<link rel="preload" href="{html.escape(preload_image, quote=True)}" as="image" fetchpriority="high">' if preload_image else '')}
<link rel=\"preload\" href=\"/assets/fonts/geist-regular-latin.woff2\" as=\"font\" type=\"font/woff2\" crossorigin><link rel=\"preload\" href=\"/assets/fonts/geist-medium-latin.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>
<style data-critical-revision=\"{ctx['ASSET_REVISION']}\">{critical_css}</style>
<link rel=\"stylesheet\" href=\"/assets/site.css?v={ctx['ASSET_REVISION']}\" media=\"print\" id=\"site-styles\">{style_loader}<noscript><link rel=\"stylesheet\" href=\"/assets/site.css?v={ctx['ASSET_REVISION']}\"></noscript>
<script type=\"application/ld+json\">{json_script(ld)}</script>"""


def render_shell(*, title: str, description: str, path: str, body: str,
                 body_class: str = "", image: str = "/og-card.png",
                 kind: str = "website",
                 extra_json_ld: list[dict[str, Any]] | None = None,
                 canonical_url: str | None = None,
                 include_announcement: bool = True,
                 noindex: bool = False,
                 preload_image: str | None = None,
                 preload_mobile_image: str | None = None) -> str:
    ctx = site_context()
    nav = partial("nav.html", ctx)
    if not include_announcement:
        start = nav.find('<div class="announcement"')
        end = nav.find("</div>", start)
        nav = nav[:start] + nav[end + 6:] if start >= 0 and end >= 0 else nav
    footer = partial("footer.html", ctx)
    return f"""<!doctype html>
<html lang=\"en\">
<head>
{head(title=title, description=description, path=path, image=image, kind=kind, extra_json_ld=extra_json_ld, canonical_url=canonical_url, noindex=noindex, preload_image=preload_image, preload_mobile_image=preload_mobile_image)}
</head>
<body class=\"{html.escape(body_class, quote=True)}\">
<a class=\"skip-link\" href=\"#content\">Skip to content</a>
{nav}
<main id=\"content\">
{body}
</main>
{footer}
<script src=\"/assets/site.js?v={ctx['ASSET_REVISION']}\" defer></script>
</body>
</html>
"""
