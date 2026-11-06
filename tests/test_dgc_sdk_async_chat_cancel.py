"""Cancelled async ChatDGC startup closes the late-created backend."""

import asyncio
import threading
import unittest

from dgc_sdk.client import AsyncDGC


class AsyncChatCancellationTests(unittest.TestCase):
    def test_cancelled_open_closes_late_chat(self):
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()

        class Chat:
            def close(self):
                closed.set()

        class Sync:
            def chat(self, **_kwargs):
                entered.set()
                release.wait(5)
                return Chat()

        async def scenario():
            client = object.__new__(AsyncDGC)
            client._sync = Sync()
            task = asyncio.create_task(client.chat())
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            release.set()
            self.assertTrue(await asyncio.to_thread(closed.wait, 5))

        asyncio.run(scenario())


class AsyncChatStreamTests(unittest.TestCase):
    """Stopping at the "reply" event (the last one) is ordinary: no cancel goes after a finished reply."""

    class Fake:
        id = "c1"

        def __init__(self, events):
            self.events, self.cancels = events, 0

        def stream(self, text, **options):
            yield from self.events

        def cancel(self):
            self.cancels += 1

    def run_stream(self, events, stop_at):
        from dgc_sdk.chat import AsyncChat
        fake = self.Fake(events)

        async def scenario():
            stream = AsyncChat(fake).stream("hi")
            async for event in stream:
                if event.kind == stop_at:
                    break
            await stream.aclose()                # what the event loop's finalizer does later
        asyncio.run(scenario())
        return fake.cancels

    def test_a_caller_that_stops_at_the_reply_sends_no_cancel(self):
        from dgc_sdk.chat import ChatEvent
        self.assertEqual(self.run_stream([ChatEvent("text", text="Hel"), ChatEvent("reply", reply="Hello")], "reply"), 0)

    def test_a_caller_that_stops_mid_reply_still_cancels_it(self):
        from dgc_sdk.chat import ChatEvent
        self.assertEqual(self.run_stream([ChatEvent("text", text="Hel"), ChatEvent("reply", reply="Hello")], "text"), 1)
