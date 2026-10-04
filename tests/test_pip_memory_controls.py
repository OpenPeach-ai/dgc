"""Actual exception helpers through the authenticated raw controller boundary."""
import copy
import json
import unittest
from unittest.mock import patch

from dgc import pips
from tests import test_pip_checkpoint_integration as fixtures


class MemoryControlTests(unittest.TestCase):
    setUp=fixtures.CheckpointIntegrationTests.setUp
    git=fixtures.CheckpointIntegrationTests.git
    commit=fixtures.CheckpointIntegrationTests.commit
    create=fixtures.CheckpointIntegrationTests.create
    completed=fixtures.CheckpointIntegrationTests.completed
    control=fixtures.CheckpointIntegrationTests.control

    def source(self):
        job=self.create();run=self.completed(job,'first')
        request={'type':'get_pip_exception_source','pip_id':job['id'],'run_id':run['id'],'finding_index':0}
        response=self.control(request)
        self.assertTrue(response['ok'],response)
        return job,run,response['result']

    def recording(self,job,run,candidate,**overrides):
        return {'type':'record_pip_exception','pip_id':job['id'],'run_id':run['id'],'finding_index':0,
                'expected_source_digest':candidate['digest'],'reason':'Human reviewed this tradeoff.',
                'request_key':'record-fixture',**overrides}

    def test_controller_source_record_list_revoke_and_retries_preserve_config(self):
        original=copy.deepcopy(self.cfg.data),copy.deepcopy(self.cfg.permissions),self.cfg.project_root
        job,run,candidate=self.source()
        request=self.recording(job,run,candidate)
        saved=self.control(request)
        self.assertTrue(saved['ok'],saved)
        value=saved['result']['memory']
        self.assertEqual(value['created_by'],'review-device')
        self.assertEqual(value['source'],candidate['source'])
        self.assertTrue(self.control(request)['result']['replayed'])
        listed=self.control({'type':'list_pip_memories','pip_id':job['id'],'limit':1})
        self.assertEqual(listed['result']['memories'],[value])
        revoke={'type':'revoke_pip_exception','pip_id':job['id'],'memory_id':value['id'],
                'expected_revision':0,'reason':'Reconsider the original choice.'}
        result=self.control(revoke)
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['result']['memory']['status'],'revoked')
        self.assertTrue(self.control(revoke)['result']['replayed'])
        self.assertEqual((self.cfg.data,self.cfg.permissions,self.cfg.project_root),original)

    def test_restricted_and_sandboxed_raw_reads_and_mutations_refuse_before_registry(self):
        job,run,candidate=self.source()
        requests=[{'type':'get_pip_exception_source','pip_id':job['id'],'run_id':run['id'],'finding_index':0},
                  {'type':'list_pip_memories','pip_id':job['id']},self.recording(job,run,candidate),
                  {'type':'revoke_pip_exception','pip_id':job['id'],'memory_id':'memory_'+'a'*32,
                   'expected_revision':0,'reason':'Review'}]
        for restriction in ('dgc.permissions.session_policy','dgc.sandbox.requested'):
            for request in requests:
                with self.subTest(restriction=restriction,command=request['type']), \
                        patch(restriction,return_value=object()), \
                        patch.object(pips,'WorkspaceRegistry',side_effect=AssertionError('Restricted control must not open storage')):
                    result=self.control(request)
                self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'session_policy',result)
                self.assertEqual(result['request_id'],'fixture-control')

    def test_disabled_reads_and_mutations_refuse_before_registry(self):
        job,run,candidate=self.source();self.cfg.data['pips_enabled']=False
        for request in ({'type':'list_pip_memories','pip_id':job['id']},self.recording(job,run,candidate)):
            with patch.object(pips,'WorkspaceRegistry',side_effect=AssertionError('Disabled control must not open storage')):
                result=self.control(request)
            self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'disabled')

    def test_source_actor_workspace_and_path_fields_cannot_be_forged(self):
        job,run,candidate=self.source();request=self.recording(job,run,candidate)
        for key,value in (('actor','another-user'),('created_by','another-user'),('workspace_id','ws_'+'f'*32),
                          ('source',{'source_revision':'b'*40}),('project_root','/tmp'),('permissions',{'allow':['Bash']})):
            with self.subTest(key=key):
                result=self.control({**request,key:value})
                self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'invalid_request')
        stale=self.control({**request,'expected_source_digest':'f'*64})
        self.assertFalse(stale['ok']);self.assertEqual(stale['error']['code'],'conflict')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_memories').fetchone()[0],0)

    def test_cross_pip_source_refuses_and_original_memory_is_private_to_pip(self):
        job,run,candidate=self.source();other=self.create()
        result=self.control({'type':'get_pip_exception_source','pip_id':other['id'],'run_id':run['id'],'finding_index':0})
        self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'not_found')
        saved=self.control(self.recording(job,run,candidate))['result']['memory']
        result=self.control({'type':'revoke_pip_exception','pip_id':other['id'],'memory_id':saved['id'],
                             'expected_revision':0,'reason':'Try foreign source'})
        self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'not_found')
        self.assertEqual(self.control({'type':'list_pip_memories','pip_id':other['id']})['result']['memories'],[])

    def test_configured_credentials_are_refused_before_record_and_revoke(self):
        job,run,candidate=self.source();secret='fixture-configured-secret-never-in-memory'
        self.cfg.set('api_key',secret,persist=False)
        request=self.recording(job,run,candidate,reason='Keep '+secret)
        result=self.control(request)
        self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'invalid_memory')
        self.assertNotIn(secret,json.dumps(result))
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_memories').fetchone()[0],0)
        saved=self.control(self.recording(job,run,candidate))['result']['memory']
        result=self.control({'type':'revoke_pip_exception','pip_id':job['id'],'memory_id':saved['id'],
                             'expected_revision':0,'reason':'Remove '+secret})
        self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'invalid_memory')
        self.assertEqual(self.registry.db.execute('SELECT status FROM pip_memories').fetchone()[0],'active')
        self.assertFalse(any(secret in row for row in self.registry.db.iterdump()))

    def test_malformed_null_cursors_and_oversized_reason_do_not_write(self):
        job,run,candidate=self.source()
        for request in ({'type':'list_pip_memories','pip_id':job['id'],'before_id':None},
                        {'type':'list_pip_memories','pip_id':job['id'],'limit':True},
                        self.recording(job,run,candidate,reason='x'*1001),
                        self.recording(job,run,candidate,request_key=None)):
            result=self.control(request)
            self.assertFalse(result['ok'],result)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_memories').fetchone()[0],0)


if __name__=='__main__':unittest.main()
