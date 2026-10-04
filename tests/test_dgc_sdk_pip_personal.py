"""Personal connection metadata SDK contract; no network or sleeps."""
import unittest
from tests.test_dgc_sdk_pips import Wire, session, CAPS
from dgc_sdk import DGCConfigError, DGCUnsupportedError
from dgc_sdk.pips import COMMAND_FIELDS
from dgc.pips import _COMMAND_ARGS


class PersonalSDKTests(unittest.TestCase):
    def test_shared_connection_metadata_is_read_only_and_capability_gated(self):
        for command, params in [('list_pip_connections', {}), ('inspect_pip_connection', {'server':'composio'})]:
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command])
            wire=Wire(); old=session(wire,caps={**CAPS,'pips_api_version':27})
            with self.assertRaisesRegex(DGCUnsupportedError,'API 28'):old.pips.read(command,params)
            current=session(wire,caps={**CAPS,'pips_api_version':28})
            with self.assertRaises(DGCConfigError):current.pips.mutate(command,params,approved=True)
            with self.assertRaises(DGCConfigError):current.pips.read(command,{**params,'token':'forged'})
            self.assertFalse(wire.calls)
            self.assertEqual(current.pips.read(command,params)['request']['type'],command)
            self.assertEqual(len(wire.calls),1)

    def test_reviewed_app_plan_refuses_old_runtime_even_with_approval(self):
        params={'pip_id':'pip_saved','expected_version':1,'changes':{'app_plan':None},'reason':'Remove reads'}
        wire=Wire();old=session(wire,caps={**CAPS,'pips_api_version':27})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 28'):old.pips.mutate('propose_pip_update',params,approved=True)
        self.assertFalse(wire.calls)
        current=session(wire,caps={**CAPS,'pips_api_version':28})
        with self.assertRaises(DGCConfigError):current.pips.mutate('propose_pip_update',params)
        self.assertEqual(current.pips.mutate('propose_pip_update',params,approved=True)['request']['changes'],{'app_plan':None})

    def test_github_reads_require_api41_and_human_approval(self):
        plan={'schema_version':1,'repository':'OpenPeach-ai/dgc','reads':[{'kind':'commit_checks'}]}
        params={'pip_id':'pip_saved','expected_version':1,'changes':{'github_plan':plan},'reason':'Read CI'}
        wire=Wire();old=session(wire,caps={**CAPS,'pips_api_version':40})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 41'):old.pips.mutate('propose_pip_update',params,approved=True)
        self.assertEqual(wire.calls,[])
        current=session(wire,caps={**CAPS,'pips_api_version':41})
        self.assertEqual(current.pips.mutate('propose_pip_update',params,approved=True)['request']['changes'],{'github_plan':plan})

    def test_account_discovery_api29_is_read_only_and_has_no_implicit_approval(self):
        wire=Wire();old=session(wire,caps={**CAPS,'pips_api_version':28})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 29'):old.pips.read('list_pip_accounts',{'server':'composio'})
        self.assertFalse(wire.calls)
        current=session(wire,caps={**CAPS,'pips_api_version':29})
        with self.assertRaises(DGCConfigError):current.pips.mutate('list_pip_accounts',{'server':'composio'},approved=True)
        self.assertEqual(current.pips.read('list_pip_accounts',{'server':'composio'})['request']['type'],'list_pip_accounts')
        self.assertEqual(COMMAND_FIELDS['list_pip_accounts'],_COMMAND_ARGS['list_pip_accounts'])

    def test_personal_handoff_requires_api30_and_separate_mutation_approval(self):
        command='propose_pip_personal_handoff'
        params={'source_run_id':'run_source','target_pip_id':'pip_target','shared_text':'Reviewed result.',
                'task':'Create a checklist','idempotency_key':'one'}
        self.assertEqual(COMMAND_FIELDS[command],_COMMAND_ARGS[command])
        wire=Wire();old=session(wire,caps={**CAPS,'pips_api_version':29})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 30'):old.pips.mutate(command,params,approved=True)
        current=session(wire,caps={**CAPS,'pips_api_version':30})
        with self.assertRaises(DGCConfigError):current.pips.read(command,params)
        with self.assertRaises(DGCConfigError):current.pips.mutate(command,params)
        with self.assertRaises(DGCConfigError):current.pips.mutate(command,{**params,'action':{'kind':'patch'}},approved=True)
        self.assertEqual(wire.calls,[])
        self.assertEqual(current.pips.mutate(command,params,approved=True)['request']['shared_text'],params['shared_text'])
        self.assertEqual(len(wire.calls),1)

    def test_recurring_calendar_plan_requires_api33_and_human_approval(self):
        params={'pip_id':'pip_saved','expected_version':1,'changes':{'app_plan':{'schema_version':2}},'reason':'Read each day'}
        wire=Wire();old=session(wire,caps={**CAPS,'pips_api_version':32})
        with self.assertRaisesRegex(DGCUnsupportedError,'API 33'):old.pips.mutate('propose_pip_update',params,approved=True)
        self.assertEqual(wire.calls,[])
        current=session(wire,caps={**CAPS,'pips_api_version':33})
        with self.assertRaises(DGCConfigError):current.pips.mutate('propose_pip_update',params)
        self.assertEqual(current.pips.mutate('propose_pip_update',params,approved=True)['request']['changes'],params['changes'])
