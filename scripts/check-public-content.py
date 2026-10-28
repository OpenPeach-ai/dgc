#!/usr/bin/env python3
"""Reject private work records and website trees in tracked public sources."""
import os
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


# What may sit at the top of the product tree. A new top-level file is a deliberate decision: notes, plans and
# comparisons were written there and kept out only by naming each one in .gitignore, which published their names.
_ROOT_FILES = {'.gitattributes', '.gitignore', 'AGENTS.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE',
               'README.md', 'SECURITY.md', 'install.sh', 'pyproject.toml', 'requirements.lock'}
_ROOT_DIRS = {'.dgc', '.github', 'deploy', 'dgc', 'docs', 'editors', 'examples', 'schemas', 'scripts', 'sdk',
              'tests'}
# Home folders tests and docs use as examples. A path under any other name is someone's real home folder.
_EXAMPLE_HOMES = {'u', 'pip', 'me', 'Me', 'dgc', 'someone', 'ana', 'anabel', 'you', 'user', 'bob', 'alice', 'x',
                  'private', 'fixture', 'Public', 'runner', 'ubuntu', '...'}
_HOME = re.compile(rb'(?:/home|/Users)/([A-Za-z0-9_.-]+)/')
# A coding agent's scratch folder (Claude Code's /tmp/claude-<uid>/): a default that names a session.
_AGENT_SCRATCH = re.compile(rb'/tmp/claude-\d+/')


def _private_terms(root: Path) -> list[tuple[str, re.Pattern]]:
    """Words that must never be published, kept OUT of the repository: one per line in the checkout's
    .git/info/public-denylist (machine names, addresses, private project names). Absent, nothing extra.
    Each matches as a whole word, any case: a name inside a longer word (FileNotFoundError) is not it."""
    try:
        common = subprocess.check_output(['git', 'rev-parse', '--git-common-dir'], cwd=root, text=True).strip()
        lines = (root / common / 'info' / 'public-denylist').read_text(encoding='utf-8').splitlines()
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError):
        return []
    words = [line.strip() for line in lines if line.strip() and not line.lstrip().startswith('#')]
    return [(word, re.compile(rb'(?<![A-Za-z0-9])' + re.escape(word.encode()) + rb'(?![A-Za-z0-9])', re.I))
            for word in words]


def _content_errors(name: str, data: bytes, terms: list[tuple[str, re.Pattern]]) -> list[str]:
    errors = []
    homes = sorted({m.group(1).decode(errors='replace') for m in _HOME.finditer(data)} - _EXAMPLE_HOMES)
    if homes:
        errors.append(f'{name}: a real home folder ({", ".join(homes)}); use an example one such as /home/me/')
    if _AGENT_SCRATCH.search(data):
        errors.append(f"{name}: a coding agent's scratch folder")
    for word, pattern in terms:
        if pattern.search(data):
            errors.append(f'{name}: a word from the local deny-list ({word})')
    return errors


def check(root: Path) -> list[str]:
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    terms = _private_terms(root)
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
        top = name.split('/', 1)
        if (len(top) == 1 and name not in _ROOT_FILES) or (len(top) == 2 and top[0] not in _ROOT_DIRS):
            errors.append(name + ': a new top-level entry; add it to _ROOT_FILES or _ROOT_DIRS in '
                                 'scripts/check-public-content.py if it belongs in the product')
            continue
        # Stream text so a large export cannot evade the check. Binary archives/media have
        # separate release allowlists and checksum/provenance validators.
        with path.open('rb') as stream:
            data = stream.read(8192)
            if b'\0' in data:
                continue
            found = set()
            while data:
                if content.search(data):
                    errors.append(name + ': conversation-export marker')
                    break
                for error in _content_errors(name, data, terms):
                    if error not in found:
                        found.add(error); errors.append(error)
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


# The address a new commit is published under. A personal address on a public commit cannot be taken back,
# so what is about to be published (the commits not yet on origin/main) must carry a GitHub noreply address.
_NOREPLY = re.compile(r'^(?:\d+\+)?[A-Za-z0-9-]+(?:\[bot\])?@users\.noreply\.github\.com$|^noreply@github\.com$', re.I)


def check_identity(root: Path, published: str = 'refs/remotes/origin/main') -> list[str]:
    """Refuse a commit about to be published under an address that is not a GitHub noreply one."""
    known = subprocess.run(['git', 'rev-parse', '-q', '--verify', published], cwd=root,
                           capture_output=True, text=True).returncode == 0
    span = ['HEAD', '^' + published] if known else ['HEAD']
    log = subprocess.run(['git', 'log', '--format=%h %ae %ce', *span], cwd=root,
                         capture_output=True, text=True, errors='replace')
    if log.returncode != 0:
        return ['git history could not be read to check commit addresses']
    errors = []
    for line in log.stdout.splitlines():
        sha, author, committer = (line.split() + ['', '', ''])[:3]
        bad = sorted({a for a in (author, committer) if not _NOREPLY.match(a)})
        if bad:
            errors.append(f'{sha}: not published under a GitHub noreply address ({", ".join(bad)}); '
                          'set user.email to <id>+<login>@users.noreply.github.com and re-author it')
    return errors


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    errors = check(root) + check_history(root)
    # CI checks what is already public; the address is decided before publishing, on this machine.
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        errors += check_identity(root)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        raise SystemExit(1)
    print('Public source content: product tree only; no private work records or website paths.')
