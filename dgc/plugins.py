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


def _state() -> dict:
    """The installed-plugins record, salvaged if part of it is unreadable.

    Seen in a real profile: something else wrote a sentence of text over `installed`, and every
    catalog read then crashed, leaving Plugins and Apps empty with no way back from the editor.
    Valid plugin records and removed defaults are kept; the original file is set aside as
    installed.json.invalid-<time> for inspection, and a repaired one written in its place.
    """
    if not STATE_PATH.exists():
        return {}
    try:
        data = sources.read_json(STATE_PATH)
    except (OSError, sources.SourceError):
        data = None
    rows = data.get('installed', []) if isinstance(data, dict) else None
    removed = data.get('removed_defaults', []) if isinstance(data, dict) else None
    valid = (isinstance(rows, list) and isinstance(removed, list)
             and all(isinstance(r, dict) and isinstance(r.get('name'), str) for r in rows)
             and all(isinstance(n, str) for n in removed))
    if valid:
        return data
    import sys
    import time
    salvaged = {**(data if isinstance(data, dict) else {}),
                'installed': [r for r in rows if isinstance(r, dict) and isinstance(r.get('name'), str)]
                if isinstance(rows, list) else [],
                'removed_defaults': [n for n in removed if isinstance(n, str)] if isinstance(removed, list) else []}
    aside = STATE_PATH.with_name(f'{STATE_PATH.name}.invalid-{time.strftime("%Y%m%d-%H%M%S")}')
    os.replace(STATE_PATH, aside)
    sources.write_json(STATE_PATH, salvaged)
    print(f'[plugins] {STATE_PATH} was unreadable; kept it as {aside.name} and repaired the list',
          file=sys.stderr, flush=True)
    return salvaged


def _installed() -> list[dict]:
    return _state().get('installed', [])


def _save(rows: list[dict]) -> None:
    state = _state()
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


def mcp_spec(url: str, bearer: str, *, oauth_scope: str = "") -> dict:
    args = ["-y", "mcp-remote", url]
    if oauth_scope:
        # A server that needs a scope at sign-in (Plain wants "openid offline_access", or it answers
        # 403 after a sign-in that looked fine). The bridge uses this metadata instead of its default.
        if not re.fullmatch(r"[A-Za-z0-9:._/ -]{1,200}", oauth_scope):
            raise PluginError("Invalid OAuth scope")
        args += ["--static-oauth-client-metadata",
                 json.dumps({"client_name": "DGC", "client_uri": "https://vibedgc.com", "scope": oauth_scope})]
    spec = {
        "transport": "remote",
        "command": "npx",
        "args": args,
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
    manifest = _manifest(root)
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
    for relative in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json"):
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
        # The same flat namespace, from the other side: a package whose plugin.json names itself
        # after a connected app installs over that connector's ownership row, while the connector's
        # entry in config.mcp_servers stays live with its bearer. The panel then reports the app
        # disconnected while the editor goes on re-supplying its token on every backend generation.
        if any(r['name'] == name and r.get('connector') == name for r in old_rows):
            raise PluginError('A connected app already uses this name. Disconnect it before installing this plugin.')
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


# Every plugin format a vendor may ship, in the order DGC prefers them. The same package often
# carries several (Claude, Codex, Cursor, and the open Agent Plugins standard at the root).
MANIFESTS = (".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json")
MCP_FILES = (".mcp.json", "mcp.json")


def _manifest(source: Path | None) -> dict:
    for relative in MANIFESTS:
        found = _package_json(source, relative)
        if found:
            return found
    return {}


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
    manifest = _manifest(source)
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
        "package_logo": text(interface.get("logo") or manifest.get("logo"), 256),
        "default_prompt": [text(p, 600) for p in prompts[:3] if isinstance(p, str)] if isinstance(prompts, list) else [],
    }
    app_file = manifest.get("apps") if isinstance(manifest.get("apps"), str) else ".app.json"
    apps = _package_json(source, app_file).get("apps", {})
    rows["apps"] = [{"id": text(name, 120), "name": text(value.get("displayName") or value.get("name") or (rows["display_name"] if len(apps) == 1 else name) or name, 120)}
                    for name, value in list(apps.items())[:32] if isinstance(value, dict)] if isinstance(apps, dict) else []
    mcps = next((found for found in (_package_json(source, name) for name in MCP_FILES) if found), {})
    mcps = mcps.get("mcpServers") or mcps.get("mcp_servers") or mcps
    mcps = {k: v for k, v in mcps.items() if k != "$schema"} if isinstance(mcps, dict) else {}
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
                       disabled: set | None = None, config=None) -> list[dict]:
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
            # The cloud banner is a disclosure, so the flag has to travel the list path too, not
            # only the install review's raw entry. It sits below the metadata spread with the rest
            # of DGC's compatibility decisions: a package must not be able to un-declare it.
            "cloud_execution": bool(entry.get("cloud_execution")),
            "logo_file": (have or {}).get("logo_file") or "",
            # The keys its servers take, for the field on its page: whether one is saved (never the key itself) or
            # comes from the environment DGC started with.
            "keys": _editor_keys(entry, have, config) if have else [],
            "apps": metadata.get("apps", []),
            "mcps": [{"name":name, "url":spec.get("url", ""), "command":spec.get("command", ""), "transport":spec.get("transport", "stdio")} for name,spec in record_servers(have).items()] if have else metadata.get("mcps", []),
        })
    return items


def _editor_keys(entry: dict, record: dict, config=None) -> list[dict]:
    from . import plugin_keys
    rows = []
    for server, spec in record_servers(record).items():
        if spec.get('defer_until_setup'):
            continue
        saved = set(plugin_keys.saved_names(server, spec))
        client = sign_in_client(server, spec, config, entry)
        for index, name in enumerate(plugin_keys.key_names(spec)[:8]):
            described = plugin_keys.describe(entry, name)
            rows.append({'server': server, 'env': name, 'saved': name in saved,
                         # Where it was saved: the system keychain, or the owner-only file where there is none.
                         'stored': plugin_keys.stored_where(server) if name in saved else '',
                         'from_environment': name in os.environ,
                         # Sign in with the service instead (GitHub), offered only once DGC has an app to do it with.
                         'sign_in': client['provider'] or entry.get('display_name') or 'the service' if client else '',
                         **({} if index or not client else _sign_in_permissions(entry, server, spec, described)),
                         **{k: v for k, v in described.items() if k != 'sign_in'}})
    return rows[:16]


def _sign_in_permissions(entry: dict, server: str, spec: dict, described: dict) -> dict:
    """The page's checklist "What DGC may do on GitHub": each permission, whether the next sign-in asks for it, whether
    the current sign-in has it, and whether a tool asked for it. Nothing for a sign-in without a checklist."""
    sign_in = described.get('sign_in') or {}
    choices = sign_in_choices(sign_in)
    if not choices:
        return {}
    chosen = set(chosen_sign_in_scopes(str(entry.get('name') or ''), choices))
    held = _held_choices(server, spec, sign_in, choices)
    asked = set(_asked_choices(server, spec, choices))
    return {'signed_in': held is not None,
            'sign_in_scopes': [{**c, 'chosen': c['id'] in chosen, 'held': held is not None and c['id'] in held,
                                'asked': c['id'] in asked} for c in choices]}


def _key_server(record: dict, server: str = '', env: str = '') -> tuple[str, dict, str]:
    """The installed server (and variable) a key is for: named, or the plugin's only one."""
    from . import plugin_keys
    choices = [(name, spec, variable) for name, spec in record_servers(record).items()
               for variable in plugin_keys.key_names(spec)
               if (not server or name == server) and (not env or variable == env)]
    if not choices:
        raise PluginError(f"{record.get('display_name') or record['name']} doesn't take a key.")
    if len(choices) > 1:
        raise PluginError('Choose which key to save: this plugin takes more than one.')
    return choices[0]


def save_key(config, manager, name: str, key: str, *, server: str = '', env: str = '', input_handler=None,
             cancel=None) -> dict:
    """Save one installed plugin's key in the system keychain. A server connected with the old key connects again
    with the new one; one that isn't connected waits for Connect."""
    from . import plugin_keys
    _availability_ok(name)
    record = next((r for r in _installed() if r.get('name') == name), None)
    if record is None:
        raise PluginError(f'{name} is not installed.')
    server, spec, variable = _key_server(record, server, env)
    where = plugin_keys.save(server, spec, {variable: key})
    label = plugin_keys.describe(_key_entry(server) or record, variable)['label']
    if manager is not None:
        # "Needs a key" or a refusal of the old one is no longer true of this server: the next Connect says what is.
        getattr(manager, 'failures', {}).pop(server, None)
    if manager is not None and server in getattr(manager, 'servers', {}):
        connect(config, manager, record, input_handler=input_handler, cancel=cancel)
    place = 'your system keychain' if where != 'file' else 'an owner-only file in DGC\'s folder (this computer has no keychain DGC can use)'
    return {'server': server, 'env': variable, 'where': where,
            'message': f'Saved your {label} in {place}.'}


def remove_key(config, manager, name: str, *, server: str = '', env: str = '', input_handler=None, cancel=None) -> dict:
    """Forget an installed plugin's saved key. A server connected with it is disconnected (or connects again with the
    environment's key, where DGC was started with one)."""
    from . import plugin_keys
    record = next((r for r in _installed() if r.get('name') == name), None)
    if record is None:
        raise PluginError(f'{name} is not installed.')
    server, spec, variable = _key_server(record, server, env)
    had = plugin_keys.remove(server, [variable] if env else None)
    if manager is not None:
        getattr(manager, 'failures', {}).pop(server, None)
    entry = _key_entry(server) or record
    described = plugin_keys.describe(entry, variable)
    if manager is not None and server in getattr(manager, 'servers', {}):
        if variable in os.environ:
            connect(config, manager, record, input_handler=input_handler, cancel=cancel)
        else:
            manager.disconnect(server)
            getattr(manager, '_runtime_specs', {}).pop(server, None)
    revoke = (f" To stop it working everywhere, delete it at {described['manage_url']}."
              if described.get('manage_url') else '')
    message = (f"Removed your {described['label']} from this computer.{revoke}" if had
               else f"No {described['label']} was saved here.")
    return {'server': server, 'env': variable, 'removed': had, 'message': message}


def ensure_first_party() -> None:
    # A removed default stays removed. This records a user's choice, not just presence.
    state = _state()
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


def _key_entry(server: str) -> dict:
    """The catalog entry that labels a server's key: the curated one now (an older install's record predates its
    `keys`), else the installed record that owns the server."""
    owner = next((r for r in _installed() if server in record_servers(r)), None)
    if owner is None:
        return {}
    try:
        current = next((e for e in sources.read_json(CATALOG_PATH)['plugins'] if e.get('name') == owner['name']), None)
    except (OSError, sources.SourceError, KeyError, TypeError):
        current = None
    return {**owner, **(current or {})}


def missing_keys(server: str, spec: dict, supplied=None) -> list[str]:
    """The variables this server still lacks: not given to it, not saved on its page, not in the environment."""
    from . import plugin_keys
    supplied = supplied if isinstance(supplied, dict) else (spec.get('env') or {})
    saved = set(plugin_keys.saved_names(server, spec))
    return [key for key in spec.get('env_names', []) if isinstance(key, str)
            and key not in supplied and key not in saved and key not in os.environ]


def missing_key_message(server: str, missing: list[str]) -> str:
    from . import plugin_keys
    entry = _key_entry(server)
    if not entry:
        # A server you added yourself, not a plugin's: its key belongs in its own form.
        return (f"Needs {missing[0] if missing else 'its key'}. Set it in the environment DGC starts with, or save a "
                f"token for this server in Settings → MCP servers.")
    return plugin_keys.missing_message(entry, missing[0] if missing else '', entry.get('display_name') or server)


def refused_key_message(server: str, spec: dict, error: str) -> str:
    """A server that turned its key away (HTTP 401), said plainly with what to check; else the error unchanged."""
    from . import plugin_keys
    if '(HTTP 401)' not in str(error) or not plugin_keys.key_names(spec):
        return error
    entry = _key_entry(server)
    label = plugin_keys.describe(entry, plugin_keys.key_names(spec)[0])['label']
    plugin = entry.get('display_name') or server
    if label.lower().startswith(plugin.lower() + ' '):
        label = label[len(plugin) + 1:]                  # "GitHub didn't accept this personal access token"
    return (f"{plugin} didn't accept this {label} (HTTP 401). Check that you copied all of it and that it hasn't "
            f"expired or been revoked, or create a new one, save it here, and connect again.")


def connect(config, manager, record: dict, *, input_handler, cancel=None) -> None:
    _availability_ok(record['name'])
    specs = register_mcp(config, record)
    # Setup-only presets must never cause a pretend sign-in or be auto-launched.
    active = {n:s for n,s in specs.items() if not s.get('defer_until_setup')}
    if not active: return
    runtime = config.mcp_runtime_servers(active) if hasattr(config, 'mcp_runtime_servers') else active
    available = {}
    from . import plugin_keys
    from .mcp import _has_device_sign_in
    for name, spec in runtime.items():
        # A key saved on the plugin's page fills its variable (MCPManager.connect_all reads it from the keychain);
        # the environment DGC started with is the fallback for anyone who already sets it.
        missing = missing_keys(name, spec)
        only_bearer = bool(missing) and spec.get('transport') == 'remote' and set(missing) <= set(plugin_keys.key_names(spec))
        client = sign_in_client(name, spec, config) if only_bearer else None
        if client:
            # No key: sign in with the service instead (GitHub's device flow, with DGC's registered app).
            available[name] = _signing_in(spec, client)
        elif only_bearer and _has_device_sign_in(name, spec):
            available[name] = spec                      # signed in before; connect_all sends that sign-in
        elif missing:
            manager.failures[name] = missing_key_message(name, missing)
        else: available[name] = spec
    if available: manager.connect_all(available, input_handler=input_handler, cancel=cancel)


def sign_in_client(server: str, spec: dict, config=None, entry: dict | None = None) -> dict | None:
    """The app a plugin signs in with instead of a key, when DGC has one: GitHub's device flow needs only a public
    client id, from the setting the catalog names (``github_sign_in_client_id``) or shipped in the catalog itself.
    None until one is set: DGC ships no client secret, and registers nothing at the vendor by itself."""
    from . import plugin_keys
    names = plugin_keys.key_names(spec)
    if not names or spec.get('transport') != 'remote':
        return None
    found = plugin_keys.describe(entry if entry and entry.get('keys') else _key_entry(server), names[0]).get('sign_in') or {}
    if found.get('kind') != 'device':
        return None
    client_id, setting = '', found.get('client_id_setting')
    if config is not None and isinstance(setting, str) and re.fullmatch(r'[a-z0-9_]{1,64}', setting):
        try:
            client_id = str(config.get(setting, '') or '').strip()
        except Exception:  # noqa: BLE001 -- a config that can't answer has no client id
            client_id = ''
    client_id = client_id or str(found.get('client_id') or '').strip()
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', client_id):
        return None
    owner = entry if entry and entry.get('name') else _key_entry(server)
    return {'client_id': client_id, 'grant': 'device', 'provider': str(found.get('provider') or '')[:40],
            **_chosen_sign_in(str(owner.get('name') or ''), found)}


def _signing_in(spec: dict, client: dict) -> dict:
    """This connection signs in with the service (DGC's own client runs the device flow) instead of sending a key.
    With a permission checklist (GitHub's), the sign-in asks for exactly what the user chose, and a tool that needs
    more is told which permission to add on the plugin's page instead of widening the sign-in by itself."""
    launch = {k: v for k, v in spec.items() if k != 'auth_env'}
    info = {'client_id': client['client_id'], 'grant': 'device'}
    if client.get('scope'):
        info.update({'scope': client['scope'], 'scope_choice': True, 'provider': client.get('provider') or '',
                     'scope_labels': client.get('scope_labels') or {}})
    launch['args'] = [*spec.get('args', []), '--static-oauth-client-info', json.dumps(info, separators=(',', ':'))]
    return launch


# What a sign-in may do: the permissions a plugin's sign-in offers (the catalog's sign_in.scopes, GitHub's checklist
# "What DGC may do on GitHub"). The always-on ones are what its tools need to work at all; the optional ones are off
# until the user turns them on, and the choice is kept per plugin in installed.json beside its permission level.
_CHOICE_ID = re.compile(r'[a-z][a-z0-9_]{0,31}')
_SCOPE_LIST = re.compile(r'[A-Za-z0-9:._-]{1,60}( [A-Za-z0-9:._-]{1,60}){0,7}')


def sign_in_choices(sign_in: dict) -> list[dict]:
    """The permissions a sign-in offers, in the catalog's order: {id, label, short, description, scope, always}."""
    rows, seen = [], set()
    for item in (sign_in.get('scopes') if isinstance(sign_in, dict) and isinstance(sign_in.get('scopes'), list) else [])[:16]:
        if not isinstance(item, dict):
            continue
        ident, scope = str(item.get('id') or ''), str(item.get('scope') or '')
        if not _CHOICE_ID.fullmatch(ident) or not _SCOPE_LIST.fullmatch(scope) or ident in seen:
            continue
        seen.add(ident)
        label = str(item.get('label') or ident)[:80]
        rows.append({'id': ident, 'label': label, 'short': str(item.get('short') or label)[:80],
                     'description': str(item.get('description') or '')[:200], 'scope': scope,
                     'always': item.get('always') is True})
    return rows


def chosen_sign_in_scopes(name: str, choices: list[dict]) -> list[str]:
    """The ids the next sign-in asks for: the always-on ones and the optional ones the user turned on (none by
    default)."""
    saved = _state().get('sign_in_scopes')
    picked = saved.get(name) if isinstance(saved, dict) else None
    picked = {p for p in picked if isinstance(p, str)} if isinstance(picked, list) else set()
    return [c['id'] for c in choices if c['always'] or c['id'] in picked]


def _scope_text(choices: list[dict], ids) -> str:
    wanted = set(ids)
    return ' '.join(dict.fromkeys(s for c in choices if c['id'] in wanted for s in c['scope'].split()))


def _chosen_sign_in(name: str, sign_in: dict) -> dict:
    """The scope a sign-in asks for, and the plain name of each scope (for a tool that needs one not chosen)."""
    choices = sign_in_choices(sign_in)
    if not choices:
        return {}
    labels = {scope: c['label'] for c in choices for scope in c['scope'].split()}
    return {'scope': _scope_text(choices, chosen_sign_in_scopes(name, choices)), 'scope_labels': labels}


def _sign_in_entry(name: str) -> tuple[dict, str, dict, list[dict]]:
    """An installed plugin's sign-in that offers permissions: (record, server, its sign_in, the choices)."""
    from . import plugin_keys
    record = next((r for r in _installed() if r.get('name') == name), None)
    if record is None:
        raise PluginError(f'{name} is not installed. Run: dgc plugin install {name}')
    for server, spec in record_servers(record).items():
        names = plugin_keys.key_names(spec)
        if names and spec.get('transport') == 'remote':
            sign_in = plugin_keys.describe(_key_entry(server) or record, names[0]).get('sign_in') or {}
            choices = sign_in_choices(sign_in)
            if choices:
                return record, server, sign_in, choices
    raise PluginError(f"{record.get('display_name') or name} has no sign-in permissions to choose.")


def set_sign_in_scopes(name: str, ids) -> dict:
    """Save which optional permissions a plugin's next sign-in asks for. Takes effect at the next sign-in: the service
    asks the user to approve a change, so a sign-in already made keeps what it has until they sign in again."""
    if not isinstance(name, str) or not sources.NAME.fullmatch(name):
        raise PluginError('Name an installed plugin.')
    if not isinstance(ids, (list, tuple)) or any(not isinstance(i, str) for i in ids) or len(ids) > 16:
        raise PluginError('Choose the permissions by name.')
    with _registry_lock():
        record, server, sign_in, choices = _sign_in_entry(name)
        known = {c['id']: c for c in choices}
        unknown = [i for i in ids if i not in known]
        if unknown:
            offered = ', '.join(c['id'] for c in choices if not c['always'])
            raise PluginError(f"{record.get('display_name') or name} has no permission called {unknown[0]!r}. "
                              f"Choose from: {offered}.")
        state = _state()
        saved = state.get('sign_in_scopes') if isinstance(state.get('sign_in_scopes'), dict) else {}
        state['sign_in_scopes'] = {**saved, name: [c['id'] for c in choices if not c['always'] and c['id'] in ids]}
        sources.write_json(STATE_PATH, state)
    chosen = chosen_sign_in_scopes(name, choices)
    provider = str(sign_in.get('provider') or record.get('display_name') or name)
    held = _held_choices(server, record_servers(record)[server], sign_in, choices)
    message = f"Saved. Signing in asks {provider} for: {_shorts(choices, chosen)}."
    if held is not None and set(held) != set(chosen):
        message += (f" Your sign-in keeps what it has until you sign in again: {provider} asks you to approve a "
                    "change.")
    return {'chosen': chosen, 'held': held, 'provider': provider, 'message': message}


def _choice_changed(name: str) -> bool:
    """Signed in, with a choice saved since that differs from what the sign-in has."""
    try:
        record, server, sign_in, choices = _sign_in_entry(name)
    except PluginError:
        return False
    held = _held_choices(server, record_servers(record)[server], sign_in, choices)
    return held is not None and set(held) != set(chosen_sign_in_scopes(name, choices))


def _choice_ids(choices: list[dict], text: str) -> list[str]:
    """`--scopes notifications,gist`: each by its id or by a GitHub scope it stands for; "none" for none."""
    picked = []
    for word in [w for w in re.split(r'[\s,]+', str(text or '').strip()) if w]:
        if word.lower() == 'none':
            continue
        found = next((c for c in choices if c['id'] == word.lower().replace('-', '_')), None) \
            or next((c for c in choices if word in c['scope'].split()), None)
        if found is None:
            offered = ', '.join(c['id'] for c in choices if not c['always'])
            raise PluginError(f"There's no permission called {word!r}. Choose from: {offered} (or none).")
        if not found['always'] and found['id'] not in picked:
            picked.append(found['id'])
    return picked


def describe_sign_in(name: str) -> list[str]:
    """`dgc plugin show NAME`: what the plugin is, and for a sign-in with permissions, what it has and asks for."""
    record = next((r for r in _installed() if r.get('name') == name), None)
    if record is None:
        raise PluginError(f'{name} is not installed. Run: dgc plugin install {name}')
    lines = [f"{record.get('display_name') or name} ({name})  license={record.get('license') or 'none'}  "
             f"skills={len(record.get('skills') or [])}  servers={', '.join(record_servers(record)) or 'none'}"]
    try:
        _record, server, sign_in, choices = _sign_in_entry(name)
    except PluginError:
        return lines
    spec = record_servers(record)[server]
    provider = str(sign_in.get('provider') or record.get('display_name') or name)
    chosen = chosen_sign_in_scopes(name, choices)
    held = _held_choices(server, spec, sign_in, choices)
    if missing_keys(server, spec) == []:
        lines.append(f"Connects with the key saved on its page (or in the environment), not a {provider} sign-in.")
    elif held is None:
        lines.append(f"Not signed in with {provider}. Sign in: dgc plugin sign-in {name}")
    else:
        lines.append(f"Signed in with: {_shorts(choices, held)}.")
    lines.append(f"What DGC may do on {provider}:")
    for c in choices:
        mark = 'x' if c['id'] in chosen else ' '
        lines.append(f"  [{mark}] {c['label']} ({c['scope']}){'  always on' if c['always'] else ''}"
                     f"{'  (a tool asked for this)' if c['id'] in _asked_choices(server, spec, choices) else ''}")
    if held is not None and set(held) != set(chosen):
        lines.append(f"The next sign-in asks for what's ticked; {provider} asks you to approve the change. "
                     f"Sign in again: dgc plugin sign-in {name} --scopes "
                     + (','.join(c['id'] for c in choices if c['id'] in chosen and not c['always']) or 'none'))
    else:
        lines.append(f"Change it: dgc plugin sign-in {name} --scopes A,B  (from "
                     + ', '.join(c['id'] for c in choices if not c['always']) + "; or none)")
    return lines


def _shorts(choices: list[dict], ids) -> str:
    wanted = set(ids)
    return ', '.join(c['short'] for c in choices if c['id'] in wanted) or 'nothing'


def _saved_sign_in(server: str, spec: dict) -> dict:
    """This server's device sign-in as mcp_remote kept it, or {} (none, unreadable, or another address's)."""
    from . import plugin_credentials
    try:
        saved = plugin_credentials.load(server) or {}
    except Exception:  # noqa: BLE001 -- an unreadable keychain has no sign-in to show
        return {}
    tokens = saved.get('tokens') if isinstance(saved.get('tokens'), dict) else {}
    client = saved.get('client') if isinstance(saved.get('client'), dict) else {}
    if saved.get('url') != spec.get('url') or client.get('grant') != 'device' or not tokens.get('access_token'):
        return {}
    return saved


def _held_choices(server: str, spec: dict, sign_in: dict, choices: list[dict]) -> list[str] | None:
    """The permissions the current sign-in has (None when there is none): every scope of a choice granted, or implied
    by one granted. GitHub lists the scopes it granted, normalised (project stands for read:project too)."""
    saved = _saved_sign_in(server, spec)
    if not saved:
        return None
    granted = {s for s in re.split(r'[\s,]+', str(saved['tokens'].get('scope') or '')) if s}
    implies = sign_in.get('implies') if isinstance(sign_in.get('implies'), dict) else {}
    for scope in list(granted):
        granted |= set(str(implies.get(scope) or '').split())
    return [c['id'] for c in choices if set(c['scope'].split()) <= granted]


def _asked_choices(server: str, spec: dict, choices: list[dict]) -> list[str]:
    """The permissions a tool asked for since the last sign-in (mcp_remote keeps the scope it was refused for)."""
    asked = set(str(_saved_sign_in(server, spec).get('step_up_scope') or '').split())
    return [c['id'] for c in choices if asked & set(c['scope'].split())]


def signed_in_launch(server: str, spec: dict) -> dict:
    """A server signed in before (no key; Sign in with GitHub), launched without its key header and with the permissions
    chosen on its page, so a sign-in it has to make again asks for exactly those."""
    from . import plugin_keys
    names = plugin_keys.key_names(spec)
    saved = _saved_sign_in(server, spec)
    entry = _key_entry(server)
    plain = {k: v for k, v in spec.items() if k != 'auth_env'}
    if not names or not saved or not entry:
        return plain
    sign_in = plugin_keys.describe(entry, names[0]).get('sign_in') or {}
    chosen = _chosen_sign_in(str(entry.get('name') or ''), sign_in)
    if not chosen or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', str(saved['client'].get('client_id') or '')):
        return plain
    return _signing_in(spec, {'client_id': saved['client']['client_id'], 'grant': 'device',
                              'provider': str(sign_in.get('provider') or '')[:40], **chosen})


def sign_in_again(config, manager, name: str, *, input_handler, cancel=None) -> dict:
    """Sign in again with the permissions chosen now: the current sign-in is set aside, then the device flow runs. If
    the new sign-in doesn't finish, the old one is put back, so a cancelled sign-in never leaves the plugin signed
    out. GitHub can't revoke an app's token without the app's secret, which DGC doesn't ship: the old token is
    deleted from this computer, and stays listed at github.com/settings/applications until the user revokes it."""
    from . import plugin_credentials
    record, server, _sign_in, _choices = _sign_in_entry(name)
    if missing_keys(server, record_servers(record)[server]) == []:
        raise PluginError(f"{record.get('display_name') or name} connects with the key saved on its page, not a "
                          "sign-in. Remove the key to sign in instead.")
    try:
        old = plugin_credentials.load(server)
    except plugin_credentials.CredentialError as exc:
        raise PluginError(f"DGC couldn't read the current sign-in: {exc}") from None
    if manager is not None and hasattr(manager, 'disconnect'):
        manager.disconnect(server)
    if old is not None:
        plugin_credentials.delete(server)
    failure = ''
    try:
        connect(config, manager, record, input_handler=input_handler, cancel=cancel)
    finally:
        try:
            fresh = plugin_credentials.load(server)
        except plugin_credentials.CredentialError:
            fresh = None
        if fresh is None and old is not None:
            failure = str(getattr(manager, 'failures', {}).get(server) or '')
            plugin_credentials.save(server, old)
            if manager is not None:
                connect(config, manager, record, input_handler=None)
    return {'server': server, 'signed_in': fresh is not None, 'kept': fresh is None and old is not None,
            'failure': failure}


_USAGE = ("dgc plugin list|search [TEXT]|install NAME [--accept-license ID]|sign-in NAME [--scopes A,B|none]|show NAME|"
          "key NAME [--remove]|uninstall NAME|marketplace list|add SOURCE|remove NAME|refresh NAME|installed")


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
        print("usage: " + _USAGE)
        return 0
    if action == "key" and len(argv) >= 2:
        # A plugin's key, kept in the system keychain like a sign-in: typed at a hidden prompt (or piped in), never
        # an argument other users of this computer could read from the process list.
        name, rest = argv[1], argv[2:]
        server = rest[rest.index("--server") + 1] if "--server" in rest and rest.index("--server") + 1 < len(rest) else ""
        if "--remove" in rest:
            print(remove_key(config, manager, name, server=server)["message"])
            return 0
        record = next((r for r in _installed() if r.get("name") == name), None)
        if record is None:
            raise PluginError(f"{name} is not installed. Run: dgc plugin install {name}")
        from . import plugin_keys
        target, _spec, variable = _key_server(record, server)
        described = plugin_keys.describe(_key_entry(target) or record, variable)
        import sys
        if sys.stdin.isatty():
            if described.get("create_url"):
                print(f"Create one at {described['create_url']}")
            if described.get("permissions"):
                print(described["permissions"])
            from getpass import getpass
            value = getpass(f"{described['label']} › ")
        else:
            value = sys.stdin.readline()
        print(save_key(config, None, name, value, server=target)["message"])
        if record.get("sign_in_url") and manager is not None and ui is not None:
            connect(config, manager, record, input_handler=cli_mcp_input(ui))
            names = set(record_servers(record))
            if names <= set(manager.servers):
                print(f"{record.get('display_name') or name} is connected. Its tools are ready.")
            else:
                raise PluginError("Saved, but not connected: " + "; ".join(
                    str(manager.failures.get(n, "not connected")) for n in names - set(manager.servers)))
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
    if action == "show" and len(argv) == 2:
        for line in describe_sign_in(argv[1]):
            print(line)
        return 0
    if action in ("install", "sign-in") and len(argv) >= 2:
        name = argv[1]
        entry = next((row for row in load_catalog()["plugins"] if row["name"] == name), None)
        if entry is None:
            raise PluginError(f"unknown plugin {name}")
        accept = ""
        if "--accept-license" in argv:
            accept = argv[argv.index("--accept-license") + 1]
        again = False
        if action == "install":
            record = install(entry, accept_license=accept)
            print(f"installed {record['name']}  skills={len(record['skills'])}")
        else:
            record = next((row for row in _installed() if row.get("name") == name), None)
            if record is None:
                raise PluginError(f"{name} is not installed")
            if "--scopes" in argv:
                at = argv.index("--scopes") + 1
                if at >= len(argv):
                    raise PluginError("usage: dgc plugin sign-in NAME --scopes A,B (or none)")
                _record, server, _found, choices = _sign_in_entry(name)
                result = set_sign_in_scopes(name, _choice_ids(choices, argv[at]))
                # A sign-in already made keeps what it has: a different choice is a new sign-in.
                again = result["held"] is not None and set(result["held"]) != set(result["chosen"])
                print(f"Saved. DGC asks {result['provider']} for: {_shorts(choices, result['chosen'])}."
                      + (f" {result['provider']} asks you to approve the change, so DGC signs in again."
                         if again else ""))
            else:
                again = _choice_changed(name)        # chosen on the page since the last sign-in
        if record.get("sign_in_url") and manager is not None and ui is not None:
            if again:
                sign_in_again(config, manager, name, input_handler=cli_mcp_input(ui))
            else:
                connect(config, manager, record, input_handler=cli_mcp_input(ui))
            names = set(record_servers(record))
            waiting = [n for n, spec in record_servers(record).items()
                       if n not in manager.servers and missing_keys(n, spec)
                       and manager.failures.get(n) == missing_key_message(n, missing_keys(n, spec))]
            if names <= set(manager.servers): print(f"{record['name']} is connected. Its tools are ready.")
            elif record.get('setup_required'): print(record.get('setup_instructions', 'MCP setup is required.'))
            elif waiting and set(waiting) == names - set(manager.servers):
                # Installed, and waiting for its key: that is the next step, not a failure.
                print(f"Installed {record.get('display_name') or record['name']}. " + manager.failures[waiting[0]])
            else: raise PluginError('Plugin installed but not connected: ' + '; '.join(str(manager.failures.get(n, 'not connected')) for n in names - set(manager.servers)))
        else:
            print("Reload DGC so the new skills are available.")
        return 0
    raise PluginError("usage: " + _USAGE)


def _skill_files(source: Path) -> list[Path]:
    manifest = _manifest(source)
    declared = manifest.get('skills', 'skills')
    if not manifest and not (source / 'skills').is_dir() and any(source.glob('*/SKILL.md')):
        # A package pinned at its skills folder (the rest of the repository has symlinks or a
        # 23 MB logo that DGC will not fetch): the folder itself holds the skills.
        declared = '.'
    paths = declared if isinstance(declared, list) else [declared]
    result = []
    for relative in paths:
        folder = sources.contained(source, relative)
        if folder.is_file() and folder.name == 'SKILL.md': found = [folder]
        elif folder.is_dir(): found = sorted(folder.rglob('SKILL.md'))
        else: found = []
        # A manifest may name a folder and, again, folders inside it (Adobe's App Builder lists
        # ./skills/ and three of its subfolders): one file is one skill, however often it is named.
        result.extend(f for f in found if f not in result)
    if len(result) > 40: raise PluginError('A plugin can contain at most 40 skills')
    names = [_frontmatter_field(file, 'name') or file.parent.name for file in result]
    if len(names) != len(set(names)): raise PluginError('Plugin contains duplicate skill names')
    if len({file.parent.name for file in result}) != len(result): raise PluginError('Plugin contains duplicate skill folder names')
    for file in result:
        sources.contained(source, str(file.relative_to(source)))
        if file.stat().st_size > 65536: raise PluginError('A skill exceeds DGC\'s 64 KiB limit')
    return result


def _read_server_specs(source: Path | None, entry: dict) -> dict:
    if source is None or isinstance(entry.get('mcp_presets'), dict):
        # A curated entry can set the package's servers: a vendor's file may name a per-account
        # placeholder, a pasted key where sign-in works, or no server at all.
        declared = entry.get('mcp_presets', {})
    else:
        manifest = _manifest(source)
        declared = manifest.get('mcpServers')
        if declared is None:
            declared = next((name for name in MCP_FILES if sources.contained(source, name).is_file()), '.mcp.json')
        if isinstance(declared, str):
            path = sources.contained(source, declared)
            declared = sources.read_json(path, 65536) if path.is_file() else {}
        elif not isinstance(declared, dict):
            raise PluginError('Unsupported MCP declaration format')
        if not isinstance(declared, dict): raise PluginError('MCP declarations must be an object')
        declared = declared.get('mcpServers', declared.get('mcp_servers', declared))
    if isinstance(declared, dict):
        declared = {k: v for k, v in declared.items() if k != '$schema'}
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
            if raw.get('type') not in (None, 'http', 'streamable-http', 'streamableHttp'):
                raise PluginError('Unsupported MCP transport ' + str(raw.get('type')))
            bearer = raw.get('bearer_token_env_var') or raw.get('auth_env') or ''
            headers = raw.get('headers', {})
            if headers:
                auth = headers.get('Authorization') if isinstance(headers,dict) else None
                match = re.fullmatch(r'Bearer \$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}', str(auth or ''))
                # An optional key (`${NAME:-}`, empty when unset): the server works without one, as
                # Context7's does; DGC connects anonymously and never sends an empty credential.
                optional = re.fullmatch(r'(?:Bearer )?\$\{[A-Za-z_][A-Za-z0-9_]{0,127}:-\}', str(auth or ''))
                if len(headers) != 1 or not (match or optional):
                    raise PluginError('Inline MCP headers are not imported. Use an environment reference for a bearer token.')
                bearer = match.group(1) if match else ''
            # DGC's catalog may pin a server's plain address: a vendor URL that names another client
            # (?client=claude-code-plugin) would present DGC as that client.
            url = (entry.get('mcp_urls') or {}).get(name) or raw['url']
            spec = mcp_spec(url, bearer, oauth_scope=raw.get('oauth_scope', ''))
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
        manifest = _manifest(source)
        for kind in ('hooks', 'agents', 'commands', 'rules', 'lspServers', 'outputStyles'):
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
        state = _state()
        state['removed_defaults'] = sorted(set(state.get('removed_defaults', [])) | {name})
        sources.write_json(STATE_PATH,state)
    from . import plugin_keys, plugin_signin
    signed_out = [message for message in (plugin_signin.forget(server)['message'] for server in removed) if message]
    # A key saved on its page goes with it (a server another plugin or the user still keeps keeps its key). Only the
    # vendor can revoke the key itself.
    keyed = (set(record_servers(record)) | set(owned) | set(removed)) - set(retained)
    if any([plugin_keys.remove(server) for server in sorted(keyed)]):
        signed_out.append('Its saved key was deleted from this computer; revoke the key itself in your account '
                          'at the service if you no longer use it.')
    return {'name':name, 'retained_servers':retained, 'removed_servers':removed, 'signed_out':signed_out}


# What a plugin may do without asking, ChatGPT's four levels (OpenAI, "Managing app permissions in ChatGPT"):
# always_ask asks even before it reads; any_changes reads at once and asks before any change; important (the
# default) reads at once and asks before an important action (sending, creating, editing, deleting, sharing,
# paying); never_ask asks nothing, and is never offered for a plugin that can move money. Turning a plugin on
# in Settings is the consent to use it at all (founder, 2026-10-09): no "use this plugin?" card anywhere.
PERMISSIONS = ('always_ask', 'any_changes', 'important', 'never_ask')
DEFAULT_PERMISSION = 'important'


def permission(name: str) -> str:
    levels = _state().get('permissions')
    level = levels.get(name) if isinstance(levels, dict) else None
    return level if level in PERMISSIONS else DEFAULT_PERMISSION


def set_permission(name: str, level: str, *, money: bool) -> str:
    """Save one plugin's level. A payment plugin can never be set to never_ask."""
    if not isinstance(name, str) or not sources.NAME.fullmatch(name):
        raise PluginError('Name an installed plugin.')
    if level not in PERMISSIONS:
        raise PluginError('Choose always_ask, any_changes, important or never_ask.')
    if level == 'never_ask' and money:
        raise PluginError('This plugin can move money, so it always asks before it does anything that changes something.')
    with _registry_lock():
        if not any(r.get('name') == name for r in _installed()):
            raise PluginError(f'{name} is not installed.')
        state = _state()
        levels = state.get('permissions') if isinstance(state.get('permissions'), dict) else {}
        state['permissions'] = {**{k: v for k, v in levels.items() if v in PERMISSIONS}, name: level}
        sources.write_json(STATE_PATH, state)
    return level


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
    manifest = _manifest(source)
    if 'github.com/openai/' in entry.get('upstream','').lower() and manifest.get('name') in {'openai-templates','plugin-management','product-design'}:
        raise PluginError('This OpenAI package is not imported. DGC uses its own templates and Plugin Management.')
    return {**entry, 'license':license_id, 'install':'allow', 'review_license':False}
