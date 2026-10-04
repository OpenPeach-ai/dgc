"""Human-reviewed exact calls on saved Zapier, Arcade, Make and n8n connectors.

A tool schema is a contract fingerprint, not proof of read-only behavior. These
calls never become unattended read grants. Accounts and workflow implementations
remain provider-managed and can change without changing an MCP tool schema.
"""
from __future__ import annotations

import json
import re
import time
from contextlib import contextmanager

from . import pip_app_access as apps
from .workspace_registry import RegistryError

NAME = re.compile(r'[A-Za-z0-9_.:/-]{1,160}')
PROVIDERS = {'zapier': 'Zapier', 'arcade': 'Arcade', 'make': 'Make', 'n8n': 'n8n'}
MEANING = 'The connector returned a response. This does not confirm downstream completion.'
NOTICE = ('Approve one exact tool call. Accounts, defaults and workflow contents are managed by the connector; '
          'check them there before approving. A workflow can keep running after DGC times out. '
          'DGC will not retry this attempt automatically.')


def supported(name, spec):
    if name not in PROVIDERS or not isinstance(spec, dict):
        return False
    from .connectors import validate
    from .plugins import PluginError
    try:
        validate(name, spec)
        return True
    except (PluginError, ValueError, TypeError):
        return False


def arguments(call):
    apps.bounded(call, 10000)
    if (not isinstance(call, dict) or set(call) != {'tool', 'arguments'}
            or not isinstance(call['tool'], str) or not NAME.fullmatch(call['tool'])
            or not isinstance(call['arguments'], dict)):
        raise RegistryError('invalid_connector_call', 'Choose one exact tool and its JSON input object.')
    return json.loads(json.dumps(call['arguments'], ensure_ascii=False))


def _manager(config, name, cancel):
    from .mcp import MCPManager
    spec, _ = apps.connection(config, name)
    if not supported(name, spec):
        raise RegistryError('unsupported_connector', 'Choose a saved Zapier, Arcade, Make or n8n connector from Settings.')
    manager = MCPManager(config.project_root)
    try:
        manager.connect_all(config.mcp_runtime_servers({name: spec}), cancel=cancel,
                            input_handler=lambda *a, **kw: {'action': 'cancel'})
        if name not in manager.servers:
            raise RegistryError('connection_unavailable', 'Finish connecting this service in Settings first.')
        return manager
    except BaseException:
        manager.stop_all()
        raise


def catalog(manager, name):
    # Use the original descriptors: the model-facing catalog shortens descriptions
    # and includes synthetic resource operations which are not connector actions.
    server = manager.servers.get(name)
    rows = getattr(server, 'tools', None)
    if not isinstance(rows, list) or len(rows) > 100:
        raise RegistryError('connector_tool_limit', 'Expose at most 100 tools in this connector before reviewing Pip actions.')
    apps.bounded(rows, 131072)
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise RegistryError('connector_schema_changed', 'The connector returned a malformed tool descriptor.')
        tool = row.get('name')
        if not isinstance(tool, str) or not NAME.fullmatch(tool) or tool in result:
            raise RegistryError('connector_schema_changed', 'The connector returned an invalid or duplicate tool name.')
        schema = row.get('inputSchema')
        if not isinstance(schema, dict) or schema.get('type') != 'object':
            raise RegistryError('connector_schema_changed', 'This connector tool must declare an object input schema.')
        apps.bounded(row, 20000)
        description = row.get('description', '')
        if not isinstance(description, str) or len(description.encode()) > 8000:
            raise RegistryError('connector_schema_changed', 'The connector tool description is invalid or too large.')
        routes = [exposed for exposed, route in manager._routes.items()
                  if route == (name, tool) and exposed not in getattr(manager, '_context_routes', {})]
        if len(routes) != 1:
            raise RegistryError('connector_schema_changed', 'This connector tool has no unique direct route.')
        result[tool] = {'tool': tool, 'schema_digest': apps.digest(row),
                        'description': description, 'input_schema': schema, '_route': routes[0]}
    return result


def inspect(config, name, *, manager_factory=_manager, clock=time.monotonic, deadline=None):
    spec, fingerprint = apps.connection(config, name)
    if not supported(name, spec):
        raise RegistryError('unsupported_connector', 'Choose a saved Zapier, Arcade, Make or n8n connector from Settings.')
    cancel = apps.DeadlineCancellation(min(clock() + 30, deadline) if deadline is not None else clock() + 30, clock=clock)
    manager = manager_factory(config, name, cancel)
    try:
        rows = catalog(manager, name)
        if cancel.is_set() or apps.connection(config, name)[1] != fingerprint:
            raise RegistryError('connection_changed', 'Connection changed or discovery timed out. Inspect it again.')
        result = {'server': name, 'provider': PROVIDERS[name], 'connection_digest': fingerprint,
                  'tools': [{k: v for k, v in row.items() if k != '_route'} for row in rows.values()],
                  'notice': NOTICE, 'account_binding': 'connection_managed', 'minimum_api': 36}
        from .redaction import contains_secret, secret_values
        if contains_secret(result, secret_values(config)):
            raise RegistryError('secret_detected', 'The connector returned configured credentials in its tool metadata.')
        return result
    finally:
        manager.stop_all()


def validate_receipt(value):
    if (not isinstance(value, dict) or set(value) != {'provider', 'tool', 'response_digest', 'response_preview', 'meaning'}
            or value['provider'] not in PROVIDERS.values() or value['meaning'] != MEANING
            or not isinstance(value['tool'], str) or not NAME.fullmatch(value['tool'])
            or not isinstance(value['response_digest'], str) or not re.fullmatch('[a-f0-9]{64}', value['response_digest'])
            or not isinstance(value['response_preview'], str) or len(value['response_preview'].encode()) > 1024):
        raise RegistryError('invalid_connector_receipt', 'The connector response receipt is malformed.')
    return value


def result(raw, config, name, tool):
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 32768 or len(raw.encode()) > 32768 or raw.startswith('ERROR:'):
        raise RegistryError('connector_result_unknown', 'The connector did not return a bounded response.')
    from .redaction import contains_secret, secret_values
    if contains_secret(raw, secret_values(config)):
        raise RegistryError('secret_detected', 'The connector response contains configured credentials.')
    try:
        decoded = json.loads(raw)
    except ValueError:
        decoded = None
    if isinstance(decoded, dict) and (decoded.get('isError') is True or decoded.get('successful') is False
                                     or decoded.get('success') is False or decoded.get('error')):
        raise RegistryError('connector_result_unknown', 'The connector reported an error; downstream effects are unconfirmed.')
    return validate_receipt({'provider': PROVIDERS[name], 'tool': tool, 'response_digest': apps.digest(raw),
                            'response_preview': raw.encode()[:1024].decode('utf-8', errors='ignore'), 'meaning': MEANING})


@contextmanager
def prepared(config, payload, authorize, *, manager_factory=_manager,
             servers_reader=apps.saved_servers, clock=time.monotonic):
    cancel = apps.DeadlineCancellation(clock() + 30, clock=clock)
    args = arguments(payload['call'])
    name = payload['server']
    def check():
        authorize()
        if cancel.is_set():
            raise RegistryError('cancelled', 'The connector action reached its deadline.')
        spec, fingerprint = apps.connection(config, name)
        saved = servers_reader(config).get(name)
        if (not supported(name, spec) or fingerprint != payload['connection_digest']
                or not isinstance(saved, dict) or saved.get('enabled') is False or apps.digest(saved) != fingerprint):
            raise RegistryError('connection_changed', 'The saved connector changed or was removed. Prepare a new review.')
    check()
    manager = manager_factory(config, name, cancel)
    try:
        def route():
            row = catalog(manager, name).get(payload['call']['tool'])
            if row is None or row['schema_digest'] != payload['schema_digest']:
                raise RegistryError('connector_schema_changed', 'The tool descriptor changed. Inspect it and prepare a new review.')
            return row['_route']
        route()
        check()
        def invoke():
            check()
            target = route()
            return result(manager.call(target, args, cancel=cancel,
                                       input_handler=lambda *a, **kw: {'action': 'cancel'}),
                          config, name, payload['call']['tool'])
        yield invoke
    finally:
        manager.stop_all()
