"""Personal main-chat control: exact scope, local authority and durable retry."""
import copy
import json
import unittest
from unittest.mock import patch

from dgc import pip_run_tool as run, pip_lifecycle_tool as lifecycle, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.test_pip_proposal_tool import PipProposalToolTests as Fixture


class PersonalControlsTests(unittest.TestCase):
    setUp = Fixture.setUp
    context = Fixture.context

    def job(self, role='rook'):
        return self.store.create(self.registry.personal()['id'], 'Personal helper',
                                 'Prepare a plan from details I share', 'user', pip_type=role)

    def request(self, job, **changes):
        return dict(pip_id=job['id'], expected_version=job['current_version'],
                    scope='personal', request_key='one', reason='Run the reviewed task', **changes)

    def dispatch(self, args, ctx=None):
        ctx = ctx or self.context()
        with patch.object(run, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}):
            return json.loads(run.run(args, ctx))

    def mutate(self, operation, args, ctx=None):
        ctx = ctx or self.context()
        with patch.object(lifecycle, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}):
            return json.loads(lifecycle.apply(operation, args, ctx))

    def raw(self, run_id):
        return json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run_id,)).fetchone()[0])

    def test_personal_run_from_different_projects_has_no_source_or_tools(self):
        job = self.job()
        for index in range(2):
            root = self.base / ('project-' + str(index)); root.mkdir()
            self.registry.resolve(root)
            ctx = self.context('chat-' + str(index))
            identity = self.registry.associate_session('other-' + str(index), root)
            ctx.project_root = root
            ctx.pip_proposal_origin = lambda: {'session_id': 'other-' + str(index), 'workspace_id': identity['workspace_id']}
            with patch.object(pips, 'source_revision', side_effect=AssertionError('No project source')):
                receipt = self.dispatch(self.request(job), ctx)
            manifest = self.raw(receipt['run_id']); run.validate_manifest(manifest)
            pin = manifest['main_chat_request']
            self.assertEqual(pin['schema_version'], 2)
            self.assertEqual(pin['scope'], 'personal')
            self.assertEqual(pin['origin_workspace_id'], identity['workspace_id'])
            self.assertEqual(pin['workspace_id'], job['workspace_id'])
            self.assertEqual(manifest['run_kind'], 'personal_task')
            self.assertEqual(manifest['tools'], [])
            self.assertIsNone(manifest['source_revision'])

    def test_personal_role_does_not_grant_project_execution(self):
        for role in ('patch', 'pulse', 'quill'):
            receipt = self.dispatch(self.request(self.job(role)))
            manifest = self.raw(receipt['run_id']); run.validate_manifest(manifest)
            self.assertEqual(manifest['run_kind'], 'personal_task')
            self.assertEqual(manifest['tools'], [])

    def test_personal_scope_is_explicit_and_cannot_address_project_or_foreign_job(self):
        personal = self.job(); project = self.store.create(self.workspace['id'], 'Project', 'Review source', 'user')
        other = self.base/'foreign'; other.mkdir()
        foreign = self.store.create(self.registry.resolve(other)['id'], 'Foreign', 'Review', 'user')
        for payload in ({k: v for k, v in self.request(personal).items() if k != 'scope'},
                        self.request(project), self.request(foreign)):
            with self.assertRaises(RegistryError): self.dispatch(payload)
        self.assertEqual(self.store.runs(personal['id']), [])
        self.assertEqual(self.store.runs(project['id']), [])
        self.assertEqual(self.store.runs(foreign['id']), [])

    def test_session_and_personal_identity_cannot_be_forged(self):
        job = self.job(); args = self.request(job); ctx = self.context()
        ctx.pip_proposal_origin = lambda: {'session_id': 'invented', 'workspace_id': self.workspace['id']}
        with self.assertRaises(RegistryError): self.dispatch(args, ctx)
        receipt = self.dispatch(args); pin = self.raw(receipt['run_id'])['main_chat_request']
        for change in ({'origin_workspace_id': job['workspace_id']}, {'workspace_id': self.workspace['id']},
                       {'scope': 'project'}, {'schema_version': 1}, {'origin_workspace_id': None}):
            with self.assertRaises(RegistryError): run.validate_origin(self.registry, {**pin, **change})
        self.registry.db.execute("UPDATE metadata SET value=? WHERE key='personal_workspace'", (self.workspace['id'],))
        with self.assertRaises(RegistryError): run.validate_origin(self.registry, pin)

    def test_personal_worker_pin_refuses_source_and_tool_escalation(self):
        original = self.raw(self.dispatch(self.request(self.job()))['run_id'])
        for change in ({'tools':['bash']}, {'source_policy':{'mode':'committed_only'}},
                       {'source_revision':'a'*40}, {'run_kind':'patch'}, {'policy':'auto'},
                       {'handoff':{}}, {'job':{'pip_type':'core'}}):
            with self.assertRaises(RegistryError): run.validate_manifest({**copy.deepcopy(original), **change})

    def test_retry_survives_pause_but_not_scope_or_origin_change(self):
        job = self.job(); args = self.request(job); first = self.dispatch(args)
        self.store.set_paused(job['id'], True, 'user')
        self.assertEqual(first['run_id'], self.dispatch(args)['run_id'])
        with self.assertRaises(RegistryError): self.dispatch({**args, 'scope':'project'})
        ctx = self.context(); self.registry.db.execute("DELETE FROM session_workspaces WHERE session_id='chat-one'")
        with self.assertRaises(RegistryError): self.dispatch(args, ctx)

    def test_pause_resume_attach_reviewed_revision_and_attachment_survive_directory_change(self):
        job = self.job(); ctx = self.context()
        args = {**self.request(job), 'expected_lifecycle_revision':0}
        paused = self.mutate('pause_pip', args, ctx)
        self.assertEqual(paused['current']['status'], 'paused')
        self.assertTrue(self.mutate('pause_pip', args, ctx)['replayed'])
        self.assertFalse(paused['run_queued_by_this_call'])
        resumed = self.mutate('resume_pip', {**args, 'request_key':'resume', 'expected_lifecycle_revision':1}, ctx)
        self.assertEqual(resumed['current']['status'], 'active')
        with self.assertRaises(RegistryError):
            self.mutate('pause_pip', {**args, 'request_key':'stale'}, ctx)
        attached = self.mutate('attach_pip_to_session', {**args, 'request_key':'attach', 'expected_lifecycle_revision':2}, ctx)
        self.assertTrue(attached['current']['attached'])
        refs = lifecycle.attachments(self.registry, self.root, 'chat-one')['attachments']
        self.assertEqual(len(refs), 1); self.assertEqual(refs[0]['scope'], 'personal')
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(refs, lifecycle.attachments(reopened, self.root, 'chat-one')['attachments'])
        self.assertEqual(self.store.runs(job['id']), [])

    def test_invalid_scope_rejected_before_storage(self):
        job = self.job()
        for scope in ('all', '', None, [], {}):
            with self.assertRaises(RegistryError): run.request({**self.request(job), 'scope': scope})


if __name__ == '__main__':
    unittest.main()
