"""Main-chat email draft tool. Saves reference text; never selects accounts or sends."""
import hashlib
import json
import re
from .workspace_registry import WorkspaceRegistry,RegistryError,canonical_directory
from . import pip_message_drafts as drafts


def propose(args,ctx,*,kind='email'):
    _,_,content,_=drafts._spec(kind)
    from .pip_access import require_unrestricted
    require_unrestricted(ctx.config)
    if ctx.config.get('pips_enabled',False) is not True:raise RegistryError('disabled','Pips is disabled.')
    if not isinstance(args,dict) or set(args)!={'scope','source_run_id',content,'request_key'} or args['scope']!='personal':
        raise RegistryError('invalid_request','Use explicit Personal scope, a completed source run, draft content and retry key. No account or permission fields.')
    from .pip_app_actions import _id
    _id(args['source_run_id'],'run')
    if not isinstance(args['request_key'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',args['request_key']):raise RegistryError('invalid_request','Use a 1–64 character retry key.')
    from .redaction import secret_values
    message=drafts.validate_message(args[content],secret_values(ctx.config),kind=kind)
    callback=getattr(ctx,'pip_proposal_origin',None)
    if not callable(callback):raise RegistryError('session_required','Drafts require an owning local main chat.')
    origin=callback()
    with WorkspaceRegistry() as registry:
        workspace=registry.lookup(canonical_directory(ctx.project_root))
        def check():
            if workspace is None or not isinstance(origin,dict) or set(origin)!={'session_id','workspace_id'} or origin['workspace_id']!=workspace['id'] or not isinstance(origin['session_id'],str):
                raise RegistryError('session_required','This chat does not match the local workspace.')
            identity=registry.session_identity(origin['session_id'])
            if identity is None or identity['workspace_id']!=workspace['id'] or identity['workspace_binding_id']!=registry.binding(workspace['id'])['id']:
                raise RegistryError('session_required','This chat no longer matches its local workspace binding.')
            from .pip_run_tool import personal_workspace
            personal=personal_workspace(registry)
            source=registry.db.execute('SELECT workspace_id FROM pip_runs WHERE id=?',(args['source_run_id'],)).fetchone()
            if source is None or source[0]!=personal['id']:raise RegistryError('not_found','Choose a completed result from this profile’s Personal Pips.')
        check()  # Before private result parsing.
        actor='main-'+kind+':'+hashlib.sha256(origin['session_id'].encode()).hexdigest()[:32]
        key=hashlib.sha256(json.dumps([origin['session_id'],args['source_run_id'],args['request_key']]).encode()).hexdigest()
        from .pips import PipStore
        store=PipStore(registry)
        if kind=='connector' and not store.db.execute('SELECT 1 FROM pip_connector_drafts WHERE actor=? AND request_key=?',(actor,key)).fetchone():
            from .pip_connector_drafts import check_current
            check_current(message,ctx.config)
        saved=drafts.save(store,args['source_run_id'],message,actor,key,origin_check=check,kind=kind)
        pip=store._job(saved['pip_id'])
        return json.dumps({'draft_id':saved['id'],'pip_id':saved['pip_id'],'pip_name':pip['name'],
            'workspace_id':saved['workspace_id'],'digest':saved['digest'],'status':saved['status'],
            'account_selected':False,'send_authorized':False,'create_authorized':False,'execute_authorized':False,'draft_kind':kind,'message':('Connector draft saved. Review it in this Personal Pip chat, edit exact inputs and separately approve Run once. Nothing ran.' if kind=='connector' else 'Calendar draft saved. Open this Personal Pip’s chat to review it. Choose an account and separately approve Create once. No event was created.' if kind=='calendar' else 'Email draft saved. Open this Personal Pip’s chat and review the email draft. Choose an account and separately review Send once. Nothing was sent.')})
