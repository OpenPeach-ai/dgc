"""Validated user-owned connectors, using the existing MCP and plugin stores."""
from __future__ import annotations
import json
from pathlib import Path
from urllib.parse import urlsplit
from .mcp_config import validate_mcp_spec

CATALOG = json.loads(Path(__file__).with_name('connector_catalog.json').read_text())


def validate(name, spec):
    from .plugins import PluginError
    definition = CATALOG.get(name)
    if definition is None:
        raise PluginError('Unknown app connector')
    clean, error = validate_mcp_spec(spec, persisted=True)
    if error or clean is None:
        raise PluginError(error or 'Invalid connector configuration')
    url = clean.get('url', '')
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise PluginError('Invalid connector URL') from None
    if (clean.get('transport') != 'remote' or clean.get('command') != 'npx'
            or clean.get('args') != ['-y', 'mcp-remote', url]
            or not parsed.hostname or parsed.query or parsed.fragment or parsed.username or parsed.password
            or any(ord(c) <= 32 or ord(c) == 127 for c in url) or '\\' in url):
        raise PluginError('Use a connector server URL without credentials or query parameters')
    loopback = parsed.hostname in ('localhost', '127.0.0.1', '::1')
    if parsed.scheme != 'https' and not (name == 'n8n' and parsed.scheme == 'http' and loopback):
        raise PluginError('Use HTTPS, or loopback HTTP for a local n8n instance')
    if definition['url'] and url.rstrip('/') != definition['url'].rstrip('/'):
        raise PluginError('The connector URL must match its published endpoint')
    if name == 'arcade' and (parsed.hostname != 'api.arcade.dev' or port not in (None,443)
                             or not parsed.path.startswith('/mcp/') or not parsed.path[5:].strip('/')):
        raise PluginError('Paste an Arcade Cloud gateway URL from api.arcade.dev/mcp/')
    if name == 'n8n' and not parsed.path.rstrip('/').endswith('/mcp-server/http'):
        raise PluginError('Paste the n8n instance MCP URL ending in /mcp-server/http')
    auth = 'token' if clean.get('auth_env') else 'oauth'
    if auth not in definition['auth']:
        raise PluginError('This connector requires ' + ('a connection token' if name == 'zapier' else 'browser sign-in'))
    expected_env = ['DGC_MCP_BEARER_TOKEN'] if auth == 'token' else []
    if clean.get('env_names', []) != expected_env or (auth == 'token' and clean['auth_env'] != expected_env[0]):
        raise PluginError('Connector credentials must use the existing MCP secret store')
    if bool(clean.get('defer_until_setup')) != (auth == 'token'):
        raise PluginError('Token connectors must wait for their secret before starting')
    return clean


def save(config, name, spec, accept_license=''):
    """Save ownership and public config together; never persist a bearer token here."""
    from . import plugins
    clean = validate(name, spec)
    entry = next((r for r in plugins.load_catalog()['plugins'] if r['name'] == name and r.get('connector') == name), None)
    if not entry:
        raise plugins.PluginError('Connector is not offered')
    with plugins._registry_lock():
        rows = plugins._installed()
        previous = next((r for r in rows if r['name'] == name), None)
        plugins._license_ok(entry, accept_license or (previous or {}).get('accepted_license', ''))
        before = dict(config.get('mcp_servers', {}) or {})
        if name in before and (not previous or previous.get('connector') != name):
            raise plugins.PluginError('A manually configured server already uses this name. Rename it before connecting this service.')
        if any(name in plugins.record_servers(r) for r in rows if r['name'] != name):
            raise plugins.PluginError('Another plugin already owns this connection')
        record = {**entry, 'skills': [], 'servers': {name: clean}, 'server_names': [name],
                  'registered_specs': {name: clean}, 'sign_in_url': clean['url'],
                  'accepted_license': entry['license'], 'setup_required': False}
        config.set('mcp_servers', {**before, name: clean})
        try:
            plugins._save([r for r in rows if r['name'] != name] + [record])
        except Exception:
            config.set('mcp_servers', before)
            raise
        return record


def forget(config, name):
    """Remove just a connector's ownership record during MCP removal/compensation."""
    from . import plugins
    if name not in CATALOG:
        return
    with plugins._registry_lock():
        rows = plugins._installed()
        if any(r['name'] == name and r.get('connector') == name for r in rows):
            before = dict(config.get('mcp_servers', {}) or {})
            config.set('mcp_servers', {k: v for k, v in before.items() if k != name})
            try:
                plugins._save([r for r in rows if r['name'] != name])
            except Exception:
                config.set('mcp_servers', before)
                raise
