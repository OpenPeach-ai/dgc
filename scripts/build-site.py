#!/usr/bin/env python3
"""Build vibedgc.com from small HTML partials, Markdown, and committed data.

No framework or third-party Python package is required. Release archives already
present in site/ are preserved; this script owns only the public files listed by
generated_outputs().
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import importlib.util
import json
import re
import shutil
import sys
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from benchmark_site import (  # noqa: E402
    benchmark_context,
    ranked_harnesses,
    subject_harness,
    validate_benchmark,
)
from site_common import (  # noqa: E402
    SRC,
    SITE,
    load_json,
    minify_css,
    render_shell,
    site_context,
    substitute,
)

DATA = SRC / "data"
CONTENT = SRC / "content"
PAGES = SRC / "pages"
PARTIALS = SRC / "partials"


def inline(text: str) -> str:
    # Inline Markdown is rendered into both element text and link attributes.
    # Escaping quotes up front keeps a malformed trusted content link from
    # breaking out of its generated href.
    value = html.escape(text, quote=True)
    value = re.sub(r"`([^`]+)`", r"<code>\1</code>", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", value)
    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', value)
    return value


def slug(text: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", text.lower())).strip("-")


def read_markdown(path: Path) -> tuple[dict[str, str], str]:
    raw = path.read_text(encoding="utf-8")
    meta: dict[str, str] = {}
    if raw.startswith("---\n"):
        front, raw = raw[4:].split("\n---\n", 1)
        for line in front.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                meta[key.strip()] = value.strip()
    return meta, raw.strip()


def markdown_html(markdown: str, *, drop_first_h1: bool = False) -> str:
    lines = markdown.splitlines()
    out: list[str] = []
    paragraph: list[str] = []
    list_type: str | None = None
    dropped = False

    def flush_paragraph() -> None:
        if paragraph:
            out.append(f"<p>{inline(' '.join(paragraph))}</p>")
            paragraph.clear()

    def close_list() -> None:
        nonlocal list_type
        if list_type:
            out.append(f"</{list_type}>")
            list_type = None

    index = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("```"):
            flush_paragraph(); close_list(); index += 1
            code: list[str] = []
            while index < len(lines) and not lines[index].startswith("```"):
                code.append(lines[index]); index += 1
            out.append(f"<pre><code>{html.escape(chr(10).join(code), quote=False)}</code></pre>")
            index += 1; continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            flush_paragraph(); close_list()
            level = len(heading.group(1)); text = heading.group(2).strip()
            if drop_first_h1 and level == 1 and not dropped:
                dropped = True; index += 1; continue
            anchor = slug(text)
            out.append(f'<div class="heading-row h{level}-row"><h{level} id="{anchor}">{inline(text)}</h{level}><a class="anchor" href="#{anchor}" aria-label="Link to {html.escape(text, quote=True)}">#</a></div>')
            index += 1; continue
        unordered = re.match(r"^-\s+(.+)$", line)
        ordered = re.match(r"^\d+\.\s+(.+)$", line)
        if unordered or ordered:
            flush_paragraph(); wanted = "ul" if unordered else "ol"
            if list_type != wanted:
                close_list(); list_type = wanted; out.append(f"<{wanted}>")
            out.append(f"<li>{inline((unordered or ordered).group(1))}</li>")
            index += 1; continue
        if not line.strip():
            flush_paragraph(); close_list(); index += 1; continue
        paragraph.append(line.strip()); index += 1
    flush_paragraph(); close_list()
    return "\n".join(out)


def partial(name: str, context: dict[str, Any] | None = None) -> str:
    source = (PARTIALS / name).read_text(encoding="utf-8")
    return substitute(source, context) if context is not None else source


def capture_context(data: dict[str, Any]) -> dict[str, str]:
    """Expose reviewed capture labels without duplicating claims in templates."""
    if data.get("schema_version") != 1 or not isinstance(data.get("captures"), dict):
        raise ValueError("capture-media.json has an unsupported schema")
    context: dict[str, str] = {}
    for name in ("cli", "editor"):
        capture = data["captures"].get(name)
        if not isinstance(capture, dict):
            raise ValueError(f"capture-media.json is missing {name}")
        duration = capture.get("duration_label")
        provenance = capture.get("provenance")
        if not isinstance(duration, str) or not re.fullmatch(r"\d+:[0-5]\d", duration):
            raise ValueError(f"capture-media.json has an invalid {name} duration label")
        if not isinstance(provenance, str) or not provenance.strip():
            raise ValueError(f"capture-media.json has invalid {name} provenance")
        prefix = f"CAPTURE_{name.upper()}"
        context[f"{prefix}_DURATION_LABEL"] = html.escape(duration, quote=True)
        context[f"{prefix}_PROVENANCE"] = html.escape(provenance.strip(), quote=True)
    return context


def figure4(bench: dict[str, Any]) -> str:
    validate_benchmark(bench)
    context = benchmark_context(bench)
    subject = subject_harness(bench)
    ranked = ranked_harnesses(bench)
    axis = bench["chart"]
    axis_min = float(axis["axis_min_percent"])
    axis_max = float(axis["axis_max_percent"])
    axis_width = axis_max - axis_min
    rows = []
    table_rows = []
    aria_scores = []
    for item in ranked:
        cls = " dgc" if item is subject else ""
        score = float(item["pass_at_2"])
        position = 100 * (score - axis_min) / axis_width
        name = html.escape(str(item["name"]))
        rows.append(f'<div class="plot-row{cls}"><span class="plot-name">{name}</span><span class="plot-dot" style="left:{position:.3f}%" aria-hidden="true"></span><span class="plot-value" style="left:calc({position:.3f}% + 15px)">{score:.1f}%</span></div>')
        aria_scores.append(f'{item["name"]} {score:.1f} percent')
        note = "direct result rows"
        if item is subject:
            note = f'{item["timeouts"]} timeouts · {item["average_round_seconds"]:.1f} s/round · {item["output_tokens"]:,} output tokens'
        table_rows.append(f'<tr><td>{name}</td><td class="num">{item["solved"]} / {bench["problems"]}</td><td class="num">{score:.1f}%</td><td class="table-note">{note}</td></tr>')
    ticks = []
    tick = axis_min
    while tick <= axis_max + 1e-9:
        position = 100 * (tick - axis_min) / axis_width
        label = f"{tick:g}%"
        ticks.append(f'<span style="left:{position:.3f}%">{label}</span>')
        tick += float(axis["tick_step_percent"])
    aria_label = (
        f'Harness {str(bench["metric"]).replace("@", " at ")} scores on an axis from '
        f'{axis_min:g} to {axis_max:g} percent. ' + ", ".join(aria_scores) + "."
    )
    return f'''<figure class="instrument benchmark-panel reveal" aria-labelledby="fig4-title">
  <figcaption class="figure-title" id="fig4-title"><span class="figure-id">FIG.4 · Harness evaluation</span><span>{bench["metric"]} · {bench["problems"]} problems · {bench["cap_seconds_per_round"]} s/round</span><span class="figure-state">{html.escape(str(bench["publication_label"]))}</span></figcaption>
  <div class="dot-plot" role="img" aria-label="{html.escape(aria_label, quote=True)}"><div class="plot-grid">{''.join(rows)}</div><div class="plot-axis">{''.join(ticks)}</div><p class="plot-axis-label">{bench["metric"]} · axis runs {axis_min:g}–{axis_max:g}%, not from zero</p></div>
  <div class="cost-grid"><div class="cost-tile"><b>{subject["timeouts"]}</b><small>agent-round timeouts · {html.escape(str(subject["name"]))} only</small></div><div class="cost-tile"><b>{subject["average_round_seconds"]:.1f} s</b><small>average round · {context["BENCH_DGC_AVERAGE_LABEL"]}</small></div><div class="cost-tile"><b>{context["BENCH_DGC_TOKEN_DELTA"]}%</b><small>output tokens vs {html.escape(str(context["BENCH_SCORE_LEADER"]))}</small></div><div class="cost-tile"><b>{subject["solved"]} / {bench["problems"]}</b><small>solved · {html.escape(str(context["BENCH_DGC_RANK_LABEL"]))}</small></div></div>
  <details class="table-twin"><summary>Accessible table view</summary><div class="table-scroll"><table><thead><tr><th>Harness</th><th>Solved</th><th>{bench["metric"]}</th><th>Evidence note</th></tr></thead><tbody>{''.join(table_rows)}</tbody></table></div></details>
  <p class="figure-foot">Every manifest records <code>{html.escape(bench["model"])}</code>, the same caller-declared digest, endpoint URL, and hardware. The runner verified context size; {context["BENCH_WEIGHTS_CLAUSE"]}. The saved manifest reports {html.escape(str(subject["name"]))} {bench["run_version"]}; {context["BENCH_RUNNER_CLAUSE"]}, so this is labelled a {html.escape(str(bench["publication_label"]))} rather than a release-gating league.</p>
</figure>'''


def language_grid(bench: dict[str, Any]) -> str:
    cards = []
    for lang in bench["languages"]:
        meter = "".join('<i class="on"></i>' if i < lang["solved"] else "<i></i>" for i in range(lang["total"]))
        cards.append(f'<article><b>{lang["solved"]} / {lang["total"]}</b><span>{html.escape(lang["name"])}</span><span class="language-meter" style="grid-template-columns:repeat({lang["total"]},1fr)" aria-hidden="true">{meter}</span></article>')
    return f'<div class="language-grid reveal">{"".join(cards)}</div>'


def evidence_rows(bench: dict[str, Any]) -> str:
    rows = []
    for item in ranked_harnesses(bench):
        key = item["slug"]
        filename = f"{key}-{bench['run_version']}.tar.gz"
        checksum_path = SITE / "evidence" / f"{filename}.sha256"
        checksum = checksum_path.read_text(encoding="utf-8").split()[0] if checksum_path.exists() else "missing"
        rows.append(f'<article class="release reveal"><div><span class="release-version">{html.escape(item["name"])}</span><time>{item["solved"]}/{bench["problems"]} · {item["pass_at_2"]:.1f}%</time></div><div><a href="/evidence/{filename}" data-event="benchmark_traces">Download archive ↓</a><br><a class="table-note" href="/evidence/{filename}.sha256">SHA-256 file</a></div><code class="table-note">{checksum[:16]}…</code></article>')
    return f'<div class="release-list" style="margin-top:38px">{"".join(rows)}</div>'


def faq_html(context: dict[str, Any]) -> str:
    _, raw = read_markdown(CONTENT / "faq.md")
    raw = substitute(raw, context)
    blocks = re.split(r"^##\s+", raw, flags=re.MULTILINE)[1:]
    result = []
    for block in blocks:
        title, *body = block.splitlines()
        result.append(f'<details><summary>{inline(title.strip())}</summary>{markdown_html(chr(10).join(body).strip())}</details>')
    if len(result) != 8:
        raise ValueError(f"FAQ must contain exactly 8 questions, found {len(result)}")
    return "".join(result)


def release_rows(items: list[dict[str, Any]]) -> str:
    rows = []
    for item in items:
        notes = "".join(f"<li>{html.escape(note)}</li>" for note in item["notes"][:3])
        url = item.get("url", "#")
        rows.append(f'<article class="release reveal" id="release-{slug(item["version"])}"><div><a class="release-version" href="{html.escape(url, quote=True)}">{html.escape(item["version"])} ↗</a><time datetime="{item["date"]}">{item["date"]}</time></div><ul>{notes}</ul><span class="status-pill{" live" if item["status"] == "current" else ""}">{html.escape(item["status"])}</span></article>')
    return "".join(rows)


def post_cards(posts: list[tuple[Path, dict[str, str], str]]) -> str:
    cards = []
    for path, meta, _ in posts:
        cards.append(f'<a class="card spotlight post-card reveal" href="/blog/{path.stem}"><time datetime="{meta["date"]}">{meta["date"]}</time><h2>{html.escape(meta["title"])}</h2><p>{html.escape(meta["description"])}</p><span class="read">Read note →</span></a>')
    return "".join(cards)


def generic_markdown_page(filename: str, eyebrow: str) -> str:
    meta, raw = read_markdown(CONTENT / filename)
    first = re.search(r"^#\s+(.+)$", raw, re.MULTILINE)
    title = first.group(1) if first else meta["title"]
    body = markdown_html(raw, drop_first_h1=True)
    effective_date = meta.get("effective_date")
    effective = (
        f'<p class="page-meta"><span class="micro">Effective</span> '
        f'<time datetime="{html.escape(effective_date, quote=True)}">'
        f'{html.escape(effective_date)}</time></p>'
        if effective_date else ""
    )
    return f'<header class="page-hero field field-2"><div class="container"><div class="eyebrow"><b>{html.escape(eyebrow)}</b> DGC</div><h1>{inline(title)}</h1><p class="lede">{html.escape(meta["description"])}</p>{effective}</div></header><section class="section"><div class="container content-grid"><article class="prose">{body}</article><aside class="card side-card"><span class="micro">DGC {site_context()["VERSION"]}</span><h3 style="margin-top:18px">Built in the open.</h3><p>Inspect the implementation, its tests, release checksums, and the source that backs this page.</p><a href="{site_context()["GITHUB_URL"]}">Open repository ↗</a><a href="/changelog">Read changelog →</a></aside></div></section>'


def page_template(name: str, context: dict[str, Any]) -> str:
    return substitute((PAGES / name).read_text(encoding="utf-8"), context)


def marketplace_proof(metrics: dict[str, Any]) -> dict[str, str]:
    """Return an attributed snapshot label, or neutral editor copy when unavailable."""
    if metrics.get("schema_version") != 1:
        raise ValueError("site metrics use an unsupported schema")
    metric = metrics.get("marketplace")
    if not isinstance(metric, dict):
        raise ValueError("site metrics omit marketplace state")
    if metric == {"status": "unavailable"}:
        return {
            "MARKETPLACE_PROOF_LABEL": "Editor",
            "MARKETPLACE_PROOF_VALUE": "VS Code + Cursor",
        }
    count = metric.get("install_count")
    if (metric.get("status") != "available"
            or metric.get("publisher") != "vibedgc"
            or metric.get("extension") != "dgc"
            or isinstance(count, bool) or not isinstance(count, int) or count < 0
            or metric.get("source") != "visual-studio-marketplace-gallery-api"):
        raise ValueError("site metrics contain an invalid marketplace snapshot")
    try:
        observed = dt.datetime.fromisoformat(str(metric["observed_at"]).replace("Z", "+00:00"))
    except (KeyError, ValueError) as exc:
        raise ValueError("marketplace snapshot has an invalid observed_at") from exc
    if observed.tzinfo is None:
        raise ValueError("marketplace snapshot observed_at must include a timezone")
    day = observed.astimezone(dt.timezone.utc).date().isoformat()
    noun = "install" if count == 1 else "installs"
    return {
        "MARKETPLACE_PROOF_LABEL": f"Marketplace · {day} snapshot",
        "MARKETPLACE_PROOF_VALUE": f"{count:,} reported {noun}",
    }


def social_sources(bench: dict[str, Any]) -> dict[str, str]:
    """Render benchmark-bearing social sources for review and PNG locking."""
    context = benchmark_context(bench)
    axis = bench["chart"]
    axis_min = float(axis["axis_min_percent"])
    axis_max = float(axis["axis_max_percent"])
    plot_width = 980.0
    plot_left = 110.0
    circles = []
    subject = subject_harness(bench)
    # Paint neutral marks first so the highlighted subject remains visible when
    # two harnesses tie at the same score.
    for item in [
        *(row for row in ranked_harnesses(bench) if row is not subject),
        subject,
    ]:
        x = plot_left + plot_width * (float(item["pass_at_2"]) - axis_min) / (axis_max - axis_min)
        if item is subject:
            circles.append(
                f'<circle cx="{x:.1f}" cy="445" r="12" fill="#7C5CFF" stroke="#A78BFA" stroke-width="2"/>'
                f'<text x="{x:.1f}" y="490" text-anchor="middle" fill="#A78BFA" font-family="monospace" font-size="17">'
                f'{html.escape(str(item["name"]))} {item["pass_at_2"]:.1f}</text>'
                f'<circle cx="{x:.1f}" cy="445" r="5" fill="#fff" opacity=".2"/>'
            )
        else:
            circles.append(f'<circle cx="{x:.1f}" cy="445" r="9" fill="#6B6B78"/>')
    context["BENCH_OG_PLOT"] = "".join(circles)
    return {
        name: substitute((SRC / "social" / name).read_text(encoding="utf-8"), context)
        for name in ("og-card.svg", "og-benchmark.svg")
    }


def feed(title: str, subtitle: str, entries: list[dict[str, str]], *, base: str) -> str:
    updated = max((entry["date"] for entry in entries), default="2026-09-04") + "T00:00:00Z"
    body = []
    for entry in entries:
        url = entry["url"]
        body.append(f'<entry><title>{html.escape(entry["title"])}</title><id>{html.escape(url)}</id><link href="{html.escape(url, quote=True)}"/><updated>{entry["date"]}T00:00:00Z</updated><summary>{html.escape(entry["description"])}</summary></entry>')
    return f'<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>{html.escape(title)}</title><subtitle>{html.escape(subtitle)}</subtitle><id>{base}</id><link href="{base}"/><updated>{updated}</updated>{"".join(body)}</feed>\n'


def brand_zip() -> bytes:
    buffer = BytesIO()
    readme = "DGC brand kit\n\nDGC is the product name; Vibe DGC is the long form. Preserve paths and proportions. Violet: #7C5CFF.\n"
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, name in [(SITE / "dgc-mark.svg", "dgc-mark-dark.svg"), (SITE / "dgc-mark-mono.svg", "dgc-mark-mono.svg"), (SITE / "favicon.svg", "dgc-mark-light.svg")]:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 4, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED; info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes())
        info = zipfile.ZipInfo("README.txt", date_time=(2026, 9, 4, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED; info.external_attr = 0o644 << 16
        archive.writestr(info, readme)
    return buffer.getvalue()


def build_outputs() -> dict[str, str | bytes]:
    ctx: dict[str, Any] = site_context()
    bench = load_json(DATA / "bench.json")
    ctx.update(benchmark_context(bench))
    ctx.update(marketplace_proof(load_json(DATA / "site-metrics.json")))
    ctx.update(capture_context(load_json(DATA / "capture-media.json")))
    releases = load_json(DATA / "releases.json")
    protocol_source = (ROOT / "dgc" / "editor_protocol.py").read_text(encoding="utf-8")
    protocol_match = re.search(r"^PROTOCOL_VERSION\s*=\s*(\d+)\s*$", protocol_source, re.MULTILINE)
    if not protocol_match:
        raise ValueError("could not read the editor protocol version")
    post_items: list[tuple[Path, dict[str, str], str]] = []
    for path in sorted((CONTENT / "blog").glob("*.md")):
        meta, raw = read_markdown(path)
        post_items.append((path, meta, substitute(raw, ctx)))
    ctx.update({
        "FIG1": partial("fig1.html", ctx), "FIG2": partial("fig2.html"), "FIG3": partial("fig3.html", ctx), "FIG4": figure4(bench), "FIG5": partial("fig5.html"), "TERMINAL": partial("terminal.html", ctx),
        "LANGUAGE_GRID": language_grid(bench), "EVIDENCE_ROWS": evidence_rows(bench), "FAQ": faq_html(ctx),
        "RELEASE_COUNT": releases.get("cli_releases_last_14_days", 13), "CLI_RELEASES": release_rows(releases["cli"]), "EXT_RELEASES": release_rows(releases["extension"]), "POST_CARDS": post_cards(post_items),
        "EXT_VERSION": releases["extension"][0]["version"], "PROTOCOL_VERSION": protocol_match.group(1), "EXT_NOTE_1": releases["extension"][0]["notes"][0], "EXT_NOTE_2": releases["extension"][0]["notes"][1], "EXT_NOTE_3": releases["extension"][0]["notes"][2],
    })
    pages: dict[str, tuple[str, str, str, str]] = {
        "index.html": ("Vibe DGC — a coding agent for the models you run", "A native coding-agent loop for local and API models, plus supported official-CLI subscriptions—in your terminal and editor.", page_template("index.html", ctx), "/og-card.png"),
        "benchmark.html": ("Benchmark", f'A transparent same-model comparison of {ctx["BENCH_HARNESS_NAMES"]} on {ctx["BENCH_PROBLEMS"]} real polyglot tasks.', page_template("benchmark.html", ctx), "/og-benchmark.png"),
        "vscode/index.html": ("DGC for VS Code and Cursor", "The DGC coding harness inside VS Code, Cursor, and VSCodium with structured tools, diffs, plans, and goals.", page_template("vscode.html", ctx), "/og-editor.png"),
        "pricing.html": ("Pricing", "DGC is free for noncommercial use, with a direct route for commercial licensing.", page_template("pricing.html", ctx), "/og-card.png"),
        "changelog.html": ("Changelog", "A build-time record of reviewed DGC CLI and editor releases.", page_template("changelog.html", ctx), "/og-card.png"),
        "blog/index.html": ("DGC engineering notes", "Writing about coding-agent evaluation, permissions, local models, and harness engineering.", page_template("blog.html", ctx), "/og-card.png"),
        "brand.html": ("Brand", "Official DGC naming, marks, colours, clear space, and downloadable vector assets.", page_template("brand.html", ctx), "/og-card.png"),
        "about.html": ("About DGC", "Why DGC exists, who builds it, and how to help shape the coding-agent harness.", generic_markdown_page("about.md", "About"), "/og-card.png"),
        "security.html": ("Security", "DGC's permission, workspace, sandbox, credential, and vulnerability-reporting boundaries.", generic_markdown_page("security.md", "Security"), "/og-card.png"),
        "privacy.html": ("Privacy", "What DGC stores locally, what reaches a chosen provider, and what the website processes.", generic_markdown_page("privacy.md", "Legal"), "/og-card.png"),
        "terms.html": ("Terms", "Terms for vibedgc.com and the relationship between the website and DGC's software license.", generic_markdown_page("terms.md", "Legal"), "/og-card.png"),
        "subscription.html": ("Manage release notes", "Confirm or remove a DGC release-notes subscription.", page_template("subscription.html", ctx), "/og-card.png"),
        "404.html": ("Page not found", "No such DGC page.", page_template("404.html", ctx), "/og-card.png"),
        "docs/404.html": ("Documentation page not found", "No such DGC documentation page.", page_template("404.html", ctx), "/og-docs.png"),
    }
    outputs: dict[str, str | bytes] = {}
    for path, (title, description, body, image) in pages.items():
        outputs[path] = render_shell(
            title=title,
            description=description,
            path=path,
            body=body,
            body_class="page-home" if path == "index.html" else "",
            image=image,
            include_announcement=path not in {"404.html", "docs/404.html", "subscription.html"},
            noindex=path in {"404.html", "docs/404.html", "subscription.html"},
            preload_image="/assets/hero-graded-poster.jpg" if path == "index.html" else None,
            preload_mobile_image="/assets/hero-mobile-poster.webp" if path == "index.html" else None,
        )
    for path, meta, raw in post_items:
        url_path = f"blog/{path.stem}.html"
        article = f'<header class="page-hero field field-2"><div class="container"><div class="eyebrow"><b>Engineering note</b> {meta["date"]}</div><h1>{html.escape(meta["title"])}</h1><p class="lede">{html.escape(meta["description"])}</p></div></header><section class="section"><div class="container"><article class="prose">{markdown_html(raw, drop_first_h1=True)}</article></div></section>'
        outputs[url_path] = render_shell(title=meta["title"], description=meta["description"], path=url_path, body=article, kind="article", image="/og-card.png")
    posts_feed = [{"title": meta["title"], "date": meta["date"], "description": meta["description"], "url": f'{ctx["SITE_URL"]}/blog/{path.stem}'} for path, meta, _ in post_items]
    release_feed = [{"title": f'DGC {item["version"]}', "date": item["date"], "description": "; ".join(item["notes"]), "url": item["url"]} for item in releases["cli"]]
    outputs["feed.xml"] = feed("DGC engineering notes", "The harness, measured and explained.", posts_feed, base=f'{ctx["SITE_URL"]}/feed.xml')
    outputs["changelog.xml"] = feed("DGC releases", "Reviewed DGC release notes.", release_feed, base=f'{ctx["SITE_URL"]}/changelog.xml')
    public_paths = sorted({
        "/" + path.removesuffix("index.html").removesuffix(".html").rstrip("/")
        for path in outputs
        if path.endswith(".html") and "404" not in path
    })
    docs_paths = ["/docs"] + [
        f"/docs/{slug(title)}"
        for _, titles in _docs_groups()
        for title in titles
    ]
    sitemap_paths = [path for path in public_paths if path != "/subscription"]
    outputs["sitemap.xml"] = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + "".join(f'<url><loc>{ctx["SITE_URL"]}{path or "/"}</loc></url>' for path in sitemap_paths) + "</urlset>\n"
    outputs["llms.txt"] = "\n".join(["# DGC", "", ctx["TAGLINE"] + ".", "", "## Start", f'- Docs: {ctx["DOCS_URL"]}/', f'- Benchmark: {ctx["SITE_URL"]}/benchmark', f'- Source: {ctx["GITHUB_URL"]}', "", "## Product", "DGC is a coding-agent harness for a local model, compatible API, or supported coding subscription. For native local/API routes, DGC owns context, permissions, tools, execution, verification, sessions, plans, goals, MCP, skills, hooks, and terminal/editor presentation. Subscription routes delegate model and tool execution to the supported vendor CLI while DGC retains its session, SessionStart/Stop hooks, mode mapping, and presentation.", "", "## Documentation"] + [f'- {title}: {ctx["DOCS_URL"]}/{slug(title)}' for _, titles in _docs_groups() for title in titles] + [""])
    outputs["site.webmanifest"] = json.dumps({"name":ctx["LONG_NAME"],"short_name":ctx["PRODUCT"],"start_url":"/","display":"standalone","background_color":"#0B0B0D","theme_color":"#0B0B0D","icons":[{"src":"/icon-512.png","sizes":"512x512","type":"image/png"},{"src":"/apple-touch-icon.png","sizes":"180x180","type":"image/png"}]}, separators=(",", ":")) + "\n"
    outputs["routes.json"] = json.dumps({"html": sorted(set(public_paths + docs_paths)), "generated": "build-site.py"}, separators=(",", ":")) + "\n"
    outputs["assets/brand/dgc-brand-kit.zip"] = brand_zip()
    for name in ("tokens.css", "site.css"):
        source = (SRC / "assets" / name).read_text(encoding="utf-8")
        outputs[f"assets/{name}"] = minify_css(source)
    outputs["assets/site.js"] = (SRC / "assets" / "site.js").read_bytes()
    return outputs


def _docs_groups() -> list[tuple[str, list[str]]]:
    spec = importlib.util.spec_from_file_location("dgc_docs_generator", ROOT / "scripts" / "generate-docs-site.py")
    module = importlib.util.module_from_spec(spec); assert spec.loader; spec.loader.exec_module(module)
    return module.GROUPS


def run_docs(check: bool) -> int:
    import subprocess
    command = [sys.executable, str(ROOT / "scripts" / "generate-docs-site.py")]
    if check: command.append("--check")
    return subprocess.run(command, cwd=ROOT, check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--skip-docs", action="store_true")
    args = parser.parse_args()
    outputs = build_outputs()
    stale: list[str] = []
    for name, value in outputs.items():
        data = value.encode("utf-8") if isinstance(value, str) else value
        target = SITE / name
        if args.check:
            if not target.exists() or target.read_bytes() != data: stale.append(name)
        else:
            target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
    if not args.skip_docs and run_docs(args.check) != 0:
        stale.append("docs/*")
    if args.check and stale:
        print("site is stale: " + ", ".join(stale), file=sys.stderr); return 1
    print(("verified" if args.check else "wrote") + f" {len(outputs)} shared site outputs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
