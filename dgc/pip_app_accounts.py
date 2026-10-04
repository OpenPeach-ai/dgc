"""Read-only connected-account discovery for the controller's reviewed Pip UI.

The documented MCP search envelope may expose accounts[]; older endpoints do
not. Never infer identity from aliases, current_user_info, or default accounts.
No search result plan, tool description, or account-management instruction is
executed. The user guide is docs/PIPS.md.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata

from . import pip_app_access as apps
from .workspace_registry import RegistryError

TOOLKITS = ('gmail', 'googlecalendar', 'googledrive', 'notion', 'googlecontacts')
MAX_RESPONSE = 256 * 1024  # Acceptance limit; the MCP transport owns allocation.
MAX_ACCOUNTS = 64
ACCOUNT_ID = re.compile(r'(?:ca|coup)_[A-Za-z0-9_-]{1,120}\Z')


def _field(value, *path):
    """Untrusted provider schema nodes must be objects at every step."""
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _label(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 160:
        return None
    # Service-provided labels are text, never instructions/HTML. Refuse invisible
    # controls/bidi overrides rather than displaying a misleading account name.
    if any(unicodedata.category(c).startswith('C') for c in value):
        return None
    return value.strip() or None


def parse_accounts(raw):
    """Return a bounded identity list, with explicit unsupported/empty states."""
    if not isinstance(raw, str) or len(raw) > MAX_RESPONSE:
        raise RegistryError('account_discovery_limit', 'Account discovery exceeded its response budget.')
    try:
        if len(raw.encode('utf-8')) > MAX_RESPONSE:
            raise RegistryError('account_discovery_limit', 'Account discovery exceeded its response budget.')
        value = json.loads(raw)
        if not isinstance(value, dict) or value.get('successful') is not True or value.get('error') is not None:
            raise ValueError()
        data = value['data']
        statuses = data['toolkit_connection_statuses']
        if not isinstance(statuses, list) or len(statuses) > 32:
            raise ValueError()
    except (ValueError, KeyError, TypeError, UnicodeError, RecursionError) as exc:
        raise RegistryError('account_discovery_failed', 'Composio did not return a supported account-discovery response. Check Connect Apps in Composio.') from exc
    accounts, states, seen = [], {}, set()
    for status in statuses:
        if not isinstance(status, dict):
            raise RegistryError('account_discovery_failed', 'Composio returned an invalid connection record.')
        toolkit = status.get('toolkit')
        if not isinstance(toolkit, str) or toolkit not in TOOLKITS:
            continue
        if toolkit in states:
            raise RegistryError('account_discovery_failed', 'Composio returned ambiguous connection records. Refresh account discovery.')
        if 'accounts' not in status:
            states[toolkit] = 'unsupported'
            continue
        rows = status['accounts']
        if not isinstance(rows, list) or len(rows) > MAX_ACCOUNTS:
            raise RegistryError('account_discovery_limit', 'Account discovery returned too many or invalid accounts.')
        states[toolkit] = 'empty'
        for row in rows:
            if not isinstance(row, dict):
                raise RegistryError('account_discovery_failed', 'Composio returned an invalid account record.')
            identity = row.get('id')
            if not isinstance(identity, str) or not ACCOUNT_ID.fullmatch(identity):
                raise RegistryError('account_identity_missing', 'This Composio endpoint did not return stable connected-account IDs. No account was selected.')
            key = (toolkit, identity)
            if key in seen:
                raise RegistryError('account_discovery_failed', 'Composio returned a duplicate account identity. Refresh account discovery.')
            seen.add(key)
            if len(seen) > MAX_ACCOUNTS:
                raise RegistryError('account_discovery_limit', 'Account discovery returned too many accounts.')
            # An inactive account is never selectable, even if is_default=true.
            if row.get('status') != 'ACTIVE':
                continue
            info = row.get('user_info', {})
            if not isinstance(info, dict):
                raise RegistryError('account_discovery_failed', 'Composio returned invalid account details.')
            label = _label(info.get('email')) or _label(row.get('alias')) or _label(info.get('name'))
            # Stable ID is a truthful last resort, not a mutable alias used as ID.
            accounts.append({'toolkit': toolkit, 'id': identity, 'label': label or identity})
            states[toolkit] = 'available'
    return {'accounts': accounts, 'toolkits': [
        {'toolkit': toolkit, 'state': states.get(toolkit, 'unsupported')}
        for toolkit in TOOLKITS],
        'notice': 'Choose an account explicitly. This lists connection identities only; it does not read email, events, or grant a Pip access.'}


def discover(config, name, *, manager_factory=apps._manager, clock=time.monotonic):
    """Use the existing MCP connection for one closed, read-only search call."""
    spec, fingerprint = apps.connection(config, name)
    if not apps.supported(spec):
        raise RegistryError('unsupported_connector', 'This connector has no supported Pip account-discovery adapter.')
    cancel = apps.DeadlineCancellation(clock() + 30, clock=clock)
    manager = manager_factory(config, name, cancel)
    try:
        matches = []
        for schema in manager.tool_schemas():
            fn = _field(schema, 'function')
            tool_name = _field(fn, 'name')
            if not isinstance(tool_name, str):
                continue
            route = manager._routes.get(tool_name)
            if route == (name, 'COMPOSIO_SEARCH_TOOLS'):
                props = _field(fn, 'parameters', 'properties')
                query = _field(props, 'queries')
                session = _field(props, 'session')
                if (_field(query, 'type') != 'array'
                        or _field(query, 'items', 'properties', 'use_case', 'type') != 'string'
                        or _field(session, 'type') != 'object'
                        or _field(session, 'properties', 'generate_id', 'type') != 'boolean'):
                    raise RegistryError('account_discovery_unsupported', 'The connector search contract changed. Account discovery is unavailable; no account was selected.')
                matches.append(fn['name'])
        if len(matches) != 1:
            raise RegistryError('account_discovery_unsupported', 'This connection does not expose the supported read-only account search. Use Connect Apps in Composio.')
        if cancel.is_set():
            raise RegistryError('cancelled', 'Account discovery reached its deadline.')
        raw = manager.call(matches[0], {'queries': [
            {'use_case': 'fetch Gmail emails'},
            {'use_case': 'find Google Calendar events'},
            {'use_case': 'search Google Drive file names'},
            {'use_case': 'search Notion page titles'},
            {'use_case': 'search saved Google Contacts'}], 'session': {'generate_id': True}},
            cancel=cancel, input_handler=lambda *a, **kw: {'action': 'cancel'})
        if cancel.is_set():
            raise RegistryError('cancelled', 'Account discovery reached its deadline.')
        if apps.connection(config, name)[1] != fingerprint:
            raise RegistryError('connection_changed', 'The connection changed while accounts were loading. Refresh and review it again.')
        return {'server': name, 'connection_digest': fingerprint, **parse_accounts(raw)}
    finally:
        manager.stop_all()
