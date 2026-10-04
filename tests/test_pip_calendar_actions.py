"""Offline calendar creation. No network, credentials, sleeps or provider writes."""
import copy
import json
from pathlib import Path
from datetime import datetime,timezone
import unittest
import threading
from contextlib import contextmanager
from unittest.mock import patch
from dgc import pip_calendar_actions as cal,pip_app_actions as actions,pip_app_access as apps,pips
from dgc.workspace_registry import RegistryError,WorkspaceRegistry
from dgc import workspace_registry
from tests import test_pip_app_actions as fixtures

EVENT={'summary':'Quiet reading','description':'Read <one> chapter & make notes.',
       'start_datetime':'2026-12-01T11:00:00+05:30','end_datetime':'2026-12-01T11:30:00+05:30','timezone':'Asia/Kolkata'}

class CalendarManager(fixtures.Manager):
    def __init__(self):
        super().__init__()
        self.input=json.loads((Path(__file__).parent/'fixtures/composio-calendar-create-20261004.json').read_text())
    def call(self,name,args,**kw):
        self.calls.append((name,copy.deepcopy(args)))
        if name=='schema':return json.dumps({'successful':True,'error':None,'data':{'tool_schemas':{cal.TOOL:{'tool_slug':cal.TOOL,'input_schema':self.input}}}})
        if self.send_error:raise self.send_error
        if self.send_result is not None:return self.send_result
        event=args['tools'][0]['arguments']
        return json.dumps({'successful':True,'error':None,'data':{'success':True,'results':[{'tool_slug':cal.TOOL,'response':{'successful':True,'error':None,'data':{'id':'abc123','status':'confirmed','summary':event['summary'],'start':{'dateTime':event['start_datetime']},'end':{'dateTime':event['end_datetime']}}}}]}})

class CalendarActionTests(unittest.TestCase):
    prepare_source=fixtures.AppActionTests.prepare_source
    def setUp(self):
        fixtures.AppActionTests.setUp(self)
        self.manager=CalendarManager();self.factory=lambda *a:self.manager
        self.inspection=cal.inspect(self.cfg,'composio',manager_factory=self.factory,clock=lambda:0)
        self.manager.calls.clear()
    def propose(self,**kw):
        args=dict(source_run_id=self.run['id'],server='composio',connection_digest=self.inspection['connection_digest'],account='ca_test',schema_digest=self.inspection['schema_digest'],message=EVENT,request_key='calendar',actor='local-console',config=self.cfg,kind='calendar_create')
        args.update(kw);return actions.propose(self.store,**args)
    def prepare(self,c,p,a,**kw):
        return cal.prepared(c,p,a,manager_factory=self.factory,servers_reader=lambda c:c.get('mcp_servers'),clock=lambda:0,utcnow=kw.get('utcnow',lambda:datetime(2026,10,4,tzinfo=timezone.utc)))
    def accept(self,saved):return actions.accept(self.store,saved['id'],saved['digest'],'local-console',self.cfg,prepare=self.prepare)
    def writes(self):return [args for name,args in self.manager.calls if name=='execute']
    def test_metadata_matches_actual_schema_and_never_executes(self):
        self.assertEqual(self.inspection['tool'],cal.TOOL)
        self.assertEqual(self.writes(),[])
        self.assertEqual(self.manager.input['properties']['send_updates']['type'],'string')
        self.assertTrue(self.manager.input['properties']['create_meeting_room']['default'])
    def test_exact_saved_calendar_review_creates_once(self):
        saved=self.propose();self.assertEqual(saved['payload']['schema_version'],2)
        self.assertEqual(saved['payload']['event'],EVENT);self.assertEqual(self.writes(),[])
        value=self.accept(saved);self.assertEqual(value['status'],'succeeded')
        self.assertEqual(value['receipt']['provider'],'Google Calendar')
        args=self.writes()[0]['tools'][0];self.assertEqual(args['account'],'ca_test');self.assertEqual(args['tool_slug'],cal.TOOL)
        self.assertEqual(args['arguments'],cal.arguments(EVENT))
        self.assertEqual(args['arguments']['attendees'],[]);self.assertEqual(args['arguments']['recurrence'],[])
        self.assertFalse(args['arguments']['create_meeting_room']);self.assertEqual(args['arguments']['send_updates'],'none')
        self.assertEqual(args['arguments']['description'],'Read &lt;one&gt; chapter &amp; make notes.')
        self.assertEqual(self.accept(saved),value);self.assertEqual(len(self.writes()),1)
    def test_invalid_dates_offsets_dst_and_fields_refused_before_connection(self):
        variants=[{'attendees':['x@example.invalid']},{'create_meeting_room':True},{'summary':'x\u202ey'},
            {'start_datetime':'tomorrow'},{'start_datetime':'2026-12-01T11:00:00'},
            {'start_datetime':'2026-12-01T11:00:00+04:90'},
            {'end_datetime':EVENT['start_datetime']},{'end_datetime':'2026-12-10T11:00:00+05:30'},
            {'timezone':'EST'},{'timezone':'../etc/passwd'},{'timezone':'Europe/London'},
            {'start_datetime':'2026-03-08T02:30:00-05:00','end_datetime':'2026-03-08T03:30:00-04:00','timezone':'America/New_York'},
            {'description':'界'*3000},{'description':'\ud800'}]
        for fields in variants:
            with self.subTest(fields=fields),self.assertRaises(RegistryError):self.propose(message={**EVENT,**fields})
        self.assertEqual(self.manager.calls,[])
    def test_ambiguous_dst_requires_explicit_offset_and_respects_elapsed_time(self):
        event={**EVENT,'start_datetime':'2026-11-01T01:30:00-04:00','end_datetime':'2026-11-01T01:30:00-05:00','timezone':'America/New_York'}
        self.assertEqual(cal.arguments(event)['end_datetime'],event['end_datetime'])
    def test_passed_start_stays_pending_no_automatic_rescheduling(self):
        saved=self.propose()
        with self.assertRaisesRegex(RegistryError,'start time has passed'):
            actions.accept(self.store,saved['id'],saved['digest'],'local-console',self.cfg,prepare=lambda c,p,a:self.prepare(c,p,a,utcnow=lambda:datetime(2027,1,1,tzinfo=timezone.utc)))
        self.assertEqual(actions.get(self.store,saved['id'])['status'],'pending');self.assertEqual(self.manager.calls,[])
    def test_changed_schema_and_removed_connection_refuse_before_dispatch(self):
        saved=self.propose();self.manager.input['properties']['send_updates']['type']='boolean'
        with self.assertRaises(RegistryError):self.accept(saved)
        self.assertEqual(self.writes(),[]);self.assertEqual(actions.get(self.store,saved['id'])['status'],'pending')
    def test_ambiguous_response_consumes_attempt_and_does_not_echo_error(self):
        saved=self.propose();self.manager.send_error=TimeoutError('private contents')
        value=self.accept(saved);self.assertEqual(value['status'],'unknown');self.assertNotIn('private contents',json.dumps(value))
        self.assertEqual(self.accept(saved),value);self.assertEqual(len(self.writes()),1)
    def test_crash_after_claim_never_retries(self):
        saved=self.propose();self.manager.send_error=SystemExit('crash')
        with self.assertRaises(SystemExit):self.accept(saved)
        self.assertEqual(self.accept(saved)['status'],'dispatching');self.assertEqual(len(self.writes()),1)
    def test_remote_and_model_cannot_propose_calendar_actions(self):
        request={'type':'propose_pip_calendar_action','request_id':'calendar-control','source_run_id':self.run['id'],
                 **{k:self.inspection[k] for k in ('server','connection_digest','schema_digest')},'account':'ca_test','event':EVENT,'request_key':'control'}
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)):
            for actor in ('model','remote-device'):
                value=pips.handle_control(self.cfg,request,actor,start_worker=False)
                self.assertFalse(value['ok']);self.assertEqual(value['error']['code'],'local_only')
            value=pips.handle_control(self.cfg,request,'editor-user',start_worker=False)
            self.assertTrue(value['ok'],value);self.assertEqual(value['result']['action']['payload']['event'],EVENT)
    def test_schema27_migration_preserves_rows_and_old_reader_refuses(self):
        saved=self.propose(kind='gmail_send',message=self.message,request_key='legacy');before=[tuple(r) for r in self.store.db.execute('SELECT * FROM pip_app_actions')]
        self.store.db.execute('DROP TABLE pip_connector_drafts');self.store.db.execute('DROP TABLE pip_calendar_drafts');self.store.db.execute('PRAGMA user_version=27')
        with WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0],workspace_registry.SCHEMA_VERSION)
            self.assertEqual([tuple(r) for r in upgraded.db.execute('SELECT * FROM pip_app_actions')],before)
        import dgc.workspace_registry as registry
        with patch.object(registry,'SCHEMA_VERSION',27),self.assertRaisesRegex(RegistryError,'compatible DGC version'):
            WorkspaceRegistry(self.registry.directory)
    def test_calendar_history_and_reject_preserve_exact_kind(self):
        saved=self.propose();page=actions.history(self.store,self.source['id'])
        self.assertEqual(page['actions'][0]['kind'],'calendar_create');self.assertEqual(page['actions'][0]['subject'],EVENT['summary'])
        self.assertEqual(actions.reject(self.store,saved['id'],saved['digest'],'local-console')['status'],'rejected')
        with self.assertRaises(RegistryError):self.accept(saved)
        self.assertEqual(self.writes(),[])
    def test_two_calendar_approvers_make_only_one_provider_call(self):
        saved=self.propose();barrier=threading.Barrier(2);calls=[];errors=[];outcomes=[]
        @contextmanager
        def prepare(c,p,a):
            barrier.wait(timeout=5)
            def create():
                calls.append('created')
                return {'provider':'Google Calendar','event_id':'abc123','meaning':cal.ACCEPTED}
            yield create
        def approve():
            try:
                with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as registry:
                    outcomes.append(actions.accept(pips.PipStore(registry),saved['id'],saved['digest'],'editor-user',self.cfg,prepare=prepare)['status'])
            except BaseException as exc:errors.append(exc)
        threads=[threading.Thread(target=approve) for _ in range(2)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads));self.assertEqual(errors,[])
        self.assertEqual(calls,['created']);self.assertEqual(len(outcomes),2)
    def test_mismatched_provider_event_is_unknown_and_never_retried(self):
        for field,value in [('summary','Another event'),('status','cancelled'),('id','invalid!'),
                            ('start',{'dateTime':'2026-12-01T12:00:00+05:30'})]:
            with self.subTest(field=field):
                self.manager.send_result=None
                raw=json.loads(self.manager.call('execute',{'tools':[{'arguments':cal.arguments(EVENT)}]}))
                raw['data']['results'][0]['response']['data'][field]=value
                self.manager.calls.clear();self.manager.send_result=json.dumps(raw)
                saved=self.propose(request_key=field)
                result=self.accept(saved);self.assertEqual(result['status'],'unknown')
                self.assertEqual(self.accept(saved),result);self.assertEqual(len(self.writes()),1)
    def test_revocation_during_calendar_discovery_blocks_creation(self):
        saved=self.propose();original=self.manager.call
        def call(name,args,**kw):
            answer=original(name,args,**kw)
            if name=='schema':actions.reject(self.store,saved['id'],saved['digest'],'local-console')
            return answer
        with patch.object(self.manager,'call',call),self.assertRaises(RegistryError):self.accept(saved)
        self.assertEqual(self.writes(),[])
