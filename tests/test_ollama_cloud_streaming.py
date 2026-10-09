"""An Ollama cloud reply streams (found building ChatDGC, 2026-10-10).

Ollama's cloud labels its newline-delimited stream `application/json`, the header it also uses for a
single object. Since e7b91b67 that body was read whole and then parsed, which made cloud models usable
but meant no text reached the screen until the reply had ended -- in Work, in Pips and in ChatDGC alike
(measured: 361 parts of a story delivered within 10 ms, 6.5 s after it was asked for). The first line
now settles the shape: one that parses alone is a stream, used frame by frame as its lines arrive; one
that doesn't is a single object over several lines, read whole as before.
"""
import threading
import unittest

from dgc import llm


class Body:
    """A response whose bytes arrive in the pieces given; records how many pieces were read."""

    def __init__(self, pieces, ctype="application/json", raw=None):
        self.headers = {"Content-Type": ctype}
        self.status_code, self.encoding = 200, "utf-8"
        self.pieces, self.read, self.closed = list(pieces), 0, False
        self.seen_before = []           # what had reached on_text before each piece was read
        self.text_so_far = None
        if raw is not None:
            self.raw = raw

    def iter_content(self, chunk_size=65536):
        for piece in self.pieces:
            self.seen_before.append("".join(self.text_so_far or []))
            self.read += 1
            yield piece.encode()

    def close(self):
        self.closed = True


def frame(text, done=False, **extra):
    import json
    return json.dumps({"model": "m", "message": {"role": "assistant", "content": text}, "done": done, **extra}) + "\n"


def consume(body, cancel=None, think_budget=0):
    client = llm.LLMClient.__new__(llm.LLMClient)
    client.think_budget_chars = 0
    parts = []
    body.text_so_far = parts
    result = client._consume_ollama(body, parts.append, lambda *a: None, cancel=cancel, think_budget=think_budget)
    return "".join(parts), result.finish_reason, parts


class CloudStreamTests(unittest.TestCase):
    def test_each_frame_reaches_the_screen_as_its_line_arrives(self):
        body = Body([frame("Once "), frame("upon "), frame("a time.") + frame("", done=True, done_reason="stop")])
        text, finish, parts = consume(body)
        self.assertEqual((text, finish), ("Once upon a time.", "stop"))
        self.assertEqual(body.seen_before, ["", "Once ", "Once upon "], "each part was shown before the next arrived")

    def test_a_line_split_across_pieces_and_a_last_frame_without_its_newline(self):
        whole = frame("Hel") + frame("lo") + frame("", done=True, done_reason="stop").rstrip("\n")
        body = Body([whole[:30], whole[30:70], whole[70:]])
        self.assertEqual(consume(body)[:2], ("Hello", "stop"))

    def test_one_object_over_several_lines_is_still_read_whole(self):
        pretty = '{\n  "model": "m",\n  "message": {"role": "assistant", "content": "Hello"},\n  "done": true,\n  "done_reason": "stop"\n}'
        self.assertEqual(consume(Body([pretty[:20], pretty[20:]]))[:2], ("Hello", "stop"))

    def test_a_single_object_on_one_line(self):
        self.assertEqual(consume(Body([frame("Hello", done=True, done_reason="stop").rstrip("\n")]))[:2], ("Hello", "stop"))

    def test_a_bad_line_mid_stream_still_fails_loudly(self):
        with self.assertRaisesRegex(llm.LLMError, "malformed JSON"):
            consume(Body([frame("Hi"), "{not json\n", frame("", done=True)]))
        with self.assertRaisesRegex(llm.LLMError, "malformed JSON"):
            consume(Body(["{not json at all"]))

    def test_stop_ends_the_read_and_keeps_what_arrived(self):
        cancel = threading.Event()
        pieces = [frame("One "), frame("two "), frame("three "), frame("", done=True)]
        body = Body(pieces)
        original = body.iter_content

        def stop_after_two(chunk_size=65536):
            for index, piece in enumerate(original(chunk_size)):
                if index == 2:
                    cancel.set()
                yield piece
        body.iter_content = stop_after_two
        text, finish, _ = consume(body, cancel=cancel)
        self.assertEqual((text, finish), ("One two ", "cancelled"))
        self.assertTrue(body.closed)

    def test_a_plain_body_is_read_as_it_arrives_not_64_kib_at_a_time(self):
        class Raw:
            chunked = False
            closed = False

            def __init__(self, pieces):
                self.pieces = [p.encode() for p in pieces]

            def read1(self, amt, decode_content=True):
                return self.pieces.pop(0) if self.pieces else b""

        raw = Raw([frame("A"), frame("B"), frame("", done=True, done_reason="stop")])
        body = Body([], raw=raw)
        body.iter_content = lambda chunk_size=65536: (_ for _ in ()).throw(AssertionError("read 64 KiB at a time"))
        self.assertEqual(consume(body)[:2], ("AB", "stop"))

    def test_a_local_stream_labelled_ndjson_is_unchanged(self):
        body = Body([frame("He"), frame("llo"), frame("", done=True, done_reason="stop")], ctype="application/x-ndjson")
        self.assertEqual(consume(body)[:2], ("Hello", "stop"))


if __name__ == "__main__":
    unittest.main()
