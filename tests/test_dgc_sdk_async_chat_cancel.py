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
