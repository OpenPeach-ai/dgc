"""A local model server cannot keep a health check alive by slowly sending a response."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest import TestCase, mock
import time

from dgc import server_check


class SlowBody(TestCase):
    def test_a_dribbling_response_respects_the_total_check_deadline(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "50")
                self.end_headers()
                for _ in range(50):
                    try:
                        self.wfile.write(b"x")
                        self.wfile.flush()
                    except OSError:
                        break
                    time.sleep(0.025)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            started = time.monotonic()
            with mock.patch.object(server_check, "_TOTAL_S", 0.12):
                _, body, _ = server_check._get(f"http://127.0.0.1:{server.server_port}/", {}, 4096)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertLess(len(body), 50)
        finally:
            server.shutdown()
            server.server_close()
