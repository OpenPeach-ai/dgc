"""Personal scope is private profile state, independent of the active project."""
import json
import os
import unittest
from unittest.mock import patch
from dgc import pips, pip_chat, pip_sources
from dgc.workspace_registry import WorkspaceRegistry, RegistryError
from tests import test_pips_local as fixtures

class PersonalTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def make(self, role='rook'):
        ws = self.registry.personal()
        return self.store.create(ws['id'], 'Daily helper', 'Help plan my day', 'user', pip_type=role)

    def test_shared_profile_not_current_directory(self):
        first=self.registry.personal()
        other=self.base/'other';other.mkdir()
        self.registry.resolve(other)
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(first['id'],reopened.personal()['id'])
            self.assertEqual(reopened.get(first['id'])['kind'],'personal')
            self.assertNotEqual(reopened.binding(first['id'])['canonical_root'],str(other))
        with WorkspaceRegistry(self.base/'different-profile') as different:
            self.assertNotEqual(first['id'],different.personal()['id'])

    def test_cannot_rebind_or_inherit_source(self):
        job=self.make()
        with self.assertRaises(RegistryError):
            self.registry.rebind(job['workspace_id'],self.root,expected_root=self.registry.directory/'personal')
        with self.assertRaises(RegistryError):
            self.store.propose(job['id'],1,{'source_policy':'committed_only'},'user')
        project=self.store.create(self.workspace['id'],'Project','Review','user')
        with self.assertRaises(RegistryError):
            self.store.propose(project['id'],1,{'source_policy':{'mode':'personal'}},'user')

    def test_private_root_rejects_symlink(self):
        (self.registry.directory/'personal').symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(RegistryError):self.registry.personal()

    def test_chat_no_git_no_source_no_mcp_with_saved_continuity(self):
        job=self.make()
        (self.root/'secret.txt').write_text('project-private')
        with patch.object(pips,'source_revision',side_effect=AssertionError('No Git')):
            sent=pip_chat.send(self.store,job['id'],'Help me plan tomorrow','hello','user',self.cfg)
        manifest=sent['run']['manifest']
        self.assertEqual(manifest['source_policy'],{'mode':'personal'})
        self.assertEqual(manifest['tools'],[])
        self.assertIsNone(manifest['source_revision'])
        self.assertNotIn('project-private',json.dumps(manifest))
        self.store.claim_next()
        self.store.finish(sent['run']['id'],result={'text':'What commitments should we include?'})
        with WorkspaceRegistry(self.registry.directory) as reopened:
            page=pip_chat.list_messages(pips.PipStore(reopened),job['id'])
        self.assertEqual(len(page['messages']),2)

    def test_personal_job_queue_and_role_does_not_grant_commands(self):
        for role in ['rook','scout','lens','patch','pulse','lock','quill']:
            job=self.make(role)
            run=self.store.enqueue(job['id'],'run','user',self.cfg)
            self.assertEqual(run['manifest']['run_kind'],'personal_task')
            self.assertEqual(run['manifest']['tools'],[])
            self.assertEqual(run['manifest']['policy'],'read_only')
            self.assertIsNone(run['manifest']['source_revision'])

    def test_personal_manifest_refuses_project_and_tool_escalation(self):
        run=self.store.enqueue(self.make()['id'],'run','user',self.cfg)
        manifest=run['manifest'];pip_sources.validate_manifest(manifest)
        for extra in [{'source_revision':'a'*40},{'tools':['read_file']},{'handoff':{}},{'run_kind':'patch'},{'policy':'yolo'}]:
            with self.assertRaises(RegistryError):pip_sources.validate_manifest({**manifest,**extra})

    def test_native_personal_agent_has_no_tools_and_keeps_app_reference_in_chat(self):
        from dgc.llm import LLMClient, ChatResult
        for chatting in (False, True):
            job=self.make()
            run=(pip_chat.send(self.store,job['id'],'Plan my day','one','user',self.cfg)['run']
                 if chatting else self.store.enqueue(job['id'],'one','user',self.cfg))
            raw=json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?',(run['id'],)).fetchone()[0])
            raw['app_references']=[{'tool':'GMAIL_FETCH_EMAILS','text':'UNTRUSTED_REFERENCE_SENTINEL','untrusted':True}]
            calls=[]
            def chat(client,messages,tools=None,**kwargs):
                calls.append(messages)
                self.assertEqual([t['function']['name'] for t in (tools or [])],
                                 ['draft_pip_change', 'draft_email', 'draft_calendar_event', 'offer_choices', 'add_routine', 'skill'] if chatting
                                 else ['draft_email', 'draft_calendar_event', 'skill'])   # a task may only draft or load a skill's instructions (no connector grant here)
                self.assertIn('UNTRUSTED_REFERENCE_SENTINEL',json.dumps(messages))
                return ChatResult(content='Here is a suggested plan. No messages were sent.')
            with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(personal=True))}), \
                 patch.object(LLMClient,'chat',chat), patch('dgc.agent.discover_skills',return_value={}), \
                 patch('dgc.agent.load_memories',side_effect=AssertionError('No ambient memory')), \
                 patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
                result=pips.execute_native(self.cfg,self.root,raw,lambda e:None)
            self.assertTrue(calls)
            self.assertEqual(result['tools_called'],0)
            self.assertIn('No messages were sent',result['text'])

    def test_a_chat_reply_is_all_the_pip_said_and_ends_at_its_choices(self):
        # Filmed with a real model: the hello was written before offer_choices, then "Typo above —"
        # after it; only the last text was saved. The reply is everything said before the choices.
        from dgc.llm import LLMClient, ChatResult, ToolCall
        job=self.make();run=pip_chat.send(self.store,job['id'],'Hi','hello','user',self.cfg)['run']
        raw=json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?',(run['id'],)).fetchone()[0])
        # Battle test (Morning's hello): told to end its turn, the model wrote the hello again with new
        # choices, twice, and the chat saved all three. Offering choices now ends the turn.
        turns=iter([ChatResult(content='Hi, I am Gmail.',tool_calls=[ToolCall('c1','offer_choices',{'choices':['Yes, connect Gmail','Not yet']})]),
                    ChatResult(content='Hi, I am Gmail, your Pip.',tool_calls=[ToolCall('c2','offer_choices',{'choices':['Connect Gmail','Just chat']})]),
                    ChatResult(content='Done, your choices are below.')])
        asked=[0]
        def chat(*a,**k):
            asked[0]+=1
            return next(turns)
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient,'chat',chat), patch('dgc.agent.discover_skills',return_value={}), \
             patch('dgc.agent.load_memories',side_effect=AssertionError('No ambient memory')), \
             patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
            result=pips.execute_native(self.cfg,self.root,raw,lambda e:None)
        self.assertEqual(result['text'],'Hi, I am Gmail.')
        self.assertEqual(result['choices'],['Yes, connect Gmail','Not yet'])
        self.assertEqual(asked[0],1,'no model request after the choices')

    def test_a_routine_suggested_with_no_words_still_reaches_the_chat(self):
        # Battle test: a model called add_routine, then ended its turn with no text; the empty reply
        # failed the turn and the routine card was lost.
        from dgc.llm import LLMClient, ChatResult, ToolCall
        job=self.make();run=pip_chat.send(self.store,job['id'],'Every morning at 8, a fun fact','fact','user',self.cfg)['run']
        raw=json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?',(run['id'],)).fetchone()[0])
        when={'kind':'schedule','schedule':{'type':'daily','time':'08:00','timezone':'Asia/Kolkata'}}
        first=[ChatResult(content='',tool_calls=[ToolCall('r1','add_routine',{'title':'Fun fact','prompt':'Tell me a fun fact.','when':when})])]
        turns=iter(lambda:first.pop() if first else ChatResult(content=''),None)   # then nothing, however often asked
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient,'chat',lambda *a,**k:next(turns)), patch('dgc.agent.discover_skills',return_value={}), \
             patch('dgc.agent.load_memories',side_effect=AssertionError('No ambient memory')), \
             patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
            result=pips.execute_native(self.cfg,self.root,raw,lambda e:None)
        self.assertEqual(result['text'],'Here’s a routine for that. Choose Add routine below to start it.')
        self.assertEqual([r['title'] for r in result['routine_drafts']],['Fun fact'])

    def test_native_personal_refuses_fabricated_tool_calls(self):
        from dgc.llm import LLMClient, ChatResult, ToolCall
        job=self.make();run=self.store.enqueue(job['id'],'forged','user',self.cfg)
        raw=json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?',(run['id'],)).fetchone()[0])
        count=[0]
        def chat(client,messages,tools=None,**kwargs):
            count[0]+=1
            if count[0]==1:return ChatResult(content='',tool_calls=[ToolCall('r1','read_file',{'path':'secret.txt'}),ToolCall('r2','read_file',{'path':'other.txt'}),ToolCall('r3','bash',{'command':'echo forbidden'})])
            self.assertIn('PERMISSION DENIED',json.dumps(messages))
            return ChatResult(content='Those tools are unavailable.')
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient,'chat',chat), patch('dgc.agent.discover_skills',return_value={}), \
             patch('dgc.agent.load_memories',side_effect=AssertionError('No ambient memory')), \
             patch.dict('dgc.tools.EXECUTORS',{'read_file':lambda *a,**kw:self.fail('No file execution'),'bash':lambda *a,**kw:self.fail('No command execution')}):
            result=pips.execute_native(self.cfg,self.root,raw,lambda e:None)
        self.assertEqual(count[0],2)
        self.assertEqual(result['text'],'Those tools are unavailable.')


class PersonalWorkerTests(unittest.TestCase):
    setUp=fixtures.LocalPipsTests.setUp
    def test_controller_and_real_worker_complete_offline_app_read(self):
        self._offline_worker()

    def test_calendar_bounds_reach_real_worker_and_retained_activity(self):
        self._offline_worker(calendar=True)

    def _offline_worker(self,calendar=False):
        import subprocess, sys
        from dgc import pip_app_access as apps
        from tests.test_pip_app_access import MetaManager
        self.cfg.data['mcp_servers']={'composio':{'transport':'remote','url':'https://connect.composio.dev/offline-test'}}
        manager=MetaManager()
        plan={'schema_version':1,'server':'composio','connection_digest':apps.digest(self.cfg.get('mcp_servers')['composio']),
              'calls':[{'tool':'GMAIL_FETCH_EMAILS','schema_digest':apps.digest({'executor':manager.executor,'input':manager.input}),
                        'account':'ca_offline','arguments':{'max_results':5,'query':'is:unread'}}]}
        if calendar:
            plan['schema_version']=2
            plan['calls'][0].update(tool='GOOGLECALENDAR_FIND_EVENT',arguments={'calendar_id':'primary','max_results':5},window={'kind':'calendar_days','timezone':'Asia/Kolkata','start_day':0,'days':1})
        job=self.store.create(self.registry.personal()['id'],'Morning note','Summarize the approved email reference','local-console')
        proposal=self.store.propose(job['id'],1,{'app_plan':plan},'local-console')
        self.store.accept(job['id'],proposal['id'],1,'local-console')
        self.assertEqual(self.store.get(job['id']).get('app_plan'),plan)
        run=self.store.enqueue(job['id'],'offline-app-run','local-console',self.cfg);row=self.store.claim_next()
        self.assertEqual(run['manifest'].get('app_plan'),plan)
        fixture=r'''
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult
from dgc.pips import _worker_main
import json

def chat(self,messages,tools=None,**kwargs):
    assert {t['function']['name'] for t in (tools or [])} <= {'draft_email', 'draft_calendar_event', 'skill', 'connect_app', 'read_app'}, "A Personal task may only draft, load a skill's instructions, or ask for and read its own connected apps (Grok-style, the founder 2026-10-07): nothing runs or sends"
    reference=json.dumps(messages)
    assert 'Untrusted connected-app reference data' in reference, 'Reference envelope missing'
    assert 'GMAIL_FETCH_EMAILS' in reference, 'Read tool source missing'
    return ChatResult(content='No unread messages were returned. No messages were sent.')
with patch.object(LLMClient,'chat',chat), patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
    raise SystemExit(_worker_main())
'''
        if calendar:
            fixture=fixture.replace('GMAIL_FETCH_EMAILS','GOOGLECALENDAR_FIND_EVENT').replace("    return ChatResult(","    assert '2026-10-03T18:30:00Z' in reference and '2026-10-04T18:30:00Z' in reference, 'Resolved window missing'\n    return ChatResult(")
        popen=subprocess.Popen
        def process(argv,*a,**kw):
            if argv[1:]==['-m','dgc.pips','--worker']:argv=[sys.executable,'-c',fixture]
            return popen(argv,*a,**kw)
        execute=apps.execute
        def reads(*a,**kw):
            from datetime import datetime,timezone
            return execute(*a,manager_factory=lambda *a:manager,wall_clock=lambda:datetime(2026,10,3,20,tzinfo=timezone.utc),**kw)
        with patch.object(pips.subprocess,'Popen',side_effect=process), \
             patch.object(apps,'execute',side_effect=reads), \
             patch.object(apps,'saved_servers',return_value=self.cfg.get('mcp_servers')):
            result=pips._execute_run(self.registry,row,self.cfg)
        self.assertEqual(result['snapshot'],{'files':0,'bytes':0,'scope':'personal'})
        self.store.finish(run['id'],result=result)
        self.assertEqual(self.store.run(run['id'])['status'],'succeeded')
        self.assertEqual(result['tools_called'],0)
        self.assertIs(result['external_actions'],False)
        self.assertEqual([name for name,_ in manager.calls],['schema','execute'])
        if calendar:
            event=self.registry.db.execute("SELECT payload FROM workspace_events WHERE run_id=? AND event_type='pip_run_calendar_windows'",(run['id'],)).fetchone()
            window=json.loads(event[0])['windows'][0]
            self.assertEqual(window['time_min'],'2026-10-03T18:30:00Z');self.assertEqual(window['timezone'],'Asia/Kolkata')
        self.assertEqual(list((self.registry.directory/'runs'/run['id']/'source').iterdir()),[])

if __name__=='__main__':unittest.main()


class GuessedAddressTests(unittest.TestCase):
    """A draft never goes to an address the Pip made up (battle test 2026-10-09: "rohan@acme.com as a placeholder")."""

    def test_only_addresses_from_the_user_its_job_or_their_apps(self):
        msgs = [{"role": "user", "content": "Follow up with Rohan from Acme about pricing."},
                {"role": "assistant", "content": "I'll write to rohan@acme.com."},
                {"role": "tool", "content": "From: Priya <priya@bank.example>"}]
        manifest = {"job": {"goal": "Write to sam@home.example every Friday."}, "app_references": [{"text": "cc: ops@corp.example"}]}
        self.assertEqual(pips._guessed_addresses(["rohan@acme.com"], msgs, manifest), ["rohan@acme.com"],
                         "its own reply is not where an address comes from")
        self.assertEqual(pips._guessed_addresses(["Priya@Bank.example", "sam@home.example", "ops@corp.example"], msgs, manifest), [])


class CardClaimTests(unittest.TestCase):
    """A reply that sends the user to a card it never made gets one more try (battle test 2026-10-09)."""

    def test_a_claimed_card_is_found_and_plain_words_are_not(self):
        for said in ("Tap Connect on the Google Calendar card below.", "The card below is how you add that.",
                     "There's an Allow card just below.", "Choose Allow and I'll read it.",
                     "Here's a short follow-up for Rohan — it's in the draft below, ready to review."):
            with self.subTest(said=said):
                self.assertTrue(pips._claims_a_card(said))
        for said in ("Here are three ideas for dinner.", "I can connect your calendar if you like.", "See the list below.",
                     "Here's a draft below:", "Below is a draft you can paste."):
            with self.subTest(said=said):
                self.assertFalse(pips._claims_a_card(said))

    def test_only_the_words_after_the_last_user_message_count(self):
        msgs = [{"role": "assistant", "content": "Tap Connect on the card below."}, {"role": "user", "content": "thanks"},
                {"role": "assistant", "content": "You're welcome."}]
        self.assertEqual(pips._turn_text(msgs), "You're welcome.")

    def test_the_worker_asks_once_to_make_the_card_or_say_it_without_one(self):
        from dgc.llm import ChatResult, LLMClient
        fixture = PersonalTests()
        fixture.setUp = fixtures.LocalPipsTests.setUp.__get__(fixture)
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        job = fixture.make()
        run = pip_chat.send(fixture.store, job["id"], "Can you see my calendar?", "c1", "user", fixture.cfg)["run"]
        raw = json.loads(fixture.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        replies = iter([ChatResult(content="Not yet: tap Connect on the Google Calendar card below."),
                        ChatResult(content="Not yet: I can't see your calendar until it's connected.")])
        asked = []

        def chat(client, messages, tools=None, **kwargs):
            asked.append(json.dumps(messages))
            return next(replies)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            result = pips.execute_native(fixture.cfg, fixture.root, raw, lambda e: None)
        self.assertEqual(len(asked), 2, "one more try, no more")
        self.assertIn("you made none in this turn", asked[1])
        self.assertEqual(result["text"], "Not yet: I can't see your calendar until it's connected.")

