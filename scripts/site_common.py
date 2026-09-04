"""Shared, dependency-free site shell for vibedgc.com generators."""
from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "site-src"
SITE = ROOT / "site"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def site_context() -> dict[str, str]:
    brand = load_json(SRC / "data" / "brand.json")
    version = load_json(SITE / "version.json")
    commit = str(version.get("commit", "unknown"))
    asset_sources = [
        *(SRC / "assets" / name for name in ("tokens.css", "site.css", "site.js")),
        ROOT / "scripts" / "docs-assets" / "docs.js",
    ]
    asset_revision = hashlib.sha256(
        b"\0".join(path.read_bytes() for path in asset_sources)
    ).hexdigest()[:12]
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


def head(*, title: str, description: str, path: str, image: str = "/og-card.png",
         kind: str = "website", extra_json_ld: list[dict[str, Any]] | None = None,
         canonical_url: str | None = None, noindex: bool = False,
         preload_image: str | None = None) -> str:
    ctx = site_context()
    canonical = canonical_url or (ctx["SITE_URL"] + canonical_path(path))
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
    return f"""<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">
<script>if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&'IntersectionObserver'in window)document.documentElement.classList.add('reveal-ready')</script>
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
{f'<link rel="preload" href="{html.escape(preload_image, quote=True)}" as="image" fetchpriority="high">' if preload_image else ''}
<link rel=\"preload\" href=\"/assets/fonts/geist-regular-latin.woff2\" as=\"font\" type=\"font/woff2\" crossorigin><link rel=\"preload\" href=\"/assets/fonts/geist-medium-latin.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>
<link rel=\"stylesheet\" href=\"/assets/tokens.css?v={ctx['ASSET_REVISION']}\"><link rel=\"stylesheet\" href=\"/assets/site.css?v={ctx['ASSET_REVISION']}\">
<script type=\"application/ld+json\">{json_script(ld)}</script>"""


def render_shell(*, title: str, description: str, path: str, body: str,
                 body_class: str = "", image: str = "/og-card.png",
                 kind: str = "website",
                 extra_json_ld: list[dict[str, Any]] | None = None,
                 canonical_url: str | None = None,
                 include_announcement: bool = True,
                 noindex: bool = False,
                 preload_image: str | None = None) -> str:
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
{head(title=title, description=description, path=path, image=image, kind=kind, extra_json_ld=extra_json_ld, canonical_url=canonical_url, noindex=noindex, preload_image=preload_image)}
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
