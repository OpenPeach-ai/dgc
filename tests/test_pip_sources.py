"""Pure source identity contracts: no implicit Git/snapshot coercion or authority."""
import copy
import unittest
from unittest.mock import patch

from dgc import pip_sources as sources
from dgc.workspace_registry import RegistryError


class PipSourcesTests(unittest.TestCase):
    def receipt(self):
        return {'schema_version':1, 'kind':'current_tree', 'sha256':'b'*64, 'files':2, 'bytes':23,
                'exclusions':'safe_source_v1', 'excluded_entries':3, 'excluded_directories':1,
                'consistency':'checked_non_atomic'}

    def policy(self):
        return {'mode':'current_tree', 'exclusions':'safe_source_v1'}

    def manifest(self, kind='audit', pip_type='rook'):
        return {**sources.pin(self.policy(), source_revision=None, source_snapshot=self.receipt()),
                'job':{'pip_type':pip_type,'source_policy':self.policy()}, 'pip_type':pip_type,
                'run_kind':kind, 'trigger':'manual', 'policy':'read_only'}

    def test_only_omitted_and_explicit_legacy_committed_defaults(self):
        self.assertEqual(sources.validate_policy(), {'mode':'committed_only'})
        self.assertEqual(sources.validate_policy('committed_only'), {'mode':'committed_only'})
        self.assertEqual(sources.validate_policy({'mode':'committed_only'}), {'mode':'committed_only'})
        for bad in (None, True, False, [], {}, 'current_tree', 'latest_committed', {'mode':'current_tree'},
                    {'mode':'current_tree','exclusions':'none'}, {'mode':'current_tree','exclusions':'safe_source_v1','network':True},
                    {'mode':['committed_only']}, {'mode':None}, {'mode':'committed_only','extra':1}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                sources.validate_policy(bad)

    def test_manual_source_roles_and_explicit_chat_eligible(self):
        for role in ('scout','lens','rook','lock','quill'):
            self.assertEqual(sources.validate_job(self.policy(), pip_type=role), self.policy())
            kind = 'draft' if role == 'quill' else 'audit'
            for run_kind in (kind,'conversation'):
                value = self.manifest(run_kind, role)
                self.assertEqual(sources.validate_manifest(value)['source_revision'], None)
                value['trigger'] = 'main_chat'
                self.assertEqual(sources.validate_manifest(value)['source_policy'], self.policy())

    def test_current_tree_never_enables_patch_pulse_or_automatic_jobs(self):
        for role in ('patch','pulse','core','unknown',None,True):
            with self.assertRaises(RegistryError): sources.validate_job(self.policy(), pip_type=role)
        for option in ({'schedule':{}}, {'event_trigger':{}}, {'schedule':{'type':'interval','minutes':60}},
                       {'event_trigger':{'events':['commit_changed']}}):
            with self.assertRaises(RegistryError) as caught:
                sources.validate_job(self.policy(), pip_type='rook', **option)
            self.assertEqual(caught.exception.code, 'manual_only')
        for role in ('patch','pulse'):
            self.assertEqual(sources.validate_job('committed_only', pip_type=role)['mode'], 'committed_only')

    def test_commit_and_snapshot_identities_remain_distinct(self):
        for size in (40,64):
            value = sources.pin('committed_only', source_revision='a'*size)
            self.assertEqual(value['source_snapshot'], None)
            self.assertEqual(sources.validate_pin(value), value)
        current = sources.pin(self.policy(), source_revision=None, source_snapshot=self.receipt())
        self.assertIsNone(current['source_revision'])
        self.assertEqual(current['source_snapshot'], self.receipt())
        for rev in ('b'*64,'a'*40,'',False):
            with self.assertRaises(RegistryError): sources.pin(self.policy(), source_revision=rev, source_snapshot=self.receipt())
        for rev in (None,'HEAD','A'*40,'a'*39,'a'*65,'a'*1000000,True):
            with self.assertRaises(RegistryError): sources.pin('committed_only', source_revision=rev)
        with self.assertRaises(RegistryError): sources.pin('committed_only', source_revision='a'*40, source_snapshot=self.receipt())

    def test_current_receipt_is_exact_bounded_and_not_a_path(self):
        for receipt in (None,{},str('/tmp/source'),{**self.receipt(),'path':'/tmp/source'},
                        {**self.receipt(),'files':True},{**self.receipt(),'sha256':'a'*1000000},
                        {**self.receipt(),'bytes':64*1024*1024+1},
                        {**self.receipt(),'consistency':'atomic'}, {**self.receipt(),'exclusions':'none'}):
            with self.assertRaises(RegistryError): sources.pin(self.policy(), source_revision=None, source_snapshot=receipt)
        value = sources.pin(self.policy(), source_revision=None, source_snapshot=self.receipt())
        for bad in ({k:v for k,v in value.items() if k!='source_snapshot'}, {**value,'root':'/tmp/source'}):
            with self.assertRaises(RegistryError): sources.validate_pin(bad)

    def test_legacy_readers_default_only_real_commit_shape_and_keep_original_bytes(self):
        for policy in (None,'committed_only',{'mode':'committed_only'}):
            legacy = {'source_revision':'a'*40, 'model':'fixture', 'other':'reference'}
            if policy is not None: legacy['source_policy'] = policy
            before = copy.deepcopy(legacy)
            self.assertEqual(sources.from_record(legacy)['source_policy'], {'mode':'committed_only'})
            self.assertEqual(legacy,before)
        for bad in ({},[],None,{'source_revision':None}, {'source_revision':'b'*64,'source_snapshot':self.receipt()},
                    {'source_revision':'a'*40,'source_policy':None}, {'source_revision':None,'source_snapshot':self.receipt()}):
            with self.assertRaises(RegistryError): sources.from_record(bad)

    def test_current_pinned_job_policy_and_role_must_match(self):
        value = self.manifest()
        for mutation in (lambda m:m.pop('job'), lambda m:m['job'].pop('source_policy'),
                         lambda m:m['job'].update(source_policy='committed_only'),
                         lambda m:m.update(pip_type='lens'), lambda m:m.update(job='bad'),
                         lambda m:m['job'].update(pip_type='patch'), lambda m:m['job'].update(schedule={}),
                         lambda m:m['job'].update(event_trigger={}),lambda m:m.update(policy='auto')):
            bad=copy.deepcopy(value); mutation(bad)
            with self.assertRaises(RegistryError): sources.validate_manifest(bad)
        mixed={'source_revision':'a'*40,'source_policy':'committed_only','job':{'source_policy':self.policy()}}
        with self.assertRaises(RegistryError): sources.validate_manifest(mixed)

    def test_current_run_kind_trigger_and_hidden_occurrences_are_closed(self):
        for kind in (None,'patch','test','arbitrary'):
            with self.assertRaises(RegistryError): sources.validate_manifest(self.manifest(kind))
        with self.assertRaises(RegistryError): sources.validate_manifest(self.manifest('draft','rook'))
        with self.assertRaises(RegistryError): sources.validate_manifest(self.manifest('audit','quill'))
        for trigger in (None,'schedule','event','handoff','automatic'):
            with self.assertRaises(RegistryError): sources.validate_manifest({**self.manifest(),'trigger':trigger})
        for key in ('handoff','schedule','schedule_occurrence','scheduled_at','event_trigger','event_occurrence'):
            for value in (None,{},'malicious'):
                with self.subTest(key=key,value=value), self.assertRaises(RegistryError):
                    sources.validate_manifest({**self.manifest(),key:value})

    def test_projection_labels_identity_and_does_not_expose_unrelated_fields(self):
        current=sources.projection({**self.manifest(),'api_key':'PRIVATE','canonical_root':'/private/project'})
        self.assertEqual(current['identity_kind'],'snapshot_sha256')
        self.assertEqual(current['label'],'Current-tree snapshot')
        self.assertEqual(current['identity'],'b'*64)
        self.assertNotIn('PRIVATE',str(current));self.assertNotIn('/private/project',str(current))
        legacy=sources.projection({'source_revision':'a'*40})
        self.assertEqual(legacy['identity_kind'],'git_commit')
        self.assertEqual(legacy['source_revision'],'a'*40)
        self.assertIsNone(legacy['source_snapshot'])

    def test_all_validation_is_pure_and_does_not_authorize_or_resolve_sources(self):
        value=self.manifest()
        original=copy.deepcopy(value)
        with patch('builtins.open',side_effect=AssertionError('No files')), \
             patch('os.open',side_effect=AssertionError('No descriptors')), \
             patch('subprocess.Popen',side_effect=AssertionError('No Git or helpers')), \
             patch('sqlite3.connect',side_effect=AssertionError('No registry')):
            sources.validate_manifest(value)
            sources.projection(value)
        self.assertEqual(value,original)
        # Existing SHA syntax is not evidence that an object exists. The controller
        # resolves Git refs separately; this pure parser does not invent that proof.
        self.assertEqual(sources.from_record({'source_revision':'f'*40})['source_revision'],'f'*40)


if __name__ == '__main__': unittest.main()
