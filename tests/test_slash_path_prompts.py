import unittest

from dgc.commands import is_slash_command_text


class SlashPathPromptTests(unittest.TestCase):
    def test_absolute_and_network_paths_are_prompt_text(self):
        self.assertFalse(is_slash_command_text(
            "/home/fungigb10/pregnancy-tracker , this is the directory that runs bearbloom"))
        self.assertFalse(is_slash_command_text("//server/share contains the fixtures"))

    def test_real_and_unknown_command_tokens_remain_commands(self):
        self.assertTrue(is_slash_command_text("/model gpt-6"))
        self.assertTrue(is_slash_command_text("/unknown argument"))
        self.assertTrue(is_slash_command_text("/"))

    def test_slashes_after_the_first_token_do_not_change_routing(self):
        self.assertTrue(is_slash_command_text("/review /home/me/project"))
        self.assertFalse(is_slash_command_text("explain /home/me/project"))


if __name__ == "__main__":
    unittest.main()
