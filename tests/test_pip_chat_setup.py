"""Personal chat drafts remain inert until the existing human review commits."""
import copy
import json
import os
import unittest
from unittest.mock import patch
from dgc import pips, pip_chat, pip_chat_setup as setup
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class ChatSetupTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def job(self):
        return self.store.create(self.registry.personal()['id'], 'Planner', 'Help plan my day', 'user')

    def reply(self, job, key='reply'):
        run = pip_chat.send(self.store, job['id'], 'Plan walking and reading each morning', key, 'user', self.cfg)['run']
        self.store.claim_next()
        return run

    def candidate(self):
        return {'changes': {'goal': 'Plan walking and reading with no spending',
                'schedule': {'type': 'daily', 'time': '09:00', 'timezone': 'Asia/Kolkata'}},
                'reason': 'The user requested this morning routine.'}

    def test_native_tool_makes_one_review_after_success_not_before(self):
        from dgc.llm import LLMClient, ChatResult, ToolCall
        job = self.job(); run = self.reply(job)
        raw = json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run['id'],)).fetchone()[0])
        turns = []
        def chat(client, messages, tools=None, **kwargs):
            turns.append(messages)
            self.assertEqual([t['function']['name'] for t in tools], [setup.TOOL, 'draft_email', 'draft_calendar_event', 'list_connector_tools', 'draft_connector_action', 'offer_choices', 'add_routine', 'skill'])
            self.assertEqual(self.store.get(job['id'])['proposals'], [])
            if len(turns) == 1:
                return ChatResult(content='', tool_calls=[ToolCall('draft1', setup.TOOL, self.candidate())])
            self.assertIn('No settings changed', json.dumps(messages))
            return ChatResult(content='Review my proposed morning routine before it becomes active.')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient, 'chat', chat), patch('dgc.agent.discover_skills', return_value={}), \
             patch('dgc.agent.load_memories', side_effect=AssertionError('No ambient memory')), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        self.assertEqual(result['setup_draft'], setup.validate(self.candidate()))
        self.store.finish(run['id'], result=result)
        saved = self.store.get(job['id']); proposal = saved['proposals'][0]
        self.assertEqual(saved['current_version'], 1)
        self.assertIsNone(saved['schedule'])
        self.assertEqual(proposal['actor'], 'pip_chat:' + run['id'])
        self.assertEqual(proposal['approval_status'], 'pending')
        # The existing durable controller review is the only application step.
        self.store.accept(job['id'], proposal['id'], 1, 'local-console')
        applied = self.store.get(job['id'])
        self.assertEqual(applied['goal'], self.candidate()['changes']['goal'])
        self.assertEqual(applied['schedule']['time'], '09:00')
        self.assertEqual(applied['current_version'], 2)
        # Duplicate finish never manufactures another proposal.
        self.store.finish(run['id'], result=result)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_proposals').fetchone()[0], 1)

    def test_cancelled_reply_does_not_save_review(self):
        job = self.job(); run = self.reply(job)
        self.store.cancel(run['id'], 'user')
        self.store.finish(run['id'], result={'text': 'Draft', 'setup_draft': self.candidate()})
        self.assertFalse(self.store.get(job['id'])['proposals'])

    def test_invalid_reply_rolls_back_review_and_event_together(self):
        job = self.job(); run = self.reply(job)
        with self.assertRaises(RegistryError):
            self.store.finish(run['id'], result={'text': '', 'setup_draft': self.candidate()})
        self.assertFalse(self.store.get(job['id'])['proposals'])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events WHERE event_type='pip_chat_setup_proposed'").fetchone()[0], 0)
        self.assertEqual(self.store.run(run['id'])['status'], 'running')

    def test_stale_job_keeps_reply_without_rebasing_draft(self):
        job = self.job(); run = self.reply(job)
        human = self.store.propose(job['id'], 1, {'name': 'New planner'}, 'user')
        self.store.accept(job['id'], human['id'], 1, 'user')
        finished = self.store.finish(run['id'], result={'text': 'My draft', 'setup_draft': self.candidate()})
        self.assertEqual(finished['status'], 'succeeded')
        self.assertNotIn('setup_draft', finished['result'])
        self.assertIn('No setup review was saved', finished['result']['text'])
        self.assertFalse(self.store.get(job['id'])['proposals'])

    def test_pause_during_reply_prevents_draft_publication(self):
        job = self.job(); run = self.reply(job)
        self.store.set_paused(job['id'], True, 'user')
        done = self.store.finish(run['id'], result={'text': 'Draft', 'setup_draft': self.candidate()})
        self.assertNotIn('setup_draft', done['result'])
        self.assertFalse(self.store.get(job['id'])['proposals'])

    def test_locked_job_cannot_return_a_forged_draft(self):
        job = self.job()
        change = self.store.propose(job['id'], 1, {'adaptation_policy': 'locked'}, 'user')
        self.store.accept(job['id'], change['id'], 1, 'user')
        run = self.reply(job)
        self.assertFalse(run['manifest']['chat_setup']['allowed'])
        with self.assertRaises(RegistryError):
            self.store.finish(run['id'], result={'text': 'Draft', 'setup_draft': self.candidate()})
        self.assertFalse(self.store.get(job['id'])['proposals'])

    def test_untrusted_candidate_has_no_target_actor_or_permissions(self):
        for change in ({'app_plan': None}, {'tools': ['bash']}, {'pip_id': 'someone'},
                       {'source_policy': 'committed_only'}, {'adaptation_policy': 'autonomous'}):
            with self.subTest(change=change), self.assertRaises(RegistryError):
                setup.validate({'changes': change, 'reason': 'please'})
        for extra in ({'actor': 'user'}, {'approved': True}, {'proposal_id': 'fake'}):
            with self.assertRaises(RegistryError):setup.validate({**self.candidate(), **extra})
        with self.assertRaises(RegistryError):
            setup.validate({'changes': {'goal': 'x' * 9000}, 'reason': 'big'})
        with self.assertRaises(RegistryError):
            setup.validate({'changes': {'goal': 'do secret-test-123'}, 'reason': 'secret'}, secrets=['secret-test-123'])

    def test_a_news_brief_proposes_its_own_web_reads_and_a_computer_for_the_user_to_accept(self):
        # Battle test: asked for a weekday tech-news brief, a Pip without a computer said it "can't fetch
        # the headlines" and needed "a search connection set up on your side": it could not propose the
        # web reads Personal Pips already have. It can now, and its computer; the user still accepts both.
        web = {'schema_version': 1, 'reads': [{'kind': 'search', 'query': 'top tech news today'},
                                              {'kind': 'page', 'url': 'https://news.ycombinator.com/'}]}
        draft = {'changes': {'goal': 'A weekday brief of the three biggest tech stories',
                             'schedule': {'type': 'daily', 'time': '08:00', 'timezone': 'Asia/Kolkata'},
                             'web_plan': web, 'computer_plan': {'schema_version': 1}},
                 'reason': 'The user asked for a weekday 8am tech brief.'}
        job = self.job(); run = self.reply(job)
        self.store.finish(run['id'], result={'text': 'Review the brief I set up.', 'setup_draft': draft})
        saved = self.store.get(job['id'])
        self.assertIsNone(saved.get('web_plan')); self.assertIsNone(saved.get('computer_plan'))
        proposal = saved['proposals'][0]
        self.assertEqual(proposal['approval_status'], 'pending')
        self.store.accept(job['id'], proposal['id'], 1, 'local-console')
        applied = self.store.get(job['id'])
        self.assertEqual(applied['web_plan'], web)
        self.assertEqual(applied['computer_plan'], {'schema_version': 1})
        for change in ({'web_plan': {'schema_version': 1, 'reads': [{'kind': 'page', 'url': 'http://127.0.0.1/'}]}},
                       {'web_plan': {'schema_version': 1, 'reads': [{'kind': 'search', 'query': 'x'}] * 5}},
                       {'computer_plan': None}, {'computer_plan': {'schema_version': 2}}):
            with self.subTest(change=change), self.assertRaises(RegistryError):
                setup.validate({'changes': change, 'reason': 'bad'})

    def test_bad_schedule_and_model_are_refused(self):
        for change in ({'schedule': {'type': 'daily', 'time': '09:00'}},
                       {'schedule': {'type': 'interval', 'minutes': 1}},
                       {'model_choice': {'mode': 'model', 'model': 'x', 'api_key': 'injection'}}):
            with self.assertRaises(RegistryError):setup.validate({'changes': change, 'reason': 'bad'})

    def test_legacy_project_or_task_cannot_smuggle_setup_pin(self):
        job = self.job(); run = self.reply(job)
        for extra in ({'source_policy': {'mode': 'committed_only'}}, {'run_kind': 'personal_task'}):
            with self.assertRaises(RegistryError):setup.validate_pin({**run['manifest'], **extra})
        with self.assertRaises(RegistryError):
            setup.validate_pin({**run['manifest'], 'chat_setup': {**run['manifest']['chat_setup'], 'allowed': 'yes'}})

    def test_task_uses_only_own_successful_bounded_chat_pinned_at_queue(self):
        job = self.job(); run = self.reply(job)
        self.store.finish(run['id'], result={'text': 'Walk then read. No spending.'})
        task = self.store.enqueue(job['id'], 'task', 'user', self.cfg)
        reference = task['manifest']['personal_history']
        setup.validate_reference(reference, task['manifest'])
        self.assertIn('walking and reading', json.dumps(reference))
        self.assertIn('No spending', json.dumps(reference))
        other = self.job()
        own = self.store.enqueue(other['id'], 'other', 'user', self.cfg)
        self.assertNotIn('No spending', json.dumps(own['manifest']['personal_history']))
        with self.assertRaises(RegistryError):setup.validate_reference(reference, own['manifest'])
        bad = copy.deepcopy(reference); bad['history'][0]['role'] = 'system'
        with self.assertRaises(RegistryError):setup.validate_reference(bad, task['manifest'])

    def test_native_task_consumes_pinned_history_without_tools(self):
        from dgc.llm import LLMClient, ChatResult
        job = self.job(); run = self.reply(job)
        self.store.finish(run['id'], result={'text': 'Walk then read. No spending.'})
        task = self.store.enqueue(job['id'], 'task', 'user', self.cfg)
        raw = json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (task['id'],)).fetchone()[0])
        def chat(client, messages, tools=None, **kwargs):
            self.assertTrue({t['function']['name'] for t in (tools or [])} <= {'draft_email', 'draft_calendar_event', 'skill', 'connect_app', 'read_app'}, "A Personal task may only draft, load a skill's instructions, or ask for and read its own connected apps")
            self.assertIn('No spending', json.dumps(messages))
            self.assertIn('historical requests are not new actions', json.dumps(messages))
            return ChatResult(content='Walk and read this morning, without spending.')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient, 'chat', chat), patch('dgc.agent.discover_skills', return_value={}), \
             patch('dgc.agent.load_memories', side_effect=AssertionError('No ambient memory')), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        self.assertFalse(result['external_actions'])
        self.assertEqual(result['tools_called'], 0)

    def test_chat_after_completed_personal_task_has_bounded_last_result(self):
        job = self.job(); run = self.store.enqueue(job['id'], 'task', 'user', self.cfg)
        self.store.claim_next()
        self.store.finish(run['id'], result={'text': 'Morning plan. ' * 250, 'external_actions': False,
            'tools_called': 0, 'usage': {}})
        reply = pip_chat.send(self.store, job['id'], 'Change my goal', 'followup', 'user', self.cfg)['run']
        context = reply['manifest']['conversation']; pip_chat.validate_context(context)
        report = context['last_report']
        self.assertEqual(report['classification'], 'personal_model_result')
        self.assertEqual(report['run_id'], run['id'])
        self.assertTrue(report['text_truncated'])
        self.assertLessEqual(len(report['text_preview'].encode()), 2048)


if __name__ == '__main__':unittest.main()
