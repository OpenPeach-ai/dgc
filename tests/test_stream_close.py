"""The stall watcher's own close must not surface as a transport error.

When a model opens a stream and then sends nothing, the watcher closes the response out from
under the reading thread and raises ModelStallError. On a chunked body that close lands inside
http.client, which drops `self.fp` first: the in-flight `_safe_read` then raises
`AttributeError: 'NoneType' object has no attribute 'read'`. That escaped `_bounded_stream_lines`
and replaced the stall error with a bare AttributeError -- the exact failure that broke the
v0.41.8 release run on macOS / Python 3.10. The non-chunked path had a guard for this; the
chunked path, which is what real SSE endpoints send, did not.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import llm as llm_mod  # noqa: E402


class _Raw:
    def __init__(self) -> None:
        self.closed = False


class _Response:
    """A chunked response: no usable read1, so `_bounded_stream_lines` takes iter_content."""

    def __init__(self, chunks, boom=None, mark_closed=True) -> None:
        self._chunks = list(chunks)
        self._boom = boom
        self._mark_closed = mark_closed
        self.raw = _Raw()

    def iter_content(self, chunk_size=None):
        for chunk in self._chunks:
            yield chunk
        if self._boom is not None:
            if self._mark_closed:                  # the watcher closed it, then the read failed
                setattr(self, "_dgc_closed", True)
            raise self._boom


def _lines(response):
    return list(llm_mod._bounded_stream_lines(response, 1_000_000, "body"))


class WatcherCloseTest(unittest.TestCase):
    def test_the_close_ends_the_stream_instead_of_raising(self):
        response = _Response([b"data: one\n", b"data: two\n"],
                             boom=AttributeError("'NoneType' object has no attribute 'read'"))
        self.assertEqual(_lines(response), ["data: one", "data: two"],
                         "everything received before the close is still delivered")

    def test_a_closed_raw_body_is_NOT_taken_for_the_watcher(self):
        """`raw.closed` cannot stand in for the watcher's own flag.

        urllib3 closes the connection on an IncompleteRead, so `response.raw.closed` is equally
        true when a body was cut in transit. Treating it as a watcher close meant a truncated
        response was accepted as a complete one -- silent corruption, which is worse than the
        error it was suppressing. The watcher now sets `_dgc_closed` before it tears anything
        down (RequestWatch._shutdown), so the flag alone is a sound discriminator and a real cut
        raises, is classified as a transport interruption, and is retried.
        """
        response = _Response([b"data: one\n"], boom=AttributeError("read"), mark_closed=False)
        response.raw.closed = True
        with self.assertRaises(AttributeError):
            _lines(response)

    def test_requests_wrapped_forms_of_the_same_close(self):
        for boom in (llm_mod.requests.exceptions.ChunkedEncodingError("closed"),
                     llm_mod.requests.exceptions.ConnectionError("closed"),
                     ValueError("read of closed file")):
            with self.subTest(boom=type(boom).__name__):
                self.assertEqual(_lines(_Response([b"data: one\n"], boom=boom)), ["data: one"])

    def test_a_real_transport_fault_still_raises(self):
        response = _Response([b"data: one\n"],
                             boom=AttributeError("something genuinely wrong"), mark_closed=False)
        with self.assertRaises(AttributeError):
            _lines(response)

    def test_unrelated_errors_are_never_swallowed_even_after_a_close(self):
        response = _Response([b"data: one\n"], boom=RuntimeError("a real bug"))
        with self.assertRaises(RuntimeError):
            _lines(response)

    def test_a_trailing_partial_line_survives_the_close(self):
        response = _Response([b"data: one\n", b"data: tw"], boom=AttributeError("read"))
        self.assertEqual(_lines(response), ["data: one", "data: tw"])

    def test_the_safety_bound_still_applies(self):
        response = _Response([b"x" * 200], boom=None)
        with self.assertRaises(llm_mod.LLMError):
            list(llm_mod._bounded_stream_lines(response, 100, "body"))


if __name__ == "__main__":
    unittest.main()


class BufferedReaderTests(unittest.TestCase):
    """The buffered readers were wrapped in this batch; both consequences are tested here.

    Ollama's cloud serves its newline-delimited stream under `application/json`, which takes the
    buffered path rather than the line-streaming one. Wrapping it was the fix; these are the two
    things the wrap got wrong on the first attempt.
    """

    def test_an_empty_body_does_not_crash_the_ollama_consumer(self):
        """A watcher close on a cloud-Ollama body must not raise UnboundLocalError.

        `_consume_ollama` bound `frames` only on the text-is-None path. Once the wrap made
        `_bounded_body_text` return "" instead of raising, the next line read an unbound local —
        and UnboundLocalError is a NameError, so neither the local `except (ValueError,
        RecursionError)` nor the transport-interruption classifier caught it: it escaped the whole
        chat loop. This drives the real method with a body the watcher closed after zero bytes.
        """
        from dgc.llm import LLMClient

        class Raw:
            closed = False

        class Response:
            _dgc_closed = True                      # the watcher closed it mid-read
            raw = Raw()
            status_code = 200
            headers = {"Content-Type": "application/json"}

            def iter_content(self, chunk_size=None):
                # A generator that fails DURING iteration, which is how a closed socket actually
                # surfaces. Raising when iter_content is merely called would never reach the
                # guard, and an earlier version of this test made exactly that mistake and so
                # passed against the bug.
                def body():
                    if False:
                        yield b""
                    raise AttributeError("'NoneType' object has no attribute 'read'")
                return body()

            def close(self):
                pass

        client = LLMClient("http://localhost.invalid/v1", "", "fixture")
        try:
            client._consume_ollama(Response(), lambda *a, **k: None, lambda *a, **k: None)
        except UnboundLocalError as exc:
            self.fail(f"a closed stream crashed the consumer: {exc}")
        except Exception:
            pass          # any OTHER failure is the loop's to classify and retry; not this test

    def test_a_watcher_close_on_a_buffered_body_is_quiet(self):
        from dgc.llm import _until_watcher_closes

        class Response:
            _dgc_closed = True
            raw = None
            headers = {}

        def chunks():
            yield b'{"response": "partial"}'
            raise AttributeError("'NoneType' object has no attribute 'read'")

        self.assertEqual(list(_until_watcher_closes(chunks(), Response())),
                         [b'{"response": "partial"}'])

    def test_a_body_cut_in_transit_still_raises(self):
        from dgc.llm import _until_watcher_closes

        class Raw:
            closed = True                      # urllib3 closes the connection on an IncompleteRead

        class Response:
            _dgc_closed = False                # the watcher did NOT do this
            raw = Raw()
            headers = {}

        def chunks():
            yield b'{"response": "half'
            raise llm_mod.requests.exceptions.ChunkedEncodingError("Connection broken")

        with self.assertRaises(llm_mod.requests.exceptions.ChunkedEncodingError):
            list(_until_watcher_closes(chunks(), Response()))
