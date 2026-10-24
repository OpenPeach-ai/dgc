"""Offline hostile contract and real disposable Git tests; no observer writes."""
import copy
import errno
import hashlib
import json
import os
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from dgc import pip_commit_paths as paths, pip_source_changes as changes
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


RULES=[{'kind':'exact','path':'source.py'}]
BEFORE='1'*40
AFTER='2'*40
NOW='2026-10-02T10:00:00.000Z'


def comparison(*, rules=RULES, status='matched', before=BEFORE, after=AFTER, reason=None):
    return paths._seal({'schema_version':1,'comparison':'commit_trees','before_revision':before,
        'after_revision':after,'policy_digest':paths.rules_digest(rules),'status':status,'reason':reason,
        'changed_entries':None if status=='unavailable' else 1 if status=='matched' else 0,
        'matched_rule_indices':[0] if status=='matched' else []}, paths.COMPARISON_MAX_BYTES, paths.COMPARISON_DOMAIN)


def reseal(value, domain=paths.COMPARISON_DOMAIN, maximum=paths.COMPARISON_MAX_BYTES):
    return paths._seal({k:v for k,v in value.items() if k!='digest'}, maximum, domain)


def max_rules():
    """32 canonical rules with exactly 2,048 encoded bytes; reusable integration fixture."""
    rules=[{'kind':'directory','path':f'p{i:02d}'} for i in range(32)]
    for rule in rules:
        extra=min(256-len(rule['path']),2048-len(paths._encode(rules,10000)))
        rule['path']+='a'*max(0,extra)
    checked=paths.validate_rules(rules)
    assert len(paths._encode(checked,2048))==2048
    return checked


class RuleAndReceiptTests(unittest.TestCase):
    def test_rule_canonical_order_and_domain(self):
        value=[{'kind':'directory','path':'é'},{'kind':'exact','path':'a'}]
        checked=paths.validate_rules(value)
        self.assertEqual([v['path'] for v in checked],['a','é'])
        raw=json.dumps(checked,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
        self.assertEqual(paths.rules_digest(value),hashlib.sha256(b'dgc.pips.commit_paths.rules.v1\0'+raw).hexdigest())
        self.assertEqual(value[0]['path'],'é')

    def test_closed_rules_and_all_path_escapes(self):
        for value in (None,[],{},[{'kind':['exact'],'path':'a'}],[{'kind':'exact','path':'a','extra':1}]):
            with self.subTest(value=value),self.assertRaises(RegistryError):paths.validate_rules(value)
        for value in ('','/a','a/','a//b','a/./b','a/../b','../a','a\\b','C:a','.git/a','A/.GIT/a',
                      'a\0b','a\nb','a\tb','a\x7fb','a*','a?','a[b]',' a','a ','\ud800'):
            with self.subTest(path=repr(value)),self.assertRaises(RegistryError):
                paths.validate_rules([{'kind':'exact','path':value}])
        self.assertEqual(paths.validate_rules([{'kind':'exact','path':'-leading dash'}])[0]['path'],'-leading dash')

    def test_unicode_controls_and_normalization_are_explicit(self):
        for value in ('a\u0085b','é','e\u0301','a\ufeffb'):
            self.assertEqual(paths.validate_rules([{'kind':'exact','path':value}])[0]['path'],value)
        with self.assertRaises(RegistryError):paths.validate_rules([{'kind':'exact','path':'\u0085a'}])
        with self.assertRaises(RegistryError):paths.validate_rules([{'kind':'exact','path':'é'*129}])

    def test_duplicate_paths_and_byte_count_limits(self):
        with self.assertRaises(RegistryError):paths.validate_rules([{'kind':k,'path':'a'} for k in ('exact','directory')])
        with self.assertRaises(RegistryError):paths.validate_rules([{'kind':'exact','path':str(i)} for i in range(33)])
        with self.assertRaises(RegistryError):paths.validate_rules([{'kind':'exact','path':str(i)+'x'*200} for i in range(10)])
        with self.assertRaises(RegistryError):paths.validate_rules([{'kind':'exact','path':'x'*257}])

    def test_full_rule_budget_fits_existing_quill_structure(self):
        from dgc.pip_quill_automation import _encode
        rules=max_rules()
        self.assertEqual(len(paths._encode(rules,2048)),2048)
        policy={'events':sorted(['committed_paths_changed','context_updated','finding_accepted','session_turn_completed']),
                'minimum_minutes':10080,'missed_policy':'coalesce_latest','commit_paths':rules}
        event={'seq':2**53-1,'event_id':'evt_'+'f'*32,'event_type':paths.EVENT_TYPE,'created_at':NOW}
        grant={'schema_version':1,'pip_id':'pip_'+'f'*32,'workspace_id':'ws_'+'f'*32,'job_version':999999,
            'definition_digest':'f'*64,'job_digest':'f'*64,'trigger':'event','policy':policy,
            'occurrence':{'job_version':999999,'expected_after_seq':2**53-2,'checked_at':NOW,'event':event,
                          'history_may_be_incomplete':False},'digest':'f'*64}
        self.assertEqual(len(_encode(grant,4096)),2955)

    def test_direct_serialization_bounds_and_cycles(self):
        cyclic=[];cyclic.append(cyclic)
        for value in (cyclic,{'text':'a'*100000}, {'number':float('nan')}, {'text':'\ud800'}):
            with self.assertRaises(RegistryError):paths._encode(value,2048)
        with patch.object(paths.json,'dumps',side_effect=AssertionError('oversize serialized')):
            with self.assertRaises(RegistryError):paths._encode({'text':'x'*1000000},2048)
        self.assertEqual(paths._encode(['a'],5),b'["a"]')
        with self.assertRaises(RegistryError):paths._encode(['aa'],5)

    def test_comparison_digest_counts_indices_and_booleans(self):
        value=comparison()
        self.assertIs(paths.validate_comparison(value,before_revision=BEFORE,after_revision=AFTER,rules=RULES),value)
        for change in ({'digest':'0'*64},{'changed_entries':True},{'changed_entries':0},
                       {'matched_rule_indices':[True]},{'matched_rule_indices':[0,0]},
                       {'matched_rule_indices':[1]},{'before_revision':'3'*40},{'extra':1}):
            bad={**value,**change}
            if 'digest' not in change:bad=reseal(bad)
            with self.subTest(change=change),self.assertRaises(RegistryError):
                paths.validate_comparison(bad,before_revision=BEFORE,after_revision=AFTER,rules=RULES)

    def test_unavailable_never_becomes_unmatched_or_unknown_commit(self):
        value=comparison(status='unavailable',reason='metadata_limit')
        paths.validate_comparison(value,before_revision=BEFORE,after_revision=AFTER,rules=RULES)
        for change in ({'changed_entries':0},{'matched_rule_indices':[0]},{'reason':None},{'after_revision':None}):
            with self.assertRaises(RegistryError):paths.validate_comparison(reseal({**value,**change}),
                before_revision=BEFORE,after_revision=AFTER,rules=RULES)

    def test_separate_probe_accepts_only_honest_unknowns(self):
        value={'schema_version':1,'checked_at':NOW,'status':'unavailable','reason':'ref_unavailable',
               'before_revision':BEFORE,'after_revision':None,'policy_digest':paths.rules_digest(RULES),'comparison_digest':None}
        paths.validate_probe(value,rules=RULES,checked_at=NOW)
        for change in ({'status':'unchanged','reason':None},{'status':'baselined','reason':None},
                       {'comparison_digest':'a'*64},{'after_revision':'unknown'},{'checked_at':'later'}):
            with self.assertRaises(RegistryError):paths.validate_probe({**value,**change},rules=RULES,checked_at=NOW)
        value.update(status='baselined',reason=None,before_revision=None,after_revision=AFTER)
        paths.validate_probe(value,rules=RULES,checked_at=NOW)

    def test_scoped_match_timestamp_and_double_digest(self):
        args={'pip_id':'pip_'+'1'*32,'workspace_id':'ws_'+'2'*32,'job_version':2,
              'binding_id':'binding_'+'3'*32,'binding_digest':'a'*64,'source_ref':'HEAD','rules':RULES}
        value=paths.pin_match(**args,comparison=comparison(),observed_at=NOW)
        event={'seq':3,'event_id':'evt_'+'4'*32,'event_type':paths.EVENT_TYPE,'created_at':NOW}
        paths.validate_match(value,**args,event=event)
        for change in ({'pip_id':'pip_'+'f'*32},{'job_version':True},{'binding_digest':'b'*64},
                       {'source_ref':'other'}):
            with self.assertRaises(RegistryError):paths.validate_match(value,**{**args,**change},event=event)
        with self.assertRaises(RegistryError):paths.validate_match(value,**args,event={**event,'created_at':'2026-10-02T10:00:01.000Z'})
        forged=copy.deepcopy(value);forged['comparison']['changed_entries']=2
        forged=reseal(forged,paths.MATCH_DOMAIN,4096)
        with self.assertRaises(RegistryError):paths.validate_match(forged,**args,event=event)


class GitComparisonTests(unittest.TestCase):
    setUp=fixtures.LocalPipsTests.setUp
    git=fixtures.LocalPipsTests.git
    commit=fixtures.LocalPipsTests.commit

    def compare(self,before,after,rules=RULES):
        return paths.compare(self.root,before,after,rules,deadline=time.monotonic()+5)

    def save(self):
        self.git('add','-A');self.git('commit','-qm','changed')
        return self.git('rev-parse','HEAD')

    def test_real_modify_delete_add_and_prefix_boundary(self):
        before=self.commit()
        (self.root/'source.py').unlink();(self.root/'src').mkdir();(self.root/'src'/'new.py').write_text('x')
        (self.root/'src2').mkdir();(self.root/'src2'/'other.py').write_text('y')
        after=self.save()
        rules=[{'kind':'exact','path':'source.py'},{'kind':'directory','path':'src'}]
        result=self.compare(before,after,rules)
        self.assertEqual(result['status'],'matched');self.assertEqual(result['matched_rule_indices'],[0,1])
        self.assertEqual(result['changed_entries'],3)
        self.assertEqual(self.compare(before,after,[{'kind':'directory','path':'sr'}])['status'],'unmatched')

    def test_rename_is_delete_and_add_without_heuristics(self):
        before=self.commit();(self.root/'source.py').rename(self.root/'renamed.py');after=self.save()
        result=self.compare(before,after,[{'kind':'exact','path':'renamed.py'},{'kind':'exact','path':'source.py'}])
        self.assertEqual(result['changed_entries'],2);self.assertEqual(result['matched_rule_indices'],[0,1])

    def test_equal_tree_commits_and_reversed_pair(self):
        before=self.commit();self.git('commit','--allow-empty','-qm','empty');same=self.git('rev-parse','HEAD')
        self.assertEqual(self.compare(before,same)['status'],'unmatched')
        (self.root/'source.py').write_text('changed');after=self.save()
        self.assertEqual(self.compare(after,before)['status'],'matched')
        self.assertEqual(self.compare(after,after)['changed_entries'],0)

    def test_symlink_entry_is_never_followed(self):
        before=self.commit();(self.root/'source.py').unlink();(self.root/'source.py').symlink_to('/not/available/private')
        after=self.save();result=self.compare(before,after)
        self.assertEqual(result['status'],'matched');self.assertEqual(result['changed_entries'],1)

    def test_gitlink_entry_does_not_read_submodule_source(self):
        before=self.commit();self.git('update-index','--add','--cacheinfo',f'160000,{before},vendor')
        self.git('commit','-qm','gitlink');after=self.git('rev-parse','HEAD')
        self.assertEqual(self.compare(before,after,[{'kind':'exact','path':'vendor'}])['status'],'matched')
        self.assertFalse((self.root/'vendor').exists())

    def test_missing_object_and_expired_deadline_are_unavailable(self):
        revision=self.commit()
        self.assertEqual(self.compare('0'*40,revision)['reason'],'baseline_unavailable')
        with patch.object(changes,'_capture',side_effect=AssertionError('expired deadline must not spawn')):
            value=paths.compare(self.root,revision,revision,RULES,deadline=time.monotonic()-1)
        self.assertEqual(value['reason'],'comparison_timeout')

    def test_local_hooks_diff_and_textconv_are_not_invoked(self):
        before=self.commit();marker=self.base/'must-not-exist'
        script=self.base/'hostile';script.write_text('#!/bin/sh\ntouch '+str(marker)+'\n');script.chmod(0o700)
        self.git('config','diff.external',str(script));self.git('config','diff.evil.textconv',str(script))
        (self.root/'.gitattributes').write_text('*.py diff=evil\n');(self.root/'source.py').write_text('changed')
        after=self.save()
        (self.root/'.git'/'hooks'/'post-checkout').write_text(script.read_text());(self.root/'.git'/'hooks'/'post-checkout').chmod(0o700)
        self.assertEqual(self.compare(before,after)['status'],'matched');self.assertFalse(marker.exists())

    def test_hostile_filename_after_match_discards_entire_comparison(self):
        before=self.commit();(self.root/'source.py').write_text('changed');(self.root/'z\nprivate').write_text('hostile')
        after=self.save();result=self.compare(before,after)
        self.assertEqual(result['status'],'unavailable');self.assertEqual(result['reason'],'unsupported_path')
        self.assertEqual(result['matched_rule_indices'],[]);self.assertIsNone(result['changed_entries'])

    def test_non_utf8_committed_filename_is_unavailable(self):
        before=self.commit()
        try:
            fd=os.open(os.fsencode(self.root)+b'/z-\xff',os.O_CREAT|os.O_WRONLY,0o600)
            os.close(fd)
            after=self.save()
        except OSError as error:
            # A Mac's APFS refuses a file name that isn't UTF-8 (EILSEQ), but such a name still reaches a Mac in a
            # commit made elsewhere: put it straight into a commit, as a clone from Linux carries it.
            if error.errno!=errno.EILSEQ:raise
            blob=self.git('hash-object','-w',os.devnull)
            self.git('update-index','--add','--cacheinfo','100644,'+blob+','+os.fsdecode(b'z-\xff'))
            self.git('commit','-qm','changed');after=self.git('rev-parse','HEAD')
        result=self.compare(before,after)
        self.assertEqual(result['status'],'unavailable');self.assertEqual(result['reason'],'unsupported_path')

    def test_complete_record_limit_accepts_10000_and_refuses_10001(self):
        before=self.commit();self.git('commit','--allow-empty','-qm','other');after=self.git('rev-parse','HEAD')
        header=b':100644 100644 '+b'1'*40+b' '+b'2'*40+b' M\0'
        original=changes._capture
        for count in (10000,10001):
            raw=b''.join(header+f'{i:04x}'.encode()+b'\0' for i in range(count))
            self.assertLess(len(raw),changes.MAX_GIT_BYTES)
            def capture(root,args,maximum,*,deadline):
                return (0,raw) if args[0]=='diff-tree' else original(root,args,maximum,deadline=deadline)
            with patch.object(changes,'_capture',side_effect=capture):
                result=self.compare(before,after,[{'kind':'exact','path':'0000'}])
            self.assertEqual(result['status'],'matched' if count==10000 else 'unavailable')
            if count==10000:self.assertEqual(result['changed_entries'],10000)
            else:self.assertEqual(result['reason'],'metadata_limit')

    def test_output_and_record_caps_are_closed(self):
        revision=self.commit();header=b':100644 100644 '+b'1'*40+b' '+b'2'*40+b' M\0'
        records=[header+b'a\0bad', b'x'*(changes.MAX_GIT_BYTES+1), b'\0'*20002,
                 header+b'source.py\0'+b'invalid\0z\0']
        original=changes._capture
        for raw in records:
            def capture(root,args,maximum,*,deadline):
                return (0,raw) if args[0]=='diff-tree' else original(root,args,maximum,deadline=deadline)
            # Both endpoint hashes must be real; a second same-tree commit is sufficient.
            self.git('commit','--allow-empty','-qm','other');after=self.git('rev-parse','HEAD')
            with self.subTest(size=len(raw)),patch.object(changes,'_capture',side_effect=capture):result=self.compare(revision,after)
            self.assertEqual(result['status'],'unavailable');self.assertEqual(result['matched_rule_indices'],[])

    def test_root_replacement_during_capture_is_refused(self):
        before=self.commit();(self.root/'source.py').write_text('changed');after=self.save();original=changes._capture
        def capture(root,args,maximum,*,deadline):
            result=original(root,args,maximum,deadline=deadline)
            if args[0]=='diff-tree':
                self.root.rename(self.base/'old-root');self.root.mkdir()
            return result
        with patch.object(changes,'_capture',side_effect=capture):result=self.compare(before,after)
        self.assertEqual(result['reason'],'root_changed');self.assertEqual(result['matched_rule_indices'],[])


if __name__=='__main__':unittest.main()
