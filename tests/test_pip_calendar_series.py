"""Finite calendar series and explicit guests; offline, no sleeps or app access."""
import copy
import json
import unittest
from unittest.mock import patch
from dgc import pip_calendar_actions as cal,pip_app_actions as actions,pip_message_drafts as drafts
from dgc.workspace_registry import RegistryError,WorkspaceRegistry
from tests.test_pip_calendar_actions import CalendarActionTests,EVENT

EXT={**EVENT,'attendees':['friend@example.invalid'],'repeat':{'frequency':'weekly','interval':1,'count':4},'send_invitations':True}

def response(event=EXT):
    args=cal.arguments(event)
    return {'successful':True,'error':None,'data':{'success':True,'results':[{'tool_slug':cal.TOOL,'response':{'successful':True,'error':None,'data':{
        'id':'abc123','status':'confirmed','summary':event['summary'],
        'start':{'dateTime':event['start_datetime'],'timeZone':event['timezone']},
        'end':{'dateTime':event['end_datetime'],'timeZone':event['timezone']},
        'attendees':[{'email':email,'responseStatus':'needsAction'} for email in args['attendees']],
        'recurrence':args['recurrence']}}}]}}

def data(raw):return raw['data']['results'][0]['response']['data']

class CalendarSeriesTests(unittest.TestCase):
    setUp=CalendarActionTests.setUp
    prepare_source=CalendarActionTests.prepare_source
    propose=CalendarActionTests.propose
    prepare=CalendarActionTests.prepare
    accept=CalendarActionTests.accept
    writes=CalendarActionTests.writes
    def test_finite_series_and_guests_are_saved_and_dispatched_once(self):
        saved=self.propose(message=EXT)
        self.assertEqual(saved['payload']['schema_version'],4);self.assertEqual(self.manager.calls,[])
        self.manager.send_result=json.dumps(response())
        result=self.accept(saved);self.assertEqual(result['status'],'succeeded')
        self.assertEqual(self.accept(saved),result);self.assertEqual(len(self.writes()),1)
        args=self.writes()[0]['tools'][0]['arguments']
        self.assertEqual(args['send_updates'],'all');self.assertEqual(args['attendees'],EXT['attendees'])
        self.assertEqual(args['recurrence'],['RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4'])
        self.assertNotIn('repeat',args);self.assertNotIn('send_invitations',args)
        self.assertFalse(args['guestsCanInviteOthers']);self.assertFalse(args['create_meeting_room'])
        self.assertNotIn('delivered',result['receipt']['meaning'])
    def test_draft_has_no_account_and_prepares_version4_without_dispatch(self):
        draft=drafts.save(self.store,self.run['id'],EXT,'main-calendar:'+'a'*32,'b'*64,kind='calendar')
        self.assertEqual(draft['payload']['event'],EXT);self.assertNotIn('account',draft['payload'])
        a=drafts.prepare(self.store,draft['id'],draft['digest'],'composio',self.inspection['connection_digest'],'ca_test',self.inspection['schema_digest'],EXT,'editor-user',self.cfg,kind='calendar')
        self.assertEqual(a['payload']['schema_version'],4);self.assertEqual(self.manager.calls,[])
    def test_partial_or_unbounded_or_hidden_additions_refused(self):
        changes=[{'send_invitations':False},{'send_invitations':1},{'attendees':[]},{'attendees':['a@example.invalid','A@example.invalid']},
            {'attendees':[' a@example.invalid']},{'attendees':['Name <a@example.invalid>']},{'attendees':[None]},
            {'attendees':['a@example.invalid']*11},{'attendees':['a@example.invalid\nb@example.invalid']},
            {'repeat':[]},{'repeat':'RRULE:FREQ=DAILY'}, {'repeat':{'frequency':'daily','interval':1}},
            {'repeat':{'frequency':'daily','interval':True,'count':4}}, {'repeat':{'frequency':'daily','interval':1,'count':53}},
            {'repeat':{'frequency':'yearly','interval':1,'count':2}}, {'repeat':{'frequency':'monthly','interval':13,'count':4}},
            {'repeat':{'frequency':'daily','interval':1,'count':4,'until':'forever'}}]
        for change in changes:
            with self.subTest(change=change),self.assertRaises(RegistryError):self.propose(message={**EXT,**change})
        for field in cal.OPTIONS:
            value=dict(EXT);del value[field]
            with self.assertRaises(RegistryError):cal.arguments(value)
        self.assertEqual(self.manager.calls,[])
    def test_non_guest_finite_series_and_single_invitation(self):
        e={**EXT,'attendees':[],'send_invitations':False}
        self.assertEqual(cal.arguments(e)['send_updates'],'none')
        self.assertEqual(cal.result(json.dumps(response(e)),e)['provider'],'Google Calendar')
        e={**EXT,'repeat':None}
        self.assertEqual(cal.arguments(e)['recurrence'],[])
        self.assertEqual(cal.result(json.dumps(response(e)),e)['provider'],'Google Calendar')
    def test_exact_receipt_rejects_missing_extra_guests_rules_and_zones(self):
        changes=[{'attendees':[]},{'attendeesOmitted':True},{'attendees':[{'email':'wrong@example.invalid'}]},
            {'attendees':[{'email':EXT['attendees'][0],'additionalGuests':1}]},
            {'attendees':[{'email':EXT['attendees'][0]},{'email':EXT['attendees'][0]}]},
            {'recurrence':[]},{'recurrence':['RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=5']},
            {'recurrence':['RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=4','EXDATE:20261208']},
            {'start':{'dateTime':EXT['start_datetime'],'timeZone':'UTC'}}]
        for change in changes:
            raw=response();data(raw).update(change)
            with self.subTest(change=change),self.assertRaises(ValueError):cal.result(json.dumps(raw),EXT)
    def test_rule_order_is_not_semantics_and_only_self_organizer_can_be_extra(self):
        raw=response();value=data(raw);value['recurrence']=['RRULE:COUNT=4;FREQ=WEEKLY;INTERVAL=1']
        value['organizer']={'email':'owner@example.invalid','self':True}
        value['attendees'].append({'email':'owner@example.invalid','self':True,'organizer':True})
        self.assertEqual(cal.result(json.dumps(raw),EXT)['event_id'],'abc123')
        value['attendees'][-1]['self']=False
        with self.assertRaises(ValueError):cal.result(json.dumps(raw),EXT)
    def test_uncertain_series_never_retried_and_guests_cannot_change_under_same_key(self):
        saved=self.propose(message=EXT)
        with self.assertRaises(RegistryError):self.propose(message={**EXT,'attendees':['other@example.invalid']})
        raw=response();data(raw)['recurrence']=[];self.manager.send_result=json.dumps(raw)
        result=self.accept(saved);self.assertEqual(result['status'],'unknown')
        self.assertEqual(self.accept(saved),result);self.assertEqual(len(self.writes()),1)
    def test_version2_cannot_hide_guests_and_schema31_reader_refuses(self):
        saved=self.propose(message=EXT);payload=copy.deepcopy(saved['payload']);payload['schema_version']=2
        with self.assertRaises(RegistryError):actions.validate(payload)
        import dgc.workspace_registry as registry
        with patch.object(registry,'SCHEMA_VERSION',31),self.assertRaises(RegistryError):WorkspaceRegistry(self.registry.directory)
    def test_main_and_own_chat_share_exact_event_schema(self):
        from dgc.tools import TOOL_SCHEMAS
        own=drafts.schema(kind='calendar')['function']['parameters']
        main=next(t for t in TOOL_SCHEMAS if t['function']['name']=='draft_pip_calendar_event')['function']['parameters']['properties']['event']
        self.assertEqual(own,main);self.assertIn('repeat',own['properties'])

if __name__=='__main__':unittest.main()
