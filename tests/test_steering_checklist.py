"""A message the user sends while a turn works asks the model to put new work on its checklist (a real goal session,
20 Nov: five asks arrived mid-turn and only the first reached the task list, so the rest could be lost at the turn's
end)."""
import unittest

from dgc.workflows import STEERING_PREFIX


class SteeringAsksForTheChecklist(unittest.TestCase):
    def test_new_work_goes_on_the_checklist(self):
        self.assertIn("say in one short sentence how you are handling it", STEERING_PREFIX)
        self.assertIn("add it there with the `todo` tool", STEERING_PREFIX)
        self.assertTrue(STEERING_PREFIX.rstrip().endswith("Then carry on:"))


if __name__ == "__main__":
    unittest.main()
