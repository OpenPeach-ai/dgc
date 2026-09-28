#!/usr/bin/env python3
"""Reject private work records and website trees in tracked public sources."""
from pathlib import Path
import re
import subprocess
import sys

# Public GitHub is the product (CLI, extension, SDK). vibedgc.com lives in a local
# deploy tree and must not return to the tracked index.
_WEBSITE_EXACT = {
    "wrangler.json",
    "package.json",
    "package-lock.json",
    "scripts/build-site.py",
    "scripts/check-site.py",
    "scripts/check-site-worker.mjs",
    "scripts/deploy-site.sh",
    "scripts/generate-docs-site.py",
    "scripts/benchmark_site.py",
    "scripts/site-measurement.py",
    "scripts/site_common.py",
    "scripts/sync-site-version.sh",
    ".github/workflows/site-metrics.yml",
}
_WEBSITE_PREFIXES = ("site/", "site-src/", "qa/site/")


def _website_path(name: str) -> bool:
    if name in _WEBSITE_EXACT:
        return True
    return name.startswith(_WEBSITE_PREFIXES)


def check(root: Path) -> list[str]:
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    # The wildcard covers every keyword, not just _AUDIT. It used to sit on _AUDIT alone, so
    # `PLUGIN_COMPATIBILITY_AUDIT.md` was caught while `SETTINGS_HANDOFF.md` and
    # `SETTINGS_PLUGINS_MIGRATION_HANDOFF.md` -- one of which opens "Migrate this implementation
    # into the main agent's current DGC development branch" -- were published for three days.
    forbidden = re.compile(r'(?:^|/)(?:\.claude|\.codex|private-evidence|internal-evidence)(?:/|$)'
                           r'|(?:^|/)(?:[^/]*[-_])?(?:HANDOFF|TAKEOVER|WORK-LOG|NEXT-STEPS|AUDIT)\.md$'
                           r'|(?:^|/)[^/]*session[^/]*\.jsonl$', re.I)
    # Provider integrations, public comparisons and runtime session code are legitimate source.
    # Personal home paths and conversation-export markers are not release documentation.
    content = re.compile(rb'(?:/home|/Users)/[^/\s]+/\.(?:claude|codex)/projects/'
                         rb'|<send_user_message_' rb'question_reply>'
                         rb'|"(?:parentUuid|isSidechain)"\s*:', re.I)
    errors = []
    for name in filter(None, paths):
        path = root / name
        if not path.is_file():
            continue
        if _website_path(name):
            errors.append(name + ': website path must not be tracked on the public product repo')
            continue
        if forbidden.search(name):
            errors.append(name + ': private work-record path')
            continue
        # Stream text so a large export cannot evade the check. Binary archives/media have
        # separate release allowlists and checksum/provenance validators.
        with path.open('rb') as stream:
            data = stream.read(8192)
            if b'\0' in data:
                continue
            while data:
                if content.search(data):
                    errors.append(name + ': conversation-export marker')
                    break
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                data = data[-256:] + chunk
    return errors


# Agent tooling attributes its work with a commit trailer, and several tools add one by default.
# On a public product repo that trailer discloses how the code was produced and maps the commit to
# a third-party GitHub account in the contributors list, and a push cannot be taken back. Two
# sibling checkouts on this machine hold 336 and 362 such commits between them; they are unpushed,
# and this gate is what keeps that true even if someone publishes from the wrong tree.
#
# Anchored trailer forms only. Subjects that merely name a vendor are legitimate and must pass --
# DGC integrates Claude, Codex, Qwen and Kimi subscriptions, and says so in its commit subjects.
_TRAILER = re.compile(
    r'^(?:Co-authored-by:.*(?:claude|anthropic)'
    r'|.*Generated with \[Claude Code\]'
    r'|.*noreply@anthropic\.com)',
    re.I | re.M)


def check_history(root: Path) -> list[str]:
    """Reject attribution trailers and vendor addresses anywhere in the history being published."""
    errors = []
    # -z separates records with NUL; a message body can contain anything else, including blank
    # lines, so no textual separator is safe here.
    log = subprocess.run(['git', 'log', '-z', '--format=%H%n%B'], cwd=root,
                         capture_output=True, text=True, errors='replace')
    if log.returncode != 0:
        return ['git history could not be read to check commit attribution']
    for record in log.stdout.split('\x00'):
        record = record.strip()
        if not record:
            continue
        found = _TRAILER.search(record)
        if found:
            errors.append(f'{record.splitlines()[0][:12]}: commit attribution trailer '
                          f'({found.group(0).strip()[:60]})')
    idents = subprocess.run(['git', 'log', '--format=%ae%n%ce'], cwd=root,
                            capture_output=True, text=True, errors='replace')
    if any('anthropic' in line.lower() for line in idents.stdout.splitlines()):
        errors.append('a commit is authored or committed under an Anthropic address')
    return errors


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    errors = check(root) + check_history(root)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        raise SystemExit(1)
    print('Public source content: product tree only; no private work records or website paths.')
