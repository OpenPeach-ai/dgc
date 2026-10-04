"""Independent immutable parent/scope checks for auditors and Quill path events."""
import copy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from dgc import pips, pip_commit_paths as paths, pip_event_triggers as events
from dgc.workspace_registry import RegistryError, identifier
from tests import test_pips_local as fixtures
from tests.test_pip_commit_paths import RULES, NOW, comparison, reseal


class ParentTests(unittest.TestCase):
    setUp=fixtures.LocalPipsTests.setUp
    git=fixtures.LocalPipsTests.git
    commit=fixtures.LocalPipsTests.commit

    def saved(self, role='rook', *, selected=None):
        job=self.store.create(self.workspace['id'],'Path review','Inspect the approved source.','human',pip_type=role)
        policy=events.validate_event_trigger({'events':[paths.EVENT,'context_updated'],'commit_paths':RULES})
        definition=pips._definition(job['name'],job['goal'],pip_type=role,event_trigger=policy)
        self.registry.db.execute('INSERT INTO pip_versions VALUES(?,?,?,?,?,?)',
            (job['id'],2,pips._json(definition),'human','Reviewed fixture',NOW))
        self.registry.db.execute('UPDATE pips SET current_version=2 WHERE id=?',(job['id'],))
        binding=self.registry.binding(self.workspace['id'])
        manifest={'schema_version':1,'pip_type':role,'pip_id':job['id'],'workspace_id':self.workspace['id'],
            'binding_id':binding['id'],'runner_id':self.registry.runner_id,'job_version':2,
            'job':{key:definition[key] for key in paths._JOB_FIELDS},'run_kind':'draft' if role=='quill' else 'audit',
            'source_policy':{'mode':'committed_only'},'source_revision':'3'*40,'source_snapshot':None,
            'policy':'read_only','trigger':'event','requested_by':'local-event-trigger','model':'fixture',
            'model_settings':{'temperature':0.7},'tools':sorted(pips.READ_TOOLS)}
        event={'seq':5,'event_id':identifier('evt'),'event_type':selected or paths.EVENT_TYPE,'created_at':NOW}
        pin={'policy':policy,'job_version':2,'expected_after_seq':4,'checked_at':NOW,'event':event,
             'history_may_be_incomplete':False,'source_semantics':events._SOURCE_SEMANTICS}
        if event['event_type']==paths.EVENT_TYPE:
            pin['commit_path_match']=paths.pin_match(pip_id=job['id'],workspace_id=self.workspace['id'],
                job_version=2,binding_id=binding['id'],binding_digest='a'*64,source_ref='HEAD',rules=RULES,
                comparison=comparison(),observed_at=NOW)
        manifest['event_trigger']=pin
        run_id=identifier('run');key='event:2:5'
        self.registry.db.execute('''INSERT INTO pip_runs(id,pip_id,workspace_id,binding_id,idempotency_key,
          requested_by,manifest,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)''',
          (run_id,job['id'],self.workspace['id'],binding['id'],key,'local-event-trigger',pips._json(manifest),'queued',NOW))
        return run_id,manifest,definition

    def row(self,run_id):
        return self.registry.db.execute('SELECT * FROM pip_runs WHERE id=?',(run_id,)).fetchone()

    def save_manifest(self,run_id,manifest):
        # Deliberately simulate damaged historical storage in this disposable
        # database. Ordinary UPDATE correctly cannot alter immutable evidence.
        self.registry.db.execute('DROP TRIGGER IF EXISTS immutable_run_manifest')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(pips._json(manifest),run_id))

    def validate(self,run_id,manifest):
        return paths.validate_parent(SimpleNamespace(db=self.registry.db),self.row(run_id),manifest)

    def test_auditor_and_quill_use_original_versions_without_source_io(self):
        for role in ('scout','lens','rook','lock','quill'):
            with self.subTest(role=role):
                run_id,manifest,_=self.saved(role)
                self.registry.db.execute('UPDATE bindings SET canonical_root=? WHERE id=?',('/missing/original',manifest['binding_id']))
                self.registry.db.execute('UPDATE pips SET current_version=3 WHERE id=?',(manifest['pip_id'],))
                with patch('pathlib.Path.stat',side_effect=AssertionError('historical read must not stat source')):
                    checked=self.validate(run_id,manifest)
                self.assertEqual(checked['match'],manifest['event_trigger']['commit_path_match'])
                self.assertNotEqual(checked['match']['comparison']['after_revision'],manifest['source_revision'])

    def test_unrelated_selected_event_still_checks_original_job(self):
        run_id,manifest,_=self.saved(selected='workspace_context_recorded')
        self.assertIsNone(self.validate(run_id,manifest)['match'])
        manifest['job']['goal']='Substituted'
        self.save_manifest(run_id,manifest)
        with self.assertRaises(RegistryError):self.validate(run_id,manifest)

    def test_retained_event_is_not_required_for_historical_parent(self):
        run_id,manifest,_=self.saved()
        self.registry.db.execute('DELETE FROM workspace_events')
        self.assertIsNotNone(self.validate(run_id,manifest)['match'])

    def test_parent_binds_saved_manifest_and_row_metadata(self):
        run_id,manifest,_=self.saved()
        changed=copy.deepcopy(manifest);changed['source_revision']='4'*40
        with self.assertRaises(RegistryError):self.validate(run_id,changed)
        for field,value in (('binding_id','binding_'+'f'*32),('requested_by','other'),('idempotency_key','event:2:6')):
            with self.subTest(field=field),self.assertRaises(RegistryError):
                paths.validate_parent(self.registry,{**dict(self.row(run_id)),field:value},manifest)

    def test_scope_precedes_private_manifest_and_definition_decode(self):
        run_id,manifest,_=self.saved()
        wrong={**dict(self.row(run_id)),'workspace_id':'ws_'+'f'*32}
        with patch.object(paths,'_load',side_effect=AssertionError('foreign body decoded')):
            with self.assertRaises(RegistryError):paths.validate_parent(self.registry,wrong,manifest)

    def test_oversized_saved_definition_refused_before_json_decode(self):
        run_id,manifest,_=self.saved()
        self.registry.db.execute('DROP TRIGGER immutable_job_version')
        self.registry.db.execute('UPDATE pip_versions SET definition=? WHERE pip_id=? AND version=2',
            ('x'*1000000,manifest['pip_id']))
        original=paths._load;seen=[]
        def load(value,maximum):seen.append(value);return original(value,maximum)
        with patch.object(paths,'_load',side_effect=load),self.assertRaises(RegistryError):self.validate(run_id,manifest)
        self.assertIsNone(seen[-1]);self.assertLess(len(seen[0]),131072)

    def test_oversized_saved_manifest_refused_before_json_decode(self):
        run_id,manifest,_=self.saved()
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',('x'*1000000,run_id))
        with patch.object(paths.json,'loads',side_effect=AssertionError('oversized body decoded')):
            with self.assertRaises(RegistryError):self.validate(run_id,manifest)

    def test_duplicate_saved_manifest_and_definition_keys_refused(self):
        for target in ('manifest','definition'):
            run_id,manifest,definition=self.saved()
            self.registry.db.execute('DROP TRIGGER IF EXISTS '+('immutable_run_manifest' if target=='manifest' else 'immutable_job_version'))
            raw='{"schema_version":1,'+pips._json(manifest if target=='manifest' else definition)[1:]
            if target=='manifest':self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(raw,run_id))
            else:self.registry.db.execute('UPDATE pip_versions SET definition=? WHERE pip_id=? AND version=2',(raw,manifest['pip_id']))
            with self.subTest(target=target),self.assertRaises(RegistryError):self.validate(run_id,manifest)

    def test_self_resigned_match_cannot_change_original_policy(self):
        run_id,manifest,_=self.saved();pin=manifest['event_trigger'];rules=[{'kind':'directory','path':'broad'}]
        pin['policy']['commit_paths']=rules
        pin['commit_path_match']=paths.pin_match(pip_id=manifest['pip_id'],workspace_id=manifest['workspace_id'],
            job_version=2,binding_id=manifest['binding_id'],binding_digest='a'*64,source_ref='HEAD',rules=rules,
            comparison=comparison(rules=rules),observed_at=NOW)
        self.save_manifest(run_id,manifest)
        paths.validate_manifest(manifest)
        with self.assertRaises(RegistryError):self.validate(run_id,manifest)

    def test_match_presence_is_exactly_selected_event(self):
        _,manifest,_=self.saved();del manifest['event_trigger']['commit_path_match']
        with self.assertRaises(RegistryError):paths.validate_manifest(manifest)
        _,other,_=self.saved(selected='workspace_context_recorded')
        _,matched,_=self.saved();other['event_trigger']['commit_path_match']=matched['event_trigger']['commit_path_match']
        with self.assertRaises(RegistryError):paths.validate_manifest(other)

    def test_wrong_receipt_identity_or_time_refused_even_with_new_digest(self):
        _,manifest,_=self.saved()
        for field,value in (('pip_id','pip_'+'f'*32),('workspace_id','ws_'+'f'*32),('job_version',3),
                            ('source_ref','other'),('observed_at','2026-10-02T10:00:01.000Z')):
            bad=copy.deepcopy(manifest);match=bad['event_trigger']['commit_path_match'];match[field]=value
            bad['event_trigger']['commit_path_match']=reseal(match,paths.MATCH_DOMAIN,4096)
            with self.subTest(field=field),self.assertRaises(RegistryError):paths.validate_manifest(bad)

    def test_current_tree_and_execution_or_manual_envelopes_refused(self):
        _,manifest,_=self.saved()
        for change in ({'trigger':'manual'},{'policy':'review_required'},{'pip_type':'pulse','run_kind':'test'},
                       {'source_policy':{'mode':'current_tree'}},{'handoff':None},{'requested_by':'human'},
                       {'schedule':None},{'conversation':None}):
            with self.subTest(change=change),self.assertRaises(RegistryError):paths.validate_manifest({**manifest,**change})

    def test_old_event_and_large_legacy_metadata_keep_original_limits(self):
        run_id,_,_=self.saved()
        legacy={'run_kind':'audit','old_counter':2**63,'old_text':'x'*20000,
                'event_trigger':{'policy':{'events':['commit_changed']}}}
        self.save_manifest(run_id,legacy)
        with patch.object(paths,'_encode',side_effect=AssertionError('new-mode bound imposed on legacy')):
            self.assertIsNone(paths.validate_manifest(legacy))
            self.assertIsNone(self.validate(run_id,legacy))

    def test_stripped_supplied_manifest_cannot_bypass_saved_new_mode(self):
        run_id,manifest,_=self.saved()
        for replacement in ({}, {'event_trigger':{'policy':{'events':['commit_changed']}}}):
            with self.subTest(replacement=replacement),self.assertRaises(RegistryError):self.validate(run_id,replacement)

    def test_actual_legacy_chat_unicode_actor_and_large_irrelevant_input_stay_legacy(self):
        from dgc import pip_chat
        self.commit()
        actor='é'*128;key='k'*128  # Chat keys retain their own ASCII-only contract.
        job=self.store.create(self.workspace['id'],'Legacy chat','Discuss approved source.','human')
        response=pip_chat.send(self.store,job['id'],'A legacy request.',key,actor,self.cfg)
        row=self.row(response['run']['id']);manifest=json.loads(row['manifest'])
        manifest['irrelevant_historical_extension']='x'*150000
        manifest['historical_large_counter']=2**63
        with patch.object(paths,'_encode',side_effect=AssertionError('new-mode limit applied to legacy')):
            self.assertIsNone(paths.validate_parent(SimpleNamespace(db=self.registry.db),row,manifest))
        retried=pip_chat.send(self.store,job['id'],'A legacy request.',key,actor,self.cfg)
        self.assertEqual(retried['run']['id'],row['id'])

    def test_actual_legacy_audit_unicode_actor_and_retry_key_stay_legacy(self):
        self.commit();actor='é'*128;key='界'*128
        job=self.store.create(self.workspace['id'],'Legacy audit','Inspect approved source.','human')
        run=self.store.enqueue(job['id'],key,actor,self.cfg)
        row=self.row(run['id']);manifest=json.loads(row['manifest'])
        with patch.object(paths,'_encode',side_effect=AssertionError('new-mode limit applied to legacy')):
            self.assertIsNone(paths.validate_parent(SimpleNamespace(db=self.registry.db),row,manifest))
        self.assertEqual(self.store.enqueue(job['id'],key,actor,self.cfg)['id'],run['id'])


if __name__=='__main__':unittest.main()
