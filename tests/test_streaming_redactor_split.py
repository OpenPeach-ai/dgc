"""A complete credential in the stream buffer must never be published because of the hold-back.

`StreamingRedactor.feed` holds back a tail that *could* be the start of a known credential, so a
secret split across two chunks is still caught. That trim used to happen BEFORE redaction, and so
could cut a credential that was already complete in the buffer: the leading part then matched
nothing and went out in clear.

Triggering it needs no exotic input -- only some OTHER known secret beginning with the buffer's
final character. On the machine where this surfaced, four ambient env credentials began with "6",
so a buffer ending "...123456" held back "6" and streamed the rest of the API key to the panel.
The suite caught it only when the release shell had the operator's real `.env` exported, which is
exactly how a release is run; in a bare shell it passed.
"""
from __future__ import annotations

import unittest

from dgc.redaction import REDACTED, StreamingRedactor


SECRET = "agentCredential-fixture-123456"


def stream(chunks, secrets):
    redactor = StreamingRedactor(tuple(secrets))
    return "".join(redactor.feed(chunk) for chunk in chunks) + redactor.flush()


class StreamingRedactorSplitTests(unittest.TestCase):
    def test_a_decoy_sharing_the_final_character_cannot_split_a_complete_secret(self) -> None:
        # "6..." is the decoy: it makes the hold-back want the buffer's last character, which is
        # also the last character of the complete secret sitting in that same buffer.
        out = stream(["answer " + SECRET[:9], SECRET[9:]], (SECRET, "6decoyCredential-value-0001"))
        self.assertNotIn(SECRET, out)
        self.assertIn(REDACTED, out)
        self.assertEqual(out, "answer " + REDACTED)

    def test_every_single_character_decoy_is_safe(self) -> None:
        # The bug was data-dependent, so sweep a decoy starting with each character of the secret.
        for index, char in enumerate(sorted(set(SECRET))):
            with self.subTest(decoy_starts_with=char):
                decoy = char + f"decoyCredential-value-{index:04d}"
                out = stream(["answer " + SECRET[:9], SECRET[9:]], (SECRET, decoy))
                self.assertNotIn(SECRET, out, f"leaked with a decoy starting {char!r}")

    def test_a_split_secret_is_still_caught_when_nothing_else_is_known(self) -> None:
        # The behaviour the hold-back exists for must survive the fix.
        out = stream(["answer " + SECRET[:9], SECRET[9:]], (SECRET,))
        self.assertEqual(out, "answer " + REDACTED)

    def test_a_secret_split_across_three_chunks_is_caught(self) -> None:
        out = stream([SECRET[:5], SECRET[5:18], SECRET[18:]], (SECRET, "6decoy-value-0002"))
        self.assertNotIn(SECRET, out)
        self.assertIn(REDACTED, out)

    def test_ordinary_prose_still_streams_without_being_held(self) -> None:
        redactor = StreamingRedactor((SECRET,))
        self.assertEqual(redactor.feed("nothing secret here. "), "nothing secret here. ")

    def test_an_emitted_marker_is_never_sliced_by_the_hold_back(self) -> None:
        # A panel renders each chunk as it arrives, so a chunk ending "[REDACTED" would show a
        # broken sentinel and read as though redaction had failed. The concatenated output looks
        # fine either way, so this has to assert PER CHUNK.
        redactor = StreamingRedactor((SECRET, "]decoy-value-0003"))
        chunks = [redactor.feed("answer " + SECRET[:9]), redactor.feed(SECRET[9:])]
        chunks.append(redactor.flush())
        for chunk in chunks:
            self.assertNotIn("[REDACTED", chunk.replace(REDACTED, ""),
                             f"a chunk carried a sliced sentinel: {chunk!r}")
            self.assertNotEqual(chunk, "]", "the sentinel's tail was carried into the next chunk")
        self.assertEqual("".join(chunks), "answer " + REDACTED)

    def test_two_secrets_back_to_back_are_both_redacted(self) -> None:
        other = "secondCredential-fixture-998877"
        out = stream([SECRET[:9], SECRET[9:] + other[:6], other[6:]], (SECRET, other, "7decoy-x"))
        self.assertNotIn(SECRET, out)
        self.assertNotIn(other, out)


if __name__ == "__main__":
    unittest.main()
