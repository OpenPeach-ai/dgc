"""The /vscode hero component must not collide with the site's own global stylesheet.

The hero arrived as a standalone prototype whose CSS used generic class names -- `.stage`,
`.focus-parent`. The site's `site.css` already defined both for unrelated components, and because
the site's sheet is global the collision applied silently:

  * `.stage::before{content:attr(data-step)}` printed the animation's raw step number ("0", "4")
    into the artwork;
  * `.focus-parent{padding:16px}` shrank the pictured DGC panel by 34px, so its transcript
    overflowed a fixed-height box and the closing line was cut to "Save follows the form state.
    Reset is".

Neither showed up in the prototype, which was verified standalone without the site's stylesheet, and
neither breaks a build. This test compares the two the way nothing did before.
"""
from __future__ import annotations

import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent
FRAGMENT = ROOT / "site-src" / "partials" / "vscode-hero.html"
SITE_CSS = ROOT / "site" / "assets" / "site.css"
COMPONENT_CSS = ROOT / "site-src" / "assets" / "extension-hero.css"
SCOPE = "dgc-extension-hero"

# Both sheets define this identically (the standard visually-hidden block), so the site's copy
# winning changes nothing. Any OTHER shared name is a real collision.
ALLOWED_SHARED = {"sr-only"}


def fragment_classes() -> set[str]:
    names: set[str] = set()
    for group in re.findall(r'class="([^"]+)"', FRAGMENT.read_text(encoding="utf-8")):
        names.update(group.split())
    return names


def top_level_selectors(css: str) -> list[str]:
    """Every selector in the sheet, including those nested one level inside @media."""
    depth, buf, blocks = 0, "", []
    for ch in css:
        buf += ch
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                blocks.append(buf)
                buf = ""
    selectors: list[str] = []
    for block in blocks:
        head = block.partition("{")[0].strip()
        if head.startswith("@media") or head.startswith("@supports"):
            inner = block[block.index("{") + 1:block.rindex("}")]
            selectors.extend(m.group(1) for m in re.finditer(r"([^{}]+)\{[^}]*\}", inner))
        elif not head.startswith("@"):
            selectors.append(head)
    return selectors


# The website tree (site-src/, site/) is gitignored local-only tooling, so a fresh checkout has
# nothing to compare. Same guard the other site test uses.
@unittest.skipUnless(
    FRAGMENT.is_file() and SITE_CSS.is_file() and COMPONENT_CSS.is_file(),
    "website tree is local-only",
)
class HeroIsolation(unittest.TestCase):
    def test_no_global_site_rule_can_match_the_hero(self) -> None:
        used = fragment_classes()
        self.assertTrue(used, "the hero fragment declared no classes; the path is probably wrong")
        collisions = []
        for selector in top_level_selectors(SITE_CSS.read_text(encoding="utf-8")):
            for part in selector.split(","):
                part = part.strip()
                if SCOPE in part:
                    continue
                names = set(re.findall(r"\.([A-Za-z][A-Za-z0-9_-]*)", part))
                # A rule reaches the hero only when every class it names is one the hero carries;
                # otherwise it needs an ancestor the hero does not have.
                if names and names <= used and not names <= ALLOWED_SHARED:
                    collisions.append(part)
        self.assertEqual(
            collisions, [],
            "site.css rules would style the hero without being scoped to it: "
            + "; ".join(sorted(set(collisions))[:6]),
        )

    def test_every_component_rule_is_scoped_to_the_component(self) -> None:
        # The other direction: the hero's sheet is served globally on /vscode, so an unscoped rule
        # there would restyle the rest of the page.
        unscoped = []
        for selector in top_level_selectors(COMPONENT_CSS.read_text(encoding="utf-8")):
            for part in selector.split(","):
                part = part.strip()
                if part and SCOPE not in part and not part.startswith("@"):
                    unscoped.append(part)
        self.assertEqual(unscoped, [],
                         "unscoped rules in extension-hero.css: " + "; ".join(sorted(set(unscoped))[:6]))

    def test_the_reserved_stage_height_matches_what_the_component_renders(self) -> None:
        # Critical CSS reserves the scene so the deferred sheet cannot shift the page. The two are
        # in different files, so a change to one silently desynchronises the other -- which is how
        # the first attempt reserved 470px for a box that renders at 540px.
        critical = (ROOT / "site-src" / "assets" / "critical-editor.css").read_text(encoding="utf-8")
        component = COMPONENT_CSS.read_text(encoding="utf-8")

        def scene_heights(css: str) -> dict[str, int]:
            """The winning .focus-scene height per media context (last declaration wins)."""
            depth, buf, blocks = 0, "", []
            for ch in css:
                buf += ch
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        blocks.append(buf)
                        buf = ""
            winners: dict[str, int] = {}
            for block in blocks:
                head = block.partition("{")[0].strip()
                body = block[block.index("{") + 1:block.rindex("}")]
                if head.startswith("@media"):
                    context = re.sub(r"\s+", "", head)
                    for m in re.finditer(r"([^{}]*focus-scene[^{}]*)\{([^}]*)\}", body):
                        for h in re.findall(r"(?<![a-z-])height:(\d+)px", m.group(2)):
                            winners[context] = int(h)
                elif not head.startswith("@") and "focus-scene" in head:
                    for h in re.findall(r"(?<![a-z-])height:(\d+)px", body):
                        winners["(base)"] = int(h)
            return winners

        comp, crit = scene_heights(component), scene_heights(critical)
        self.assertTrue(comp and crit, "could not read the scene height from both sheets")
        for context, reserved in crit.items():
            self.assertIn(context, comp, f"critical CSS reserves a height for {context}, "
                                         f"which the component never sets")
            self.assertEqual(
                reserved, comp[context],
                f"{context}: critical CSS reserves {reserved}px but the component "
                f"renders {comp[context]}px -- the page would shift by the difference",
            )
        # and every context the component varies must be reserved, or the unreserved one shifts
        self.assertEqual(sorted(comp), sorted(crit),
                         f"component sets the scene height for {sorted(comp)} but critical CSS "
                         f"reserves {sorted(crit)}")


if __name__ == "__main__":
    unittest.main()
