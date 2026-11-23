"""A Pip fetches a good tool when it would do the job better (asked 15 Nov: "for any task if it thinks a well built
github repo can be downloaded on the personal computer, a program, an application etc, it should download and use it").

Its Terminal reaches public websites and its box is the wall, so installing is inside it and asks nothing. What it is
told keeps the one real risk small: a well-known, maintained project, a tagged release, its README first, never a web
script piped into a shell, never its keys unless the task needs them; installed in its Files (every computer it has
then has it); and the user is told in one line what it installed and why."""
import unittest

from dgc import pip_computer


class BetterTools(unittest.TestCase):
    def test_a_pip_with_a_computer_is_told_to_fetch_good_tools_safely(self):
        said = pip_computer.NOTICE
        # His example (15 Nov): its image editor and a web editor didn't please him; a repo he named (fetched onto its
        # computer) did. It should reach for such a tool itself, and next time start with the one that worked.
        for words in ("well-known", "tagged release", "README", "never pipe", "your keys", "in your Files",
                      "what you installed and why", "worked well", "use it first", "next time",
                      # His addition (15 Nov): applications and programs too, judged by stars and community feedback on
                      # GitHub, or downloads and likes on Hugging Face; and (mine) its size and whether it runs here.
                      "application", "stars", "Hugging Face", "size",
                      # Decided 15 Nov: something big is a conversation, never a permission card, at every level
                      # (Do it all too): it says the size and asks in the chat; small things it just fetches and uses.
                      "about 1 GB", "ask the user in the chat", "Download it", "smaller ones just",
                      # Decided 15 Nov: no list DGC keeps; it searches each time (awesome lists, GitHub by stars,
                      # Hugging Face by downloads). System tools pip and npm can't give come from micromamba
                      # (conda-forge) into its Files: its system is shared read-only, so apt can't run there.
                      "sindresorhus/awesome", "sorted by stars", "sorted by downloads", "micromamba", "conda-forge"):
            with self.subTest(words=words):
                self.assertIn(words, said)


if __name__ == "__main__":
    unittest.main()
