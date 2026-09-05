#!/usr/bin/env python3
"""Fail closed when the generated vibedgc.com tree is incomplete or unsafe.

The checker is dependency-free so the same gate can run locally, in CI, and
immediately before a Cloudflare Pages deployment.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
import math
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urljoin, urlparse

from benchmark_site import BenchmarkDataError, benchmark_context, subject_harness, validate_benchmark
from release_bundle import validate_bundle
from site_common import emitted_asset_revision, minify_css, site_asset_revision

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
BENCH = json.loads((ROOT / "site-src" / "data" / "bench.json").read_text(encoding="utf-8"))
VERSION = json.loads((SITE / "version.json").read_text(encoding="utf-8"))["version"]

TEXT_SUFFIXES = {".html", ".css", ".js", ".json", ".xml", ".txt", ".svg", ".sha256", ".webmanifest"}
LOCAL_HOSTS = {"vibedgc.com", "www.vibedgc.com", "docs.vibedgc.com"}
EXEMPT_PATHS = {"/api/event"}
LEAK_PATTERNS = {
    "internal audit terminology": re.compile(
        r"FRONTIER_AUDIT|FRONTIER[_ -]ROADMAP|frontier[- ]hardening", re.I,
    ),
    "machine-local path": re.compile(
        r"/(?:home|Users|root)/[^/\s]+|[A-Za-z]:\\+Users\\+[^\\\s]+"
        r"|/tmp/(?:claude|dgc)-|results-orig",
        re.I,
    ),
    "hidden command": re.compile(r"(?:/bored\b|process defender|terminal arcade|snake game)", re.I),
}
SECRET_PATTERN = re.compile(
    rb"(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{24,}|github_pat_[A-Za-z0-9_]{20,}"
    rb"|gh[pousr]_[A-Za-z0-9]{30,}|re_[A-Za-z0-9_-]{24,}"
    rb"|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)

STATIC_PUBLIC_FILES = {
    "_headers", "_worker.js", "install.sh", "favicon.svg", "apple-touch-icon.png",
    "icon-512.png", "og-card.png", "og-benchmark.png", "og-docs.png", "og-editor.png",
    "dgc-mark.svg", "dgc-mark-mono.svg",
    "assets/cli-capture-poster.jpg", "assets/cli-capture.mp4", "assets/cli-capture.webm",
    "assets/editor-capture-poster.jpg", "assets/editor-capture-poster-720.jpg",
    "assets/editor-capture.mp4", "assets/editor-capture.webm",
    "assets/hero-graded-poster.jpg", "assets/hero-mobile-poster.webp", "assets/hero-graded.mp4", "assets/hero-graded.webm",
    "assets/hero-mobile.mp4", "assets/hero-mobile.webm",
    "assets/power-graded-poster.jpg", "assets/power-graded.mp4", "assets/power-graded.webm",
    "assets/sub-graded-poster.jpg", "assets/sub-graded.mp4", "assets/sub-graded.webm",
    "assets/fonts/Geist-OFL.txt", "assets/fonts/JetBrains-Mono-OFL.txt",
    "assets/fonts/geist-medium-latin.woff2", "assets/fonts/geist-regular-latin.woff2",
    "assets/fonts/jetbrains-mono-medium-latin.woff2",
    "assets/fonts/jetbrains-mono-regular-latin.woff2",
    "version.json", "provenance.json", "dgc.cdx.json", "dgc.tar.gz", "dgc.tar.gz.sha256",
    "vscode/version.json", "vscode/dgc.vsix", "vscode/dgc.vsix.sha256",
}

BENCHMARK_TEMPLATE_FILES = (
    "pages/index.html",
    "pages/benchmark.html",
    "partials/fig1.html",
    "partials/terminal.html",
    "content/faq.md",
    "social/og-card.svg",
    "social/og-benchmark.svg",
)
BENCHMARK_LITERAL_PATTERNS = (
    re.compile(r"(?<!\{)\b\d+(?:\.\d+)?%(?![\"'])"),
    re.compile(r"(?<!\{)\b\d+\s*/\s*\d+\b"),
    re.compile(r"(?<!\{)\bpass@\d+\b", re.I),
    re.compile(
        r"(?<!\{)\b\d[\d,]*(?:\.\d+)?(?:-task|-second| tasks?\b| problems?\b|"
        r" seconds?\b| s(?:/round| per round| each| grader timeout)| timeouts?\b|"
        r" predictions?\b| patches?\b|[BM] model\b| context\b)",
        re.I,
    ),
    re.compile(r"\b(?:three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ](?:harnesses|languages)\b", re.I),
    re.compile(r"--(?:context-size|limit|rounds|dgc-timeout|test-timeout)\s+\d+"),
)


def _load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def public_file_inventory() -> set[str]:
    """Return the exact reviewed output set that a production deploy may contain."""
    builder = _load_script("dgc_site_inventory", ROOT / "scripts" / "build-site.py")
    docs = _load_script("dgc_docs_inventory", ROOT / "scripts" / "generate-docs-site.py")
    expected = set(builder.build_outputs()) | STATIC_PUBLIC_FILES
    expected.update(f"docs/{name}" for name in docs.build())
    expected.update(f"docs/assets/{name}" for name in docs.DOCS_ASSETS)
    for harness in BENCH["harnesses"]:
        name = f"evidence/{harness['slug']}-{BENCH['run_version']}.tar.gz"
        expected.update((name, name + ".sha256"))
    editor_version = json.loads((SITE / "vscode" / "version.json").read_text(encoding="utf-8"))
    version = str(editor_version.get("version") or "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("vscode/version.json contains an invalid version")
    expected.add(f"vscode/dgc-{version}.vsix")
    return expected


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.refs: list[tuple[str, str, str]] = []
        self.canonical: list[str] = []
        self.descriptions = 0
        self.og_images: list[str] = []
        self.videos: list[dict[str, str]] = []
        self.events: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        data = {name: value or "" for name, value in attrs}
        if data.get("id"):
            self.ids.append(data["id"])
        for attr in ("href", "src", "poster", "data-src"):
            if data.get(attr):
                self.refs.append((tag, attr, data[attr]))
        for attr in ("srcset", "data-srcset"):
            if data.get(attr):
                for candidate in data[attr].split(","):
                    self.refs.append((tag, attr, candidate.strip().split()[0]))
        if tag == "link" and data.get("rel") == "canonical":
            self.canonical.append(data.get("href", ""))
        if tag == "meta" and data.get("name") == "description" and data.get("content"):
            self.descriptions += 1
        if tag == "meta" and data.get("property") == "og:image":
            self.og_images.append(data.get("content", ""))
        if tag == "video":
            self.videos.append(data)
        for attr in ("data-event", "data-event-play", "data-page-event"):
            if data.get(attr):
                self.events.add(data[attr])


def served_page(path: str) -> Path | None:
    clean = unquote(path).split("?", 1)[0]
    if clean in EXEMPT_PATHS:
        return None
    relative = clean.lstrip("/")
    candidates = [SITE / relative]
    if not Path(relative).suffix:
        candidates.extend((SITE / f"{relative}.html", SITE / relative / "index.html"))
    if clean.endswith("/") or not relative:
        candidates.insert(0, SITE / relative / "index.html")
    return next((candidate for candidate in candidates if candidate.is_file()), candidates[0])


def page_url(path: Path) -> str:
    relative = path.relative_to(SITE).as_posix()
    if relative == "index.html":
        return "https://vibedgc.com/"
    return "https://vibedgc.com/" + relative


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    if len(data) != 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", data[16:24])


def check_pages(errors: list[str]) -> dict[Path, PageParser]:
    parsed: dict[Path, PageParser] = {}
    pages = sorted(SITE.rglob("*.html"))
    for page in pages:
        source = page.read_text(encoding="utf-8")
        parser = PageParser(); parser.feed(source); parsed[page] = parser
        label = page.relative_to(SITE).as_posix()
        if len(parser.ids) != len(set(parser.ids)):
            duplicates = sorted({item for item in parser.ids if parser.ids.count(item) > 1})
            errors.append(f"{label}: duplicate ids {duplicates}")
        if len(parser.canonical) != 1:
            errors.append(f"{label}: expected one canonical link, found {len(parser.canonical)}")
        if parser.descriptions != 1:
            errors.append(f"{label}: expected one meta description, found {parser.descriptions}")
        if len(parser.og_images) != 1:
            errors.append(f"{label}: expected one og:image, found {len(parser.og_images)}")
        if re.search(r"\{\{[A-Z][A-Z0-9_]*\}\}", source):
            errors.append(f"{label}: unresolved template marker")
        if label.startswith("docs/") and "**" in source:
            errors.append(f"{label}: raw Markdown emphasis marker")
        critical = re.findall(
            r'<style data-critical-revision="[0-9a-f]{12}">(.*?)</style>',
            source,
            flags=re.DOTALL,
        )
        if len(critical) != 1:
            errors.append(f"{label}: expected one revisioned inline critical stylesheet")
        elif len(critical[0].encode("utf-8")) > 10 * 1024:
            errors.append(f"{label}: inline critical CSS exceeds 10 KiB")

    for page, parser in parsed.items():
        base = page_url(page)
        for tag, attr, raw in parser.refs:
            if raw.startswith(("#", "mailto:", "tel:", "data:", "javascript:")):
                target_page = page
                fragment = raw[1:] if raw.startswith("#") else ""
            else:
                parsed_url = urlparse(urljoin(base, raw))
                if parsed_url.scheme not in {"", "http", "https"} or parsed_url.hostname not in LOCAL_HOSTS:
                    continue
                target_path = parsed_url.path
                if parsed_url.hostname == "docs.vibedgc.com" and not target_path.startswith("/docs"):
                    target_path = "/docs" + (target_path if target_path != "/" else "")
                target_page = served_page(target_path)
                fragment = unquote(parsed_url.fragment)
                if parsed_url.path in EXEMPT_PATHS:
                    continue
                if target_page is None or not target_page.is_file():
                    errors.append(f"{page.relative_to(SITE)}: broken {tag}[{attr}] {raw}")
                    continue
            if fragment:
                target_parser = parsed.get(target_page)
                if target_parser is None and target_page and target_page.suffix == ".html":
                    target_parser = PageParser(); target_parser.feed(target_page.read_text(encoding="utf-8"))
                if target_parser is not None and fragment not in target_parser.ids:
                    errors.append(f"{page.relative_to(SITE)}: missing fragment #{fragment} in {target_page.relative_to(SITE)}")
    return parsed


def check_css(errors: list[str]) -> None:
    for name in ("assets/tokens.css", "assets/site.css"):
        path = SITE / name
        text = path.read_text(encoding="utf-8")
        if re.search(r"font-weight\s*:\s*(?:[6-9]00|[6-9]\d\d)", text):
            errors.append(f"{name}: font weight above 500")
        if "fonts.googleapis" in text or "fonts.gstatic" in text:
            errors.append(f"{name}: remote font origin")
        if "/*" in text or "\n" in text:
            errors.append(f"{name}: public CSS is not build-minified")
        for raw in re.findall(r"url\((?:['\"])?([^)'\"]+)", text):
            if raw.startswith(("data:", "http:", "https:", "#", "%23")):
                continue
            clean = raw.split("?", 1)[0]
            target = (SITE / clean.lstrip("/")) if clean.startswith("/") else (path.parent / clean).resolve()
            if not target.is_file():
                errors.append(f"{name}: broken CSS url {raw}")


def check_analytics_event_contract(parsed: dict[Path, PageParser], errors: list[str]) -> None:
    """Keep every browser-emitted event synchronized with the Worker allowlist."""
    used = {event for parser in parsed.values() for event in parser.events}
    worker = (SITE / "_worker.js").read_text(encoding="utf-8")
    match = re.search(r"const EVENTS = new Set\(\[(.*?)\]\);", worker, re.DOTALL)
    if not match:
        errors.append("_worker.js: could not read the analytics event allowlist")
        return
    allowed = set(re.findall(r'"([a-z][a-z0-9_]*)"', match.group(1)))
    if used != allowed:
        missing = sorted(used - allowed)
        dead = sorted(allowed - used)
        errors.append(
            "analytics event contract disagrees between HTML and Worker"
            f" (unhandled={missing}, unused={dead})"
        )


def check_website_intake_retired(errors: list[str]) -> None:
    """Prevent any retired contact or release-signup data path from returning."""
    for page in sorted(SITE.rglob("*.html")):
        source = page.read_text(encoding="utf-8")
        if re.search(r"<form\b", source, re.I):
            errors.append(f"{page.relative_to(SITE)}: website forms are retired")
    if (SITE / "subscription.html").exists():
        errors.append("subscription.html: retired release-signup page must be absent")

    worker = (SITE / "_worker.js").read_text(encoding="utf-8")
    retired_markers = (
        "DGC_CONTACT_EMAIL", "DGC_FROM_EMAIL", "DGC_RATE_LIMIT_SECRET", "DGC_SITE_DB",
        "RESEND_API_KEY", "commercialRoute", "normalizedCommercial", "validCommercial",
        "subscribeRoute", "subscribeRequestRoute", "subscriptionAction", "sendEmail",
        "pending_subscriptions", "commercial_leads", "form_cooldowns", "subscribers",
    )
    for marker in retired_markers:
        if marker in worker:
            errors.append(f"_worker.js: retired website-intake marker remains: {marker}")
    retired_paths = (
        "/api/commercial", "/api/subscribe", "/api/subscribe/confirm", "/api/unsubscribe",
    )
    if "RETIRED_API_PATHS.has(url.pathname)" not in worker \
            or 'response = json({error: "Not found"}, 404);' not in worker:
        errors.append("_worker.js: retired website-intake endpoints need an explicit JSON 404")
    for path in retired_paths:
        if json.dumps(path) not in worker:
            errors.append(f"_worker.js: retired endpoint tombstone is missing: {path}")

    generated_assets = "\n".join(
        (SITE / name).read_text(encoding="utf-8")
        for name in ("assets/site.js", "assets/site.css")
    )
    for marker in ("data-async-form", "data-subscription-panel", "release-form"):
        if marker in generated_assets:
            errors.append(f"generated assets retain retired form marker: {marker}")

    config_path = ROOT / "wrangler.json"
    if not config_path.is_file():
        errors.append("wrangler.json: Pages configuration is missing")
    else:
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            if config.get("d1_databases"):
                errors.append("wrangler.json: retired D1 binding remains")
            if config.get("vars"):
                errors.append("wrangler.json: website runtime variables are not expected")
        except (OSError, TypeError, json.JSONDecodeError) as exc:
            errors.append(f"wrangler.json: invalid JSON ({exc})")
    migrations = ROOT / "migrations"
    if migrations.exists() and any(migrations.glob("*.sql")):
        errors.append("migrations: retired website persistence schema remains")


def check_blog_retired(errors: list[str]) -> None:
    """Keep the removed blog, article feed, and publishing sources out of the site."""
    retired_page = ROOT / "site-src" / "pages" / "blog.html"
    retired_content = ROOT / "site-src" / "content" / "blog"
    if retired_page.exists():
        errors.append(f"{retired_page.relative_to(ROOT)}: website blog source is retired")
    if retired_content.exists() and any(path.is_file() for path in retired_content.rglob("*")):
        errors.append(f"{retired_content.relative_to(ROOT)}: website blog source is retired")
    generated_blog = SITE / "blog"
    if generated_blog.exists() and any(path.is_file() for path in generated_blog.rglob("*")):
        errors.append("site/blog: retired website blog output must be absent")
    if (SITE / "feed.xml").exists():
        errors.append("site/feed.xml: retired engineering-notes feed must be absent")

    routes = (SITE / "routes.json").read_text(encoding="utf-8")
    sitemap = (SITE / "sitemap.xml").read_text(encoding="utf-8")
    generated_html = "\n".join(
        page.read_text(encoding="utf-8") for page in sorted(SITE.rglob("*.html"))
    )
    retired_reference = re.compile(
        r"(?:https://vibedgc\.com)?/blog(?:[\"'/<]|$)|/feed\.xml",
    )
    for label, text in (
        ("routes.json", routes),
        ("sitemap.xml", sitemap),
        ("generated HTML", generated_html),
    ):
        if retired_reference.search(text):
            errors.append(f"{label}: retired website blog reference remains")


def check_css_minifier(errors: list[str]) -> None:
    """Pin the string, comment, escape, and selector-safety contract."""
    cases = (
        (
            "descendant pseudo-classes",
            ".a :is(.b, .c), .d ::before { color: red; }",
            ".a :is(.b,.c),.d ::before{color: red}",
        ),
        (
            "quoted comment-like text and escapes",
            r'''.x::before { content: "/* literal */ ; } >"; note: 'it\'s C:\\tmp'; } /* remove */''',
            r'''.x::before{content: "/* literal */ ; } >";note: 'it\'s C:\\tmp'}''',
        ),
        (
            "comments preserve surrounding selector whitespace",
            ".a/**/:hover, .b /**/:focus { color: red; /* declaration */ margin: 0; }",
            ".a:hover,.b :focus{color: red;margin: 0}",
        ),
        (
            "declarations and media features",
            "@media (max-width : 760px) { .x { color : red ; transform: translate(1px, 2px); } }",
            "@media (max-width : 760px){.x{color : red;transform: translate(1px,2px)}}",
        ),
        (
            "custom-property leading value whitespace",
            ':root { --raw: foo ; --quoted:" bar"; color: red; }',
            ':root{--raw: foo;--quoted:" bar";color: red}',
        ),
    )
    for label, source, expected in cases:
        actual = minify_css(source)
        if actual != expected:
            errors.append(f"CSS minifier {label}: expected {expected!r}, found {actual!r}")
        elif minify_css(actual) != actual:
            errors.append(f"CSS minifier {label}: output is not idempotent")


def check_asset_revision_contract(errors: list[str]) -> None:
    """Pin revisions to emitted bytes, including changes caused only by the transformer."""
    source = ".sample { color: red; }"
    script = b"const sample = true;"
    baseline = emitted_asset_revision((source,), (script,), css_minifier=minify_css)
    comment_only = emitted_asset_revision(
        ("/* build note */ " + source,), (script,), css_minifier=minify_css,
    )
    implementation_change = emitted_asset_revision(
        (source,), (script,),
        css_minifier=lambda value: minify_css(value).replace("red", "blue"),
    )
    script_change = emitted_asset_revision(
        (source,), (script + b"\n",), css_minifier=minify_css,
    )
    actual = site_asset_revision()
    unchanged_implementation = site_asset_revision(css_minifier=lambda value: minify_css(value))
    changed_implementation = site_asset_revision(
        css_minifier=lambda value: minify_css(value) + "\n",
    )
    if comment_only != baseline:
        errors.append("asset revision changed even though emitted CSS bytes were identical")
    if implementation_change == baseline:
        errors.append("asset revision ignored a minifier-only emitted CSS change")
    if script_change == baseline:
        errors.append("asset revision ignored an emitted script change")
    if unchanged_implementation != actual:
        errors.append("asset revision changed for a byte-identical minifier implementation")
    if changed_implementation == actual:
        errors.append("site asset revision ignored minifier-only emitted CSS changes")


def check_leak_pattern_contract(errors: list[str]) -> None:
    """Exercise machine-path coverage without embedding publishable fixture paths."""
    separator = chr(92)
    fixtures = (
        ("root POSIX home", "/".join(("", "root", "private-work", "trace.json"))),
        ("Windows user home", "C:" + separator + separator.join(("Users", "builder", "trace.json"))),
        (
            "JSON-escaped Windows user home",
            "D:" + separator * 2 + (separator * 2).join(("Users", "builder", "trace.json")),
        ),
    )
    pattern = LEAK_PATTERNS["machine-local path"]
    for label, fixture in fixtures:
        if not pattern.search(fixture):
            errors.append(f"machine-local path leak pattern missed its {label} fixture")
    for fixture in ("/rooted/public/path", "Users/builder/project", "roots/private-work"):
        if pattern.search(fixture):
            errors.append(f"machine-local path leak pattern rejected benign text {fixture!r}")


def check_routes(parsed: dict[Path, PageParser], errors: list[str]) -> None:
    routes = json.loads((SITE / "routes.json").read_text(encoding="utf-8"))["html"]
    if len(routes) != len(set(routes)):
        errors.append("routes.json: duplicate route")
    expected = set()
    for page in parsed:
        relative = page.relative_to(SITE).as_posix()
        if relative.endswith("404.html"):
            continue
        route = "/" + relative.removesuffix("index.html").removesuffix(".html").rstrip("/")
        expected.add(route or "/")
    missing = sorted(expected - set(routes))
    extra = sorted(set(routes) - expected)
    if missing:
        errors.append(f"routes.json: missing HTML routes {missing}")
    if extra:
        errors.append(f"routes.json: unknown HTML routes {extra}")


def check_asset_revisions(parsed: dict[Path, PageParser], errors: list[str]) -> None:
    """Keep HTML and mutable shared assets in lockstep across deployments."""
    # Tokens and route-specific critical CSS are inlined. Their bytes participate in the
    # shared revision emitted on the deferred full stylesheet and site script.
    expected = {"/assets/site.css", "/assets/site.js"}
    for page, parser in parsed.items():
        found: dict[str, str] = {}
        docs_revision = ""
        for _tag, _attr, raw in parser.refs:
            parsed_url = urlparse(raw)
            if parsed_url.path in expected:
                match = re.fullmatch(r"v=([0-9a-f]{12})", parsed_url.query)
                if match:
                    found[parsed_url.path] = match.group(1)
            elif parsed_url.path == "/docs/assets/docs.js":
                match = re.fullmatch(r"v=([0-9a-f]{12})", parsed_url.query)
                if match:
                    docs_revision = match.group(1)
        label = page.relative_to(SITE).as_posix()
        if set(found) != expected:
            errors.append(f"{label}: shared CSS/JS must carry a 12-hex content revision")
        elif len(set(found.values())) != 1:
            errors.append(f"{label}: shared CSS/JS content revisions disagree")
        elif (label.startswith("docs/") and label != "docs/404.html"
              and docs_revision != next(iter(found.values()))):
            errors.append(f"{label}: documentation JS content revision is missing or disagrees")


def check_media(parsed: dict[Path, PageParser], errors: list[str]) -> None:
    home = parsed.get(SITE / "index.html")
    if home is None:
        errors.append("index.html: missing")
        return
    autoplay = [video for video in home.videos if "autoplay" in video]
    if (len(autoplay) != 1 or "data-hero-video" not in autoplay[0]
            or autoplay[0].get("preload") != "auto"
            or not all(key in autoplay[0] for key in ("muted", "loop", "playsinline"))):
        errors.append("index.html: hero must be the sole muted, looping, inline autoplay video with preload=auto")
    lazy = [video for video in home.videos if "data-lazy-video" in video]
    if len(lazy) != 2 or any(video.get("preload") != "none" for video in lazy):
        errors.append("index.html: both ambient section videos must lazy-load with preload=none")
    required = {
        "og-card.png": (1200, 630), "og-benchmark.png": (1200, 630),
        "og-docs.png": (1200, 630), "og-editor.png": (1200, 630),
        "icon-512.png": (512, 512), "apple-touch-icon.png": (180, 180),
    }
    for name, expected in required.items():
        path = SITE / name
        if not path.is_file():
            errors.append(f"{name}: required image is missing")
            continue
        try:
            actual = png_size(path)
            if actual != expected:
                errors.append(f"{name}: expected {expected[0]}x{expected[1]}, found {actual[0]}x{actual[1]}")
        except ValueError as exc:
            errors.append(f"{name}: {exc}")


CAPTURE_MEDIA_FILES = {
    "cli": {
        "prefix": "cli-capture",
        "width": 1280,
        "height": 720,
        "min_duration": 46.0,
        "kind": "real_cli_local_model",
        "required": {
            "live_model": True,
            "controlled_fixture": True,
            "real_time": True,
            "tool_sequence": ["read_file", "read_file", "edit_file", "bash"],
            "sandbox_backend": "bwrap",
            "model_route": "local Ollama · qwen2.5:14b",
        },
        "provenance_terms": (
            "Actual current DGC ", "real local Ollama run", "qwen2.5:14b",
            "disposable controlled fixture", "python3 -m unittest -v passed 3/3",
            "real time, no speed adjustment", "no user config or session persisted",
        ),
    },
    "editor": {
        "prefix": "editor-capture",
        "width": 1440,
        "height": 900,
        "min_duration": 30.0,
        "kind": "actual_extension_deterministic_fixture",
        "required": {
            "live_model": False,
            "controlled_fixture": True,
            "deterministic_fixture": True,
            "real_time": True,
            "tool_sequence": ["read_file", "edit_file", "bash"],
            "real_plan_button_click": True,
            "visible_editor_matches_diff": True,
            "source_unchanged_through_current_head": True,
        },
        "provenance_terms": (
            "Actual extension surface", "deterministic protocol fixture",
            "real disposable-file edit and unittest run", "not a live model session",
            "real time, no speed adjustment",
        ),
    },
}
CAPTURE_RECORD_KEYS = {"path", "sha256", "bytes", "codec", "width", "height"}
CAPTURE_VIDEO_RECORD_KEYS = CAPTURE_RECORD_KEYS | {"duration_seconds"}
CAPTURE_KEYS = {
    "cli": {
        "kind", "live_model", "controlled_fixture", "real_time", "tool_sequence",
        "duration_seconds", "duration_label", "provenance", "model_route", "time_compression",
        "sandbox_backend", "files",
    },
    "editor": {
        "kind", "live_model", "controlled_fixture", "deterministic_fixture", "real_time",
        "tool_sequence", "real_plan_button_click", "visible_editor_matches_diff",
        "source_unchanged_through_current_head", "duration_seconds", "duration_label", "provenance",
        "vscode_version", "extension_version", "packaged_extension_source_commit",
        "extension_vsix_sha256", "time_compression", "files",
    },
}


def _capture_probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration:stream=codec_name,width,height", "-of", "json", str(path)],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30,
    )
    return json.loads(result.stdout)


def check_capture_manifest(errors: list[str]) -> None:
    """Fail closed on capture provenance and on any media/manifest byte mismatch."""
    manifest_path = ROOT / "site-src" / "data" / "capture-media.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        errors.append(f"capture-media.json: could not read structured manifest ({exc})")
        return
    if set(manifest) != {"schema_version", "captures"} or manifest.get("schema_version") != 1:
        errors.append("capture-media.json: expected schema_version=1 and only captures")
        return
    captures = manifest.get("captures")
    if not isinstance(captures, dict) or set(captures) != set(CAPTURE_MEDIA_FILES):
        errors.append("capture-media.json: CLI and editor capture sets must both be declared")
        return

    declared: dict[str, str] = {}
    for slug, spec in CAPTURE_MEDIA_FILES.items():
        capture = captures.get(slug)
        if not isinstance(capture, dict):
            errors.append(f"capture-media.json: {slug} record is not an object")
            continue
        if set(capture) != CAPTURE_KEYS[slug]:
            errors.append(f"capture-media.json: {slug} has an invalid structured schema")
        for key, expected in spec["required"].items():
            if capture.get(key) != expected:
                errors.append(f"capture-media.json: {slug}.{key} disagrees with capture provenance")
        if capture.get("kind") != spec["kind"]:
            errors.append(f"capture-media.json: {slug}.kind is invalid")
        provenance = capture.get("provenance")
        if not isinstance(provenance, str) or any(term not in provenance for term in spec["provenance_terms"]):
            errors.append(f"capture-media.json: {slug}.provenance is incomplete")
        if slug == "cli" and isinstance(provenance, str) \
                and f"Actual current DGC {VERSION}" not in provenance:
            errors.append("capture-media.json: CLI provenance is not for the current release")
        if not isinstance(provenance, str) or re.search(r"permission denied|denied|loop|retry", provenance, re.I):
            errors.append(f"capture-media.json: {slug}.provenance contains denied/retry evidence")
        factor = capture.get("time_compression")
        if (capture.get("real_time") is not True or factor != 1
                or isinstance(factor, bool) or not isinstance(factor, (int, float))):
            errors.append(f"capture-media.json: {slug} must be an uncompressed real-time capture")
        duration = capture.get("duration_seconds")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) \
                or not math.isfinite(float(duration)) or float(duration) < spec["min_duration"]:
            errors.append(f"capture-media.json: {slug} duration is below the publication gate")
        if isinstance(duration, (int, float)) and not isinstance(duration, bool):
            rounded = int(float(duration) + 0.5)
            expected_label = f"{rounded // 60}:{rounded % 60:02d}"
            if capture.get("duration_label") != expected_label:
                errors.append(f"capture-media.json: {slug}.duration_label disagrees")
        if slug == "editor":
            try:
                public_editor = json.loads((SITE / "vscode" / "version.json").read_text(encoding="utf-8"))
                actual_vsix_sha = hashlib.sha256((SITE / "vscode" / "dgc.vsix").read_bytes()).hexdigest()
                if capture.get("vscode_version") != "1.107.1":
                    errors.append("capture-media.json: editor VS Code provenance is invalid")
                if capture.get("extension_version") != public_editor.get("version"):
                    errors.append("capture-media.json: editor extension version disagrees")
                if capture.get("extension_vsix_sha256") != actual_vsix_sha:
                    errors.append("capture-media.json: editor VSIX provenance disagrees")
                with zipfile.ZipFile(SITE / "vscode" / "dgc.vsix") as package:
                    build = json.loads(package.read("extension/dist/build.json"))
                if (capture.get("packaged_extension_source_commit") != build.get("source_commit")
                        or build.get("flavor") != "selfhost"):
                    errors.append("capture-media.json: editor packaged-source provenance disagrees")
            except (OSError, KeyError, TypeError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
                errors.append(f"capture-media.json: editor package provenance is invalid ({exc})")
        files = capture.get("files")
        expected_kinds = {"webm", "mp4", "poster"}
        if slug == "editor":
            expected_kinds.add("preview")
        if not isinstance(files, dict) or set(files) != expected_kinds:
            errors.append(
                f"capture-media.json: {slug} must declare exactly "
                + ", ".join(sorted(expected_kinds))
            )
            continue
        observed_duration: dict[str, float] = {}
        file_specs = [
            ("webm", f"assets/{spec['prefix']}.webm", "vp9", spec["width"], spec["height"], True),
            ("mp4", f"assets/{spec['prefix']}.mp4", "h264", spec["width"], spec["height"], True),
            ("poster", f"assets/{spec['prefix']}-poster.jpg", "mjpeg", spec["width"], spec["height"], False),
        ]
        if slug == "editor":
            file_specs.append(
                ("preview", "assets/editor-capture-poster-720.jpg", "mjpeg", 720, 450, False)
            )
        for kind, expected_path, codec, width, height, is_video in file_specs:
            record = files.get(kind)
            if not isinstance(record, dict):
                errors.append(f"capture-media.json: {slug}.{kind} is not an object")
                continue
            expected_keys = CAPTURE_VIDEO_RECORD_KEYS if is_video else CAPTURE_RECORD_KEYS
            if set(record) != expected_keys:
                errors.append(f"capture-media.json: {slug}.{kind} has an invalid schema")
                continue
            relative = record.get("path")
            if relative != expected_path:
                errors.append(f"capture-media.json: {slug}.{kind} path is not source-owned")
                continue
            if relative in declared:
                errors.append(f"capture-media.json: duplicate media path {relative}")
            declared[relative] = slug
            path = SITE / relative
            if not path.is_file() or path.is_symlink():
                errors.append(f"capture-media.json: declared media is missing {relative}")
                continue
            try:
                raw = path.read_bytes()
                actual_sha = hashlib.sha256(raw).hexdigest()
                if record.get("sha256") != actual_sha:
                    errors.append(f"capture-media.json: {relative} sha256 disagrees with bytes")
                if record.get("bytes") != len(raw):
                    errors.append(f"capture-media.json: {relative} byte count disagrees with bytes")
                metadata = _capture_probe(path)
                stream = (metadata.get("streams") or [{}])[0]
                if (record.get("codec") != codec or record.get("codec") != stream.get("codec_name")
                        or record.get("width") != width or record.get("height") != height
                        or stream.get("width") != width or stream.get("height") != height):
                    errors.append(f"capture-media.json: {relative} codec or dimensions disagree")
                if kind == "preview" and len(raw) > 50 * 1024:
                    errors.append("capture-media.json: editor preview exceeds its 50 KiB budget")
                if is_video:
                    media_duration = float((metadata.get("format") or {}).get("duration", 0))
                    declared_duration = record.get("duration_seconds")
                    observed_duration[kind] = media_duration
                    if (not isinstance(declared_duration, (int, float))
                            or isinstance(declared_duration, bool)
                            or not math.isfinite(float(declared_duration))
                            or abs(float(declared_duration) - media_duration) > 0.05
                            or abs(float(declared_duration) - float(duration)) > 0.05):
                        errors.append(f"capture-media.json: {relative} duration disagrees")
            except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
                errors.append(f"capture-media.json: could not validate {relative} ({exc})")
        if len(observed_duration) == 2 and abs(observed_duration["webm"] - observed_duration["mp4"]) > 0.05:
            errors.append(f"capture-media.json: {slug} webm/mp4 durations are a mixed set")

    expected_declared = {
        f"assets/{spec['prefix']}{extension}"
        for spec in CAPTURE_MEDIA_FILES.values()
        for extension in (".webm", ".mp4", "-poster.jpg")
    }
    expected_declared.add("assets/editor-capture-poster-720.jpg")
    if set(declared) != expected_declared:
        errors.append("capture-media.json: declared media inventory is incomplete or mixed")


def _benchmark_path(value: object) -> str:
    """Return one canonical, bounded task-relative path or reject the row."""
    if not isinstance(value, str) or not value or len(value) > 256 or "\x00" in value:
        raise ValueError("invalid task file path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("invalid task file path")
    return path.as_posix()


def _benchmark_int(value: object, *, maximum: int = 1_000_000_000) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
        raise ValueError("integer metric is outside its allowed range")
    return value


def _benchmark_seconds(value: object, *, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("duration is not numeric")
    result = float(value)
    if not math.isfinite(result) or not 0 <= result <= maximum:
        raise ValueError("duration is outside its allowed range")
    return result


def check_benchmark_single_source(errors: list[str]) -> None:
    """Keep every public benchmark literal bound to bench.json."""
    try:
        validate_benchmark(BENCH)
        context = benchmark_context(BENCH)
    except (BenchmarkDataError, KeyError, TypeError, ValueError) as exc:
        errors.append(f"bench.json: invalid authoritative data ({exc})")
        return

    for relative in BENCHMARK_TEMPLATE_FILES:
        source = ROOT / "site-src" / relative
        try:
            text = source.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"benchmark source: could not read {relative} ({exc})")
            continue
        for pattern in BENCHMARK_LITERAL_PATTERNS:
            match = pattern.search(text)
            if match:
                line = text.count("\n", 0, match.start()) + 1
                errors.append(
                    f"benchmark source: {relative}:{line} contains literal {match.group(0)!r}; "
                    "publish it through a BENCH_* placeholder"
                )

    try:
        builder = _load_script("dgc_site_benchmark_sources", ROOT / "scripts" / "build-site.py")
        rendered = builder.social_sources(BENCH)
        lock = json.loads((ROOT / "site-src" / "social" / "benchmark-png-lock.json").read_text(
            encoding="utf-8",
        ))
        locked = lock["assets"]
        if lock.get("schema_version") != 1 or set(locked) != set(rendered):
            raise ValueError("lock inventory/schema disagrees with rendered social sources")
        for source_name, svg in rendered.items():
            item = locked[source_name]
            png_name = item["png"]
            if not isinstance(png_name, str) or not re.fullmatch(r"og-[a-z-]+\.png", png_name):
                raise ValueError(f"invalid PNG target for {source_name}")
            source_sha = hashlib.sha256(svg.encode("utf-8")).hexdigest()
            png_path = SITE / png_name
            png_sha = hashlib.sha256(png_path.read_bytes()).hexdigest()
            if item.get("rendered_source_sha256") != source_sha:
                errors.append(
                    f"social benchmark source changed for {source_name}; rerender and review {png_name}, "
                    "then update benchmark-png-lock.json"
                )
            if item.get("png_sha256") != png_sha:
                errors.append(f"social benchmark PNG bytes changed without a lock update: {png_name}")
    except (OSError, KeyError, TypeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        errors.append(f"social benchmark lock is invalid ({exc})")

def _check_benchmark_evidence(
    slug: str,
    members: dict[str, bytes],
    claimed: dict,
    errors: list[str],
) -> dict[str, object] | None:
    """Prove each published benchmark row from its downloadable evidence."""
    try:
        summary = json.loads(members["summary.json"])
        manifest = json.loads(members["manifest.json"])
        rows = [json.loads(line) for line in members["results.jsonl"].splitlines() if line.strip()]
        aggregate = summary["aggregate"]
        settings = manifest["settings"]
        environment = manifest["environment"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        errors.append(f"evidence: could not parse benchmark facts for {slug} ({exc})")
        return None
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows) \
            or not all(isinstance(value, dict) for value in (
                aggregate, manifest, summary, settings, environment,
            )):
        errors.append(f"evidence: malformed benchmark facts for {slug}")
        return None

    expected_engine = slug
    if summary.get("engine") != expected_engine or any(row.get("engine") != expected_engine for row in rows):
        errors.append(f"evidence: engine identity disagrees for {slug}")
    if summary.get("model") != BENCH["model"] or any(row.get("model") != BENCH["model"] for row in rows):
        errors.append(f"evidence: model identity disagrees for {slug}")
    if summary.get("schema_version") != 3 or manifest.get("schema_version") != 3:
        errors.append(f"evidence: unsupported benchmark schema for {slug}")
    run_id = manifest.get("run_id")
    if not isinstance(run_id, str) or not re.fullmatch(r"[0-9a-f]{16}", run_id) \
            or summary.get("run_id") != run_id \
            or any(row.get("run_id") != run_id or row.get("schema_version") != 3 for row in rows):
        errors.append(f"evidence: run identity disagrees for {slug}")
    identities = [(row.get("lang"), row.get("ex")) for row in rows]
    if len(rows) != BENCH["problems"] or len(set(identities)) != len(rows):
        errors.append(f"evidence: task count/identity disagrees for {slug}")
    subject = subject_harness(BENCH)
    if slug == subject["slug"]:
        trace = BENCH["featured_trace"]
        trace_rows = [
            row for row in rows
            if row.get("lang") == trace["language_slug"] and row.get("ex") == trace["exercise"]
        ]
        try:
            trace_row = trace_rows[0]
            solved_round = trace_row["solved_round"]
            graded_round = trace_row["rounds"][solved_round - 1]
            if len(trace_rows) != 1 or trace_row.get("run_id") != trace["run_id"] \
                    or solved_round != trace["solved_round"] \
                    or graded_round.get("grader_isolated") is not trace["isolated"] \
                    or not math.isclose(
                        float(graded_round.get("test_time")), float(trace["grader_seconds"]),
                        rel_tol=0.0, abs_tol=0.05,
                    ):
                raise ValueError("retained trace fields disagree")
        except (IndexError, KeyError, TypeError, ValueError, OverflowError) as exc:
            errors.append(f"bench.json: featured_trace disagrees with DGC evidence ({exc})")

    computed: dict[str, dict[str, int | float]] = {}
    canonical_tasks: list[dict[str, object]] = []
    try:
        for row in rows:
            language = row["lang"]
            exercise = row["ex"]
            rounds = row["rounds"]
            input_sha = row["input_sha256"]
            solutions = row["sol"]
            tests = row["test"]
            if (not isinstance(language, str) or not isinstance(exercise, str)
                    or not exercise or len(exercise) > 128 or any(ord(char) < 32 for char in exercise)
                    or not isinstance(input_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", input_sha)
                    or not isinstance(solutions, list) or not solutions
                    or not isinstance(tests, list) or not tests
                    or len(solutions) > 32 or len(tests) > 32
                    or not isinstance(rounds, list)
                    or not 1 <= len(rounds) <= BENCH["rounds"]):
                raise ValueError("invalid result row")
            canonical_solutions = sorted(_benchmark_path(value) for value in solutions)
            canonical_tests = sorted(_benchmark_path(value) for value in tests)
            if len(set(canonical_solutions)) != len(canonical_solutions) \
                    or len(set(canonical_tests)) != len(canonical_tests):
                raise ValueError("duplicate task file path")

            passed_rounds: list[int] = []
            task_test_sha: str | None = None
            item = computed.setdefault(language, {
                "n": 0, "p1": 0, "p2": 0, "rounds": 0, "timeouts": 0,
                "output_tokens": 0, "agent_s": 0.0,
            })
            item["n"] += 1
            item["rounds"] += len(rounds)
            for expected_round, round_data in enumerate(rounds, 1):
                round_number = round_data.get("round") if isinstance(round_data, dict) else None
                if isinstance(round_number, bool) or not isinstance(round_number, int) \
                        or round_number != expected_round:
                    raise ValueError("round sequence disagrees")
                agent = round_data["agent"]
                if not isinstance(agent, dict):
                    raise ValueError("invalid agent result")
                usage = agent["usage"]
                if not isinstance(usage, dict) or usage.get("synchronized") is not True:
                    raise ValueError("provider usage is not synchronized")
                timeout = agent.get("timeout")
                test_pass = round_data.get("test_pass")
                if not isinstance(timeout, bool) or not isinstance(test_pass, bool) \
                        or round_data.get("grader_isolated") is not True:
                    raise ValueError("invalid grading semantics")
                agent_seconds = _benchmark_seconds(
                    agent["time"], maximum=float(BENCH["cap_seconds_per_round"]) + 1.0,
                )
                _benchmark_seconds(
                    round_data["test_time"],
                    maximum=float(BENCH["grader_timeout_seconds"]) + 1.0,
                )
                output_tokens = _benchmark_int(usage["output_tokens"])
                _benchmark_int(usage["input_tokens"])
                _benchmark_int(usage["requests"])
                solution_sha = round_data.get("solution_sha256")
                tests_sha = round_data.get("tests_sha256")
                if not isinstance(solution_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", solution_sha) \
                        or not isinstance(tests_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", tests_sha):
                    raise ValueError("invalid grading hash")
                if task_test_sha is None:
                    task_test_sha = tests_sha
                elif tests_sha != task_test_sha:
                    raise ValueError("test fixture changed between rounds")
                if test_pass:
                    passed_rounds.append(expected_round)
                item["timeouts"] += int(timeout)
                item["output_tokens"] += output_tokens
                item["agent_s"] += agent_seconds

            solved = row.get("solved")
            solved_round = row.get("solved_round")
            if not isinstance(solved, bool) or isinstance(solved_round, bool) \
                    or (solved_round is not None and not isinstance(solved_round, int)) \
                    or solved_round not in (None, *range(1, len(rounds) + 1)) \
                    or passed_rounds not in ([], [len(rounds)]) \
                    or solved != bool(passed_rounds) \
                    or solved_round != (passed_rounds[0] if passed_rounds else None) \
                    or (not solved and len(rounds) != BENCH["rounds"]):
                raise ValueError("solved state disagrees with grading rounds")
            item["p1"] += int(solved_round == 1)
            item["p2"] += int(solved)
            canonical_tasks.append({
                "lang": language,
                "exercise": exercise,
                "input_sha256": input_sha,
                "solution_files": canonical_solutions,
                "test_files": canonical_tests,
                "tests_sha256": task_test_sha,
            })
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        errors.append(f"evidence: invalid result semantics/bounds for {slug} ({exc})")
        return None

    expected_languages = {
        entry["slug"]: entry["total"] for entry in BENCH.get("languages", [])
        if isinstance(entry, dict) and isinstance(entry.get("slug"), str)
    }
    actual_languages = {language: value["n"] for language, value in computed.items()}
    if actual_languages != expected_languages:
        errors.append(f"evidence: per-language task population disagrees for {slug}")
    canonical_tasks.sort(key=lambda task: (str(task["lang"]), str(task["exercise"])))
    task_set_sha256 = hashlib.sha256(json.dumps(
        canonical_tasks, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()

    fields = ("n", "p1", "p2", "rounds", "timeouts", "output_tokens")
    if set(aggregate) != set(computed):
        errors.append(f"evidence: language set disagrees for {slug}")
    for language, actual in computed.items():
        published = aggregate.get(language)
        if not isinstance(published, dict):
            continue
        if any(published.get(field) != actual[field] for field in fields) \
                or not math.isclose(float(published.get("agent_s", -1)), float(actual["agent_s"]),
                                    rel_tol=1e-9, abs_tol=1e-6):
            errors.append(f"evidence: summary disagrees with result rows for {slug}/{language}")

    totals = {field: sum(value[field] for value in computed.values()) for field in fields}
    average = round(
        sum(float(value["agent_s"]) for value in computed.values()) / max(1, int(totals["rounds"])),
        1,
    )
    expected = {
        "pass_at_1_solved": totals["p1"],
        "solved": totals["p2"],
        "pass_at_2": round(100 * int(totals["p2"]) / BENCH["problems"], 1),
        "timeouts": totals["timeouts"],
        "rounds": totals["rounds"],
        "average_round_seconds": average,
        "output_tokens": totals["output_tokens"],
        "per_language": {language: int(value["p2"]) for language, value in computed.items()},
    }
    if any(claimed.get(key) != value for key, value in expected.items()):
        errors.append(f"bench.json: published metrics disagree with evidence for {slug}")

    expected_settings = {
        "model": BENCH["model"],
        "model_digest": BENCH["model_digest"],
        "context_tokens": BENCH["context_tokens"],
        "rounds": BENCH["rounds"],
        "agent_timeout_s": BENCH["cap_seconds_per_round"],
        "test_timeout_s": BENCH["grader_timeout_seconds"],
    }
    dataset = manifest.get("dataset") if isinstance(manifest.get("dataset"), dict) else {}
    if any(settings.get(key) != value for key, value in expected_settings.items()) \
            or dataset.get("commit") != BENCH["dataset_commit"] \
            or dataset.get("dirty") is not False \
            or not isinstance(settings.get("base_url"), str) or not settings.get("base_url"):
        errors.append(f"evidence: manifest settings disagree for {slug}")
    return {
        "execution": (
            settings.get("base_url"), environment.get("hardware_label"),
            environment.get("accelerator"), environment.get("cpu_count"),
            environment.get("memory_bytes"),
        ),
        "task_set_sha256": task_set_sha256,
    }


def check_benchmark(errors: list[str]) -> None:
    try:
        validate_benchmark(BENCH)
        context = benchmark_context(BENCH)
    except (BenchmarkDataError, KeyError, TypeError, ValueError) as exc:
        errors.append(f"bench.json: invalid authoritative data ({exc})")
        return
    home = (SITE / "index.html").read_text(encoding="utf-8")
    page = (SITE / "benchmark.html").read_text(encoding="utf-8")
    dgc = subject_harness(BENCH)
    for needle in (
        f'{dgc["pass_at_2"]:.1f}%', f'{dgc["solved"]} / {BENCH["problems"]}',
        BENCH["model"], BENCH["model_digest"][:22] + "…", BENCH["dataset_commit"][:16] + "…",
        str(BENCH["cap_seconds_per_round"]), str(BENCH["grader_timeout_seconds"]),
        f'{BENCH["context_tokens"]:,}', str(BENCH["rounds"]),
        f'{dgc["average_round_seconds"]:.1f} s', str(context["BENCH_DGC_RANK_LABEL"]),
    ):
        if needle not in page:
            errors.append(f"benchmark.html: missing authoritative value {needle!r}")
    for needle in (
        f'{dgc["pass_at_2"]:.1f}%', BENCH["model"], str(BENCH["problems"]),
        str(BENCH["cap_seconds_per_round"]), f'{dgc["average_round_seconds"]:.1f} s',
    ):
        if needle not in home:
            errors.append(f"index.html: missing authoritative benchmark value {needle!r}")
    if BENCH.get("completion_profile") is None and "Why there is no completion-profile curve" not in page:
        errors.append("benchmark.html: missing completion-curve evidence boundary")
    swe = BENCH["swe_bench_lite"]
    if any(needle not in page for needle in (
        str(swe["claim_source"]), f'{swe["predictions_retained"]} predictions',
        str(swe["non_empty_patches"]), "cannot reproduce",
    )):
        errors.append("benchmark.html: incomplete SWE-bench evidence disclosure")

    claims = {str(item["slug"]): item for item in BENCH["harnesses"]}
    shared_execution: tuple | None = None
    shared_task_set: str | None = None
    for harness in claims:
        archive = SITE / "evidence" / f"{harness}-{BENCH['run_version']}.tar.gz"
        checksum = Path(str(archive) + ".sha256")
        if not archive.is_file() or not checksum.is_file():
            errors.append(f"evidence: missing archive/checksum for {harness}")
            continue
        expected = checksum.read_text(encoding="utf-8").split()[0]
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if expected != actual:
            errors.append(f"evidence: checksum mismatch for {archive.name}")
        try:
            with tarfile.open(archive, "r:gz") as bundle:
                names = set(bundle.getnames())
                member_data: dict[str, bytes] = {}
                required = {"README.txt", "SOURCE_SHA256SUMS", "manifest.json", "results.jsonl", "summary.json"}
                if names != required:
                    errors.append(f"evidence: unexpected members for {archive.name}: {sorted(names)}")
                for member in bundle.getmembers():
                    if not member.isfile():
                        errors.append(f"evidence: non-file member in {archive.name}: {member.name}")
                        continue
                    data = bundle.extractfile(member).read()
                    member_data[member.name] = data
                    internal = (b"/root/", b"/workspace/", b"/home/", b"/tmp/", b"results-orig", b".vast_api_key", b"CLAUDE.md")
                    if SECRET_PATTERN.search(data) or any(marker in data for marker in internal):
                        errors.append(f"evidence: unsanitized content in {archive.name}/{member.name}")
                    if member.name == "results.jsonl" and any(marker in data for marker in (b'"trace"', b'"output_tail"', b'"stderr_tail"', b'"test_tail"')):
                        errors.append(f"evidence: raw output field survived in {archive.name}/{member.name}")
                if set(member_data) == required:
                    identity = _check_benchmark_evidence(
                        harness, member_data, claims[harness], errors,
                    )
                    if identity is not None:
                        execution = identity["execution"]
                        task_set = identity["task_set_sha256"]
                        if shared_execution is None:
                            shared_execution = execution
                        elif execution != shared_execution:
                            errors.append(
                                f"evidence: endpoint/hardware identity differs for {harness}"
                            )
                        if shared_task_set is None:
                            shared_task_set = str(task_set)
                        elif task_set != shared_task_set:
                            errors.append(
                                f"evidence: canonical task set differs for {harness}"
                            )
        except (tarfile.TarError, gzip.BadGzipFile, EOFError) as exc:
            errors.append(f"evidence: invalid archive {archive.name}: {exc}")


def check_public_tree(errors: list[str]) -> set[str]:
    try:
        expected = public_file_inventory()
    except (OSError, UnicodeError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        errors.append(f"public inventory could not be built: {exc}")
        expected = set()
    public_paths = list(SITE.rglob("*"))
    for path in public_paths:
        if path.is_symlink():
            errors.append(f"{path.relative_to(SITE)}: symlinks may never enter the public tree")
    actual = {
        path.relative_to(SITE).as_posix()
        for path in public_paths if not path.is_symlink() and path.is_file()
    }
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    if missing:
        errors.append(f"public tree is missing declared outputs: {missing}")
    if unexpected:
        errors.append(f"public tree contains undeclared outputs: {unexpected}")

    for path in sorted(public_paths):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(SITE)
        if any(part == ".env" or part.startswith(".env.") for part in relative.parts):
            errors.append(f"{relative}: environment files may never enter the public tree")
        try:
            raw = path.read_bytes()
        except OSError as exc:
            errors.append(f"{relative}: could not scan file ({exc})")
            continue
        if SECRET_PATTERN.search(raw):
            errors.append(f"{relative}: contains a credential marker")
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in LEAK_PATTERNS.items():
            if pattern.search(text):
                errors.append(f"{relative}: contains {label}")
    if f'"version":"{VERSION}"' not in (SITE / "site.webmanifest").read_text(encoding="utf-8"):
        # The manifest deliberately does not expose a software version; this
        # branch merely documents that version.json is the public source.
        pass
    headers = (SITE / "_headers").read_text(encoding="utf-8")
    for directive in ("default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "font-src 'self'"):
        if directive not in headers:
            errors.append(f"_headers: missing CSP directive {directive}")

    vsix = SITE / "vscode" / "dgc.vsix"
    checksum = SITE / "vscode" / "dgc.vsix.sha256"
    editor_manifest = SITE / "vscode" / "version.json"
    try:
        editor_data = json.loads(editor_manifest.read_text(encoding="utf-8"))
        editor_version = str(editor_data["version"])
        if (not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", editor_version)
                or editor_data.get("vsix") != "https://vibedgc.com/vscode/dgc.vsix"):
            errors.append("vscode/version.json: invalid version or self-hosted URL")
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        editor_version = ""
        errors.append(f"vscode/version.json: invalid manifest ({exc})")
    if not vsix.is_file():
        errors.append("vscode: self-hosted VSIX is missing")
    elif not checksum.is_file():
        errors.append("vscode: checksum is missing")
    else:
        fields = checksum.read_text(encoding="utf-8").split()
        if len(fields) != 2 or fields[1] != "dgc.vsix":
            errors.append("vscode/dgc.vsix.sha256: expected '<sha256>  dgc.vsix'")
        elif fields[0] != hashlib.sha256(vsix.read_bytes()).hexdigest():
            errors.append("vscode/dgc.vsix.sha256: checksum does not match dgc.vsix")
        versioned_vsix = SITE / "vscode" / f"dgc-{editor_version}.vsix"
        if not versioned_vsix.is_file():
            errors.append(f"vscode: versioned dgc-{editor_version}.vsix is missing")
        elif versioned_vsix.read_bytes() != vsix.read_bytes():
            errors.append("vscode: alias and versioned VSIX bytes disagree")
        try:
            with zipfile.ZipFile(vsix) as package:
                package_json = json.loads(package.read("extension/package.json"))
            if package_json.get("name") != "dgc" or package_json.get("version") != editor_version:
                errors.append("vscode: embedded package metadata disagrees with version.json")
        except (OSError, KeyError, TypeError, ValueError, zipfile.BadZipFile,
                json.JSONDecodeError) as exc:
            errors.append(f"vscode/dgc.vsix: invalid extension package ({exc})")

    sitemap = (SITE / "sitemap.xml").read_text(encoding="utf-8")
    for name in ("404.html", "docs/404.html"):
        page = (SITE / name).read_text(encoding="utf-8")
        if not re.search(r'<meta\s+name="robots"\s+content="noindex(?:,(?:no)?follow)?"', page):
            errors.append(f"{name}: expected a noindex robots directive")
    if "/subscription" in sitemap:
        errors.append("sitemap.xml: private subscription-management route must be absent")
    return expected


def check_release_metadata(errors: list[str]) -> None:
    """Cross-check every human and machine-readable current-release identity."""
    try:
        source_text = (ROOT / "dgc" / "__init__.py").read_text(encoding="utf-8")
        source_match = re.search(r'^__version__\s*=\s*["\']([^"\']+)["\']\s*$',
                                 source_text, re.MULTILINE)
        source_version = source_match.group(1) if source_match else ""
        site_version = str(json.loads((SITE / "version.json").read_text(encoding="utf-8"))["version"])
        releases = json.loads((ROOT / "site-src" / "data" / "releases.json").read_text(
            encoding="utf-8"))
        cli_current = [item for item in releases.get("cli", []) if item.get("status") == "current"]
        if source_version != site_version or len(cli_current) != 1 \
                or str(cli_current[0].get("version")) != source_version:
            errors.append("release metadata: CLI source, site manifest, and one current row must agree")

        package = json.loads((ROOT / "editors" / "vscode" / "package.json").read_text(
            encoding="utf-8"))
        package_lock = json.loads((ROOT / "editors" / "vscode" / "package-lock.json").read_text(
            encoding="utf-8"))
        editor_manifest = json.loads((SITE / "vscode" / "version.json").read_text(
            encoding="utf-8"))
        editor_version = str(package.get("version") or "")
        locked_versions = {
            str(package_lock.get("version") or ""),
            str((package_lock.get("packages") or {}).get("", {}).get("version") or ""),
        }
        extension_current = [
            item for item in releases.get("extension", []) if item.get("status") == "current"
        ]
        if (not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", editor_version)
                or locked_versions != {editor_version}
                or str(editor_manifest.get("version") or "") != editor_version
                or len(extension_current) != 1
                or str(extension_current[0].get("version")) != editor_version):
            errors.append(
                "release metadata: extension package, lock, site manifest, and one current row must agree"
            )

        protocol_source = (ROOT / "dgc" / "editor_protocol.py").read_text(encoding="utf-8")
        protocol_match = re.search(
            r"^PROTOCOL_VERSION\s*=\s*(\d+)\s*$", protocol_source, re.MULTILINE,
        )
        protocol = protocol_match.group(1) if protocol_match else ""
        current_notes = " ".join(map(str, extension_current[0].get("notes", []))) \
            if len(extension_current) == 1 else ""
        editor_page = (SITE / "vscode" / "index.html").read_text(encoding="utf-8")
        if (not protocol or not re.search(rf"\bprotocol v{re.escape(protocol)}\b", current_notes, re.I)
                or f"protocol v{protocol} required" not in editor_page
                or f"speaks typed protocol v{protocol}" not in editor_page):
            errors.append(
                "release metadata: current extension notes and generated page must name the source protocol"
            )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"release metadata: could not validate manifests ({exc})")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--allow-unpublished-source-tag", action="store_true",
        help="pre-publication CI only: verify tracked artifact/source bytes without requiring the local tag",
    )
    parser.add_argument(
        "--stage", metavar="DIRECTORY",
        help="after a strict successful gate, copy only declared public files here",
    )
    parser.add_argument(
        "--require-public-release", action="store_true",
        help="require the release source commit to be reachable from origin/main",
    )
    args = parser.parse_args(argv)
    if args.stage and args.allow_unpublished_source_tag:
        parser.error("--stage requires the reviewed local source tag")
    if args.require_public_release and args.allow_unpublished_source_tag:
        parser.error("--require-public-release requires the public source tag")
    errors: list[str] = []
    parsed = check_pages(errors)
    check_analytics_event_contract(parsed, errors)
    check_website_intake_retired(errors)
    check_blog_retired(errors)
    check_css_minifier(errors)
    check_asset_revision_contract(errors)
    check_leak_pattern_contract(errors)
    check_css(errors)
    check_routes(parsed, errors)
    check_asset_revisions(parsed, errors)
    check_media(parsed, errors)
    check_capture_manifest(errors)
    check_benchmark_single_source(errors)
    check_benchmark(errors)
    check_release_metadata(errors)
    expected = check_public_tree(errors)
    errors.extend(
        f"release bundle: {error}" for error in validate_bundle(
            SITE,
            source_root=ROOT,
            require_git_binding=True,
            require_public=args.require_public_release,
            require_source_tag=not args.allow_unpublished_source_tag,
        )
    )
    if errors:
        print("site gate failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    if args.stage:
        destination = Path(args.stage).resolve()
        destination.mkdir(parents=True, exist_ok=True)
        if any(destination.iterdir()):
            print(f"site staging directory must be empty: {destination}", file=sys.stderr)
            return 2
        for name in sorted(expected):
            source = SITE / name
            if source.is_symlink() or not source.is_file():
                print(f"declared site output is not a regular file before staging: {name}", file=sys.stderr)
                return 1
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        print(f"staged {len(expected)} declared public files → {destination}")
    print(f"site gate passed: {len(parsed)} HTML pages, {len(json.loads((SITE / 'routes.json').read_text())['html'])} routed pages, benchmark evidence verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
