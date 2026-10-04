"""Independent compatibility regression for Pulse's shared run reader seam."""
import unittest
from unittest.mock import patch

from dgc.workspace_registry import RegistryError

from dgc import pip_chat, pip_pulse_results, pips
from tests import test_pips_local as fixtures


class PulseReaderReviewTests(unittest.TestCase):
    setUp=fixtures.LocalPipsTests.setUp
    git=fixtures.LocalPipsTests.git
    commit=fixtures.LocalPipsTests.commit

    def test_legal_native_chat_result_over_64k_remains_readable(self):
        self.commit()
        job=self.store.create(self.workspace['id'],'Chat','Discuss source.','human')
        response=pip_chat.send(self.store,job['id'],'A bounded conversation.','reader-review','human',self.cfg)
        run_id=response['run']['id']
        self.assertEqual(self.store.claim_next()['id'],run_id)
        usage={'input_tokens':1,'output_tokens':1,'cached_input_tokens':0,'reasoning_tokens':0,'requests':1}
        snapshot={'sha256':'a'*64,'files':1,'bytes':32}
        result=None
        for count in range(10800,10930):
            worker={'text':'\x01'*count,'usage':usage,'tools_called':0}
            pip_chat.validate_text(worker['text'],reply=True)
            worker_bytes=len((pips._json({'kind':'result','result':worker})+'\n').encode())
            candidate={**worker,'snapshot':snapshot}
            stored_bytes=len(pips._json(candidate).encode())
            if worker_bytes<=65536<stored_bytes:
                result=candidate
                break
        self.assertIsNotNone(result,'Fixture must pass the native line bound and exceed64KiB after parent snapshot metadata.')
        finished=self.store.finish(run_id,result=result)
        self.assertEqual(finished['status'],'succeeded')
        self.assertEqual(finished['result'],result)
        self.assertEqual(self.store.run(run_id)['result'],result)
        self.assertIsNone(pip_pulse_results.stored(self.registry,self.workspace['id'],run_id))
        saved=self.registry.db.execute('SELECT length(CAST(result AS BLOB)) FROM pip_runs WHERE id=?',(run_id,)).fetchone()[0]
        self.assertGreater(saved,65536)
        self.assertEqual(pip_chat.list_messages(self.store,job['id'])['messages'][-1]['text'],result['text'])

    def test_legacy_unicode_actor_and_key_keep_exact_retry_authority(self):
        self.commit()
        actor='🪴'*128
        key='🔑'*128
        job=self.store.create(self.workspace['id'],'Unicode owner','Inspect source.','human')
        queued=self.store.enqueue(job['id'],key,actor,self.cfg)
        self.assertEqual(len(actor.encode('utf-8')),512)
        self.assertEqual(len(key.encode('utf-8')),512)
        self.assertEqual(queued['requested_by'],actor)
        bounded=self.store._transition_row(queued['id'])
        self.assertEqual(bounded['requested_by'],actor)
        self.assertEqual(bounded['idempotency_key'],key)
        with patch.object(pips,'source_revision',side_effect=AssertionError('An exact retry performs no source preparation')):
            retried=self.store.enqueue(job['id'],key,actor,self.cfg)
            self.assertEqual(retried['id'],queued['id'])
            self.assertEqual(retried['requested_by'],actor)
            with self.assertRaises(RegistryError) as error:
                self.store.enqueue(job['id'],key,'another actor',self.cfg)
        self.assertEqual(error.exception.code,'conflict')
        self.assertEqual(len(self.store.runs(job['id'])),1)
        self.assertNotIn('idempotency_key',retried)


if __name__=='__main__':unittest.main()
