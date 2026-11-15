"""memory_review.Reviews: a review thread is listed as running only once it has started, so a close() (a ChatDGC
service closing, a test's tearDown) that lands between the two never joins a thread that hasn't started:
"cannot join thread before it is started" (seen once in the full suite, 15 Nov, test_chatdgc_wakeups)."""
import threading
import unittest

from dgc.memory_review import Reviews


class Spy:
    """The Reviews lock, checking each time it is let go that every listed review thread has started."""

    def __init__(self, reviews):
        self.real, self.reviews, self.unstarted = reviews._lock, reviews, []

    def __enter__(self):
        self.real.__enter__()
        return self

    def __exit__(self, *exc):
        self.unstarted += [t.name for t in self.reviews._running.values() if t.ident is None]
        return self.real.__exit__(*exc)


class CloseRace(unittest.TestCase):
    def test_a_listed_review_has_always_started(self):
        release = threading.Event()
        reviews = Reviews(lambda key: 10_000, lambda key: release.wait(5))
        spy = reviews._lock = Spy(reviews)
        thread = reviews.now("chat-1")
        self.assertIsNotNone(thread)
        self.assertEqual(spy.unstarted, [], "listed before it started: a close() then could join it unstarted")
        release.set()
        reviews.close(2.0)

    def test_close_while_a_review_starts_never_raises(self):
        reviews = Reviews(lambda key: 10_000, lambda key: None)
        errors = []

        def closer():
            try:
                reviews.close(1.0)
            except RuntimeError as exc:           # the bug: joining a thread not yet started
                errors.append(exc)
        for i in range(200):
            reviews._closed = False
            t = threading.Thread(target=closer)
            t.start()
            reviews.now(f"chat-{i}")
            t.join()
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
