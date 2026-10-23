"""Controller-owned, reviewed read calls over existing user-owned MCP connections.

No credentials or MCP process cross into the Pip model worker. This initial
adapter supports explicitly named Composio read actions, not arbitrary executor
payloads, account management, workflows, sending or purchase operations.
"""
from __future__ import annotations
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from . import pip_calendar_window, pip_app_read_adapters as extra_reads
from urllib.parse import urlsplit
from .workspace_registry import RegistryError

# Closed action vocabulary. Provider annotations alone never grant read authority.
READ_ACTIONS = frozenset({'GMAIL_FETCH_EMAILS', 'GOOGLECALENDAR_FIND_EVENT'}) | extra_reads.TOOLS
MAX_PLAN = 8192
MAX_RESULT = 32768

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()

def bounded(value,limit):
    try:
        data=json.dumps(value,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()
    except (TypeError,ValueError,UnicodeError,RecursionError) as exc:
        raise RegistryError('invalid_app_plan','App data must be bounded JSON.') from exc
    if len(data)>limit:raise RegistryError('app_limit','App data exceeds its byte budget.')
    return value

def connection(config,name):
    from . import pip_sdk_apps
    if pip_sdk_apps.is_app(name):
        # Your own app (Pips API 61): kept by DGC, not in Settings' servers; its digest is its name and address.
        return pip_sdk_apps.connection(name)
    specs=config.get('mcp_servers',{}) or {}
    spec=specs.get(name)
    if not isinstance(spec,dict) or spec.get('enabled') is False:
        raise RegistryError('connection_unavailable','This connection is removed or disabled. Reconnect it in Settings.')
    # Hash the exact saved spec, never a runtime credential map.
    return spec,digest(spec)

def supported(spec):
    try:
        host=urlsplit(spec.get('url','')).hostname or ''
        return spec.get('transport')=='remote' and urlsplit(spec['url']).scheme=='https' and (host=='composio.dev' or host.endswith('.composio.dev'))
    except (ValueError,KeyError):return False

def connections(config):
    from . import pip_connector_actions, pip_sdk_apps
    result=[]
    for name,spec in list((config.get('mcp_servers',{}) or {}).items())[:64]:
        if not isinstance(spec,dict):continue
        result.append({'name':name,'provider':'Composio' if supported(spec) else pip_connector_actions.PROVIDERS.get(name,name),
            'configured':True,'enabled':spec.get('enabled') is not False,
            'pip_read_adapter':supported(spec),'pip_action_adapter':pip_connector_actions.supported(name,spec),'sign_in_again':False,
            'notice':'Uses the accounts exposed by this existing server; access is reviewed per Pip.' if supported(spec)
                     else pip_connector_actions.NOTICE if pip_connector_actions.supported(name,spec) else 'Available to main DGC. A scoped Pip adapter for this connection is not available yet.'})
    # Your own apps (Pips API 61) as connections app:<name>, in the same shape.
    return (result+pip_sdk_apps.connections())[:64]

class DeadlineCancellation:
    """MCP cancellation interface; no polling thread and no sleep in tests."""
    def __init__(self, deadline, parent=None, clock=time.monotonic):
        self.deadline, self.parent, self.clock = deadline, parent, clock
    def is_set(self):
        return self.clock() >= self.deadline or self.parent is not None and self.parent.is_set()


def validate_arguments(tool, arguments):
    if tool in extra_reads.TOOLS:return extra_reads.validate(tool,arguments)
    common = {'query', 'max_results'}
    allowed = (common | {'user_id', 'label_ids', 'include_payload', 'include_spam_trash', 'verbose', 'ids_only'}
               if tool == 'GMAIL_FETCH_EMAILS' else common | {'calendar_id', 'time_min', 'time_max', 'single_events', 'show_deleted', 'order_by'})
    if set(arguments) - allowed:
        raise RegistryError('invalid_app_arguments', 'This read adapter does not support those fields or pagination.')
    if type(arguments.get('max_results')) is not int or not 1 <= arguments['max_results'] <= 20:
        raise RegistryError('invalid_app_arguments', 'Review an explicit read limit between 1 and 20 items.')
    for key, value in arguments.items():
        if key == 'max_results': continue
        if key in ('include_payload', 'include_spam_trash', 'verbose', 'ids_only', 'single_events', 'show_deleted'):
            if type(value) is not bool: raise RegistryError('invalid_app_arguments', 'Read flags must be booleans.')
        elif key == 'label_ids':
            if not isinstance(value, list) or len(value) > 10 or any(not isinstance(v, str) or not 1 <= len(v) <= 128 for v in value):
                raise RegistryError('invalid_app_arguments', 'Review up to ten bounded email labels.')
        elif not isinstance(value, str) or not 1 <= len(value) <= 1024:
            raise RegistryError('invalid_app_arguments', 'Read fields must be bounded nonempty strings.')
    if tool == 'GMAIL_FETCH_EMAILS' and arguments.get('user_id', 'me') != 'me':
        raise RegistryError('invalid_app_arguments', 'Read only the explicitly selected account, using user_id me.')
    if tool == 'GOOGLECALENDAR_FIND_EVENT' and not arguments.get('calendar_id'):
        raise RegistryError('invalid_app_arguments', 'Review the calendar ID explicitly, such as primary.')


def saved_servers(config):
    """Reread connection revocations without loading secrets or saving Config."""
    from .config import DEFAULTS, USER_CONFIG
    try:
        with USER_CONFIG.open('rb') as stream:
            data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024: raise ValueError()
        raw = json.loads(data)
        # A config written before Pips existed has no pips_enabled key: that is the default (on),
        # not a refusal. Only an explicit false turns Pips off here.
        if not isinstance(raw, dict) or raw.get('pips_enabled', DEFAULTS['pips_enabled']) is not True: raise ValueError()
        servers = raw.get('mcp_servers', {})
        if not isinstance(servers, dict): raise ValueError()
        return servers
    except (OSError, ValueError, TypeError) as exc:
        raise RegistryError('connection_unavailable', 'Pips or the saved connection became unavailable. Review Settings.') from exc


def validate(plan):
    if plan is None:return None
    bounded(plan,MAX_PLAN)
    from . import pip_sdk_apps
    if isinstance(plan,dict) and pip_sdk_apps.is_app(plan.get('server')):
        # Exact reads on your own app (Pips API 61): their shape here; that each is a read, and current, when it runs.
        return pip_sdk_apps.validate_plan(plan)
    if (not isinstance(plan,dict) or set(plan)!={'schema_version','server','connection_digest','calls'}
            or plan['schema_version'] not in (1,2,3) or type(plan['schema_version']) is not int
            or not isinstance(plan['server'],str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',plan['server'])
            or not isinstance(plan['connection_digest'],str) or not re.fullmatch('[0-9a-f]{64}',plan['connection_digest'])
            or not isinstance(plan['calls'],list) or not 1<=len(plan['calls'])<=4):
        raise RegistryError('invalid_app_plan','Review one connection and up to four exact read calls.')
    for call in plan['calls']:
        if (not isinstance(call,dict) or set(call) not in ({'tool','schema_digest','arguments'}, {'tool','schema_digest','arguments','account'}, {'tool','schema_digest','arguments','account','window'})
                or not isinstance(call['tool'],str) or call['tool'] not in READ_ACTIONS or not isinstance(call['schema_digest'],str)
                or not re.fullmatch('[0-9a-f]{64}',call['schema_digest']) or not isinstance(call['arguments'],dict)):
            raise RegistryError('unsupported_app_action','Only supported, bounded app reads can be granted. Generic execute, send and connection-management tools are not supported.')
        if call['tool'] in extra_reads.TOOLS and (plan['schema_version']!=3 or 'account' not in call):
            raise RegistryError('invalid_app_plan','Additional app reads require version 3 and an explicitly reviewed account.')
        if 'account' in call and (not isinstance(call['account'],str) or not re.fullmatch(r'(?:ca|coup)_[A-Za-z0-9_-]{1,120}',call['account'])):
            raise RegistryError('invalid_account','Choose a connected account ID, not a mutable account alias.')
        if 'window' in call:
            if plan['schema_version'] not in (2,3) or call['tool']!='GOOGLECALENDAR_FIND_EVENT' or any(k in call['arguments'] for k in ('time_min','time_max')):
                raise RegistryError('invalid_calendar_window','Relative windows require a version 2 calendar read with no fixed date overrides.')
            pip_calendar_window.validate(call['window'])
        # A direct known tool has no nested execution envelope. Keep requests small.
        bounded(call['arguments'],4096)
        validate_arguments(call['tool'], call['arguments'])
    return json.loads(json.dumps(plan))

def _manager(config,name,cancel=None):
    from .mcp import MCPManager
    spec,_=connection(config,name)
    if not supported(spec):raise RegistryError('unsupported_connector','This connection needs a reviewed scoped adapter before a Pip can use it.')
    manager=MCPManager(config.project_root)
    try:
        manager.connect_all(config.mcp_runtime_servers({name:spec}),cancel=cancel,
                            input_handler=lambda *a,**kw:{'action':'cancel'})
        if name not in manager.servers:raise RegistryError('connection_unavailable','Open the existing connector in Settings and finish sign-in. No new account was created.')
        return manager
    except BaseException:
        manager.stop_all();raise

def _routes(manager,name,cancel=None):
    result={};generic=None;schemas=None
    for schema in manager.tool_schemas():
        fn=schema.get('function',{});route=manager._routes.get(fn.get('name'))
        if not route or route[0]!=name:continue
        if route[1] in READ_ACTIONS and route[1] not in extra_reads.TOOLS:
            result[route[1]]=(fn['name'],digest(fn.get('parameters',{})),False)
        elif route[1]=='COMPOSIO_MULTI_EXECUTE_TOOL':generic=fn
        elif route[1]=='COMPOSIO_GET_TOOL_SCHEMAS':schemas=fn
    if generic and schemas:
        # Require the documented explicit account field; never fall back to an alias
        # or default account when the endpoint's execution contract differs.
        props=generic.get('parameters',{}).get('properties',{})
        account=props.get('tools',{}).get('items',{}).get('properties',{}).get('account')
        if not isinstance(account,dict) or account.get('type')!='string':return result
        raw=manager.call(schemas['name'],{'tool_slugs':sorted(READ_ACTIONS),'include':['input_schema']},
                         cancel=cancel, input_handler=lambda *a,**kw:{'action':'cancel'})
        if not isinstance(raw,str) or len(raw.encode())>131072:
            raise RegistryError('app_schema_changed','Tool discovery exceeded its bounded response.')
        try:
            response=json.loads(raw)
            if response.get('successful') is not True or response.get('error') is not None:raise ValueError()
            found=response['data']['tool_schemas']
            if not isinstance(found, dict): raise ValueError()
        except (ValueError,KeyError,TypeError,AttributeError) as exc:
            raise RegistryError('app_schema_changed','The connector could not return validated read-tool schemas.') from exc
        for tool in READ_ACTIONS:
            value=found.get(tool,{})
            if isinstance(value, dict) and value.get('tool_slug')==tool and isinstance(value.get('input_schema'),dict):
                if tool in extra_reads.TOOLS and not extra_reads.schema_supported(tool,value['input_schema']):continue
                result[tool]=(generic['name'],digest({'executor':generic['parameters'],'input':value['input_schema']}),True)
    return result


def inspect(config,name,*,manager_factory=_manager,clock=time.monotonic):
    from . import pip_sdk_apps
    if pip_sdk_apps.is_app(name):
        return pip_sdk_apps.inspect(name)
    _,fingerprint=connection(config,name)
    cancel=DeadlineCancellation(clock()+30,clock=clock)
    manager=manager_factory(config,name,cancel)
    try:
        routes=_routes(manager,name,cancel)
        return {'server':name,'connection_digest':fingerprint,'tools':[
            {'tool':tool,'schema_digest':value[1],'account_required':value[2],
             'arguments_example':(extra_reads.DESCRIPTORS[tool]['example'] if tool in extra_reads.TOOLS else {'max_results':5,'user_id':'me','include_payload':False} if tool=='GMAIL_FETCH_EMAILS' else {'max_results':10,'calendar_id':'primary'}),
             **({'relative_window_example':{'kind':'calendar_days','timezone':'UTC','start_day':0,'days':1},'relative_window_plan_version':2,'relative_window_minimum_api':33} if tool=='GOOGLECALENDAR_FIND_EVENT' else {}),
             **({'minimum_api':39,'plan_version':3,'toolkit':extra_reads.DESCRIPTORS[tool]['toolkit'],'description':extra_reads.DESCRIPTORS[tool]['notice']} if tool in extra_reads.TOOLS else {}),
             'limits':'Up to 20 items. Exact reviewed arguments or a reviewed calendar-day window; no automatic pagination.'} for tool,value in sorted(routes.items())],
            'notice':('Review exact read calls and the connected account. This does not read application data.' if routes else
                      'This server exposes no supported direct read tools. Its generic setup/execution tools remain available in main DGC; scoped Pip access is not yet supported.')}
    finally:manager.stop_all()

def execute(config,plan,*,authorize,cancel=None,manager_factory=_manager,servers_reader=None,deadline=None,clock=time.monotonic,wall_clock=lambda:datetime.now(timezone.utc),context=None):
    plan=validate(plan)
    if plan is None:return []
    from . import pip_sdk_apps
    if pip_sdk_apps.is_app(plan['server']):
        # Your own app: one signed POST a read, the run's pip_id and run_id with each (context).
        if not isinstance(context,dict) or not {'pip_id','run_id'}<=set(context):
            raise RegistryError('invalid_app_plan','Reads on your own app run only inside a Pip run.')
        return pip_sdk_apps.execute_plan(config,plan,authorize=authorize,context=context,deadline=deadline)
    cancel=DeadlineCancellation(min(deadline or float("inf"),clock()+30),cancel,clock)
    def check():
        authorize()
        if cancel is not None and cancel.is_set():raise RegistryError('cancelled','App reads were cancelled.')
        spec,fingerprint=connection(config,plan['server'])
        if servers_reader is not None:
            saved=servers_reader(config).get(plan['server'])
            if not isinstance(saved,dict) or saved.get('enabled') is False or digest(saved)!=fingerprint:
                raise RegistryError('connection_changed','The saved connection was removed or changed. Review app access again.')
        if not supported(spec) or fingerprint!=plan['connection_digest']:
            raise RegistryError('connection_changed','The saved connection changed. Review app access again.')
    check()
    # Resolve all windows before connecting; one instant for every read in a run.
    now=wall_clock() if any('window' in c for c in plan['calls']) else None
    resolved=[{**c['arguments'],**(pip_calendar_window.resolve(c['window'],now) if 'window' in c else {})} for c in plan['calls']]
    manager=manager_factory(config,plan['server'],cancel)
    try:
        routes=_routes(manager,plan['server'],cancel);results=[];used=0;received=0
        # Validate every tool before making even the first provider call.
        for call in plan['calls']:
            if call['tool'] not in routes or routes[call['tool']][1]!=call['schema_digest']:
                raise RegistryError('app_schema_changed','The connector tools changed. Inspect and review this Pip’s app access again.')
            if 'account' in call and not routes[call['tool']][2]:
                raise RegistryError('account_required','This tool cannot enforce the reviewed account. Choose an account-specific connector route.')
            if routes[call['tool']][2] and 'account' not in call:
                raise RegistryError('account_required','Review a specific connected account before this read.')
        for call,read_arguments in zip(plan['calls'],resolved):
            check()
            route=routes[call['tool']]
            arguments=read_arguments
            if route[2]:
                if 'account' not in call:raise RegistryError('account_required','Review a specific connected account before this read.')
                arguments={'tools':[{'tool_slug':call['tool'],'account':call['account'],'arguments':arguments}],
                           'sync_response_to_workbench':False,'current_step':'READING_APPROVED_PIP_INPUT'}
            text=manager.call(route[0],arguments,cancel=cancel,
                              input_handler=lambda *a,**kw:{'action':'cancel'})
            check()
            if not isinstance(text,str) or text.startswith('ERROR:'):
                raise RegistryError('app_read_failed','The connector could not complete the approved read. Check the existing connection in Settings.')
            if len(text)>MAX_RESULT or len(text.encode())+received>MAX_RESULT:
                raise RegistryError('app_limit','The connected app returned too much data. Review a smaller read limit.')
            received+=len(text.encode())
            if route[2]:
                try:
                    envelope=json.loads(text)
                    if envelope.get('successful') is not True or envelope.get('error') is not None:raise ValueError()
                    body=envelope.get('data',{})
                    if body.get('success') is not True or not isinstance(body.get('results'),list) or len(body['results']) != 1:raise ValueError()
                    for item in body['results']:
                        if not isinstance(item,dict) or not isinstance(item.get('response'),dict):raise ValueError()
                        response=item['response']
                        if item.get('error') or response.get('error') or item.get('successful') is False or response.get('successful') is False:raise ValueError()
                        if item.get('successful') is not True and response.get('successful') is not True:raise ValueError()
                except (ValueError,TypeError,AttributeError) as exc:
                    raise RegistryError('app_read_failed','The connected app did not confirm a successful read.') from exc
            if call['tool'] in extra_reads.TOOLS:
                row=body['results'][0]
                if row.get('tool_slug')!=call['tool'] or row['response'].get('successful') is not True:
                    raise RegistryError('app_read_failed','The returned app result does not match this approved read.')
                text=json.dumps(extra_reads.project(call['tool'],row['response'].get('data'),read_arguments),ensure_ascii=False,separators=(',',':'))
            from .redaction import redact_text,secret_values
            text=redact_text(text,secret_values(config));used+=len(text.encode())
            if used>MAX_RESULT:
                raise RegistryError('app_limit','The projected app results exceeded their aggregate limit.')
            results.append({'server':plan['server'],'tool':call['tool'],'text':text,'untrusted':True,
                **({'calendar_window':{**call['window'],'time_min':read_arguments['time_min'],'time_max':read_arguments['time_max']}} if 'window' in call else {})})
        check()
        return results
    finally:manager.stop_all()
