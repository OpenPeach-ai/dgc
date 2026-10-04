"""Offline reviewed Personal result sharing; no timing sleeps or provider calls."""
import copy
import json
import os
import unittest
from unittest.mock import patch
from dgc import pips, pip_handoffs as h, pip_personal_handoffs as personal, pip_sources
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class PersonalHandoffTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def prepare(self, role='quill'):
        self.now = '2026-10-04T06:00:00.000Z'
        self.registry.clock = lambda: self.now
        workspace = self.registry.personal()
        self.source = self.store.create(workspace['id'], 'Morning planner', 'Plan my morning', 'local-console', pip_type='rook')
        self.target = self.store.create(workspace['id'], 'Writing helper', 'Write a clear checklist', 'local-console', pip_type=role)
        queued = self.store.enqueue(self.source['id'], 'source', 'local-console', self.cfg)
        self.store.claim_next()
        self.text = 'Walk for 30 minutes. Read for 45 minutes. Private detail not shared.'
        self.excerpt = 'Walk for 30 minutes. Read for 45 minutes.'
        self.result = {'text': self.text, 'external_actions': False, 'tools_called': 0, 'usage': {}}
        self.run = self.store.finish(queued['id'], result=self.result)

    def propose(self, **changes):
        args = dict(source_run_id=self.run['id'], target_pip_id=self.target['id'], shared_text=self.excerpt,
                    task='Turn the shared plan into a checklist.', idempotency_key='one', actor='local-console', config=self.cfg)
        args.update(changes)
        return h.propose_personal(self.store, **args)

    def accept(self, value):
        return h.accept(self.store, value['id'], 0, 'local-console', self.cfg)

    def raw(self, run):
        return json.loads(self.store.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run['id'],)).fetchone()[0])

    def test_explicit_excerpt_and_pending_review_never_enqueue(self):
        self.prepare(); proposal = self.propose()
        self.assertEqual(proposal['status'], 'pending')
        self.assertEqual(proposal['payload']['type'], personal.TYPE)
        self.assertEqual(proposal['payload']['source']['text'], self.excerpt)
        self.assertNotIn('Private detail', json.dumps(proposal))
        self.assertNotIn('conversation', json.dumps(proposal))
        self.assertEqual(self.store.runs(self.target['id']), [])
        self.assertEqual(h.validate_payload(proposal['payload']), proposal['payload'])

    def test_approval_queues_exactly_once_in_existing_ledger(self):
        self.prepare(); proposed = self.propose()
        with patch.object(pips, 'source_revision', side_effect=AssertionError('Personal handoffs never read Git')):
            accepted = self.accept(proposed)
            retried = self.accept(proposed)
        self.assertEqual(accepted['run']['id'], retried['run']['id'])
        self.assertEqual(len(self.store.runs(self.target['id'])), 1)
        manifest = self.raw(accepted['run'])
        self.assertEqual(manifest['run_kind'], 'personal_task')
        self.assertEqual(manifest['tools'], [])
        self.assertIsNone(manifest['source_revision'])
        self.assertEqual(manifest['handoff']['payload']['action'], personal.ACTION)
        pip_sources.validate_manifest(manifest)
        personal.require_current(self.store, manifest, self.cfg)

    def test_native_worker_reads_only_reviewed_excerpt_and_cannot_use_tools(self):
        from dgc.llm import LLMClient, ChatResult
        self.prepare(); accepted = self.accept(self.propose()); manifest = self.raw(accepted['run']); calls=[]
        def chat(client, messages, tools=None, **kwargs):
            calls.append(messages)
            self.assertEqual(tools or [], [])
            text = json.dumps(messages)
            self.assertIn(self.excerpt, text)
            self.assertNotIn('Private detail', text)
            self.assertIn('untrusted reference text', text)
            return ChatResult(content='Checklist: walk, then read. Nothing was sent.')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, 'chat', chat), patch('dgc.agent.discover_skills', return_value={}), \
                patch('dgc.agent.load_memories', side_effect=AssertionError('No ambient memory')), \
                patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        self.assertTrue(calls); self.assertEqual(result['tools_called'], 0)

    def test_different_excerpt_same_key_conflicts_and_retry_is_stable(self):
        self.prepare(); first = self.propose()
        self.assertEqual(self.propose(), first)
        with self.assertRaisesRegex(RegistryError, 'different work'):
            self.propose(shared_text='Walk for 30 minutes.')

    def test_missing_fabricated_or_oversize_text_is_refused(self):
        self.prepare()
        for text in ['', 'Invented instruction', 'x'*12001, None]:
            with self.subTest(text=str(text)[:30]), self.assertRaises(RegistryError):
                self.propose(shared_text=text)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0], 0)

    def test_self_and_project_targets_refused(self):
        self.prepare()
        project = self.store.create(self.workspace['id'], 'Project', 'Read source', 'local-console')
        for target in [self.source['id'], project['id']]:
            with self.assertRaises(RegistryError): self.propose(target_pip_id=target)

    def test_job_revision_change_invalidates_review_without_queue(self):
        for target in (False, True):
            with self.subTest(target=target):
                self.prepare()
                proposed = self.propose(idempotency_key='target-'+str(target))
                job = self.target if target else self.source
                change = self.store.propose(job['id'], 1, {'goal': 'A changed goal'}, 'local-console')
                self.store.accept(job['id'], change['id'], 1, 'local-console')
                with self.assertRaises(RegistryError): self.accept(proposed)
                self.assertEqual(self.store.runs(self.target['id']), [])
                self.assertEqual(h.get(self.store, proposed['id'])['status'], 'pending')

    def test_model_change_and_permission_injection_refused(self):
        self.prepare(); proposed = self.propose()
        self.cfg.data['model'] = 'different'
        with self.assertRaises(RegistryError): self.accept(proposed)
        for action in [{'kind': 'patch'}, {'kind': 'read_only'}, {**personal.ACTION, 'tools': ['bash']}]:
            payload = copy.deepcopy(proposed['payload']); payload['action'] = action; payload['action_digest'] = h._digest(action)
            with self.assertRaises(RegistryError): h.validate_payload(payload)

    def test_expired_and_rejected_reviews_never_dispatch(self):
        self.prepare(); proposed = self.propose()
        h.reject(self.store, proposed['id'], 0, 'local-console', 'Not needed')
        with self.assertRaises(RegistryError): self.accept(proposed)
        second = self.propose(idempotency_key='two'); self.now='2026-10-12T06:00:00.000Z'
        with self.assertRaises(RegistryError): self.accept(second)
        self.assertEqual(h.get(self.store, second['id'])['status'], 'expired')
        self.assertEqual(self.store.runs(self.target['id']), [])

    def test_queued_run_rechecks_target_before_dispatch(self):
        self.prepare(); run=self.accept(self.propose())['run']; manifest=self.raw(run)
        change=self.store.propose(self.target['id'],1,{'goal':'Changed after queuing'},'local-console')
        self.store.accept(self.target['id'],change['id'],1,'local-console')
        with self.assertRaises(RegistryError): personal.require_current(self.store,manifest,self.cfg)

    def test_forged_personal_manifest_cannot_enable_project_or_unreviewed_apps(self):
        self.prepare(); manifest=self.raw(self.accept(self.propose())['run'])
        for change in [{'tools':['read_file']},{'run_kind':'patch'},{'source_policy':{'mode':'committed_only'}},
                       {'app_plan':{'anything':'unreviewed'}}]:
            with self.subTest(change=change), self.assertRaises(RegistryError):
                h.validate_manifest(manifest['handoff'],{**manifest,**change})


    def test_local_controller_and_cli_cannot_be_used_by_remote_actor(self):
        from dgc.workspace_registry import WorkspaceRegistry
        from dgc import pip_cli
        self.prepare()
        args=pip_cli.parser().parse_args(['handoff','propose-personal',self.run['id'],self.target['id'],
            '--shared-text',self.excerpt,'--task','Make a checklist','--idempotency-key','cli-one'])
        request=pip_cli._request(args)
        self.assertEqual(request['type'],'propose_pip_personal_handoff')
        self.assertNotIn('action',request)
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)):
            denied=pips.handle_control(self.cfg,request,'remote-device',start_worker=False)
            self.assertFalse(denied['ok']);self.assertEqual(denied['error']['code'],'local_only')
            created=pips.handle_control(self.cfg,request,'local-console',start_worker=False)
            self.assertTrue(created['ok'],created)
            for command in ('get_pip_handoff','accept_pip_handoff','reject_pip_handoff'):
                fields={'expected_revision':0} if command!='get_pip_handoff' else {}
                if command=='reject_pip_handoff':fields['reason']='forged'
                reply=pips.handle_control(self.cfg,{'type':command,'request_id':'blocked',
                    'handoff_id':created['result']['handoff']['id'],**fields},'remote-device',start_worker=False)
                self.assertFalse(reply['ok']);self.assertEqual(reply['error']['code'],'local_only')
        self.assertEqual(self.store.runs(self.target['id']),[])

    def test_pending_handoff_blocks_archive_and_rejected_one_stays_rejected(self):
        from dgc.pip_archive import transition
        self.prepare(); proposed=self.propose()
        with self.assertRaisesRegex(RegistryError,'Resolve incoming'):
            transition(self.store,self.target['id'],archived=True,expected_version=1,
                expected_lifecycle_revision=0,request_key='blocked-archive',reason='Test',actor='local-console')
        h.reject(self.store,proposed['id'],0,'local-console','Reject before archiving')
        for state in (True,False):
            job=self.store._job(self.target['id'])
            transition(self.store,job['id'],archived=state,expected_version=job['current_version'],
                expected_lifecycle_revision=job['lifecycle_revision'],request_key='life-'+str(state),
                reason='Test lifecycle',actor='local-console')
        with self.assertRaises(RegistryError):self.accept(proposed)
        self.assertEqual(self.store.runs(self.target['id']),[])

    def test_app_permissions_are_recipient_only_and_changed_grants_block_dispatch(self):
        from dgc import pip_app_access as apps
        from tests.test_pip_app_access import MetaManager
        self.prepare()
        self.cfg.data['mcp_servers']={'composio':{'transport':'remote','url':'https://connect.composio.dev/offline'}}
        manager=MetaManager()
        plan={'schema_version':1,'server':'composio','connection_digest':apps.digest(self.cfg.get('mcp_servers')['composio']),
            'calls':[{'tool':'GMAIL_FETCH_EMAILS','schema_digest':apps.digest({'executor':manager.executor,'input':manager.input}),
                'account':'ca_recipient','arguments':{'max_results':5}}]}
        changed=self.store.propose(self.target['id'],1,{'app_plan':plan},'local-console')
        self.store.accept(self.target['id'],changed['id'],1,'local-console')
        proposed=self.propose();self.assertEqual(proposed['payload']['target']['app_plan'],plan)
        self.assertNotIn('app_plan',proposed['payload']['source'])
        queued=self.accept(proposed)['run'];manifest=self.raw(queued)
        self.assertEqual(manifest['app_plan'],plan)
        personal.require_current(self.store,manifest,self.cfg)
        removed=self.store.propose(self.target['id'],2,{'app_plan':None},'local-console')
        self.store.accept(self.target['id'],removed['id'],2,'local-console')
        with self.assertRaises(RegistryError):personal.require_current(self.store,manifest,self.cfg)


if __name__ == '__main__': unittest.main()
