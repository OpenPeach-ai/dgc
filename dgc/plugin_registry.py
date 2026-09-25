"""User-added marketplaces and DGC-authored starter packages."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import shutil
import tempfile
from functools import wraps

from .plugin_sources import (SourceError, NAME, contained, copy_tree, read_json,
                             snapshot_github, write_json)

MANIFESTS = ('.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'marketplace.json')


def list_marketplaces(home: Path) -> list[dict]:
    path = home / 'marketplaces.json'
    if not path.exists():
        return []
    data = read_json(path)
    if not isinstance(data, dict) or not isinstance(data.get('marketplaces'), list):
        raise SourceError('Marketplace registry is invalid')
    return data['marketplaces'][:32]


def _manifest(root: Path):
    for relative in MANIFESTS:
        path = contained(root, relative)
        if path.is_file():
            data = read_json(path)
            if isinstance(data, dict) and isinstance(data.get('plugins'), list):
                return data
    raise SourceError('No marketplace found. Expected .agents/plugins/marketplace.json or .claude-plugin/marketplace.json')


def _locked(function):
    @wraps(function)
    def call(*args, **kwargs):
        from .plugins import _registry_lock
        with _registry_lock(): return function(*args, **kwargs)
    return call


@_locked
def add_marketplace(home: Path, source: str, *, refresh=False) -> dict:
    if not isinstance(source, str) or not source.strip() or len(source) > 2048:
        raise SourceError('Enter a marketplace folder or public GitHub repository')
    source = source.strip()
    local = Path(source).expanduser()
    sha = ''
    if local.is_dir():
        source = str(local.resolve())
        root = local.resolve()
        # Snapshot mutable local input too, so install always uses the reviewed bytes.
        data = _manifest(root)
        copy_id = hashlib.sha256(source.encode()).hexdigest()[:20]
        cache = home / 'marketplace-sources' / copy_id
        cache.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.market-', dir=cache.parent))
        try:
            copy_tree(root, stage)
            data = _manifest(stage)
            entries = _entries(data, stage, source, '')
            # Include content digest in the path: existing installations keep their source pin.
            digest = hashlib.sha256()
            for file in sorted(stage.rglob('*')):
                if file.is_file():
                    digest.update(str(file.relative_to(stage)).encode()); digest.update(file.read_bytes())
            sha = digest.hexdigest()
            root = cache.with_name(copy_id + '-' + sha[:16])
            if root.exists():
                shutil.rmtree(stage)
            else:
                stage.rename(root)
        finally:
            if stage.exists(): shutil.rmtree(stage)
    else:
        root, sha, _ = snapshot_github(home, source)
        data = _manifest(root)
        entries = _entries(data, root, source, sha)
    name = data.get('name')
    if not isinstance(name, str) or not NAME.fullmatch(name) or name in {'dgc-curated', 'personal'}:
        raise SourceError('Marketplace needs a unique lowercase name (not dgc-curated or personal)')
    rows = list_marketplaces(home)
    same = next((r for r in rows if r['name'] == name), None)
    if same and same['source'] != source:
        raise SourceError('A different marketplace already uses that name')
    if len(rows) >= 32 and not same:
        raise SourceError('At most 32 marketplaces can be registered')
    label = data.get('interface', {}).get('displayName', name) if isinstance(data.get('interface', {}), dict) else name
    record = {'name': name, 'display_name': str(label)[:100], 'source': source,
              'root': str(root), 'pin': sha, 'count': len(entries)}
    write_json(home / 'marketplaces.json', {'marketplaces': [r for r in rows if r['name'] != name] + [record]})
    return record


def _entries(data, root, source, pin):
    from .plugins import _declared_license, _package_metadata
    rows = []
    if len(data['plugins']) > 500:
        raise SourceError('Marketplace exceeds 500 plugins')
    market = data.get('name', '')
    if not isinstance(market, str) or not NAME.fullmatch(market):
        raise SourceError('Marketplace needs a valid lowercase name')
    seen = set()
    for entry in data['plugins']:
        if not isinstance(entry, dict): raise SourceError('Invalid marketplace entry')
        name = entry.get('name', '')
        if not isinstance(name, str) or not NAME.fullmatch(name) or name in seen:
            raise SourceError('Marketplace has invalid or duplicate plugin names')
        seen.add(name)
        plugin_id = (market[:24] + '--' + name[:36])
        spec = entry.get('source', '')
        path = spec.get('path', '') if isinstance(spec, dict) and spec.get('source') == 'local' else spec if isinstance(spec, str) else ''
        why = ''
        folder = None
        external = None
        if isinstance(spec, dict) and spec.get('source') in {'url', 'git-subdir', 'github'}:
            url = spec.get('url') or ('https://github.com/' + str(spec.get('repo', '')))
            try:
                from .plugin_sources import github_parts
                owner, repo, ref, subpath = github_parts(url)
                subpath = spec.get('path', subpath)
                contained(Path('/source'), subpath)
                external = {'upstream':f'https://github.com/{owner}/{repo}', 'path':subpath,
                            'sha':spec.get('sha') or spec.get('ref') or ref}
            except (SourceError, ValueError):
                why = 'This source is not a supported public GitHub repository.'
        elif path and not path.startswith(('https:', 'git:', 'ssh:')):
            folder = contained(root, path)
            if not folder.is_dir(): raise SourceError(f'Plugin folder is missing: {name}')
        else:
            why = 'This marketplace uses an unsupported source format. Add a public GitHub plugin link directly.'
        meta = _package_metadata(folder)
        license_id = (_declared_license(folder) or _declared_license(root)) if folder else ''
        policy = entry.get('policy', {})
        if isinstance(policy, dict) and policy.get('installation') in {'NOT_AVAILABLE', 'DISABLED', 'BLOCKED'}:
            why = 'This marketplace does not offer installation of this plugin.'
        if name in {'openai-templates', 'plugin-management'} and 'openai' in str(source).lower():
            why = 'DGC supplies its own templates and Plugin Management. This OpenAI package is not imported.'
        if not external and license_id not in {'MIT', 'Apache-2.0'}:
            why = why or 'This marketplace package needs a reviewed distribution license. DGC currently imports MIT and Apache-2.0 packages.'
        rows.append({'name': plugin_id, 'package_name': name,
                     'display_name': meta.get('display_name') or name,
                     'summary': meta.get('summary') or str(entry.get('description', ''))[:500],
                     'license': license_id or ('Review on fetch' if external else 'Not provided'), 'install': 'block' if why else 'review' if external else 'allow',
                     'block_reason': why, 'marketplace': market, 'source_kind': 'marketplace',
                     'source_path': str(folder) if folder else '', 'upstream': source, 'sha': pin,
                     **(external or {}), 'review_license': bool(external),
                     'auth': 'none', 'metadata': meta})
    if len({r['name'] for r in rows}) != len(rows): raise SourceError('Plugin names collide after namespacing')
    return rows


def entries(home: Path) -> list[dict]:
    rows = []
    for market in list_marketplaces(home):
        root = Path(market['root'])
        rows += _entries(_manifest(root), root, market['source'], market['pin'])
    authored = home / 'authored'
    if authored.is_dir():
        for root in sorted(authored.iterdir())[:100]:
            if root.is_dir() and NAME.fullmatch(root.name):
                rows += _entries({'name': 'personal', 'plugins': [{'name': root.name, 'source': './' + root.name}]},
                                 authored, 'Created locally', '')
    return rows


@_locked
def remove_marketplace(home: Path, name: str):
    rows = list_marketplaces(home)
    if not any(r['name'] == name for r in rows): raise SourceError('Marketplace not found')
    # Removing discovery never silently removes an installed plugin.
    write_json(home / 'marketplaces.json', {'marketplaces': [r for r in rows if r['name'] != name]})


@_locked
def create_plugin(home: Path, name: str, display_name: str, description: str) -> Path:
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise SourceError('Use a lowercase plugin name with letters, digits and hyphens')
    if not isinstance(description, str) or not 1 <= len(description.strip()) <= 500:
        raise SourceError('Add a description of up to 500 characters')
    if not isinstance(display_name, str) or len(display_name) > 100:
        raise SourceError('Plugin display name is too long')
    root = home / 'authored' / name
    if root.exists(): raise SourceError('A local plugin with this name already exists')
    root.mkdir(parents=True)
    import json
    write_json(root / '.codex-plugin/plugin.json', {'name': name, 'version': '0.1.0', 'license': 'Apache-2.0',
               'interface': {'displayName': display_name or name, 'shortDescription': description,
                             'developerName': 'Local author'}})
    skill = root / 'skills' / name / 'SKILL.md'
    skill.parent.mkdir(parents=True)
    skill.write_text('---\nname: ' + name + '\ndescription: ' + json.dumps(description.strip()) +
                     '\n---\n\n# ' + (display_name or name).replace('\n', ' ') +
                     '\n\nDescribe when to use this skill and the steps DGC should follow.\n', encoding='utf-8')
    (root / 'README.md').write_text('Edit skills/' + name + '/SKILL.md, then install this package from the Personal directory.\n'
                                    'Creating the package does not install or execute it.\n', encoding='utf-8')
    return root
