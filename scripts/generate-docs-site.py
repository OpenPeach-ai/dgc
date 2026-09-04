#!/usr/bin/env python3
"""Render the documentation site from dgc/docs.py — the same source that drives
the in-app `/docs` and, through command_specs(), the live slash-command palette.

The HTML pages under site/docs/ were originally produced by hand from this
list, with no way to regenerate them; the website and the CLI could drift
silently. This script closes that loop: edit dgc/docs.py, re-run this, and both
surfaces move together.

    python3 scripts/generate-docs-site.py [--out site/docs] [--check]

--check renders to memory and exits non-zero if anything on disk differs, so CI
(or a release preflight) can fail when the site is stale.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import shutil
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS_SRC = Path(__file__).resolve().parent / "docs-assets"
DOCS_ASSETS = ("docs.js",)
sys.path.insert(0, str(ROOT))

from dgc.docs import DOCS  # noqa: E402  (needs the path above)
from site_common import render_shell, site_context  # noqa: E402

# Site-only presentation metadata: how the flat DOCS list is grouped and ordered
# in the sidebar. Titles must match dgc/docs.py exactly — a mismatch is fatal.
GROUPS: list[tuple[str, list[str]]] = [
    ("Getting started", ["Getting started", "Keyboard shortcuts", "Slash commands", "Command line"]),
    ("Using DGC", ["Permission modes", "Plan mode", "Sessions & rewind", "Standing goals"]),
    ("Providers & models", ["Connect your model", "Subscriptions", "Thinking & reasoning"]),
    ("Features", ["Artifacts", "MCP servers", "Lifecycle hooks", "Skills",
                  "Multiple agents", "Training export", "Python code-action (power mode)"]),
    ("Reference", ["Configuration"]),
]

FAVICON = ("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2090%2090'%20"
           "fill='%237C5CFF'%3E%3Cpath%20d='M32%2024%20L20%2030%20L13%2072%20L25%2066%20Z'/%3E%3Cpath%20"
           "d='M54%2018%20L42%2024%20L35%2072%20L47%2066%20Z'/%3E%3Cpath%20d='M76%2024%20L64%2030%20L57%2066"
           "%20L69%2060%20Z'/%3E%3C/svg%3E")

SITE = "https://vibedgc.com"          # where the docs link back OUT to
DOCS_SITE = "https://docs.vibedgc.com"  # the docs' own canonical home

MARK_SVG = ('<svg viewBox="0 0 90 90" fill="currentColor" aria-hidden="true">'
            '<path d="M32 24 L20 30 L13 72 L25 66 Z"/>'
            '<path d="M54 18 L42 24 L35 72 L47 66 Z"/>'
            '<path d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>')


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)


def inline(text: str) -> str:
    """Escape, then re-apply the inline markdown subset the docs actually use."""
    out = html.escape(text, quote=True)
    out = re.sub(r"`([^`]+)`", lambda m: f"<code>{m.group(1)}</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", lambda m: f"<strong>{m.group(1)}</strong>", out)
    out = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', out)
    return out


def render_markdown(md: str) -> tuple[str, list[tuple[str, str]]]:
    """Return (html, [(heading_id, heading_text)]) — the h2s become the page TOC."""
    lines = md.strip("\n").split("\n")
    out: list[str] = []
    toc: list[tuple[str, str]] = []
    i = 0
    para: list[str] = []
    items: list[str] = []

    def flush_para() -> None:
        if para:
            out.append(f"<p>{inline(' '.join(para).strip())}</p>")
            para.clear()

    def flush_list() -> None:
        if items:
            out.append("<ul>")
            out.extend(f"<li>{inline(x)}</li>" for x in items)
            out.append("</ul>")
            items.clear()

    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            flush_para(); flush_list()
            i += 1
            code: list[str] = []
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i]); i += 1
            i += 1
            body = html.escape("\n".join(code), quote=False)
            out.append('<div class="codeblock"><button class="copy-btn" type="button" '
                       f'aria-label="Copy code">Copy</button><pre><code>{body}</code></pre></div>')
            continue
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            flush_para(); flush_list()
            level, text = len(m.group(1)), m.group(2).strip()
            hid = slug(text)
            anchor = (f'<a class="anchor" href="#{hid}" aria-label="Link to this section">#</a>')
            if level == 1:
                out.append(f'<div class="heading-row h1-row"><h1 id="{hid}">{inline(text)}</h1>{anchor}</div>')
            else:
                out.append(f'<div class="heading-row h{level}-row"><h{level} id="{hid}">{inline(text)}</h{level}>{anchor}</div>')
                if level == 2:
                    toc.append((hid, text))
            i += 1
            continue
        if line.startswith("- "):
            flush_para()
            items.append(line[2:].strip())
            i += 1
            continue
        if not line.strip():
            flush_para(); flush_list()
            i += 1
            continue
        # A wrapped source line belongs to the preceding list item until the
        # blank line that closes the list. Joining before inline rendering also
        # keeps emphasis/code spans valid when their delimiters cross a wrap.
        if items:
            items[-1] += " " + line.strip()
        else:
            para.append(line.strip())
        i += 1
    flush_para(); flush_list()
    return "\n".join(out), toc


def sidebar(order: list[tuple[str, str, str]], current: str) -> str:
    """order: [(title, slug, description)] flattened in sidebar sequence."""
    by_title = {t: (s, d) for t, s, d in order}
    parts: list[str] = []
    for group, titles in GROUPS:
        parts.append('<div class="grp">')
        parts.append(f'<div class="grp-h">{html.escape(group)}</div>')
        if group == "Getting started":
            act = ' aria-current="page" class="active"' if current == "index" else ' class=""'
            parts.append(f'<a href="index.html"{act} data-title="Overview" '
                         f'data-desc="every page, grouped">Overview</a>')
        for t in titles:
            s, d = by_title[t]
            act = ' aria-current="page" class="active"' if current == s else ' class=""'
            parts.append(f'<a href="{s}.html"{act} data-title="{html.escape(t, quote=True)}" '
                         f'data-desc="{html.escape(d, quote=True)}">{html.escape(t)}</a>')
        parts.append("</div>")
    return "\n".join(parts)


def shell(title: str, description: str, page: str, side: str, body: str, toc_html: str) -> str:
    context = site_context()
    edit_path = "dgc/docs.py"
    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "DGC", "item": context["SITE_URL"]},
            {"@type": "ListItem", "position": 2, "name": "Docs", "item": context["DOCS_URL"]},
            {"@type": "ListItem", "position": 3, "name": title, "item": context["DOCS_URL"] if page == "index" else f'{context["DOCS_URL"]}/{page}'},
        ],
    }
    page_event = ' data-page-event="docs_getting_started_reached"' if page == "getting-started" else ""
    inner = f'''<div class="docs-shell" data-doc-page="{html.escape(page, quote=True)}"{page_event}>
  <nav class="docs-sidebar" id="docs-sidebar" aria-label="Documentation navigation">{side}</nav>
  <article class="docs-article">
    <div class="docs-tools"><button class="version-stub docs-menu-button" type="button" aria-expanded="false" aria-controls="docs-menu">Browse docs</button><label class="docs-search"><span class="sr-only">Search documentation</span><input id="docsearch" type="search" placeholder="Search docs…" autocomplete="off" spellcheck="false"></label><span class="version-stub">DGC {context["VERSION"]}</span><a href="{context["GITHUB_URL"]}/edit/main/{edit_path}">Edit on GitHub ↗</a></div>
{body}
  </article>
  <aside class="docs-toc" aria-label="On this page"><h2>On this page</h2>{toc_html}</aside>
</div>
<dialog class="mobile-nav docs-menu" id="docs-menu" aria-label="Documentation pages"><div class="mobile-nav-head"><span class="micro">Documentation</span><button type="button" data-close-docs aria-label="Close documentation menu">×</button></div><nav>{side}</nav></dialog>
<script src="/docs/assets/docs.js?v={context['ASSET_REVISION']}" defer></script>'''
    canonical = context["DOCS_URL"] if page == "index" else f'{context["DOCS_URL"]}/{page}'
    return render_shell(title=f"{title} · DGC Docs", description=description,
                        path=f"docs/{page}.html", body=inner, image="/og-docs.png",
                        extra_json_ld=[breadcrumb], canonical_url=canonical)


def build() -> dict[str, str]:
    docs = {t: (d, md) for t, d, md in DOCS}
    ordered_titles = [t for _, titles in GROUPS for t in titles]

    missing = [t for t in ordered_titles if t not in docs]
    extra = [t for t in docs if t not in ordered_titles]
    if missing or extra:
        raise SystemExit(f"GROUPS is out of sync with dgc/docs.py — missing={missing} unlisted={extra}")

    order = [(t, slug(t), docs[t][0]) for t in ordered_titles]
    group_of = {t: g for g, titles in GROUPS for t in titles}
    pages: dict[str, str] = {}

    for idx, (title, s, desc) in enumerate(order):
        body_html, toc = render_markdown(docs[title][1])
        crumb = (f'      <div class="crumb">{html.escape(group_of[title])}'
                 f'<span class="sep">/</span>{html.escape(title)}</div>')
        lead = f'      <p class="lead">{html.escape(desc)}</p>'

        prev_link = next_link = ""
        if idx > 0:
            pt, ps, _ = order[idx - 1]
            prev_link = (f'<a class="prev" href="{ps}.html"><div class="k">← Previous</div>'
                         f'<div class="t">{html.escape(pt)}</div></a>')
        else:
            prev_link = ('<a class="prev" href="index.html"><div class="k">← Previous</div>'
                         '<div class="t">Overview</div></a>')
        if idx < len(order) - 1:
            nt, ns, _ = order[idx + 1]
            next_link = (f'<a class="next" href="{ns}.html"><div class="k">Next →</div>'
                         f'<div class="t">{html.escape(nt)}</div></a>')
        pager = ('      <nav class="pager" aria-label="Pagination">\n'
                 + prev_link + ("\n" + next_link if next_link else "") + "\n</nav>")

        toc_html = "\n".join(
            f'<a href="#{hid}" data-id="{hid}" class="lvl2">{html.escape(text)}</a>' for hid, text in toc
        ) or '<a href="#content" data-id="content" class="lvl2">Top</a>'

        pages[f"{s}.html"] = shell(title, desc, s, sidebar(order, s),
                                   "\n".join([crumb, lead, body_html, pager]), toc_html)

    pages["index.html"] = build_index(order, group_of)
    return pages


def build_index(order, group_of) -> str:
    desc_of = {t: d for t, _, d in order}
    slug_of = {t: s for t, s, _ in order}
    body: list[str] = [
        '      <div class="crumb">Docs<span class="sep">/</span>Overview</div>',
        '      <p class="lead">Everything DGC does, grouped. Start at the top, or jump straight '
        'to the part you need.</p>',
        '      <div class="heading-row h1-row"><h1 id="overview">DGC documentation</h1><a class="anchor" href="#overview" '
        'aria-label="Link to this section">#</a></div>',
        "<p>DGC is a local-first coding agent for your terminal and for VS&nbsp;Code. Native local "
        "and API routes run DGC's agentic loop — planning, reading files, running tools, and editing "
        "code — against a model <strong>you</strong> choose. Supported subscription routes delegate "
        "the model-and-tool turn to the vendor CLI. The selected model receives the conversation "
        "context it needs; optional remote integrations receive the requests you direct to them.</p>",
        '<div class="dhome-start"><div><div class="s-t">New to DGC?</div>'
        '<div class="s-d">Install it, launch it, and connect a model — about five minutes.</div></div>'
        '<a class="s-b" href="getting-started.html">Start here →</a></div>',
    ]
    toc: list[str] = []
    for group, titles in GROUPS:
        gid = slug(group)
        toc.append(f'<a href="#{gid}" data-id="{gid}" class="lvl2">{html.escape(group)}</a>')
        body.append(f'<div class="heading-row h2-row"><h2 id="{gid}">{html.escape(group)}</h2>'
                    f'<a class="anchor" href="#{gid}" aria-label="Link to this section">#</a></div>')
        body.append('<div class="dhome-grid">')
        for t in titles:
            d = desc_of[t]
            d = d[0].upper() + d[1:] if d else d
            body.append(f'  <a class="dhome-card" href="{slug_of[t]}.html">'
                        f'<div class="t">{html.escape(t)}</div>'
                        f'<div class="d">{inline(d)}.</div></a>')
        body.append("</div>")
    body.append('      <nav class="pager" aria-label="Pagination">\n'
                '<a class="next solo" href="getting-started.html"><div class="k">Next →</div>'
                '<div class="t">Getting started</div></a>\n</nav>')
    return shell("Overview", "Everything DGC does, grouped — start here, then go deep on the part you need.",
                 "index", sidebar(order, "index"), "\n".join(body), "\n".join(toc))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "site" / "docs"))
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if the rendered site differs from what is on disk")
    a = ap.parse_args()
    out = Path(a.out)
    pages = build()

    if a.check:
        stale = [n for n, html_text in pages.items()
                 if not (out / n).exists() or (out / n).read_text() != html_text]
        for name in DOCS_ASSETS:
            asset = ASSETS_SRC / name
            dst = out / "assets" / name
            if not dst.exists() or dst.read_bytes() != asset.read_bytes():
                stale.append(f"assets/{name}")
        orphan = sorted(p.name for p in out.glob("*.html") if p.name not in pages and p.name != "404.html")
        if stale or orphan:
            print(f"docs site is stale: differs={stale} orphaned={orphan}", file=sys.stderr)
            return 1
        print(f"docs site is up to date ({len(pages)} pages)")
        return 0

    out.mkdir(parents=True, exist_ok=True)
    (out / "assets").mkdir(exist_ok=True)
    for name in DOCS_ASSETS:
        shutil.copy2(ASSETS_SRC / name, out / "assets" / name)
    for name, html_text in pages.items():
        (out / name).write_text(html_text)
    for p in sorted(out.glob("*.html")):
        if p.name not in pages:
            print(f"  note: {p.name} is no longer generated (left in place)")
    print(f"wrote {len(pages)} pages + {len(DOCS_ASSETS)} assets to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
