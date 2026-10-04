"""Model proposals cannot bypass Personal result selection, scope or human review."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_handoff_tool as tool, pip_handoffs as h, pips, config as config_module
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_personal_handoffs as personal_fixtures
from tests import test_pip_proposal_tool as proposal_fixtures


class PersonalHandoffToolTests(unittest.TestCase):
    prepare = personal_fixtures.PersonalHandoffTests.prepare
    context = proposal_fixtures.PipProposalToolTests.context

    def setUp(self):
        personal_fixtures.PersonalHandoffTests.setUp(self)
        self.prepare()
        scoped = patch.object(config_module, 'USER_HOME', self.base / 'home' / '.dgc')
        scoped.start(); self.addCleanup(scoped.stop)

    def request(self, **changes):
        return {'source_kind':'personal_result', 'scope':'personal', 'source_run_id':self.run['id'],
                'target_pip_id':self.target['id'], 'shared_text':self.excerpt,
                'task':'Turn these blocks into a checklist.', 'request_key':'personal-one', **changes}

    def propose(self, args=None, ctx=None):
        with patch.object(tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)):
            return json.loads(tool.propose(self.request() if args is None else args, ctx or self.context()))

    def test_proposal_only_exact_excerpt_and_no_dispatch(self):
        with patch.object(pips.PipStore, 'enqueue', side_effect=AssertionError('No dispatch')), \
             patch.object(h, 'accept', side_effect=AssertionError('No approval')):
            receipt = self.propose()
        self.assertEqual(receipt['source_kind'], 'personal_result')
        self.assertEqual(receipt['workspace_id'], self.source['workspace_id'])
        self.assertTrue(receipt['review_required']); self.assertFalse(receipt['execution_started'])
        saved = h.get(self.store, receipt['handoff_id'])
        self.assertEqual(saved['payload']['source']['text'], self.excerpt)
        self.assertNotIn('Private detail', json.dumps(saved))
        self.assertEqual(self.store.runs(self.target['id']), [])
        self.assertEqual(self.propose(), receipt)
        changed = self.request(); changed['shared_text'] = 'Walk for 30 minutes.'
        with self.assertRaisesRegex(RegistryError, 'different work'): self.propose(changed)

    def test_personal_scope_is_explicit_and_actions_cannot_be_injected(self):
        base = self.request()
        candidates = [{k:v for k,v in base.items() if k!='scope'}, {**base,'scope':'project'},
            {**base,'action':{'kind':'patch'}}, {**base,'finding_index':0},
            {**base,'shared_text':'Made-up result'}, {**base,'shared_text':'x'*12001},
            {**base,'shared_text':'界'*4001}, {**base,'shared_text':' ' + self.excerpt}]
        for value in candidates:
            with self.subTest(value=list(value)), self.assertRaises(RegistryError): self.propose(value)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0],0)

    def test_no_private_report_parse_before_scope_authorization(self):
        project = self.store.create(self.workspace['id'], 'Project', 'Inspect source', 'local-console')
        for field, value in [('target_pip_id',project['id']),('source_run_id','run_'+'0'*32),
                             ('target_pip_id',self.source['id'])]:
            request=self.request();request[field]=value
            with patch.object(pips.PipStore,'_job',side_effect=AssertionError('No private parsing')), self.assertRaises(RegistryError):
                self.propose(request)

    def test_forged_or_rebound_origin_is_refused(self):
        ctx=self.context();ctx.pip_proposal_origin=lambda:{'session_id':'chat-one','workspace_id':self.source['workspace_id']}
        with self.assertRaises(RegistryError):self.propose(ctx=ctx)
        ctx=self.context()
        other=self.base/'other';other.mkdir();foreign=self.registry.resolve(other)
        self.registry.db.execute("UPDATE session_workspaces SET binding_id=? WHERE session_id='chat-one'",(foreign['binding_id'],))
        with self.assertRaises(RegistryError):self.propose(ctx=ctx)

    def test_origin_is_rechecked_inside_proposal_transaction(self):
        ctx=self.context();original=h._current
        def race(*args,**kwargs):
            result=original(*args,**kwargs)
            self.registry.db.execute("DELETE FROM session_workspaces WHERE session_id='chat-one'")
            return result
        with patch.object(h,'_current',race), self.assertRaises(RegistryError):self.propose(ctx=ctx)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0],0)

    def test_exact_retry_after_human_approval_never_requeues(self):
        first=self.propose();accepted=h.accept(self.store,first['handoff_id'],0,'local-console',self.cfg)
        with patch.object(pips.PipStore,'enqueue',side_effect=AssertionError('No re-dispatch')):
            replay=self.propose()
        self.assertEqual(replay['run_id'],accepted['run']['id'])
        self.assertFalse(replay['execution_started']);self.assertFalse(replay['review_required'])
        self.assertEqual(len(self.store.runs(self.target['id'])),1)

    def test_session_policy_and_disabled_pips_refuse(self):
        with patch('dgc.pip_access.restricted',return_value=True),self.assertRaises(RegistryError):self.propose()
        self.cfg.data['pips_enabled']=False
        with self.assertRaises(RegistryError):self.propose()

    def test_no_secret_excerpt_forwarding(self):
        with patch.object(tool,'secret_values',return_value=['Walk for 30 minutes.']),self.assertRaisesRegex(RegistryError,'credentials'):
            self.propose()
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0],0)


if __name__ == '__main__':
    unittest.main()
