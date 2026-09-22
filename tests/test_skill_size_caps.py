"""A skill has to be accepted AND delivered whole, or not accepted at all.

The parser capped a body at 30,000 characters and `render()` sliced at 32,000. Real skills outgrew
both: the Figma plugin's figma-use is 35,665 characters, figma-generate-design 33,487 and
skill-creator 33,168, so all three were refused outright. The two caps must move together — lifting
only the parser would accept a skill and then hand the model a procedure cut off mid-step, which is
worse than refusing it, because the model cannot tell that the end is missing.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from pathlib import Path                                  # noqa: E402
from dgc import skills as skills_mod                      # noqa: E402


def skill_text(body_chars: int) -> str:
    head = "---\nname: big\ndescription: a large but legal skill\n---\n"
    return head + ("x" * body_chars)


class SkillSizeCapTests(unittest.TestCase):
    def parse(self, body_chars: int):
        with tempfile.TemporaryDirectory(prefix="dgc-skill-") as tmp:
            from pathlib import Path
            root = Path(tmp) / "big"
            root.mkdir()
            (root / "SKILL.md").write_text(skill_text(body_chars), encoding="utf-8")
            return skills_mod.load_skill(root) if hasattr(skills_mod, "load_skill") else None

    def test_the_caps_move_together(self):
        # If these ever diverge again, a skill can be accepted and then truncated on the way to
        # the model — the failure this test exists to prevent.
        self.assertEqual(skills_mod.MAX_SKILL_BODY_CHARS, skills_mod.MAX_SKILL_RENDER_CHARS,
                         "a body that parses must render whole")

    def test_the_cap_admits_todays_largest_real_skills(self):
        # figma-use, the largest skill in the official Figma plugin.
        self.assertGreaterEqual(skills_mod.MAX_SKILL_BODY_CHARS, 35_665,
                                "figma-use would still be rejected")

    def test_a_body_at_the_cap_renders_whole(self):
        body = "y" * skills_mod.MAX_SKILL_BODY_CHARS
        skill = skills_mod.Skill(name="big", description="d", body=body, path=Path("/tmp/big/SKILL.md"))
        self.assertEqual(len(skill.render()), len(body.strip()),
                         "a skill at the cap must reach the model complete")

    def test_a_mid_sized_body_renders_whole(self):
        body = "z" * 34_378
        skill = skills_mod.Skill(name="mid", description="d", body=body, path=Path("/tmp/mid/SKILL.md"))
        rendered = skill.render()
        self.assertEqual(len(rendered), 34_378)
        self.assertTrue(rendered.endswith("z"), "the tail of the procedure must survive")

    def test_over_the_cap_is_still_refused(self):
        # Refusing is the correct behaviour: a silently truncated procedure is worse.
        body = "w" * (skills_mod.MAX_SKILL_BODY_CHARS + 1)
        self.assertGreater(len(body), skills_mod.MAX_SKILL_BODY_CHARS)

    def test_the_documented_number_matches_the_code(self):
        from pathlib import Path
        root = Path(__file__).resolve().parents[1]
        want = f"{skills_mod.MAX_SKILL_BODY_CHARS:,}"
        for rel in ("dgc/docs.py", "dgc/skills_builtin/skill-author/SKILL.md"):
            text = (root / rel).read_text(encoding="utf-8")
            self.assertIn(want, text, f"{rel} still quotes the old cap")


if __name__ == "__main__":
    unittest.main()
