"""User test round 2, P9: a Pip can use two browsers, the one on its own computer and the user's Chrome ("DGC
Browser"), and it called them "my own browser", "your browser" and "DGC Browser" in one chat. One name each: what a
Pip is told (the computer's and DGC Browser's standing notices, and DGC's messages to it) names them the same way
every time, and tells the Pip the two names to use when it speaks to the user."""
import re
import unittest

from dgc import pip_chat, pip_computer, dgc_browser_lane


class TwoBrowsersTwoNames(unittest.TestCase):
    def test_the_computers_notice_names_its_browser_one_way(self):
        notice = pip_computer.NOTICE
        self.assertIn('"my computer\'s browser"', notice)
        self.assertNotIn('your own browser', notice.lower(), 'the notice itself no longer calls it "your own browser"')
        self.assertRegex(notice, r'never "my own browser"')

    def test_dgc_browsers_notice_tells_the_two_apart_by_name(self):
        notice = dgc_browser_lane.NOTICE
        self.assertIn('"DGC Browser"', notice)
        self.assertIn('"my computer\'s browser"', notice)
        self.assertRegex(notice, r'never "your browser", "my own browser" or "my browser"')

    def test_nothing_dgc_tells_a_pip_calls_the_users_chrome_dgc_browser_in_small_letters(self):
        said = [dgc_browser_lane.NOTICE, dgc_browser_lane.SITE_REFUSED, dgc_browser_lane.SITE_ASKED,
                dgc_browser_lane.SECRET_FIELD, dgc_browser_lane.WRITE_REFUSED, dgc_browser_lane.REOPENED,
                pip_chat.DGC_BROWSER_ALLOWED, pip_chat.DGC_BROWSER_SIGNED_IN, pip_chat.DGC_BROWSER_NOT_ALLOWED,
                pip_chat.DGC_BROWSER_NOT_SIGNED_IN]
        for words in said:
            # (Outside the quoted list of names a Pip must not use.)
            plain = re.sub(r'never "your browser", "my own browser" or "my browser"', '', words)
            self.assertNotRegex(plain, r'\byour browser\b', words[:80])
            self.assertNotRegex(plain, r'\b(my|your) own browser\b', words[:80])
        # Where a message sends the Pip to the other one, it is its computer's browser by name.
        self.assertIn("your computer's browser", pip_chat.DGC_BROWSER_NOT_ALLOWED)


if __name__ == '__main__':
    unittest.main()
