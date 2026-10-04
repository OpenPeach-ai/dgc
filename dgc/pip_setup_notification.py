"""Verified editor approval receipts, delivered without impersonating the user."""
import json
import re
import sqlite3
from contextlib import nullcontext
from .workspace_registry import WorkspaceRegistry, RegistryError

PREFIX = '[DGC saved Pip setup]\n'
FIELDS = {'setup_id', 'pip_id', 'name', 'pip_type', 'run_id'}

def valid_notice(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        return None
    for key, prefix in (('setup_id', 'setup'), ('pip_id', 'pip')):
        if not isinstance(value[key], str) or not re.fullmatch(prefix + r'_[a-f0-9]{32}', value[key]):
            return None
    if value['run_id'] is not None and (not isinstance(value['run_id'], str) or not re.fullmatch(r'run_[a-f0-9]{32}', value['run_id'])):
        return None
    if value['pip_type'] not in ('core','scout','lens','patch','rook','pulse','lock','quill'):
        return None
    if not isinstance(value['name'], str) or not 1 <= len(value['name']) <= 200:
        return None
    return dict(value)

def decode(text):
    value = valid_notice(json.loads(text.split('\n', 2)[1]))
    if value is None:
        raise ValueError('Invalid saved Pip setup notice')
    return value

def legacy_notice(content, session_id, project_root):
    """Display an old generated receipt honestly, without rewriting its transcript.

    A phrase alone is insufficient: require the exact saved receipt and owner.
    This is presentation only and never delivers, approves or executes anything.
    """
    if not isinstance(content,str) or len(content)>16384:
        return None
    match=re.search(r'(?:^|\n\n)I approved Pip setup (setup_[a-f0-9]{32}) for ',content)
    if not match or '. The saved receipt is ' not in content:
        return None
    try:
        raw=content.split('. The saved receipt is ',1)[1]
        receipt,end=json.JSONDecoder().raw_decode(raw)
        suffix = '. Read its current status and continue our conversation.'
        guard = ' The setup is already applied; do not create a duplicate Pip or treat this as permission for additional work.'
        if not re.fullmatch(re.escape(suffix) + '(?:' + re.escape(guard) + ')?'
                            + r'(?:\n\n<dgc-now>Local time: [^<>\n]{1,100}</dgc-now>)?', raw[end:]):
            return None
        with WorkspaceRegistry() as registry:
            from . import pip_setup
            workspace=registry.lookup(project_root)
            if workspace is None:return None
            setup=pip_setup.get(registry,match[1],workspace['id'])
            row=registry.db.execute('SELECT session_id FROM pip_setup_proposals WHERE id=?',(match[1],)).fetchone()
            if row is None or row['session_id']!=session_id or setup['status']!='accepted' or receipt!=setup['receipt']:
                return None
            return valid_notice({'setup_id':setup['id'],'pip_id':receipt['pip_id'],
                'run_id':receipt['run_id'],'name':setup['name'],'pip_type':setup['pip_type']})
    except (RegistryError,ValueError,KeyError,TypeError,OSError,sqlite3.Error):
        return None

def notify(backend, config, request):
    if set(request) - {'type','request_id','setup_id'} or config.get('pips_enabled',False) is not True:
        raise RegistryError('invalid_request','Pip approval notifications require an enabled local session and one setup ID.')
    if config.get('subscription_engine',''):
        raise RegistryError('unsupported','Setup is saved. Background approval notices currently require a native DGC model session.')
    session = getattr(backend.agent, 'session_file', None)
    if session is None:
        raise RegistryError('session_required','Open the conversation that proposed this setup.')
    with WorkspaceRegistry() as registry:
        from . import pip_setup
        workspace = registry.resolve(config.project_root)
        setup = pip_setup.get(registry, request.get('setup_id'), workspace['id'])
        owner = registry.db.execute('SELECT session_id FROM pip_setup_proposals WHERE id=?',(setup['id'],)).fetchone()
        if owner is None or owner['session_id'] != session.stem:
            raise RegistryError('session_mismatch','Notify the conversation that originally proposed this setup.')
        if setup['status'] != 'accepted' or not setup['receipt'].get('accepted'):
            raise RegistryError('approval_required','This setup has not been approved. No model notification was queued.')
        notice = valid_notice({'setup_id':setup['id'],'pip_id':setup['receipt']['pip_id'],
                               'name':setup['name'],'pip_type':setup['pip_type'],'run_id':setup['receipt']['run_id']})
        if notice is None:
            raise RegistryError('invalid_receipt','The saved approval receipt is invalid.')
    # Session/root changes use the dispatch guard. Recheck after the SQLite read
    # so a slow approval lookup cannot wake the newly selected conversation.
    with backend._dispatch_guard() if hasattr(backend, "_dispatch_guard") else nullcontext():
        current_config = getattr(backend, 'config', config)
        if (getattr(backend.agent, 'session_file', None) != session
                or current_config.project_root != config.project_root):
            raise RegistryError('session_mismatch', 'The conversation changed. Reopen the proposing chat to notify it.')
        if current_config.get('pips_enabled',False) is not True or current_config.get('subscription_engine',''):
            raise RegistryError('unsupported', 'Setup is saved. Reconnect an enabled native DGC chat to notify it.')
        with backend._turn_state_lock() if hasattr(backend, "_turn_state_lock") else nullcontext():
            # Ownership comes from real pending/delivered inputs, not a sticky "seen" set:
            # Stop may drop a queued receipt, in which case Retry must be able to deliver it.
            pending = [item[0] for item in getattr(backend, '_queue', []) if len(item)>3 and item[3]=='pip_setup']
            pending += [item[0] for item in getattr(backend, '_steer_payloads', {}).values() if len(item)>4]
            pending += [getattr(backend, '_running_pip_setup_text', None)]
            for text in pending:
                if isinstance(text, str) and text.startswith(PREFIX) and decode(text)['setup_id']==notice['setup_id']:
                    return {'notification':'already_notified','setup_id':notice['setup_id']}
            if any(isinstance(m,dict) and isinstance(m.get('_dgc_pip_setup'),dict)
                and m['_dgc_pip_setup'].get('setup_id') == notice['setup_id'] for m in getattr(backend.agent,'messages',[]) or []):
                return {'notification':'already_notified','setup_id':notice['setup_id']}
            text = PREFIX + json.dumps(notice,ensure_ascii=False,separators=(',',':')) + '\n' + (
                'Controller notification, not a new user message. The user approved this exact setup; it is already saved. '
                'Do not recreate it, request another run, or infer success from a queued run. Read current status if useful. '
                'Continue the existing task. Keep unanswered questions open; this receipt is not an answer or permission for other work.')
            state, _ = backend._start_turn(text, delivery='steer', kind='pip_setup')
            if state not in ('started','queued','steered'):
                raise RegistryError('busy','Setup is saved. The chat cannot receive its notification yet; retry shortly.')
            return {'notification':state,'setup_id':notice['setup_id']}
