"""Conversational Pulse uses one human decision and existing immutable grants."""
import copy
import unittest
from unittest.mock import patch
from dgc import pip_setup, pip_pulse_plans as plans, pip_execution, pips
from dgc.workspace_registry import RegistryError
from tests import test_pip_setup as base


def plan(http=False):
    return {'schema_version': 1, 'action': {'kind': 'test', 'network': 'loopback_http_v1' if http else False,
        'tests': [{'argv': ['dgc-http-check', 'http://127.0.0.1:3090/healthz', '200'] if http else ['/usr/bin/python3', '-c', 'print("smoke")'], 'cwd': '.'}]}}


class PulseSetupTests(unittest.TestCase):
    setUp = base.PipSetupTests.setUp
    git = base.PipSetupTests.git
    commit = base.PipSetupTests.commit
    draft = base.PipSetupTests.draft
    review = base.PipSetupTests.review
    state = base.PipSetupTests.state

    def request(self, **changes):
        return base.PipSetupTests.request(self, **{'pip_type': 'pulse', 'work_kind': 'command_verification', 'verification_plan': plan(), **changes})

    def test_draft_has_exact_plan_no_job_or_authority(self):
        draft = self.draft()
        self.assertEqual(draft['verification_plan'], plans.validate_plan(plan()))
        self.assertEqual(draft['permissions'], 'review_required')
        for table in ('pips','pip_runs','pip_approvals','pip_proposals'):
            self.assertEqual(self.registry.db.execute('SELECT count(*) FROM '+table).fetchone()[0], 0)

    def test_accept_queues_once_without_model_and_with_original_human_approval(self):
        draft = self.draft()
        with patch('dgc.pips._model_settings', side_effect=AssertionError('No model')), patch('dgc.pip_execution.capability', return_value={'available': True}):
            accepted = self.review(draft)
            self.assertEqual(accepted, self.review(draft))
        run = self.store.run(accepted['receipt']['run_id'])
        self.assertIsNone(run['manifest']['model'])
        self.assertEqual(run['manifest']['pulse_verification']['job_version'],1)
        self.assertEqual(run['manifest']['pulse_verification']['plan_digest'],plans.plan_digest(plan()))
        self.assertEqual(len(self.store.runs(accepted['receipt']['pip_id'])),1)
        self.assertEqual(accepted['next_run_at'],'2026-10-03T05:30:00.000Z')
        a=self.registry.db.execute('SELECT * FROM pip_approvals').fetchone()
        self.assertEqual((a['status'],a['resolved_by'],a['expected_version']),('approved','local-user',0))

    def test_execution_probe_preflight_holds_no_registry_writer_lock(self):
        draft=self.draft()
        def unavailable():
            self.assertFalse(self.registry.db.in_transaction)
            raise RegistryError('execution_unavailable','No confinement')
        with patch('dgc.pip_execution.require_capability',side_effect=unavailable) as probe,self.assertRaisesRegex(RegistryError,'No confinement'):
            self.review(draft)
        probe.assert_called_once()
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0],0)

    def test_http_setup_does_not_claim_shell_or_browser_authority(self):
        d=self.draft(self.request(work_kind='app_smoke_test',verification_plan=plan(True),run_now=False))
        self.assertIn('No redirects',d['scope_notice'])
        accepted=self.review(d)
        job=self.store.get(accepted['receipt']['pip_id'])
        self.assertEqual(job['verification_plan']['action']['network'],'loopback_http_v1')
        plans._definition(self.registry,job['id'],self.workspace['id'],1)

    def test_wrong_work_kind_missing_or_unauthorized_plan_refused(self):
        for kwargs in ({'verification_plan':None},{'work_kind':'source_review'},
                       {'work_kind':'app_smoke_test'}, {'pip_type':'rook','work_kind':'source_review'}):
            with self.subTest(kwargs=kwargs),self.assertRaises(RegistryError):self.draft(self.request(**kwargs))

    def test_rejection_creates_no_execution_approval(self):
        self.review(self.draft(),False)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_approvals').fetchone()[0],0)

    def test_queue_failure_rolls_back_execution_approval_and_job(self):
        d=self.draft();before=self.state()
        with patch.object(pips.PipStore,'enqueue',side_effect=RegistryError('unavailable','Queue unavailable')),self.assertRaises(RegistryError):self.review(d)
        self.assertEqual(self.state(),before)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_approvals').fetchone()[0],0)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_proposals').fetchone()[0],0)

    def test_plan_change_requires_new_review(self):
        d=self.draft();other=self.request(request_key='new',verification_plan=plan(True),work_kind='app_smoke_test')
        d2=self.draft(other)
        self.assertNotEqual(d['digest'],d2['digest'])
        with self.assertRaises(RegistryError):self.review(d,expected_digest=d2['digest'])

    def test_existing_pulse_update_keeps_explicit_plan(self):
        accepted=self.review(self.draft(self.request(run_now=False)))
        job=self.store.get(accepted['receipt']['pip_id'])
        req=self.request(request_key='updated',run_now=False,pip_id=job['id'],expected_version=1,expected_lifecycle_revision=job['lifecycle_revision'])
        updated=self.review(self.draft(req))
        self.assertEqual(updated['receipt']['job_version'],2)
        plans._definition(self.registry,job['id'],self.workspace['id'],2)

    def test_http_worker_dispatch_is_fixed_not_argv_execution(self):
        import sys
        prepared={'unused': True}
        output={'data':b'PASS','status':'passed','exit_code':0,'truncated':False}
        # DGC's own checker needs no sandbox: neither the capability gate nor the sandbox runtime is consulted.
        with patch.object(pip_execution,'require_capability',side_effect=AssertionError('no sandbox needed')),patch.object(pip_execution,'_prepared',return_value=(self.base,self.root)),patch.object(pip_execution,'_capture',return_value=output) as capture,patch.object(pip_execution,'_artifact',return_value={}), \
             patch.object(pip_execution,'_runtime',side_effect=AssertionError('no sandbox helper needed')):
            pip_execution.run_reviewed_tests(prepared,plans.validate_plan(plan(True))['action'])
        argv=capture.call_args.args[0]
        self.assertEqual(argv[:3],[sys.executable,'-I','-c'])
        self.assertIn('HTTPConnection',argv[3]);self.assertNotIn('exec(',argv[3])
        self.assertEqual(argv[4:],['http://127.0.0.1:3090/healthz','200'],'only the validated URL and status')
        self.assertEqual(capture.call_args.kwargs['timeout'],10)
        self.assertEqual(capture.call_args.kwargs['env'],{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})


class HTTPPlanBoundaryTests(unittest.TestCase):
    def test_refuse_host_escape_auth_query_redirect_and_argv_injection(self):
        urls=['http://localhost:3090/health','https://127.0.0.1:3090/health','http://127.0.0.1:80/',
              'http://127.0.0.1:65536/','http://user@127.0.0.1:3090/', 'http://127.0.0.1:3090/?token=abc',
              'http://127.0.0.1:3090/#fragment','http://127.0.0.2:3090/','http://127.0.0.1:3090/%2e',
              'http://127.0.0.1:3090/../admin','http://127.0.0.1:3090//host','http://example.com:3090/']
        for url in urls:
            p=plan(True);p['action']['tests'][0]['argv'][1]=url
            with self.subTest(url=url),self.assertRaises(RegistryError):plans.validate_plan(p)
        for argv in (['python3','-c','evil'],['dgc-http-check','http://127.0.0.1:3090/','200','--redirect']):
            p=plan(True);p['action']['tests'][0]['argv']=argv
            with self.assertRaises(RegistryError):plans.validate_plan(p)

    def test_no_network_authority_on_patch_or_handoff(self):
        from dgc.pip_handoffs import _action
        with self.assertRaises(RegistryError):_action('pulse',plan(True)['action'])
        p=plan(True)['action'];p.update(kind='patch',write_paths=['file.txt'])
        with self.assertRaises(RegistryError):pip_execution.validate_action('patch',p)

    def test_fixed_helper_limits_follow_the_platform(self):
        # macOS rejects a finite RLIMIT_AS; the runner's sampled footprint guard covers memory there.
        from dgc.pip_http_checks import WORKER
        import resource,sys
        from contextlib import redirect_stdout
        from io import StringIO
        for platform,address_space in (('linux',True),('darwin',False)):
            factory=unittest.mock.Mock(side_effect=OSError('refused'))
            with self.subTest(platform=platform),patch.object(sys,'platform',platform),patch('resource.setrlimit') as limits, \
                 patch('http.client.HTTPConnection',factory),patch.object(sys,'argv',['probe','http://127.0.0.1:3090/','200']), \
                 redirect_stdout(StringIO()),self.assertRaises((SystemExit,OSError)):
                exec(compile(WORKER,'pulse-http-worker','exec'),{})
            keys=[call.args[0] for call in limits.call_args_list]
            self.assertEqual(resource.RLIMIT_AS in keys,address_space)
            for key in (resource.RLIMIT_CPU,resource.RLIMIT_CORE,resource.RLIMIT_FSIZE):self.assertIn(key,keys)

    def test_fixed_helper_never_uses_proxy_redirect_cookie_or_body_output(self):
        from dgc.pip_http_checks import WORKER
        # Compile the production helper and run with deterministic fake HTTP,
        # resource and argv, without a socket, subprocess or sleep.
        import types,sys
        from contextlib import redirect_stdout
        from io import StringIO
        for status,chunks,expected,remaining in [(200,[b'ok',b''],0,None),(302,[b''],1,None),(200,[b'x'*65537],1,None),(200,[b''],1,5),(200,[],1,65537)]:
            class Response:
                def read1(self,n):return chunks.pop(0)
            response=Response();response.status=status;response.length=remaining
            connection=unittest.mock.Mock();connection.getresponse.return_value=response
            factory=unittest.mock.Mock(return_value=connection)
            out=StringIO()
            with patch('http.client.HTTPConnection',factory),patch('resource.setrlimit'),patch.object(sys,'argv',['probe','http://127.0.0.1:3090/health','200']),redirect_stdout(out),self.assertRaises(SystemExit) as exit:
                exec(compile(WORKER,'pulse-http-worker','exec'),{})
            self.assertEqual(exit.exception.code,expected)
            self.assertEqual(connection.request.call_args.args,('GET','/health'))
            self.assertEqual(factory.call_args.args,('127.0.0.1',3090))
            self.assertNotIn('Cookie',connection.request.call_args.kwargs['headers'])
            self.assertNotIn('xxxxxxxx',out.getvalue())
            connection.close.assert_called_once()
