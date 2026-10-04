"""One bounded, controller-owned Gmail send adapter over an existing connection.

No credentials enter inference. A reviewed action never enables a general MCP
executor for a Pip. No send is retried here, including an ambiguous timeout.
Public contract: https://docs.composio.dev/kb/guide/toolkits-gmail
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from contextlib import contextmanager

from . import pip_app_access as apps
from .workspace_registry import RegistryError

TOOL = 'GMAIL_SEND_EMAIL'
MAX_BODY = 12000
MAX_RESPONSE = 32768
HASH = re.compile(r'[a-f0-9]{64}\Z')
ACCOUNT = re.compile(r'(?:ca|coup)_[A-Za-z0-9_-]{1,120}\Z')
ARGS = {'recipient_email', 'subject', 'body', 'user_id', 'is_html', 'cc', 'bcc', 'extra_recipients'}
ACCEPTED = 'Provider accepted the message; delivery to the recipient is not confirmed.'


def arguments(value):
    if not isinstance(value, dict) or set(value) != {'recipient_email', 'subject', 'body'}:
        raise RegistryError('invalid_send', 'Review one recipient, a subject and a plain-text body. No hidden recipients or attachments.')
    from .pip_checkpoints import _text
    for key, maximum in (('recipient_email',254),('subject',200),('body',MAX_BODY)):
        text = _text(value[key], key, maximum, multiline=key=='body')
        if text != value[key].strip() or any(unicodedata.category(c).startswith('C') and not (key=='body' and c in '\n\t') for c in text):
            raise RegistryError('invalid_send', 'Review the exact trimmed message, without invisible controls.')
    # Deliberately one ordinary ASCII mailbox; no display-name/header syntax.
    if not re.fullmatch(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}", value['recipient_email']):
        raise RegistryError('invalid_send', 'Enter one email address without a display name, comma or header.')
    return {**value, 'user_id':'me', 'is_html':False, 'cc':[], 'bcc':[], 'extra_recipients':[]}


def field(obj, *path):
    for key in path:
        if not isinstance(obj,dict):return None
        obj=obj.get(key)
    return obj


def _schema(schema, fields):
    if not isinstance(schema,dict) or schema.get('type')!='object':return False
    required=schema.get('required',[])
    if not isinstance(required,list) or any(not isinstance(x,str) or x not in fields for x in required):return False
    return all(field(schema,'properties',key,'type')==kind for key,kind in fields.items())


def route(manager, name, cancel, *, tool=TOOL, argument_types=None):
    found={}
    for item in manager.tool_schemas():
        fn=item.get('function',{}) if isinstance(item,dict) else {}
        identity=manager._routes.get(fn.get('name'))
        if identity and identity[0]==name and identity[1] in ('COMPOSIO_MULTI_EXECUTE_TOOL','COMPOSIO_GET_TOOL_SCHEMAS'):
            if identity[1] in found:raise RegistryError('send_schema_changed','The connector has ambiguous external-action routes.')
            found[identity[1]]=fn
    execute=found.get('COMPOSIO_MULTI_EXECUTE_TOOL',{}); lookup=found.get('COMPOSIO_GET_TOOL_SCHEMAS',{})
    schema=execute.get('parameters',{})
    item=field(schema,'properties','tools','items')
    if (not _schema(schema,{'tools':'array','sync_response_to_workbench':'boolean','current_step':'string'})
            or not _schema(item,{'tool_slug':'string','account':'string','arguments':'object'})
            or not _schema(lookup.get('parameters'),{'tool_slugs':'array','include':'array'})):
        raise RegistryError('unsupported_send','This connection does not offer the supported account-specific external-action contract.')
    raw=manager.call(lookup['name'],{'tool_slugs':[tool],'include':['input_schema']},cancel=cancel,
                     input_handler=lambda *a,**kw:{'action':'cancel'})
    if not isinstance(raw,str) or len(raw)>131072 or len(raw.encode())>131072:
        raise RegistryError('send_schema_changed','Action-tool discovery exceeded its response budget.')
    try:
        response=json.loads(raw); value=response['data']['tool_schemas'][tool]
        if response.get('successful') is not True or response.get('error') is not None or value.get('tool_slug')!=tool:raise ValueError()
        provider=value['input_schema']
        types=argument_types or {key:('boolean' if key=='is_html' else 'array' if key in ('cc','bcc','extra_recipients') else 'string') for key in ARGS}
        if not _schema(provider,types):raise ValueError()
    except (ValueError,KeyError,TypeError,AttributeError,RecursionError) as exc:
        raise RegistryError('send_schema_changed','External-action fields changed. Refresh the connection and prepare a new review.') from exc
    if cancel.is_set():raise RegistryError('cancelled','Action discovery reached its deadline.')
    return execute['name'],apps.digest({'executor':schema,'input':provider,'tool':tool})


def inspect(config, name, *, manager_factory=apps._manager, clock=time.monotonic):
    spec,fingerprint=apps.connection(config,name)
    if not apps.supported(spec):raise RegistryError('unsupported_connector','A scoped send adapter is not available for this connector.')
    cancel=apps.DeadlineCancellation(clock()+30,clock=clock)
    manager=manager_factory(config,name,cancel)
    try:
        _,schema_digest=route(manager,name,cancel)
        if apps.connection(config,name)[1]!=fingerprint:raise RegistryError('connection_changed','Connection changed during discovery.')
        return {'server':name,'connection_digest':fingerprint,'tool':TOOL,'schema_digest':schema_digest,
                'account_required':True,'notice':'One plain-text recipient. Sending requires a separate review of the exact saved message.'}
    finally:manager.stop_all()


def result(raw):
    """Accept only a positive provider receipt; everything else is uncertain."""
    if not isinstance(raw,str) or len(raw)>MAX_RESPONSE or len(raw.encode())>MAX_RESPONSE:raise ValueError('receipt limit')
    outer=json.loads(raw)
    if outer.get('successful') is not True or outer.get('error') is not None:raise ValueError('executor error')
    data=outer['data']; rows=data['results']
    if data.get('success') is not True or not isinstance(rows,list) or len(rows)!=1:raise ValueError('executor result')
    row=rows[0]
    if row.get('tool_slug')!=TOOL:raise ValueError('wrong tool receipt')
    response=row['response']
    if response.get('successful') is not True or response.get('error') is not None:raise ValueError('provider error')
    identity=response['data']['id']
    if not isinstance(identity,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}',identity):raise ValueError('missing message receipt')
    return validate_receipt({'provider':'Gmail','message_id':identity,'meaning':ACCEPTED})


def validate_receipt(receipt):
    if (not isinstance(receipt,dict) or set(receipt)!={'provider','message_id','meaning'}
            or receipt['provider']!='Gmail' or receipt['meaning']!=ACCEPTED
            or not isinstance(receipt['message_id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}',receipt['message_id'])):
        raise RegistryError('invalid_send_receipt','The provider did not confirm acceptance of this message.')
    return receipt


@contextmanager
def prepared(config, payload, authorize, *, manager_factory=apps._manager, servers_reader=apps.saved_servers, clock=time.monotonic):
    """Resolve and pin metadata before consuming one durable send authorization."""
    cancel=apps.DeadlineCancellation(clock()+30,clock=clock)
    def check():
        authorize()
        if cancel.is_set():raise RegistryError('cancelled','The send reached its deadline before dispatch.')
        spec,fingerprint=apps.connection(config,payload['server'])
        saved=servers_reader(config).get(payload['server'])
        if (not apps.supported(spec) or fingerprint!=payload['connection_digest']
                or not isinstance(saved,dict) or saved.get('enabled') is False or apps.digest(saved)!=fingerprint):
            raise RegistryError('connection_changed','This connection was removed or changed. Prepare a new send review.')
    check();manager=manager_factory(config,payload['server'],cancel)
    try:
        name,fingerprint=route(manager,payload['server'],cancel)
        if fingerprint!=payload['schema_digest']:raise RegistryError('send_schema_changed','The send schema changed. Prepare a new review.')
        check()
        def send():
            # Called only after the ledger commits dispatching. Any exception now
            # consumes the attempt; never reconnect or retry the mutation.
            check()
            return result(manager.call(name,{'tools':[{'tool_slug':TOOL,'account':payload['account'],
                'arguments':arguments(payload['message'])}], 'sync_response_to_workbench':False,
                'current_step':'SENDING_HUMAN_REVIEWED_PIP_MESSAGE'},cancel=cancel,
                input_handler=lambda *a,**kw:{'action':'cancel'}))
        yield send
    finally:manager.stop_all()
