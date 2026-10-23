"""Immutable human reviews and at-most-one local attempt for external Pip actions.

The model worker cannot approve or execute this ledger. An ambiguous delivery
is retained and never retried automatically, even after a controller crash.
"""
from __future__ import annotations

import json
import re
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

from . import pip_app_access as apps, pip_app_sends as sends, pip_calendar_actions as calendar, pip_connector_actions as connector
from .workspace_registry import RegistryError, identifier

MAX_PAYLOAD = 20000
MAX_ACTIONS = 10000
COMMANDS = frozenset({'inspect_pip_connector_actions','propose_pip_connector_action','inspect_pip_calendar_connection','propose_pip_calendar_action','inspect_pip_send_connection','propose_pip_app_action','get_pip_app_action',
                     'list_pip_app_actions','accept_pip_app_action','reject_pip_app_action','always_allow_pip_app_action'})
SCHEMA = """
CREATE TABLE pip_app_actions(
 id TEXT PRIMARY KEY, pip_id TEXT NOT NULL REFERENCES pips(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), source_run_id TEXT NOT NULL REFERENCES pip_runs(id),
 request_key TEXT NOT NULL, requested_by TEXT NOT NULL, request_digest TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=20000), digest TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','dispatching','succeeded','unknown','rejected','expired')),
 resolved_by TEXT, resolved_at TEXT,
 receipt TEXT CHECK(receipt IS NULL OR length(CAST(receipt AS BLOB))<=2048),
 UNIQUE(requested_by,request_key));
CREATE INDEX pip_app_action_history ON pip_app_actions(pip_id,created_at,id);
CREATE TRIGGER immutable_pip_app_action BEFORE UPDATE OF id,pip_id,workspace_id,source_run_id,
 request_key,requested_by,request_digest,payload,digest,created_at,expires_at ON pip_app_actions
 BEGIN SELECT RAISE(ABORT,'immutable external action review'); END;
CREATE TRIGGER one_way_pip_app_action BEFORE UPDATE OF status,resolved_by,resolved_at,receipt ON pip_app_actions
 WHEN NOT ((OLD.status='pending' AND NEW.status IN ('dispatching','rejected','expired') AND NEW.receipt IS NULL)
        OR (OLD.status='dispatching' AND NEW.status IN ('succeeded','unknown') AND NEW.receipt IS NOT NULL))
        OR NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL
 BEGIN SELECT RAISE(ABORT,'external action attempt can only advance once'); END;
CREATE TRIGGER retain_pip_app_action BEFORE DELETE ON pip_app_actions
 BEGIN SELECT RAISE(ABORT,'external action history is retained'); END;
"""


def _id(value, prefix):
    if not isinstance(value,str) or not re.fullmatch(prefix+r'_[a-f0-9]{32}',value):
        raise RegistryError('invalid_app_action','Use an exact saved action, Pip or run identity.')
    return value


def _actor(actor):
    if actor not in ('local-console','editor-user'):
        raise RegistryError('local_only','External action reviews are available only in the local CLI and extension.')


def _acting(actor, store=None, payload=None):
    """The user, a Pip's Always-allow grant covering exactly this action (pip_action_grants), or its level
    (pip_levels). Only the runner acts as a grant or a level; every control request is the user's (handle_control).
    DGC itself opens the review for a Pip's change on your own app, so the app can decide it too (Pips API 62): it
    only proposes, never decides (_review)."""
    from .pip_sdk_app_approvals import REVIEWER, is_app_action
    if actor == REVIEWER:
        if payload is not None and not is_app_action(payload):
            raise RegistryError('local_only','External action reviews are available only in the local CLI and extension.')
        return
    if isinstance(actor, str) and actor.startswith('pip-grant:'):
        from .pip_action_grants import ACTOR, check
        if not ACTOR.fullmatch(actor):
            raise RegistryError('local_only','External action reviews are available only in the local CLI and extension.')
        if payload is not None:
            check(store, actor, payload)
        return
    if isinstance(actor, str) and actor.startswith('pip-level:'):
        # Its level (pip_levels, API 58): the runner sends what the Pip's level lets through, re-checked here.
        from .pip_levels import ACTOR as LEVEL_ACTOR, check as level_check
        if not LEVEL_ACTOR.fullmatch(actor):
            raise RegistryError('local_only','External action reviews are available only in the local CLI and extension.')
        if payload is not None:
            level_check(store, actor, payload)
        return
    _actor(actor)


def _adapter(kind):
    return {'gmail_send': sends, 'calendar_create': calendar, 'connector_call': connector}[kind]


def validate(payload):
    apps.bounded(payload,MAX_PAYLOAD)
    is_calendar=isinstance(payload,dict) and payload.get('kind')=='calendar_create'
    is_connector=isinstance(payload,dict) and payload.get('kind')=='connector_call'
    content='call' if is_connector else 'event' if is_calendar else 'message'
    version=3 if is_connector else (4 if calendar.extended(payload.get('event')) else 2) if is_calendar else 1
    if (not isinstance(payload,dict) or set(payload)!={'schema_version','kind','source','server','connection_digest','account','schema_digest',content}
            or type(payload['schema_version']) is not int or payload['schema_version']!=version
            or payload['kind'] not in ('gmail_send','calendar_create','connector_call')):
        raise RegistryError('invalid_app_action','This is not a supported closed external-action review.')
    source=payload['source']
    if not isinstance(source,dict) or set(source)!={'run_id','pip_id','workspace_id','job_version','lifecycle_revision','result_digest'}:
        raise RegistryError('invalid_app_action','The source result pin is invalid.')
    for key,prefix in (('run_id','run'),('pip_id','pip'),('workspace_id','ws')):_id(source[key],prefix)
    for key,low in (('job_version',1),('lifecycle_revision',0)):
        if type(source[key]) is not int or not low<=source[key]<2**53:raise RegistryError('invalid_app_action','Invalid source revision.')
    for value in (source['result_digest'],payload['connection_digest'],payload['schema_digest']):
        if not isinstance(value,str) or not sends.HASH.fullmatch(value):raise RegistryError('invalid_app_action','Invalid review digest.')
    # A connector call names a saved connector or a plugin's server; which one, and whether the Pip may
    # use it, is checked against today's settings before anything runs (propose, _current).
    account_valid = (payload['account']=='connection_managed' and isinstance(payload['server'],str)
                     if is_connector else isinstance(payload['account'],str) and sends.ACCOUNT.fullmatch(payload['account']))
    from .pip_sdk_apps import is_app
    # A connector call may also name your own app, app:<name> (Pips API 61).
    if (not isinstance(payload['server'],str) or not account_valid
            or not (re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',payload['server']) or (is_connector and is_app(payload['server'])))):
        raise RegistryError('invalid_app_action','Select the saved connection and the account binding supported by this action.')
    _adapter(payload['kind']).arguments(payload[content])
    return json.loads(json.dumps(payload,ensure_ascii=False))


def _source(store, run_id):
    _id(run_id,'run');run=store.run(run_id);job=store._job(run['pip_id'])
    from .pip_archive import require_live
    require_live(store,job['id'])
    if (store.registry.get(job['workspace_id'])['kind']!='personal' or job['source_policy']!={'mode':'personal'}
            or run['status']!='succeeded' or run['manifest'].get('run_kind') not in ('personal_task','conversation')
            or run['manifest'].get('source_policy')!={'mode':'personal'}):
        raise RegistryError('source_unavailable','Choose a completed Personal result before preparing an external action.')
    from .pip_personal_results import validate as result_valid
    if run['manifest']['run_kind']=='personal_task':result_valid(run['result'])
    else:
        from .pip_chat import validate_text
        validate_text(run['result'].get('text'),reply=True)
    if job['current_version']!=run['manifest']['job_version']:
        raise RegistryError('stale_source','This Pip changed since the result. Prepare a fresh result first.')
    return {'run_id':run_id,'pip_id':job['id'],'workspace_id':job['workspace_id'],
            'job_version':job['current_version'],'lifecycle_revision':job['lifecycle_revision'],
            'result_digest':apps.digest(run['result'])}


def _plugin_allowed(store,payload,config):
    from . import pip_sdk_apps
    if payload['kind']=='connector_call' and pip_sdk_apps.is_app(payload['server']):
        # Your own app (Pips API 61): still registered, the same address, its change tool with the same schema,
        # and inputs that fit it. Checked when it is proposed and again before it runs.
        pip_sdk_apps.check_action(payload)
        return
    # A plugin's server is a Pip's while the plugin is installed and turned on in Settings → Plugins (pip_plugins).
    if payload['kind']=='connector_call' and payload['server'] not in connector.PROVIDERS:
        from .pip_plugins import require_server
        require_server(store.registry,payload['source']['pip_id'],payload['server'],config)


def _current(store,payload,config):
    from .pip_access import require_unrestricted
    from .pip_daemon import is_runtime_paused
    require_unrestricted(config)
    if config.get('pips_enabled',False) is not True or is_runtime_paused(store.registry):
        raise RegistryError('disabled','Pips are stopped or disabled. No external action was performed.')
    if _source(store,payload['source']['run_id'])!=payload['source']:
        raise RegistryError('stale_source','The Pip, result or lifecycle changed after review. Prepare a new message review.')
    if store._job(payload['source']['pip_id'])['status']!='active':
        raise RegistryError('paused','This Pip is paused. No external action was performed.')
    _plugin_allowed(store,payload,config)


def _row(store, action_id):
    _id(action_id,'appaction')
    row=store.db.execute('SELECT id,pip_id,workspace_id,source_run_id,status,digest,created_at,expires_at,resolved_by,resolved_at, '
        'CASE WHEN length(CAST(payload AS BLOB))<=20000 THEN payload ELSE NULL END AS payload, '
        'CASE WHEN length(CAST(receipt AS BLOB))<=2048 THEN receipt ELSE NULL END AS receipt '
        'FROM pip_app_actions WHERE id=?',(action_id,)).fetchone()
    if row is None:raise RegistryError('not_found','Saved external-action review not found.')
    try:
        result=dict(row);result['payload']=validate(json.loads(row['payload']))
        result['receipt']=json.loads(row['receipt']) if row['receipt'] is not None else None
    except (TypeError,ValueError,RecursionError) as exc:
        raise RegistryError('stored_data_limit','Saved external-action review is malformed or oversized.') from exc
    source=result['payload']['source']
    if apps.digest(result['payload'])!=result['digest'] or (row['pip_id'],row['workspace_id'],row['source_run_id'])!=(source['pip_id'],source['workspace_id'],source['run_id']):
        raise RegistryError('invalid_app_action','Saved action identity does not match its immutable payload.')
    if result['status']=='succeeded':_adapter(result['payload']['kind']).validate_receipt(result['receipt'])
    if result['status']=='succeeded' and result['payload']['kind']=='connector_call':
        if result['receipt']['provider']!=connector.provider(result['payload']['server']) or result['receipt']['tool']!=result['payload']['call']['tool']:
            raise RegistryError('invalid_connector_receipt','The receipt does not match this connector action.')
    if result['status']=='unknown' and (not isinstance(result['receipt'],dict) or set(result['receipt'])!={'meaning'}):
        raise RegistryError('invalid_send_receipt','The retained uncertain-delivery receipt is invalid.')
    result['delivery_unconfirmed']=result['status'] in ('dispatching','unknown')
    result['notice']=('Delivery unconfirmed. This attempt will not be retried. Check Gmail Sent or the Composio log before preparing another message.'
                      if result['delivery_unconfirmed'] else 'Preparing a message does not send it. Approval authorizes one exact send attempt.')
    if result['payload']['kind']=='calendar_create':
        result['notice']=('Creation unconfirmed. Do not repeat this action; check the calendar or Composio log first.'
                          if result['delivery_unconfirmed'] else 'Preparing an event does not create it. Approval authorizes one exact creation attempt, including the reviewed guests and series. Invitation delivery and acceptance are not confirmed.')
    if result['payload']['kind']=='connector_call':
        from . import pip_sdk_apps
        result['notice']=pip_sdk_apps.NOTICE if pip_sdk_apps.is_app(result['payload']['server']) else connector.NOTICE
    return result


def get(store, action_id):
    value=_row(store,action_id)
    if value['status']=='pending' and value['expires_at']<=store.registry.clock():
        with nullcontext() if store.db.in_transaction else store.registry.transaction():
            at=store.registry.clock()
            changed=store.db.execute("UPDATE pip_app_actions SET status='expired',resolved_by='expiry',resolved_at=? WHERE id=? AND status='pending'",
                             (at,action_id)).rowcount
            if changed:
                # Your own app hears that it expired (pip_sdk_app_approvals, Pips API 62).
                from .pip_sdk_app_approvals import resolved
                resolved(store,value,'expired','expiry',at)
        value=_row(store,action_id)
    if value['payload']['kind']=='connector_call':
        from .pip_sdk_app_approvals import deliveries, is_app_action
        if is_app_action(value['payload']):
            # What DGC told your app about it, try by try (Pips API 62).
            value['app_deliveries']=deliveries(store.db,action_id)
    return value


def propose(store,source_run_id,server,connection_digest,account,schema_digest,message,request_key,actor,config,*,kind="gmail_send"):
    _acting(actor)
    if kind not in ("gmail_send","calendar_create","connector_call"):raise RegistryError("invalid_app_action","Unknown external action.")
    adapter=_adapter(kind)
    content="call" if kind=="connector_call" else "event" if kind=="calendar_create" else "message"
    if not isinstance(request_key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',request_key):
        raise RegistryError('invalid_app_action','Use a stable retry key of at most 128 letters, digits, underscores or hyphens.')
    adapter.arguments(message)
    request={'source_run_id':source_run_id,'server':server,'connection_digest':connection_digest,'account':account,'schema_digest':schema_digest,content:message}
    if kind!='gmail_send':request['kind']=kind
    apps.bounded(request,MAX_PAYLOAD)
    from .redaction import contains_secret,secret_values
    if kind=='connector_call' and server not in connector.PROVIDERS:
        # A plugin's inputs name its own fields (Aave's "token" is a coin's address): only a saved
        # credential, verbatim, is refused (pip_plugins.saved_credential_in).
        from .pip_plugins import saved_credential_in
        if saved_credential_in(request,config):raise RegistryError('secret_detected','Remove configured credentials from the reviewed action.')
    elif contains_secret(request,secret_values(config)):raise RegistryError('secret_detected','Remove configured credentials from the reviewed action.')
    request_digest=apps.digest(request)
    def prior():
        row=store.db.execute('SELECT id,request_digest FROM pip_app_actions WHERE requested_by=? AND request_key=?',(actor,request_key)).fetchone()
        if row and row['request_digest']!=request_digest:raise RegistryError('conflict','This retry key was used for a different action. Review the saved action.')
        return get(store,row['id']) if row else None
    existing=prior()
    if existing:return existing
    source=_source(store,source_run_id)
    payload=validate({'schema_version':3 if kind=='connector_call' else (4 if calendar.extended(message) else 2) if kind=='calendar_create' else 1,'kind':kind,'source':source,'server':server,
                      'connection_digest':connection_digest,'account':account,'schema_digest':schema_digest,content:message})
    _acting(actor,store,payload)
    _plugin_allowed(store,payload,config)
    spec,fingerprint=apps.connection(config,server)
    if not (connector.supported(server,spec) if kind=='connector_call' else apps.supported(spec)) or fingerprint!=connection_digest:raise RegistryError('connection_changed','Inspect the selected connection again before reviewing an action.')
    with nullcontext() if store.db.in_transaction else store.registry.transaction():
        existing=prior()
        if existing:return existing
        if _source(store,source_run_id)!=source:raise RegistryError('stale_source','Source changed while preparing the action.')
        if store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0]>=MAX_ACTIONS:
            raise RegistryError('limit','The retained external-action ledger is full.')
        now=store.registry.clock();expiry=(datetime.fromisoformat(now.replace('Z','+00:00')).astimezone(timezone.utc)+timedelta(hours=24)).isoformat(timespec='milliseconds').replace('+00:00','Z')
        aid=identifier('appaction')
        store.db.execute('INSERT INTO pip_app_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (aid,source['pip_id'],source['workspace_id'],source_run_id,request_key,actor,request_digest,
             json.dumps(payload,ensure_ascii=False,separators=(',',':')),apps.digest(payload),now,expiry,'pending',None,None,None))
        store.registry.event(source['workspace_id'],'pip_app_action_proposed',pip_id=source['pip_id'],payload={'action_id':aid})
        if not str(actor).startswith(('pip-grant:','pip-level:')):
            # A review on your own app waits for a person: the app hears it too (pip_sdk_app_approvals, Pips API 62).
            # Always allow and a level decide at once, so the app hears only how it was decided.
            from .pip_sdk_app_approvals import requested
            requested(store,aid,payload,apps.digest(payload),expiry)
    return get(store,aid)


def _review(store, action_id, expected_digest, actor):
    from .pip_sdk_app_approvals import REVIEWER
    if actor==REVIEWER:raise RegistryError('local_only','External action reviews are available only in the local CLI and extension.')
    _acting(actor);value=get(store,action_id);_acting(actor,store,value['payload'])
    if not isinstance(expected_digest,str) or expected_digest!=value['digest']:
        raise RegistryError('action_conflict','Review this exact saved action before deciding.')
    return value


def _closed(value, default):
    from .pip_sdk_app_approvals import closed_words
    return RegistryError('action_resolved', closed_words(value) or default)


def reject(store, action_id, expected_digest, actor, *, by=None, outcome=None):
    """Reject a pending review. ``by`` is ``app:<name>`` when your own app decided its own action (Pips API 62); the
    user's actor still authorizes it. ``outcome['decided']`` says whether this call decided it."""
    _actor(actor)                       # rejecting is always the user's (or their own app's)
    with store.registry.transaction():
        value=_review(store,action_id,expected_digest,actor)
        if value['status']=='rejected':return value
        if value['status']!='pending':raise _closed(value,'This action review is already resolved or attempted.')
        from .pip_sdk_app_approvals import decider, resolved
        who=decider(by,value['payload'],actor);at=store.registry.clock()
        store.db.execute("UPDATE pip_app_actions SET status='rejected',resolved_by=?,resolved_at=? WHERE id=?",(who,at,action_id))
        resolved(store,value,'rejected',who,at)      # your own app hears it (Pips API 62)
        if outcome is not None:outcome['decided']=True
    return get(store,action_id)


def accept(store, action_id, expected_digest, actor, config, *, prepare=None, by=None, outcome=None):
    """Accept a pending review: one attempt, ever. ``by`` is ``app:<name>`` when your own app decided its own action
    (Pips API 62); the user's actor still authorizes it. ``outcome['decided']`` says whether this call decided it."""
    value=_review(store,action_id,expected_digest,actor)
    if value['status'] in ('dispatching','succeeded','unknown'):return value  # observe, never retry a send
    if value['status']!='pending':raise _closed(value,'This action review is no longer pending.')
    from .pip_sdk_app_approvals import decider, resolved
    who=decider(by,value['payload'],actor)
    payload=value['payload']
    adapter=_adapter(payload['kind'])
    from . import pip_sdk_apps
    if prepare is None and payload['kind']=='connector_call' and pip_sdk_apps.is_app(payload['server']):
        # Your own app: one signed POST that carries this action's id and digest (Pips API 61).
        from functools import partial
        prepare=partial(pip_sdk_apps.prepared,action_id=action_id,action_digest=value['digest'])
    prepare=prepare or adapter.prepared
    def authorize():_current(store,payload,config)
    authorize()
    with prepare(config,payload,authorize) as send:
        with store.registry.transaction():
            current=_review(store,action_id,expected_digest,actor)
            if current['status'] in ('dispatching','succeeded','unknown'):return current
            if current['status']!='pending':raise _closed(current,'The action was rejected or expired during preparation.')
            authorize()
            # Commit BEFORE calling the provider. A crash can lose the receipt,
            # but cannot make this same action eligible for a second attempt.
            at=store.registry.clock()
            store.db.execute("UPDATE pip_app_actions SET status='dispatching',resolved_by=?,resolved_at=? WHERE id=?",(who,at,action_id))
            resolved(store,current,'accepted',who,at)    # your own app hears it (Pips API 62)
            if outcome is not None:outcome['decided']=True
        try:
            receipt=adapter.validate_receipt(send());apps.bounded(receipt,2048);status='succeeded'
        except pip_sdk_apps.AppCallError as exc:
            # Your own app's words, cleaned of credentials when they were made: "the shop app said: ..." or that it
            # didn't answer. Either way the outcome is the app's to confirm, and DGC never retries.
            receipt={'meaning':exc.meaning[:1500]};status='unknown'
        except Exception:
            # Error text from providers may include message content or secrets.
            receipt={'meaning':('The connector action is unconfirmed. Check its execution log; it may still be running. DGC will not retry.' if payload['kind']=='connector_call' else 'Creation is unconfirmed. Check the calendar or Composio log. DGC will not retry this action.' if payload['kind']=='calendar_create' else 'Delivery is unconfirmed. Check Gmail Sent or the Composio execution log. DGC will not retry this action.')};status='unknown'
        with store.registry.transaction():
            store.db.execute('UPDATE pip_app_actions SET status=?,resolved_by=?,resolved_at=?,receipt=? WHERE id=? AND status=\'dispatching\'',
                (status,who,store.registry.clock(),json.dumps(receipt,ensure_ascii=False,separators=(',',':')),action_id))
            store.registry.event(payload['source']['workspace_id'],'pip_app_action_finished',pip_id=payload['source']['pip_id'],payload={'action_id':action_id,'status':status})
    return get(store,action_id)


def history(store, pip_id, before_id=None, limit=20):
    _id(pip_id,'pip');job=store._job(pip_id)
    if job['source_policy']!={'mode':'personal'}:raise RegistryError('local_only','Message reviews belong to Personal Pips.')
    if type(limit) is not int or not 1<=limit<=20:raise RegistryError('invalid_limit','Read 1–20 external-action reviews at a time.')
    params=[pip_id];where='pip_id=?'
    if before_id is not None:
        prior=get(store,before_id)
        if prior['pip_id']!=pip_id:raise RegistryError('invalid_cursor','The history cursor belongs to another Pip.')
        where+=' AND (created_at<? OR (created_at=? AND id<?))';params += [prior['created_at'],prior['created_at'],before_id]
    rows=store.db.execute('SELECT id FROM pip_app_actions WHERE '+where+' ORDER BY created_at DESC,id DESC LIMIT ?',(*params,limit+1)).fetchall()
    values=[]
    for row in rows[:limit]:
        value=get(store,row['id']);payload=value['payload']
        values.append({key:value[key] for key in ('id','pip_id','status','digest','created_at','expires_at','delivery_unconfirmed')})
        event=payload.get('event')
        from . import pip_sdk_apps
        own=payload['kind']=='connector_call' and pip_sdk_apps.is_app(payload['server'])
        values[-1].update(kind=payload['kind'],server=payload['server'],account=payload['account'],
                         subject=payload['call']['tool'] if payload['kind']=='connector_call' else event['summary'] if event else payload['message']['subject'],
                         recipient=pip_sdk_apps.display(pip_sdk_apps.name_of(payload['server'])) if own else 'Connection-managed account' if payload['kind']=='connector_call' else 'Primary calendar' if event else payload['message']['recipient_email'])
    return {'actions':values,'next_cursor':rows[limit-1]['id'] if len(rows)>limit else None}
