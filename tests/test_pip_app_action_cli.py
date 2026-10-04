"""Offline CLI review boundaries. No provider calls or sleeps."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from dgc import pip_cli

class AppActionCliTests(unittest.TestCase):
    def test_connector_call_prepares_only_and_rejects_fake_account(self):
        argv=['app-action','propose','run_saved','--kind','connector_call','--server','make','--connection-digest','a'*64,'--schema-digest','b'*64,'--request-key','one','--call-json','{"tool":"run_workflow","arguments":{"id":"123"}}']
        request=pip_cli._request(pip_cli.parser().parse_args(argv))
        self.assertEqual(request['type'],'propose_pip_connector_action');self.assertEqual(request['call']['arguments'],{'id':'123'});self.assertNotIn('account',request)
        with self.assertRaises(ValueError):pip_cli._request(pip_cli.parser().parse_args(argv+['--account','ca_fake']))
        self.assertEqual(pip_cli._request(pip_cli.parser().parse_args(['app-action','inspect','make','--kind','connector_call']))['type'],'inspect_pip_connector_actions')

    def test_calendar_json_prepares_one_event_without_acceptance(self):
        event={'summary':'Reading','description':'A chapter','start_datetime':'2026-12-01T11:00:00Z','end_datetime':'2026-12-01T11:30:00Z','timezone':'UTC'}
        args=pip_cli.parser().parse_args(['app-action','propose','run_test','--kind','calendar_create','--server','composio',
            '--connection-digest','a'*64,'--account','ca_test','--schema-digest','b'*64,'--request-key','one','--event-json',json.dumps(event)])
        request=pip_cli._request(args)
        self.assertEqual(request['type'],'propose_pip_calendar_action');self.assertEqual(request['event'],event);self.assertNotIn('message',request)
        inspect=pip_cli._request(pip_cli.parser().parse_args(['app-action','inspect','composio','--kind','calendar_create']))
        self.assertEqual(inspect['type'],'inspect_pip_calendar_connection')

    def test_message_file_has_exact_closed_request_and_no_implicit_accept(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'message.json';message={'recipient_email':'x@example.test','subject':'Note','body':'Draft'}
            path.write_text(json.dumps(message))
            args=pip_cli.parser().parse_args(['app-action','propose','run_test','--server','composio',
                '--connection-digest','a'*64,'--account','ca_test','--schema-digest','b'*64,'--request-key','once','--message-file',str(path)])
            request=pip_cli._request(args)
            self.assertEqual(request['type'],'propose_pip_app_action');self.assertEqual(request['message'],message)
            self.assertNotIn('yes',request);self.assertNotIn('action_file',request)
    def run_accept(self,*,yes=False,digest='a'*64,tty=False,response='n'):
        calls=[]
        def control(config,request,*args,**kwargs):
            calls.append(request)
            return {'ok':True,'result':{'action':{'id':'appaction_test','digest':'a'*64,'status':'pending','payload':{'kind':'gmail_send','message':{'body':'Exact reviewed body'}}}}}
        cfg=SimpleNamespace(get=lambda key,default=None:True if key=='pips_enabled' else default)
        output=io.StringIO();errors=io.StringIO()
        with patch('dgc.pips.handle_control',side_effect=control),patch('sys.stdin.isatty',return_value=tty),patch('builtins.input',return_value=response),contextlib.redirect_stdout(output),contextlib.redirect_stderr(errors):
            code=pip_cli.handle_command(cfg,['app-action','accept','appaction_test','--expected-digest',digest]+(['--yes'] if yes else []))
        return code,calls,output.getvalue()+errors.getvalue()
    def test_noninteractive_accept_requires_yes_after_exact_review(self):
        code,calls,out=self.run_accept();self.assertNotEqual(code,0);self.assertEqual([c['type'] for c in calls],['get_pip_app_action']);self.assertIn('Exact reviewed body',out)
        code,calls,out=self.run_accept(yes=True);self.assertEqual(code,0);self.assertEqual([c['type'] for c in calls],['get_pip_app_action','accept_pip_app_action']);self.assertEqual(calls[-1]['expected_digest'],'a'*64)
    def test_cancel_and_wrong_digest_never_send(self):
        code,calls,out=self.run_accept(tty=True,response='n');self.assertEqual(code,0);self.assertEqual(len(calls),1);self.assertIn('Cancelled',out)
        code,calls,out=self.run_accept(yes=True,digest='b'*64);self.assertNotEqual(code,0);self.assertEqual(len(calls),1)

class EmailDraftCliTests(unittest.TestCase):
    message={'recipient_email':'review@example.invalid','subject':'Plan','body':'Walk and read.'}
    def prepare(self,*,digest='a'*64,message=None):
        calls=[]
        def control(config,request,*args,**kwargs):
            calls.append(request)
            return {'ok':True,'result':{'draft':{'digest':'a'*64,'payload':{'message':self.message}}}}
        cfg=SimpleNamespace(get=lambda key,default=None:True if key=='pips_enabled' else default)
        argv=['email-draft','prepare','maildraft_test','--expected-digest',digest,'--server','composio',
              '--connection-digest','b'*64,'--account','ca_test','--schema-digest','c'*64]
        if message is not None:argv+=['--message-json',json.dumps(message)]
        with patch('dgc.pips.handle_control',side_effect=control),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            status=pip_cli.handle_command(cfg,argv)
        return status,calls
    def test_preparation_reads_exact_draft_and_never_accepts(self):
        status,calls=self.prepare();self.assertEqual(status,0)
        self.assertEqual([c['type'] for c in calls],['get_pip_message_draft','prepare_pip_message_draft'])
        self.assertEqual(calls[-1]['message'],self.message)
    def test_wrong_digest_stops_before_preparation(self):
        status,calls=self.prepare(digest='d'*64);self.assertNotEqual(status,0)
        self.assertEqual([c['type'] for c in calls],['get_pip_message_draft'])
    def test_explicit_edit_is_prepared_without_acceptance(self):
        edited={**self.message,'body':'Edited draft.'};status,calls=self.prepare(message=edited)
        self.assertEqual(status,0);self.assertEqual([c['type'] for c in calls],['prepare_pip_message_draft'])
        self.assertEqual(calls[0]['message'],edited)
    def test_list_and_dismiss_have_closed_requests(self):
        args=pip_cli.parser().parse_args(['email-draft','list','pip_test','--limit','3'])
        request=pip_cli._request(args);self.assertEqual(request['type'],'list_pip_message_drafts');self.assertEqual(request['limit'],3)
        args=pip_cli.parser().parse_args(['email-draft','dismiss','maildraft_test','--expected-digest','a'*64])
        request=pip_cli._request(args);self.assertEqual(request['type'],'dismiss_pip_message_draft');self.assertNotIn('message',request)

class CalendarDraftCliTests(unittest.TestCase):
    def test_prepare_fetches_exact_draft_without_creation(self):
        event={'summary':'Reading','description':'One chapter','start_datetime':'2026-12-01T11:00:00Z','end_datetime':'2026-12-01T11:30:00Z','timezone':'UTC'}
        calls=[]
        def control(config,request,*args,**kwargs):
            calls.append(request)
            return {'ok':True,'result':{'draft':{'digest':'a'*64,'payload':{'event':event}}}}
        cfg=SimpleNamespace(get=lambda key,default=None:True if key=='pips_enabled' else default)
        argv=['calendar-draft','prepare','caldraft_test','--expected-digest','a'*64,'--server','composio','--connection-digest','b'*64,'--account','ca_test','--schema-digest','c'*64]
        with patch('dgc.pips.handle_control',side_effect=control),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            code=pip_cli.handle_command(cfg,argv)
        self.assertEqual(code,0);self.assertEqual([c['type'] for c in calls],['get_pip_calendar_draft','prepare_pip_calendar_draft'])
        self.assertEqual(calls[-1]['event'],event);self.assertNotIn('message',calls[-1])

class ConnectorDraftCliTests(unittest.TestCase):
    def test_cli_uses_saved_tool_and_connection_and_never_implies_execution(self):
        argv=['connector-draft','prepare','conndraft_test','--expected-digest','a'*64]
        request=pip_cli._request(pip_cli.parser().parse_args(argv))
        self.assertEqual(set(request),{'type','request_id','draft_id','expected_digest'});self.assertEqual(request['type'],'prepare_pip_connector_draft')
        call={'tool':'save_note','arguments':{'title':'Plan'}}
        changed=pip_cli._request(pip_cli.parser().parse_args(argv+['--call-json',json.dumps(call)]));self.assertEqual(changed['call'],call)
        for action in ('list','show','dismiss'):
            request=pip_cli._request(pip_cli.parser().parse_args(['connector-draft',action,'pip_test' if action=='list' else 'conndraft_test']+(['--expected-digest','a'*64] if action=='dismiss' else [])))
            self.assertEqual(request['type'],{'list':'list_pip_connector_drafts','show':'get_pip_connector_draft','dismiss':'dismiss_pip_connector_draft'}[action])
