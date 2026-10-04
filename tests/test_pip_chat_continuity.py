"""Offline transactional continuation tests. No sleeps or model/network calls."""
import copy
import json
import os
import sqlite3
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_chat, pip_chat_continuity as continuity, pips
from dgc.llm import ChatResult, LLMClient
from dgc.workspace_registry import WorkspaceRegistry, RegistryError
from tests import test_pips_local as fixtures
from tests.pip_test_migrations import drop_digest_schema


class ContinuityTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def job(self):
        self.commit()
        self.pip = self.create()

    def send(self, key='first', text='Keep project codename Lavender. Never deploy without a visual review.', **kwargs):
        return pip_chat.send(self.store, self.pip['id'], text, key, 'user', self.cfg, **kwargs)['run']

    def candidate(self, run, summary='## Goal\nRemember Lavender.\n## Progress\nRead source only.\n## Next\nVisual review before deployment.', advance=True):
        pin = run['manifest']['conversation']['continuity']
        return {'version': 1, 'base_digest': pin['base_digest'], 'head_digest': pin['head']['archive_digest'],
                'advance': advance, 'summary': summary if advance else pin['state']['summary'],
                'strategy': 'model' if advance else pin['state']['strategy']}

    def finish(self, run, *, candidate=None, answer='Noted. Source inspection is not deployment approval.'):
        self.store.claim_next()
        result = {'text': answer}
        if candidate is not None:
            result['continuity'] = candidate
        return self.store.finish(run['id'], result=result)

    def test_summary_survives_restart_and_reaches_real_agent_with_fresh_authority(self):
        self.job(); first = self.send(); self.finish(first, candidate=self.candidate(first))
        with WorkspaceRegistry(self.registry.directory) as reopened:
            store = pips.PipStore(reopened)
            second = pip_chat.send(store, self.pip['id'], 'What did we agree?', 'second', 'user', self.cfg)['run']
        manifest = second['manifest']; seen = []
        def chat(client, messages, tools=None, **kwargs):
            seen.append(copy.deepcopy(messages))
            self.assertTrue({t['function']['name'] for t in tools} <= pips.READ_TOOLS)
            return ChatResult(content='Lavender needs a visual review before deployment.')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy())}), \
             patch.object(LLMClient, 'chat', chat), patch('dgc.agent.discover_skills', return_value={}), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        self.assertIn('Lavender', json.dumps(seen))
        self.assertIn('not a new user', json.dumps(seen))
        self.assertFalse(result['continuity']['advance'])
        self.store.claim_next(); self.store.finish(second['id'], result=result)
        saved = continuity.latest(self.store, self.pip['id'])
        self.assertEqual(saved['state']['messages'], 2)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_chat_messages').fetchone()[0], 4)

    def test_failed_cancelled_and_duplicate_completion_cannot_replace_checkpoint(self):
        self.job(); first = self.send(); done = self.finish(first, candidate=self.candidate(first))
        original = continuity.latest(self.store, self.pip['id'])
        self.store.finish(first['id'], result={'text': 'changed', 'continuity': {}})
        self.assertEqual(continuity.latest(self.store, self.pip['id']), original)
        for state in ('failed', 'cancelled'):
            run = self.send(state); self.store.claim_next()
            if state == 'cancelled':
                self.store.cancel(run['id'], 'user')
                self.store.finish(run['id'], result={'text': 'partial', 'continuity': self.candidate(run)})
            else:
                self.store.finish(run['id'], error={'code': 'model_failed'})
            self.assertEqual(continuity.latest(self.store, self.pip['id']), original)
        self.assertEqual(done['status'], 'succeeded')

    def test_atomic_rollback_when_checkpoint_commit_fails(self):
        self.job(); run = self.send(); self.store.claim_next()
        self.registry.db.execute("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON pip_chat_checkpoints BEGIN SELECT RAISE(ABORT,'fixture checkpoint failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.finish(run['id'], result={'text': 'answer', 'continuity': self.candidate(run)})
        self.assertEqual(self.store.run(run['id'])['status'], 'running')
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages WHERE role='assistant'").fetchone()[0], 0)

    def test_corrupted_covered_archive_refuses_next_send(self):
        self.job(); run = self.send(); self.finish(run, candidate=self.candidate(run))
        self.registry.db.execute("UPDATE pip_chat_messages SET text='changed original' WHERE role='user'")
        with self.assertRaisesRegex(RegistryError, 'disagrees'):
            self.send('next')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 1)

    def test_archive_changed_after_queue_refuses_success_and_keeps_user_only(self):
        self.job(); first = self.send(); self.finish(first)
        second = self.send('second'); self.store.claim_next()
        self.registry.db.execute("UPDATE pip_chat_messages SET text='changed' WHERE run_id=? AND role='user'", (first['id'],))
        with self.assertRaisesRegex(RegistryError, 'changed after'):
            self.store.finish(second['id'], result={'text': 'answer', 'continuity': self.candidate(second)})
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages WHERE run_id=?", (second['id'],)).fetchone()[0], 1)

    def test_cross_pip_candidate_and_stale_parent_are_refused(self):
        self.job(); first = self.send(); self.finish(first, candidate=self.candidate(first))
        second = self.send('second'); self.store.claim_next()
        for field in ('base_digest', 'head_digest'):
            c = self.candidate(second); c[field] = 'f' * 64
            with self.assertRaises(RegistryError):
                self.store.finish(second['id'], result={'text': 'answer', 'continuity': c})
        other = self.create()
        self.assertIsNone(continuity.latest(self.store, other['id']))
        self.assertEqual(continuity.projection(self.store, self.pip['id'])['summarized_messages'], 2)

    def test_model_and_job_change_retains_historical_brief_with_provenance(self):
        self.job(); first = self.send(); self.finish(first, candidate=self.candidate(first))
        self.cfg.set('model', 'different-native-model', persist=False)
        second = self.send('second')
        self.assertEqual(second['manifest']['model'], 'different-native-model')
        self.assertIn('Lavender', second['manifest']['conversation']['continuity']['state']['summary'])
        self.assertEqual(continuity.latest(self.store, self.pip['id'])['provenance']['model'], 'fixture')
        self.assertEqual(second['manifest']['policy_digest'], first['manifest']['policy_digest'])

    def test_legacy_history_is_backfilled_without_silent_omission(self):
        self.job()
        for i in range(8):
            self.finish(self.send(str(i), text='Question ' + str(i)), answer='Answer ' + str(i) + ' x' * 11000)
        run = self.send('new')
        c = run['manifest']['conversation']
        self.assertEqual(c['history_omitted_count'], 0)
        self.assertEqual(c['continuity']['state']['strategy'], 'mechanical')
        self.assertGreater(c['continuity']['state']['messages'], 0)
        self.assertEqual(c['continuity']['head']['messages'], 16)
        self.assertLessEqual(len(continuity.encoded(c['history'])) + len(c['continuity']['state']['summary'].encode()), 65536)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_chat_messages').fetchone()[0], 17)

    def test_oversize_stored_text_is_refused_before_body_fetch(self):
        self.job(); run = self.send(); self.finish(run)
        self.registry.db.execute("UPDATE pip_chat_messages SET text=? WHERE role='assistant'", ('x' * 30000,))
        queries=[]; self.registry.db.set_trace_callback(queries.append)
        with self.assertRaises(RegistryError):
            continuity.prepare(self.store, self.pip['id'], 32768)
        self.registry.db.set_trace_callback(None)
        self.assertFalse(any(q.startswith('SELECT text FROM pip_chat_messages') for q in queries))

    def test_invalid_worker_summary_rolls_back_reply(self):
        self.job(); run = self.send(); self.store.claim_next()
        for value in ('', 'x' * 8193, '\x00', True):
            c=self.candidate(run); c['summary']=value
            with self.assertRaises(RegistryError):
                self.store.finish(run['id'], result={'text': 'answer', 'continuity': c})
        c=self.candidate(run);c['permissions']='shell'
        with self.assertRaises(RegistryError):
            self.store.finish(run['id'], result={'text':'answer','continuity':c})
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_chat_checkpoints').fetchone()[0], 0)

    def test_migration_adds_table_atomically_without_rewriting_archive(self):
        self.job(); run=self.send();self.finish(run)
        before=[tuple(r) for r in self.registry.db.execute('SELECT * FROM pip_chat_messages')]
        self.registry.db.execute('DROP TABLE pip_chat_checkpoints')
        self.registry.db.execute('DROP TABLE pip_connector_drafts')
        self.registry.db.execute('DROP TABLE pip_calendar_drafts')
        self.registry.db.execute('DROP TABLE pip_message_drafts')
        self.registry.db.execute('DROP TABLE pip_app_actions')
        drop_digest_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=23')
        with patch.object(continuity,'SCHEMA',continuity.SCHEMA+'\nINVALID SQL;'), self.assertRaises(sqlite3.Error):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0],23)
        self.assertIsNone(self.registry.db.execute("SELECT name FROM sqlite_master WHERE name='pip_chat_checkpoints'").fetchone())
        with WorkspaceRegistry(self.registry.directory) as reopened:
            from dgc.workspace_registry import SCHEMA_VERSION
            self.assertEqual(reopened.db.execute('PRAGMA user_version').fetchone()[0],SCHEMA_VERSION)
            self.assertEqual([tuple(r) for r in reopened.db.execute('SELECT * FROM pip_chat_messages')],before)

    def test_retry_and_parallel_send_keep_pinned_checkpoint(self):
        self.job(); first=self.send();self.finish(first,candidate=self.candidate(first))
        second=self.send('second')
        with WorkspaceRegistry(self.registry.directory) as other:
            store=pips.PipStore(other)
            retry=pip_chat.send(store,self.pip['id'],'Keep project codename Lavender. Never deploy without a visual review.','second','user',self.cfg)
            self.assertEqual(retry['run']['id'],second['id'])
            with self.assertRaisesRegex(RegistryError,'already has'):
                pip_chat.send(store,self.pip['id'],'Another','different','user',self.cfg)
        self.assertEqual(self.send('second')['manifest']['conversation'],second['manifest']['conversation'])


class WorkerBriefTests(unittest.TestCase):
    def fixture(self, *, error=False, malformed=False, cancelled=False):
        cfg=SimpleNamespace(get=lambda key,default=None: 'sk-test-secret-value' if key=='api_key' else default,
                            api_key='sk-test-secret-value')
        stop=threading.Event()
        if cancelled:stop.set()
        calls=[]
        def chat(messages, **kwargs):
            calls.append((messages,kwargs))
            if error:raise RuntimeError('offline')
            return ChatResult(content='bad' if malformed else '## Goal\nLavender sk-test-secret-value\n## Progress\nRead only\n## Next\nVisual review')
        agent=SimpleNamespace(messages=[{'role':'system','content':'restricted'},{'role':'user','content':'[Earlier conversation compacted to this summary]\nDuring-turn memory'}],
                              config=cfg,cancelled=stop,context_size=lambda:32768,
                              _aux_client=lambda **kw:SimpleNamespace(chat=chat),_record_usage=lambda *args:None)
        conversation={'text':'Current request','history':[{'role':'user','content':'Lavender'},{'role':'assistant','content':'No deployment'}],
                      'continuity':{'base_digest':None,'head':{'through_seq':2,'messages':2,'archive_digest':'a'*64},'state':continuity.empty()}}
        return agent,conversation,calls

    def test_native_summary_and_within_reply_brief_redacted_and_no_tools(self):
        agent,c,calls=self.fixture()
        with patch('dgc.redaction.secret_values',return_value=['sk-test-secret-value']):
            result=continuity.complete(agent,c,'Current answer')
        self.assertEqual(result['strategy'],'model');self.assertTrue(result['advance'])
        self.assertIn('During-turn memory',json.dumps(calls[0][0]));self.assertNotIn('sk-test-secret-value',result['summary'])
        self.assertIsNone(calls[0][1]['tools']);self.assertEqual(calls[0][1]['reasoning_effort'],'off')

    def test_failure_malformed_and_expired_deadline_fall_back_without_erasing_prior(self):
        for kw in ({'error':True},{'malformed':True},{'cancelled':True},{}):
            agent,c,calls=self.fixture(**kw)
            c['continuity']['state']={'version':1,'summary':'Original Lavender constraint','strategy':'model','through_seq':2,'messages':2,'archive_digest':'a'*64}
            result=continuity.complete(agent,c,'Answer',deadline=0 if not kw else None)
            self.assertEqual(result['strategy'],'mechanical');self.assertIn('Lavender',result['summary'])
            if kw.get('cancelled') or not kw:self.assertEqual(calls,[])

    def test_summary_refuses_native_provider_without_output_cap(self):
        agent,c,calls=self.fixture()
        native=LLMClient('http://127.0.0.1:1/v1','','fixture',max_tokens=2048)
        native._feature_supported=lambda feature: feature != 'max_output_tokens'
        agent._aux_client=lambda **kw:native
        with patch.object(native,'chat',side_effect=AssertionError('No uncapped request')) as chat:
            result=continuity.complete(agent,c,'Answer')
        self.assertEqual(result['strategy'],'mechanical');chat.assert_not_called()

    def test_summary_request_contains_previous_brief_and_middle_constraint(self):
        agent,c,calls=self.fixture()
        c['continuity']['state']={'version':1,'summary':'Earlier project Lavender','strategy':'model','through_seq':2,'messages':2,'archive_digest':'a'*64}
        c['history']=[{'role':'user' if i%2==0 else 'assistant','content':f'Message {i}'} for i in range(20)]
        c['history'][10]['content']='Critical middle instruction: verify the mobile layout before deploy.'
        continuity.complete(agent,c,'Current answer')
        prompt=calls[0][0][0]['content']
        self.assertIn('Earlier project Lavender',prompt)
        self.assertIn(c['history'][10]['content'],prompt)
        self.assertIn('Message 0',prompt);self.assertIn('Message 19',prompt)

    def test_unchanged_short_conversation_does_not_spend_summary_request(self):
        agent,c,calls=self.fixture();agent.messages=[{'role':'system','content':'restricted'}]
        result=continuity.complete(agent,c,'Answer')
        self.assertFalse(result['advance']);self.assertEqual(calls,[])


if __name__=='__main__':unittest.main()
