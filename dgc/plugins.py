"""Curated plugins for the DGC that is installed on this machine.

Plugin files are copied into ~/.dgc/plugins when the user installs one. They are not
part of the DGC source tree. A browser plugin then uses the existing MCP sign-in.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

from .config import USER_HOME
from .mcp_config import validate_mcp_spec
from . import plugin_sources as sources
from .scheduler import named_process_lock
from contextlib import contextmanager
import hashlib

CATALOG_PATH = Path(__file__).resolve().parent / "plugin_catalog.json"
PLUGIN_HOME = USER_HOME / "plugins"
SKILL_ROOT = PLUGIN_HOME / "skills"
LOGO_ROOT = PLUGIN_HOME / "logos"
STATE_PATH = PLUGIN_HOME / "installed.json"
MAX_FILE_BYTES = 512 * 1024


PluginError = sources.SourceError


def load_catalog() -> dict:
    from .plugin_registry import entries
    data = sources.read_json(CATALOG_PATH)
    data['plugins'] = [{**row, 'marketplace': 'dgc-curated'} for row in data['plugins']] + entries(PLUGIN_HOME)
    return data


def search(query: str = "") -> list[dict]:
    needle = query.strip().lower()
    rows = [row for row in load_catalog()["plugins"]
            if row.get("install") != "block" and row.get("license") != "Proprietary"]
    if not needle:
        return rows
    return [row for row in rows if needle in " ".join([
        row.get("name", ""), row.get("display_name", ""), row.get("summary", ""),
        row.get("license", "")]).lower()]


def _source(entry: dict, *, fetch=False) -> Path:
    if entry.get('source_kind') == 'dgc':
        root = sources.contained(Path(__file__).resolve().parent / 'bundled_plugins', entry.get('path', ''))
    elif entry.get('source_kind') == 'preset':
        raise PluginError('This connection is configured from its published MCP endpoint')
    elif entry.get('source_path'):
        root = Path(entry['source_path'])
        sources.contained(PLUGIN_HOME, str(root.relative_to(PLUGIN_HOME)))
    else:
        owner, repo, _, _ = sources.github_parts(entry['upstream'])
        sha = entry.get('sha', '')
        digest = hashlib.sha256(f'{owner.lower()}/{repo.lower()}@{sha}:{entry.get("path", "")}'.encode()).hexdigest()
        base = PLUGIN_HOME / 'sources' / digest
        if fetch and not (base / '.dgc-source-complete').is_file():
            root, sha, _ = sources.snapshot_github(PLUGIN_HOME, entry['upstream'], sha, entry.get('path', ''))
            entry['sha'] = sha
            entry['source_path'] = str(root)
            return root
        root = sources.contained(base, entry.get('path', ''))
    if not root.is_dir():
        raise PluginError('Package not cached. Open the install review to fetch its pinned source.')
    return root




def _availability_ok(name: str) -> None:
    """Recheck current policy before a stale review or installed package connects."""
    current = next((row for row in load_catalog()['plugins'] if row['name'] == name), {})
    if current.get('install') == 'block' or current.get('license') == 'Proprietary':
        raise PluginError(current.get('block_reason') or 'This plugin is not offered in DGC.')


def _license_ok(entry: dict, accept_license: str) -> None:
    _availability_ok(entry['name'])
    if entry.get("install") == "block" or entry.get("license") == "Proprietary":
        raise PluginError(entry.get("block_reason") or "this plugin is not offered")
    if entry.get("install") == "accept" and accept_license != entry.get("license"):
        raise PluginError(
            f"accept the upstream terms with --accept-license {entry.get('license')}")


def _installed() -> list[dict]:
    if not STATE_PATH.exists(): return []
    data = sources.read_json(STATE_PATH)
    if not isinstance(data, dict) or not isinstance(data.get('installed', []), list):
        raise PluginError('Installed plugin state is invalid')
    return data.get('installed', [])


def _save(rows: list[dict]) -> None:
    state = sources.read_json(STATE_PATH) if STATE_PATH.exists() else {}
    state['installed'] = rows
    sources.write_json(STATE_PATH, state)


def _copy_skill_dirs(source: Path, plugin: str, target_root: Path | None = None) -> list[str]:
    # Caller stages the entire validated package first. Never reuse another package's folder.
    names = []
    for skill in _skill_files(source):
        folder = skill.parent
        name = plugin + '--' + folder.name
        dest = (target_root or SKILL_ROOT) / name
        if dest.exists(): shutil.rmtree(dest)
        sources.copy_tree(folder, dest)
        names.append(name)
    return names


def _copy_logo(source: Path, name: str) -> str:
    declared = _package_metadata(source).get("package_logo")
    candidates = [source / declared] if declared else []
    candidates += [source / "assets" / "logo-padded.png", source / "assets" / "logo.png"]
    for candidate in candidates:
        try:
            candidate.resolve().relative_to(source.resolve())
        except ValueError:
            continue
        if candidate.suffix.lower() == ".png" and candidate.is_file() and candidate.stat().st_size <= MAX_FILE_BYTES:
            LOGO_ROOT.mkdir(parents=True, exist_ok=True)
            dest = LOGO_ROOT / f"{name}.png"
            shutil.copyfile(candidate, dest)
            return str(dest)
    return ""


def mcp_spec(url: str, bearer: str) -> dict:
    spec = {
        "transport": "remote",
        "command": "npx",
        "args": ["-y", "mcp-remote", url],
        "url": url,
        "env_names": [bearer] if bearer else [],
        "log_level": "warning",
    }
    if bearer:
        spec["auth_env"] = bearer
    clean, error = validate_mcp_spec(spec, persisted=True)
    if error:
        raise PluginError(error)
    return clean


_GITHUB_HOSTS = {"github.com", "www.github.com"}


def _parse_github_url(url: str) -> tuple[str, str, str, str]:
    """Return owner, repo, ref, and path for one GitHub plugin link."""
    text = str(url or "").strip()
    if len(text) > 500 or any(ord(ch) < 32 for ch in text):
        raise PluginError("Paste a GitHub link to one plugin.")
    parsed = urlsplit(text)
    if parsed.scheme != "https" or parsed.hostname not in _GITHUB_HOSTS or parsed.username or parsed.password:
        raise PluginError("Paste an https://github.com link to one plugin.")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise PluginError("That link needs a GitHub owner and repository.")
    owner, repo = parts[0], parts[1].removesuffix(".git")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", owner) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", repo):
        raise PluginError("That GitHub link is not a repository DGC can read.")
    ref, path_parts = "", parts[2:]
    if path_parts and path_parts[0] in ("tree", "blob") :
        if len(path_parts) < 2:
            raise PluginError("That GitHub link does not name a plugin folder.")
        ref = path_parts[1]
        path_parts = path_parts[2:]
        if path_parts and path_parts[-1].endswith((".json", ".md", ".txt")):
            path_parts = path_parts[:-1]
    if any(part in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", part) for part in path_parts):
        raise PluginError("That plugin path is not one DGC can install.")
    if ref and not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", ref):
        raise PluginError("That GitHub link does not name a commit or branch DGC can pin.")
    return owner, repo, ref, "/".join(path_parts)


def catalog_entry_for_url(url: str) -> dict | None:
    """Match a pasted link to one curated plugin, when the link points at its folder."""
    owner, repo, _ref, path = _parse_github_url(url)
    upstream = f"https://github.com/{owner}/{repo}".lower()
    matches = []
    for entry in load_catalog()["plugins"]:
        if str(entry.get("upstream") or "").rstrip("/").lower() != upstream:
            continue
        entry_path = str(entry.get("path") or "").strip("/")
        if path == entry_path or path.endswith("/" + entry_path):
            matches.append(entry)
    if len(matches) == 1:
        return matches[0]
    if not path:
        raise PluginError("That repository has more than one plugin. Paste the link to one plugin folder.")
    return None


def _declared_license(root: Path) -> str:
    manifest = (_package_json(root, '.codex-plugin/plugin.json') or
                _package_json(root, '.claude-plugin/plugin.json') or _package_json(root, 'plugin.json'))
    declared = str(manifest.get('license') or '')
    if declared in ('MIT', 'Apache-2.0', 'Proprietary'): return declared
    for name in ('LICENSE', 'LICENSE.txt', 'LICENSE.md'):
        file = sources.contained(root, name)
        if file.is_file():
            with file.open('rb') as stream: text = stream.read(20001).decode('utf-8', errors='replace')
            if 'Apache License' in text and 'Version 2.0' in text: return 'Apache-2.0'
            if 'MIT License' in text or 'Permission is hereby granted, free of charge' in text: return 'MIT'
            return declared or 'License review required'
    return declared


def _plugin_name(root: Path, fallback: str) -> tuple[str, str]:
    display = fallback
    for relative in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"):
        file = root / relative
        if not file.is_file() or file.stat().st_size > 65536:
            continue
        try:
            loaded = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(loaded, dict) and loaded.get("name"):
            display = str(loaded.get("displayName") or loaded.get("display_name") or loaded["name"])
            fallback = str(loaded["name"])
            break
    slug = re.sub(r"[^a-z0-9-]+", "-", fallback.lower()).strip("-")[:64]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", slug):
        raise PluginError("That plugin has no usable name.")
    return slug, display[:80]




def _install_tree(entry: dict, source: Path | None, *, accept_license: str, selected_servers=None) -> dict:
    _license_ok(entry, accept_license)
    name = entry['name']
    if not sources.NAME.fullmatch(name): raise PluginError('Invalid plugin name')
    with _registry_lock():
        preview = _preview(entry, source)
        if not preview['supported']: raise PluginError(preview['compatibility_reason'])
        choices = preview['server_specs']
        selected = list(choices) if selected_servers is None else selected_servers
        if not isinstance(selected, list) or len(selected) > 32 or any(not isinstance(n,str) or n not in choices for n in selected):
            raise PluginError('Selected MCP servers do not belong to this plugin')
        if not preview['skills'] and not selected: raise PluginError('Select at least one supported component')
        old_rows = _installed()
        # Skills keep their declared names. Refuse ambiguity across packages instead of replacing one.
        declared = {skill['name'] for skill in preview['skills']}
        for row in old_rows:
            if row['name'] != name:
                other = {x['name'] for x in _skill_summaries(None, row.get('skills', []), set())}
                if declared & other: raise PluginError('Another installed plugin already owns a skill with this name: ' + ', '.join(sorted(declared & other)))
        packages = PLUGIN_HOME / 'packages'; packages.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.install-', dir=packages))
        dest = packages / name
        backup = packages / ('.previous-' + name)
        skill_stage = Path(tempfile.mkdtemp(prefix='.skills-', dir=packages))
        moved, prior = [], []
        committed = False
        replaced = False
        try:
            if source is not None: sources.copy_tree(source, stage)
            # Resolve relative scripts against the final installed package, not its fetch cache.
            specs = {key: _relocate_spec(value, str(source), str(dest)) for key, value in choices.items() if key in selected}
            if backup.exists(): shutil.rmtree(backup)
            if dest.exists(): dest.rename(backup)
            stage.rename(dest)
            replaced = True
            old = next((r for r in old_rows if r['name'] == name), {})
            skills = _copy_skill_dirs(dest, name, skill_stage / 'new') if source else []
            SKILL_ROOT.mkdir(parents=True, exist_ok=True)
            for folder in skills:
                live = SKILL_ROOT / folder
                if live.exists():
                    if folder not in old.get('skills', []): raise PluginError('A skill folder already exists outside this plugin ownership')
                    previous = skill_stage / 'previous' / folder
                    previous.parent.mkdir(parents=True, exist_ok=True)
                    live.rename(previous); prior.append((previous, live))
                (skill_stage / 'new' / folder).rename(live); moved.append(live)
            metadata = dict(preview['metadata'])
            if entry.get('source_kind') == 'preset':
                metadata['apps'] = [a for a in metadata.get('apps', []) if any(n.endswith('--' + a.get('id', '')) for n in specs)]
            record = {**entry, 'metadata': metadata, 'skills': skills,
                      'logo_file': _copy_logo(dest, name) if source else '',
                      'servers': specs, 'server_names': list(specs),
                      'sign_in_url': next((v['url'] for v in specs.values() if v.get('url')), ''),
                      'auth': entry.get('auth') or ('browser' if specs else 'none'),
                      'source_pin': entry.get('sha', ''), 'package_path': str(dest),
                      'warnings': preview['warnings'], 'setup_required': bool(entry.get('setup_required')),
                      'registered_specs': old.get('registered_specs', {})}
            _save([r for r in old_rows if r['name'] != name] + [record])
            committed = True
            for folder in set(old.get('skills', [])) - set(skills):
                try: _remove_owned_skill(folder, old_rows, name)
                except OSError: pass  # catalog no longer claims the old file; cleanup may be retried
            if backup.exists(): shutil.rmtree(backup, ignore_errors=True)
            return record
        except Exception:
            if not committed:
                for live in moved:
                    if live.exists(): shutil.rmtree(live)
                for previous, live in prior: previous.rename(live)
                if replaced and dest.exists(): shutil.rmtree(dest)
                if backup.exists(): backup.rename(dest)
            raise
        finally:
            if stage.exists(): shutil.rmtree(stage)
            shutil.rmtree(skill_stage, ignore_errors=True)


def install_from_url(url: str, *, accept_license: str = '', selected_servers=None) -> dict:
    entry = entry_from_url(url)
    return install(entry, accept_license=accept_license, selected_servers=selected_servers)


def install(entry: dict, *, accept_license: str = '', selected_servers=None) -> dict:
    _license_ok(entry, accept_license)
    if entry.get('connector'): raise PluginError('Open Apps and complete this connector’s setup form.')
    source = None if entry.get('source_kind') == 'preset' else _source(entry, fetch=True)
    if entry.get('review_license'):
        entry = _review_external_license(entry, source)
    return _install_tree(entry, source, accept_license=accept_license, selected_servers=selected_servers)


def register_mcp(config, record: dict) -> dict:
    specs = record_servers(record)
    if not specs: return {}
    servers = dict(config.get('mcp_servers', {}) or {})
    owned = record.get('registered_specs', {})
    for name, spec in specs.items():
        if name in servers and servers[name] != spec and servers[name] != owned.get(name):
            raise PluginError(f'MCP server {name} already has different settings. DGC will not overwrite them.')
    if len(set(servers) | set(specs)) > 32: raise PluginError('At most 32 MCP servers can be configured')
    servers.update(specs)
    config.set('mcp_servers', servers)
    record['registered_specs'] = specs
    with _registry_lock():
        _save([r if r['name'] != record['name'] else record for r in _installed()])
    return specs


def _frontmatter_field(skill_md: Path, field: str) -> str:
    """Read metadata only, with the same bounded YAML subset as skill discovery."""
    from .skills import metadata_fields
    try:
        with skill_md.open("rb") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            return ""
        text = raw.decode("utf-8").removeprefix("\ufeff").replace("\r\n", "\n")
        match = re.match(r"\A---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)", text)
        if not match:
            return ""
        return " ".join(metadata_fields(match[1], {field}).get(field, "").split())[:2000]
    except (OSError, UnicodeError, ValueError, RecursionError):
        return ""


def _package_json(source: Path | None, relative: str) -> dict:
    if source is None or not isinstance(relative, str):
        return {}
    try:
        path = (source / relative).resolve()
        path.relative_to(source.resolve())
        with path.open("rb") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            return {}
        result = json.loads(raw)
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError, RecursionError):
        return {}


def _package_metadata(source: Path | None) -> dict:
    manifest = (_package_json(source, ".codex-plugin/plugin.json")
                or _package_json(source, ".claude-plugin/plugin.json"))
    interface = manifest.get("interface", {})
    interface = interface if isinstance(interface, dict) else {}
    author = manifest.get("author", {})
    author = author.get("name", "") if isinstance(author, dict) else author
    text = lambda value, limit=4000: value[:limit] if isinstance(value, str) else ""
    prompts = interface.get("defaultPrompt", [])
    prompts = [prompts] if isinstance(prompts, str) else prompts
    rows = {
        "declared_license": text(manifest.get("license"), 160),
        "version": text(manifest.get("version"), 80),
        "source_url": text(manifest.get("repository")),
        "display_name": text(interface.get("displayName") or manifest.get("displayName"), 120),
        "summary": text(interface.get("shortDescription") or manifest.get("description"), 500),
        "long_summary": text(interface.get("longDescription") or manifest.get("description")),
        "developer": text(interface.get("developerName") or author, 160),
        "category": text(interface.get("category"), 100),
        "website_url": text(interface.get("websiteURL") or interface.get("website") or manifest.get("homepage")),
        "terms_url": text(interface.get("termsOfServiceURL") or interface.get("terms")),
        "privacy_url": text(interface.get("privacyPolicyURL") or interface.get("privacy")),
        "brand_color": text(interface.get("brandColor"), 32),
        "package_logo": text(interface.get("logo"), 256),
        "default_prompt": [text(p, 600) for p in prompts[:3] if isinstance(p, str)] if isinstance(prompts, list) else [],
    }
    app_file = manifest.get("apps") if isinstance(manifest.get("apps"), str) else ".app.json"
    apps = _package_json(source, app_file).get("apps", {})
    rows["apps"] = [{"id": text(name, 120), "name": text(value.get("displayName") or value.get("name") or (rows["display_name"] if len(apps) == 1 else name) or name, 120)}
                    for name, value in list(apps.items())[:32] if isinstance(value, dict)] if isinstance(apps, dict) else []
    mcps = _package_json(source, ".mcp.json")
    mcps = mcps.get("mcpServers") or mcps.get("mcp_servers") or mcps
    rows["mcps"] = []
    for name, value in list(mcps.items())[:32]:
        if not isinstance(value, dict):
            continue
        # Declaration only; never expose embedded auth, environment values or arbitrary args.
        url = text(value.get("url"), 2048)
        try:
            parsed = urlsplit(url)
            url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}" if parsed.scheme in ("http", "https") and not parsed.username and not parsed.password else ""
        except ValueError:
            url = ""
        rows["mcps"].append({"name": text(name, 120), "url": url,
                              "command": text(value.get("command"), 120),
                              "transport": "remote" if url else "stdio"})
    return rows


def _skill_summaries(source: Path | None, names: list[str], disabled: set[str]) -> list[dict]:
    files: list[Path] = []
    if names:
        files = [SKILL_ROOT / name / "SKILL.md" for name in names if (SKILL_ROOT / name / "SKILL.md").is_file()]
    elif source is not None:
        skills = source / "skills"
        if skills.is_dir():
            files = _skill_files(source)
    rows = []
    seen = set()
    for skill_md in files:
        name = _frontmatter_field(skill_md, "name") or skill_md.parent.name
        if name in seen:
            continue
        seen.add(name)
        rows.append({
            "name": name,
            "description": _frontmatter_field(skill_md, "description"),
            "enabled": name not in disabled,
        })
    return rows[:40]



def catalog_for_editor(opening: str = "", connected: set | None = None,
                       disabled: set | None = None) -> list[dict]:
    installed = {row["name"]: row for row in _installed()}
    disabled_names = {str(name) for name in (disabled or set())}
    items = []
    entries = load_catalog()["plugins"]
    known = {row["name"] for row in entries}
    entries = entries + [row for name, row in installed.items() if name not in known]
    for entry in entries:
        have = installed.get(entry["name"])
        unavailable = entry.get("install") == "block" or entry.get("license") == "Proprietary"
        if unavailable and not have:
            continue  # Withdrawn offers stay internal so stale reviews/links still fail closed.
        try:
            source = _source(entry)
        except (PluginError, KeyError):
            source = None
        metadata = (have or {}).get("metadata") or (_package_metadata(source) if source else entry.get("metadata", {}))
        if entry["name"] == "composio" and entry.get("source_kind") == "preset":
            # This is our service preset, not a fetched package. Old install metadata
            # must not keep advertising retired app-setup shortcuts.
            metadata = dict(entry.get("metadata", {}))
        skill_names = list((have or {}).get("skills") or [])
        items.append({
            "name": entry["name"],
            "display_name": entry.get("display_name") or entry["name"],
            "summary": entry.get("summary") or "",
            "license": entry.get("license") or "",
            "license_url": entry.get("license_url") or "",
            "install": entry.get("install") or "allow",
            "auth": entry.get("auth") or "none",
            "installed": bool(have),
            "connected": bool(have and record_servers(have) and set(record_servers(have)) <= set(connected or set())),
            "server_names": list(record_servers(have)) if have else [],
            "marketplace": entry.get("marketplace", "dgc-curated"),
            "connector": entry.get("connector", ""),
            "source_pin": (have or {}).get("source_pin") or entry.get("sha", ""),
            "setup_required": bool((have or entry).get("setup_required")),
            "setup_url": entry.get("setup_url", ""),
            "setup_instructions": entry.get("setup_instructions", ""),
            "warnings": (have or {}).get("warnings", []),
            "opening": entry["name"] == opening,
            "icon": entry.get("icon") or "",
            "upstream": entry.get("upstream") or "",
            "sign_in_url": (have or {}).get("sign_in_url") or "",
            "block_reason": entry.get("block_reason") or "",
            "developer": entry.get("developer") or "",
            "category": entry.get("category") or "",
            "long_summary": entry.get("long_summary") or "",
            "terms_url": entry.get("terms_url") or entry.get("license_url") or "",
            "privacy_url": entry.get("privacy_url") or "",
            "skills": _skill_summaries(None if skill_names else source, skill_names, disabled_names),
            **{key: value for key, value in metadata.items() if value},
            # Package metadata cannot override DGC's compatibility decision.
            "install": entry.get("install") or "allow",
            "block_reason": entry.get("block_reason") or "",
            "compatibility_url": entry.get("compatibility_url") or "",
            "verification": entry.get("verification") or "",
            "requirements": entry.get("requirements") or "",
            "audited_on": entry.get("audited_on") or "",
            "logo_file": (have or {}).get("logo_file") or "",
            "apps": metadata.get("apps", []),
            "mcps": [{"name":name, "url":spec.get("url", ""), "command":spec.get("command", ""), "transport":spec.get("transport", "stdio")} for name,spec in record_servers(have).items()] if have else metadata.get("mcps", []),
        })
    return items


def ensure_first_party() -> None:
    # A removed default stays removed. This records a user's choice, not just presence.
    state = sources.read_json(STATE_PATH) if STATE_PATH.exists() else {}
    have = {row.get('name') for row in state.get('installed', [])}
    removed = set(state.get('removed_defaults', []))
    for entry in load_catalog()['plugins']:
        if entry.get('source_kind') == 'dgc' and entry['name'] not in have | removed:
            install(entry)


def open_sign_in(url: str) -> bool:
    print(f"Opening the browser to sign in:\n  {url}")
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:
        return False


def cli_mcp_input(ui):
    """Adapt the MCP bridge callback to the CLI consent prompt."""
    def handler(server, method, params, cancel=None):
        if method == "elicitation/create":
            return ui.mcp_input(server, "elicitation", params or {}, cancel=cancel)
        return {"action": "cancel"}
    return handler


def connect(config, manager, record: dict, *, input_handler, cancel=None) -> None:
    _availability_ok(record['name'])
    specs = register_mcp(config, record)
    # Setup-only presets must never cause a pretend sign-in or be auto-launched.
    active = {n:s for n,s in specs.items() if not s.get('defer_until_setup')}
    if not active: return
    runtime = config.mcp_runtime_servers(active) if hasattr(config, 'mcp_runtime_servers') else active
    available = {}
    for name, spec in runtime.items():
        supplied = spec.get('env', {})
        missing = [key for key in spec.get('env_names', []) if key not in supplied and key not in os.environ]
        if missing:
            manager.failures[name] = 'Configure ' + ', '.join(missing) + ' in MCP server settings before connecting.'
        else: available[name] = spec
    if available: manager.connect_all(available, input_handler=input_handler, cancel=cancel)


def handle(config, argv: list[str], *, ui=None, manager=None) -> int:
    action = argv[0] if argv else "list"
    if action == 'marketplace':
        from . import plugin_registry
        sub = argv[1] if len(argv)>1 else 'list'
        if sub == 'list':
            for row in plugin_registry.list_marketplaces(PLUGIN_HOME): print(row['name'], row['source'], row['pin'])
        elif sub == 'add' and len(argv)==3:
            print(plugin_registry.add_marketplace(PLUGIN_HOME,argv[2])['name'])
        elif sub == 'remove' and len(argv)==3:
            plugin_registry.remove_marketplace(PLUGIN_HOME,argv[2])
        elif sub == 'refresh' and len(argv)==3:
            row = next((r for r in plugin_registry.list_marketplaces(PLUGIN_HOME) if r['name']==argv[2]), None)
            if not row: raise PluginError('Marketplace not found')
            plugin_registry.add_marketplace(PLUGIN_HOME,row['source'],refresh=True)
        else: raise PluginError('usage: dgc plugin marketplace list|add SOURCE|remove NAME|refresh NAME')
        return 0
    if action == 'uninstall' and len(argv)==2:
        result = uninstall(argv[1],config=config,manager=manager)
        print('Uninstalled ' + argv[1])
        if result['retained_servers']: print('Kept edited/shared MCP servers: ' + ', '.join(result['retained_servers']))
        return 0
    if action in ("-h", "--help", "help"):
        print("usage: dgc plugin list|search [TEXT]|install NAME [--accept-license ID]|sign-in NAME|uninstall NAME|marketplace list|add SOURCE|remove NAME|refresh NAME|installed")
        return 0
    if action == "list":
        for row in search(""):
            mark = "installed" if any(item.get("name") == row["name"] for item in _installed()) else row.get("install")
            print(f"{mark:10}  {row['name']:22}  {row.get('display_name')}")
        return 0
    if action == "search":
        for row in search(" ".join(argv[1:])):
            print(f"{row.get('install', ''):8}  {row['name']:22}  {row.get('license', ''):36}  {row.get('display_name')}")
        return 0
    if action == "installed":
        rows = _installed()
        if not rows:
            print("none")
            return 0
        for row in rows:
            print(f"{row['name']}  {row.get('license')}  skills={len(row.get('skills') or [])}")
        return 0
    if action in ("install", "sign-in") and len(argv) >= 2:
        name = argv[1]
        entry = next((row for row in load_catalog()["plugins"] if row["name"] == name), None)
        if entry is None:
            raise PluginError(f"unknown plugin {name}")
        accept = ""
        if "--accept-license" in argv:
            accept = argv[argv.index("--accept-license") + 1]
        if action == "install":
            record = install(entry, accept_license=accept)
            print(f"installed {record['name']}  skills={len(record['skills'])}")
        else:
            record = next((row for row in _installed() if row.get("name") == name), None)
            if record is None:
                raise PluginError(f"{name} is not installed")
        if record.get("sign_in_url") and manager is not None and ui is not None:
            connect(config, manager, record, input_handler=cli_mcp_input(ui))
            names = set(record_servers(record))
            if names <= set(manager.servers): print(f"{record['name']} is connected. Its tools are ready.")
            elif record.get('setup_required'): print(record.get('setup_instructions', 'MCP setup is required.'))
            else: raise PluginError('Plugin installed but not connected: ' + '; '.join(str(manager.failures.get(n, 'not connected')) for n in names - set(manager.servers)))
        elif record.get("auth") == "pat":
            print("Set GITHUB_PAT_TOKEN, then run: dgc plugin sign-in github")
        else:
            print("Reload DGC so the new skills are available.")
        return 0
    raise PluginError("usage: dgc plugin list|search [TEXT]|install NAME [--accept-license ID]|sign-in NAME|uninstall NAME|marketplace list|add SOURCE|remove NAME|refresh NAME|installed")


def _skill_files(source: Path) -> list[Path]:
    manifest = _package_json(source, '.codex-plugin/plugin.json') or _package_json(source, '.claude-plugin/plugin.json')
    declared = manifest.get('skills', 'skills')
    paths = declared if isinstance(declared, list) else [declared]
    result = []
    for relative in paths:
        folder = sources.contained(source, relative)
        if folder.is_file() and folder.name == 'SKILL.md': result.append(folder)
        elif folder.is_dir(): result.extend(sorted(folder.rglob('SKILL.md')))
    if len(result) > 40: raise PluginError('A plugin can contain at most 40 skills')
    names = [_frontmatter_field(file, 'name') or file.parent.name for file in result]
    if len(names) != len(set(names)): raise PluginError('Plugin contains duplicate skill names')
    if len({file.parent.name for file in result}) != len(result): raise PluginError('Plugin contains duplicate skill folder names')
    for file in result:
        sources.contained(source, str(file.relative_to(source)))
        if file.stat().st_size > 65536: raise PluginError('A skill exceeds DGC\'s 64 KiB limit')
    return result


def _read_server_specs(source: Path | None, entry: dict) -> dict:
    if source is None:
        declared = entry.get('mcp_presets', {})
    else:
        manifest = _package_json(source, '.codex-plugin/plugin.json') or _package_json(source, '.claude-plugin/plugin.json')
        declared = manifest.get('mcpServers', '.mcp.json')
        if isinstance(declared, str):
            path = sources.contained(source, declared)
            declared = sources.read_json(path, 65536) if path.is_file() else {}
        elif not isinstance(declared, dict):
            raise PluginError('Unsupported MCP declaration format')
        if not isinstance(declared, dict): raise PluginError('MCP declarations must be an object')
        declared = declared.get('mcpServers', declared.get('mcp_servers', declared))
    if not isinstance(declared, dict) or len(declared) > 16: raise PluginError('Plugin MCP declarations must contain at most 16 servers')
    result = {}
    for name, raw in declared.items():
        if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}', name) or not isinstance(raw,dict):
            raise PluginError('Invalid MCP server declaration')
        env = raw.get('env', {})
        if not isinstance(env,dict): raise PluginError('MCP environment must be an object')
        names = raw.get('env_names', [])
        if not isinstance(names, list) or any(not isinstance(n, str) for n in names):
            raise PluginError('MCP environment names must be a list of strings')
        names = list(names)
        for key, value in env.items():
            if value != '${' + key + '}':
                raise PluginError('Plugin MCP environment values must be same-name environment references; configure literal values manually')
            names.append(key)
        if raw.get('url'):
            if raw.get('type') == 'sse': raise PluginError('Legacy SSE packages require manual MCP configuration')
            bearer = raw.get('bearer_token_env_var') or raw.get('auth_env') or ''
            headers = raw.get('headers', {})
            if headers:
                auth = headers.get('Authorization') if isinstance(headers,dict) else None
                match = re.fullmatch(r'Bearer \$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}', str(auth or ''))
                if not match or len(headers) != 1: raise PluginError('Inline MCP headers are not imported. Use an environment reference for a bearer token.')
                bearer = match.group(1)
            spec = mcp_spec(raw['url'], bearer)
            spec['env_names'] = list(dict.fromkeys(spec['env_names'] + names))
        elif raw.get('command'):
            command, args = raw['command'], raw.get('args', [])
            if not isinstance(command,str) or not isinstance(args,list) or any(not isinstance(a,str) for a in args):
                raise PluginError('Invalid stdio command or arguments')
            def resolve(value):
                for key in ('${CLAUDE_PLUGIN_ROOT}', '${CODEX_PLUGIN_ROOT}', '${DGC_PLUGIN_ROOT}'):
                    value = value.replace(key, str(source))
                if '${' in value: raise PluginError('Unsupported variable in MCP command; configure it manually')
                return value
            spec = {'transport':'stdio', 'command':resolve(command), 'args':[resolve(a) for a in args], 'env_names':list(dict.fromkeys(names))}
        else:
            raise PluginError('MCP server must declare a URL or a stdio command')
        if entry.get('setup_required'): spec['defer_until_setup'] = True
        clean, error = validate_mcp_spec(spec, persisted=True)
        if error: raise PluginError(error)
        server_name = entry['name'] if len(declared) == 1 else entry['name'][:35] + '--' + name[:27]
        if server_name in result: raise PluginError('MCP server names collide after namespacing')
        result[server_name] = clean
    return result


def _relocate_spec(spec: dict, old: str, new: str) -> dict:
    result = dict(spec)
    result['command'] = spec['command'].replace(old + os.sep, new + os.sep)
    result['args'] = [arg.replace(old + os.sep, new + os.sep) for arg in spec['args']]
    return result


def _preview(entry: dict, source: Path | None) -> dict:
    metadata = _package_metadata(source) if source else dict(entry.get('metadata', {}))
    warnings = []
    if source:
        sources.tree_files(source)
        manifest = _package_json(source, '.codex-plugin/plugin.json') or _package_json(source, '.claude-plugin/plugin.json')
        for kind in ('hooks', 'agents', 'commands', 'lspServers', 'outputStyles'):
            if manifest.get(kind) or (source / kind).exists():
                warnings.append(f'{kind}: this host-specific component is not imported by DGC.')
        files = _skill_files(source)
        skills = [{'name':_frontmatter_field(f,'name') or f.parent.name, 'description':_frontmatter_field(f,'description')} for f in files]
    else:
        skills = []
    specs = _read_server_specs(source, entry)
    if metadata.get('apps') and not specs:
        warnings.append('This package declares ChatGPT apps without a standalone MCP server. DGC cannot use those hosted connections.')
    supported = bool(skills or specs or entry.get('connector'))
    return {**entry, **{k:v for k,v in metadata.items() if v}, 'metadata':metadata,
            'skills':skills, 'server_specs':specs, 'warnings':warnings, 'supported':supported,
            'compatibility_reason': '' if supported else 'No supported skills or MCP servers in this package. ' + ' '.join(warnings)}


def entry_from_url(url: str) -> dict:
    try:
        entry = catalog_entry_for_url(url)
    except PluginError:
        entry = None
    if entry is not None: return entry
    root, sha, upstream = sources.snapshot_github(PLUGIN_HOME, url)
    license_id = _declared_license(root)
    if license_id not in {'MIT', 'Apache-2.0'}:
        raise PluginError('This package needs a reviewed license. Direct links currently support MIT and Apache-2.0.')
    name, display = _plugin_name(root, sources.github_parts(url)[3].rsplit('/',1)[-1] or sources.github_parts(url)[1])
    return {'name':name, 'display_name':display, 'license':license_id, 'install':'allow',
            'source_kind':'link', 'source_path':str(root), 'upstream':upstream, 'sha':sha,
            'marketplace':'personal'}


def prepare_plugin(name: str) -> dict:
    entry = entry_from_url(name) if name.startswith('https://') else next((e for e in load_catalog()['plugins'] if e['name']==name), None)
    if entry is None:
        old = next((e for e in _installed() if e['name']==name), None)
        if old:
            entry = {**old, 'source_path':old.get('package_path', '')}
        else: raise PluginError('Plugin not found')
    _license_ok(entry, entry.get('license', ''))  # preview terms, never accept or install them here
    source = None if entry.get('source_kind') == 'preset' else _source(entry, fetch=True)
    if entry.get('review_license'):
        entry = _review_external_license(entry, source)
    if source and entry.get('marketplace') == 'personal' and entry.get('upstream') == 'Created locally':
        source, pin = sources.snapshot_local(PLUGIN_HOME, source)
        entry = {**entry, 'source_path': str(source), 'sha': pin}
    return _preview(entry, source)


def record_servers(record: dict) -> dict:
    if 'servers' in record: return dict(record['servers'])
    url = record.get('sign_in_url')
    return {record['name']:mcp_spec(url,record.get('bearer',''))} if url else {}


def _remove_owned_skill(folder: str, rows: list[dict], owner: str):
    if any(folder in r.get('skills', []) for r in rows if r['name'] != owner): return
    if not isinstance(folder,str) or '/' in folder or '\\' in folder or folder in {'.','..'}: raise PluginError('Invalid installed skill path')
    target = sources.contained(SKILL_ROOT, folder)
    if target.is_dir(): shutil.rmtree(target)


def uninstall(name: str, *, config, manager=None) -> dict:
    if not sources.NAME.fullmatch(name): raise PluginError('Invalid installed plugin name')
    with _registry_lock():
        rows = _installed()
        record = next((r for r in rows if r['name']==name), None)
        if record is None: raise PluginError('Plugin is not installed')
        servers = dict(config.get('mcp_servers', {}) or {})
        owned = record.get('registered_specs', record_servers(record))
        removed, retained = [], []
        for server, spec in owned.items():
            if any(server in record_servers(r) for r in rows if r['name'] != name):
                retained.append(server); continue
            if server not in servers or servers[server] == spec:
                servers.pop(server,None); removed.append(server)
            else: retained.append(server)
        for server in removed:
            if hasattr(config, 'drop_mcp_secrets'): config.drop_mcp_secrets(server)
        config.set('mcp_servers', servers)
        if manager:
            for server in removed:
                manager.disconnect(server)
                # reconnect must not retain an uninstalled command in its runtime fallback.
                getattr(manager, '_runtime_specs', {}).pop(server,None)
        owned_skills = {s['name'] for s in _skill_summaries(None,record.get('skills', []),set())}
        for folder in record.get('skills', []): _remove_owned_skill(folder,rows,name)
        config.set('disabled_skills', [n for n in config.get('disabled_skills',[]) if n not in owned_skills])
        config.set('disabled_mcp_servers', [n for n in config.get('disabled_mcp_servers',[]) if n not in removed])
        if not sources.NAME.fullmatch(name): raise PluginError('Invalid installed plugin name')
        dest = sources.contained(PLUGIN_HOME / 'packages', name)
        if dest.is_dir(): shutil.rmtree(dest)
        logo = sources.contained(LOGO_ROOT, name + '.png')
        logo.unlink(missing_ok=True)
        _save([r for r in rows if r['name'] != name])
        state = sources.read_json(STATE_PATH)
        state['removed_defaults'] = sorted(set(state.get('removed_defaults', [])) | {name})
        sources.write_json(STATE_PATH,state)
        return {'name':name, 'retained_servers':retained, 'removed_servers':removed}


@contextmanager
def _registry_lock():
    lock = named_process_lock('plugin-registry', str(PLUGIN_HOME))
    if not lock.acquire(timeout=10): raise PluginError('Another plugin operation is still running')
    try: yield
    finally: lock.release()


def _review_external_license(entry, source):
    license_id = _declared_license(source)
    if not license_id:
        for parent in (source, *source.parents):
            if (parent / '.dgc-source-complete').is_file():
                license_id = _declared_license(parent); break
            if parent == PLUGIN_HOME: break
    if license_id not in {'MIT', 'Apache-2.0'}:
        raise PluginError('This package has no reviewed MIT or Apache-2.0 license. DGC will not install it (' + (license_id or 'no license declared') + ').')
    manifest = _package_json(source, '.codex-plugin/plugin.json') or _package_json(source, '.claude-plugin/plugin.json')
    if 'github.com/openai/' in entry.get('upstream','').lower() and manifest.get('name') in {'openai-templates','plugin-management','product-design'}:
        raise PluginError('This OpenAI package is not imported. DGC uses its own templates and Plugin Management.')
    return {**entry, 'license':license_id, 'install':'allow', 'review_license':False}
