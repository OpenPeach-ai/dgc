"""The /// mark keeps its diagonal wherever it is laid out.

The mark's rows are different lengths and their leading blanks ARE the diagonal. The trust screen
used to centre each row on its own, so rows 13 to 19 cells wide landed at four or five different
offsets and the three slashes became a zig-zag, while the welcome screen (one offset for the block)
looked right.
"""
import re
import unittest

from dgc import logo, trust

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_BLANK = (" ", "⠀")


def _ink_start(row: str) -> int:
    return next(i for i, ch in enumerate(row) if ch not in _BLANK)


class LogoRowsShareOneWidthTests(unittest.TestCase):
    def test_every_row_is_padded_to_the_art_width_by_default(self):
        for small, width in ((False, logo.WIDTH), (True, logo.WIDTH_SMALL)):
            rows = logo.shimmer_lines(0.0, small=small)
            self.assertEqual({row.cell_len for row in rows}, {width}, f"small={small}")

    def test_an_explicit_pad_wider_than_the_art_is_honoured(self):
        rows = logo.shimmer_lines(0.0, pad=logo.WIDTH + 7)
        self.assertEqual({row.cell_len for row in rows}, {logo.WIDTH + 7})

    def test_a_pad_narrower_than_the_art_never_truncates_or_unequalises_rows(self):
        rows = logo.shimmer_lines(0.0, pad=3)
        self.assertEqual({row.cell_len for row in rows}, {logo.WIDTH})


class TrustScreenKeepsTheDiagonalTests(unittest.TestCase):
    def _logo_offsets(self, cols: int) -> list[int]:
        text = trust.trust_screen_text("/tmp/dgc-logo-layout-test", cols, 40, 0.0)
        lines = [_ANSI.sub("", line) for line in text.split("\n")]
        art_rows = [line for line in lines
                    if any(0x2801 <= ord(ch) <= 0x28FF for ch in line)][:len(logo.LOGO)]
        self.assertEqual(len(art_rows), len(logo.LOGO), "the whole mark is on the screen")
        return [_ink_start(screen) - _ink_start(art) for screen, art in zip(art_rows, logo.LOGO)]

    def test_every_row_of_the_mark_lands_at_the_same_offset(self):
        # Odd and even widths both matter: centring rounds differently for each.
        for cols in (80, 99, 100, 137, 211):
            with self.subTest(cols=cols):
                self.assertEqual(len(set(self._logo_offsets(cols))), 1)

    def test_the_mark_is_still_centred(self):
        cols = 120
        offset = self._logo_offsets(cols)[0]
        self.assertLessEqual(abs(offset - (cols - logo.WIDTH) // 2), 1)


if __name__ == "__main__":
    unittest.main()
