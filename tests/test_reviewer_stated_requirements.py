"""A reviewer never invents requirements the objective and plan don't state (the goal soak, 16 Nov).

The soak's critic helpers audited items that were already committed and found them unmet against requirements no one
had written: "100 seeded-random cases", "all four phase angles through 365 days against an independent ephemeris".
The plan said neither. The model then reworked committed items to satisfy them. A reviewer (the `critic`, and the
`verifier` that judges a claim or change) now checks the requirements the task, its objective and its plan state,
quoting each one it checks. A real defect (a wrong result, a crash, a failing test) always counts; a new requirement
nobody stated goes under a separate "Suggestions (not required)" heading and never counts as unmet.
"""
import unittest

from dgc import agents


class AReviewerQuotesWhatItChecks(unittest.TestCase):
    def body(self, name: str) -> str:
        return agents.builtin_agents()[name].body

    def test_the_critic_judges_only_stated_requirements_and_quotes_each(self):
        body = self.body("critic")
        self.assertTrue(body.startswith("You are a critic."), "Pip specialists find the role by this sentence")
        self.assertIn("against the requirements the task, its objective and its plan actually state", body)
        self.assertIn("Quote each requirement you check", body)

    def test_anything_else_is_a_suggestion_and_never_unmet(self):
        for name in ("critic", "verifier"):
            with self.subTest(agent=name):
                body = self.body(name)
                self.assertIn('"Suggestions (not required)"', body)
                self.assertIn("What never counts as unmet is a NEW requirement the task didn't state", body)
                self.assertIn("A real defect (a wrong result, a crash, broken behaviour, a failing test) always counts", body)

    def test_the_verifier_never_refutes_on_a_requirement_no_one_stated(self):
        body = self.body("verifier")
        self.assertIn("against the requirements the task, its objective and its plan actually state", body)
        self.assertIn("Quote each requirement you check", body)
        self.assertTrue(body.startswith("You are a verifier."))

    def test_the_other_roles_are_unchanged(self):
        for name in ("explorer", "researcher", "worker"):
            with self.subTest(agent=name):
                self.assertNotIn("Suggestions (not required)", self.body(name))


if __name__ == "__main__":
    unittest.main()
