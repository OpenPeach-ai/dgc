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

    def test_a_closed_raw_body_counts_as_the_watcher_too(self):
        response = _Response([b"data: one\n"], boom=AttributeError("read"), mark_closed=False)
        response.raw.closed = True
        self.assertEqual(_lines(response), ["data: one"])

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
