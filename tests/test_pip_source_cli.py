"""Real console source choice is a proposal, with explicit source-kind output."""
import unittest
from dgc import pip_cli
from tests import test_pip_cli as fixtures


class PipSourceCliTests(unittest.TestCase):
    setUp = fixtures.PipCliTests.setUp
    invoke = fixtures.PipCliTests.invoke
    value = fixtures.PipCliTests.value
    child_env = fixtures.PipCliTests.child_env
    child_cli = fixtures.PipCliTests.child_cli

    def test_console_source_change_needs_exact_saved_review(self):
        self.child_cli('enable')
        job=self.child_cli('create','Reviewer','--goal','Inspect source')['pip']
        proposal=self.child_cli('propose',job['id'],'--expected-version','1',
            '--source-policy','current_tree','--reason','Inspect eligible uncommitted source')['proposal']
        self.assertEqual(self.child_cli('show',job['id'])['pip']['source_policy'],{'mode':'committed_only'})
        self.assertEqual(proposal['definition']['source_policy'],{'mode':'current_tree','exclusions':'safe_source_v1'})
        self.assertIsNone(proposal['definition']['schedule'])
        self.assertIsNone(proposal['definition']['event_trigger'])
        changed=self.child_cli('accept',job['id'],proposal['id'],'--expected-version','1')['pip']
        self.assertEqual(changed['source_policy']['mode'],'current_tree')
        self.assertEqual(changed['current_version'],2)

    def test_format_snapshot_never_calls_it_a_commit(self):
        receipt={'schema_version':1,'kind':'current_tree','sha256':'b'*64,'files':2,'bytes':21,
            'exclusions':'safe_source_v1','excluded_entries':1,'excluded_directories':0,'consistency':'checked_non_atomic'}
        value={'run':{'id':'run','pip_id':'pip','status':'queued','manifest':{'job_version':2,'model':'fixture',
            'source_revision':None,'source_policy':{'mode':'current_tree','exclusions':'safe_source_v1'},
            'source_snapshot':receipt,'run_kind':'audit'},'result':None}}
        rendered=pip_cli._format(value)
        self.assertIn('Current-tree snapshot: '+receipt['sha256'],rendered)
        self.assertIn('checked non-atomic',rendered)
        self.assertNotIn('Committed source',rendered)


if __name__=='__main__': unittest.main()
