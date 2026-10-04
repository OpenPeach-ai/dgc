"""Real console proposal/review, without turning CLI input into automatic authority."""
import unittest
from dgc import pip_cli
from tests import test_pip_cli as fixtures


class AdaptationCliTests(unittest.TestCase):
    setUp = fixtures.PipCliTests.setUp
    invoke = fixtures.PipCliTests.invoke
    value = fixtures.PipCliTests.value
    child_env = fixtures.PipCliTests.child_env
    child_cli = fixtures.PipCliTests.child_cli

    def test_console_requires_explicit_policy_review(self):
        self.child_cli('enable')
        job = self.child_cli('create', 'Auditor', '--goal', 'Inspect source')['pip']
        result = self.child_cli('adaptation', job['id'], '--expected-version', '1', '--mode', 'bounded_adaptive',
                                '--allow-field', 'name', '--reason', 'Allow display-name maintenance')
        proposal = result['proposal']
        self.assertEqual(proposal['status'], 'proposed')
        self.assertEqual(self.child_cli('show', job['id'])['pip']['adaptation_policy']['mode'], 'suggest_changes')
        changed = self.child_cli('accept', job['id'], proposal['id'], '--expected-version', '1')['pip']
        self.assertEqual(changed['adaptation_policy'], {'mode':'bounded_adaptive', 'allowed_fields':['name']})
        self.assertEqual(self.child_cli('adaptations', job['id'])['adaptations'], [])

    def test_cli_cannot_infer_bounded_fields_or_expand_fixed_modes(self):
        for mode, flags in (('bounded_adaptive', []), ('locked', ['--allow-field','name']),
                            ('autonomous', ['--allow-field','source_ref'])):
            args = pip_cli.parser().parse_args(['adaptation', 'pip_fixture', '--expected-version','1',
                                              '--mode',mode,'--reason','Reviewed',*flags])
            with self.assertRaises(Exception) as caught:
                pip_cli._request(args)
            self.assertEqual(caught.exception.code, 'invalid_adaptation_policy')
        args = pip_cli.parser().parse_args(['adaptation','pip_fixture','--expected-version','1',
                                          '--mode','autonomous','--reason','Reviewed'])
        self.assertEqual(pip_cli._request(args)['changes']['adaptation_policy']['allowed_fields'], ['name','source_ref'])


if __name__ == '__main__': unittest.main()
