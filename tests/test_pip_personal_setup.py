"""Personal setup must survive project changes without inheriting source access."""
import unittest
from unittest.mock import patch
from dgc import pip_setup, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

class PersonalSetupTests(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.registry.associate_session('main-chat',self.root)
    def request(self,**changes):
        return {'target_root':str(self.root),'name':'Plan tomorrow','goal':'Help organize my day',
                'pip_type':'rook','scope':'personal','work_kind':'personal_task','schedule':None,
                'run_now':False,'request_key':'personal1','reason':'Requested personal helper',**changes}
    def draft(self,**changes):
        return pip_setup.propose(self.registry,self.request(**changes),self.root,'main-chat')
    def review(self,draft,config=None):
        with patch('dgc.pip_runtime.require_supervisor',return_value={'online':True}):
            return pip_setup.review(self.registry,draft['id'],draft['workspace_id'],draft['digest'],
                                    'local-console',config or self.cfg,True)
    def test_review_across_directories_has_no_git_or_project_access(self):
        other=self.base/'other';other.mkdir();cfg=self.cfg.clone_for_root(other)
        with patch.object(pips,'source_revision',side_effect=AssertionError('No Git')):
            draft=self.draft();result=self.review(draft,cfg)
        job=self.store.get(result['receipt']['pip_id'])
        self.assertEqual(job['source_policy'],{'mode':'personal'})
        self.assertEqual(job['workspace_id'],self.registry.personal()['id'])
        self.assertNotEqual(draft['project_root'],str(self.root))
        self.assertEqual(self.review(draft,cfg),result)
    def test_immediate_personal_job_queues_without_git(self):
        with patch.object(pips,'source_revision',side_effect=AssertionError('No Git')):
            draft=self.draft(run_now=True);result=self.review(draft)
        run=self.store.run(result['receipt']['run_id'])
        self.assertEqual(run['manifest']['run_kind'],'personal_task')
        self.assertEqual(run['manifest']['tools'],[])
    def test_unknown_origin_cannot_create_personal_setup(self):
        with self.assertRaises(RegistryError):
            pip_setup.propose(self.registry,self.request(),self.root,'unregistered-chat')
    def test_no_command_plan_in_personal_setup(self):
        for changes in ({'verification_plan':{}},{'work_kind':'source_review'}):
            with self.assertRaises(RegistryError):self.draft(**changes)
    def test_personal_setup_is_not_auto_approval(self):
        draft=self.draft()
        self.assertEqual(self.store.list(draft['workspace_id']),[])
        self.assertEqual(draft['status'],'pending')
    def test_profile_workspace_safe_inside_transaction(self):
        with self.registry.transaction():first=self.registry.personal()
        with self.registry.transaction():self.assertEqual(first,self.registry.personal())


class PersonalReadFlowTests(unittest.TestCase):
    setUp=PersonalSetupTests.setUp
    request=PersonalSetupTests.request
    draft=PersonalSetupTests.draft
    review=PersonalSetupTests.review
    def test_review_pins_app_calls_and_modify_preserves_grant(self):
        from dgc import pip_app_access as apps
        plan={'schema_version':1,'server':'composio','connection_digest':'a'*64,
              'calls':[{'tool':'GMAIL_FETCH_EMAILS','schema_digest':'b'*64,'account':'ca_offline_test','arguments':{'max_results':5,'query':'is:unread'}}]}
        draft=self.draft(app_plan=plan)
        self.assertEqual(draft['app_plan'],plan)
        accepted=self.review(draft);job=self.store.get(accepted['receipt']['pip_id'])
        self.assertEqual(job['app_plan'],plan)
        changed=self.draft(pip_id=job['id'],expected_version=1,expected_lifecycle_revision=job['lifecycle_revision'],request_key='modify',goal='Make a shorter summary')
        self.assertEqual(changed['app_plan'],plan)
        accepted=self.review(changed)
        run=self.store.enqueue(job['id'],'read-task','local-console',self.cfg)
        self.assertEqual(run['manifest']['app_plan'],plan)
        self.assertEqual(run['manifest']['tools'],[])
    def test_personal_result_is_durable_and_exportable(self):
        from dgc.pip_export import export_run
        from dgc.workspace_registry import WorkspaceRegistry
        job=self.store.create(self.registry.personal()['id'],'Notes','Organize notes','local-console')
        run=self.store.enqueue(job['id'],'result','local-console',self.cfg)
        self.store.claim_next()
        body={'text':'# A suggested plan\nOne private result.','tools_called':0,'external_actions':False,'usage':{}}
        self.store.finish(run['id'],result=body)
        with WorkspaceRegistry(self.registry.directory) as other:
            self.assertEqual(pips.PipStore(other).run(run['id'])['result'],body)
        path=self.base/'result.jsonl'
        export_run(self.cfg,run['id'],path,directory=self.registry.directory)
        self.assertIn('One private result',path.read_text())
        with self.assertRaises(RegistryError):export_run(self.cfg,run['id'],path,directory=self.registry.directory)
    def test_invalid_personal_result_not_saved(self):
        job=self.store.create(self.registry.personal()['id'],'Notes','Organize notes','local-console')
        run=self.store.enqueue(job['id'],'bad-result','local-console',self.cfg);self.store.claim_next()
        for result in ({'text':'Sent a message','external_actions':True,'tools_called':0,'usage':{}}, {'summary':'Looks fine'}):
            with self.assertRaises(RegistryError):self.store.finish(run['id'],result=result)
        self.assertEqual(self.store.run(run['id'])['status'],'running')

class PersonalReferenceTests(unittest.TestCase):
    setUp=PersonalSetupTests.setUp
    def test_personal_context_is_explicit_and_project_queries_stay_scoped(self):
        import json
        from types import SimpleNamespace
        from dgc import pip_context_tool
        from dgc.workspace_registry import WorkspaceRegistry
        personal=self.store.create(self.registry.personal()['id'],'Personal helper','Private day planning','local-console')
        project=self.store.create(self.workspace['id'],'Project helper','Code review','local-console')
        ctx=SimpleNamespace(config=self.cfg,project_root=self.root)
        with patch.object(pip_context_tool,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory)):
            a=pip_context_tool.read({'action':'list','scope':'personal'},ctx)
            b=pip_context_tool.read({'action':'list'},ctx)
            self.assertIn('Personal helper',a);self.assertNotIn('Project helper',a)
            self.assertIn('Project helper',b);self.assertNotIn('Personal helper',b)
            detail=json.loads(pip_context_tool.read({'action':'definition','scope':'personal','pip_id':personal['id']},ctx))
            self.assertEqual(detail['pip']['source_policy'],{'mode':'personal'})
            with self.assertRaises(RegistryError):pip_context_tool.read({'action':'definition','pip_id':personal['id']},ctx)
            with self.assertRaises(RegistryError):pip_context_tool.read({'action':'definition','scope':'personal','pip_id':project['id']},ctx)
    def test_remote_does_not_inherit_personal_workspace_access(self):
        from dgc.workspace_registry import WorkspaceRegistry
        personal=self.store.create(self.registry.personal()['id'],'Private','Plan my day','local-console')
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory)):
            result=pips.handle_control(self.cfg,{'type':'get_pip','pip_id':personal['id'],'request_id':'remote1'},'paired-phone',start_worker=False)
            self.assertFalse(result['ok'])
            self.assertEqual(result['error']['code'],'local_only')
            result=pips.handle_control(self.cfg,{'type':'list_workspaces','request_id':'remote2'},'paired-phone',start_worker=False)
            self.assertTrue(result['ok'])
            self.assertNotIn(personal['workspace_id'],str(result))

if __name__=='__main__':unittest.main()
