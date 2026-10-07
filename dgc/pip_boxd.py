"""Inside a Pip computer's Linux VM on macOS (Apple's container tool): its only way out, and its events.

Copied into the VM and run there as the computer's user; it imports nothing from DGC.

The VM has no network (--network none) and cannot connect to the Mac. The Mac can connect in, through
Unix sockets published with --publish-socket, so it keeps a few idle connections open to pool.sock.
Each local proxy client takes one: the browser and the desktop on 127.0.0.1:8899, the Pip's Terminal
commands on 127.0.0.1:8898. boxd sends one byte naming the channel, and the Mac splices the connection
to DGC's egress proxy for that channel, which lets public websites through and nothing else.

events.sock carries the dock's Browser clicks (the control FIFO) to the Mac, one line each.
"""
import os
import queue
import select
import socket
import sys
import threading

SOCKETS = "/run/dgc/sock"
CONTROL = SOCKETS + "/control"
BROWSER_PORT, TERMINAL_PORT = 8899, 8898
CHANNELS = {BROWSER_PORT: b"\x01", TERMINAL_PORT: b"\x02"}
WAIT_SECONDS = 15                 # a client waits this long for the Mac to offer a connection

idle: "queue.Queue[socket.socket]" = queue.Queue()
watchers: list = []
lock = threading.Lock()


def pump(a, b) -> None:
    try:
        while True:
            ready, _, _ = select.select([a, b], [], [], 600)
            if not ready:
                return
            for s in ready:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        a.close()
        b.close()


def listen_unix(name: str) -> socket.socket:
    path = os.path.join(SOCKETS, name)
    try:
        os.unlink(path)
    except OSError:
        pass
    server = socket.socket(socket.AF_UNIX)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(64)
    return server


def accept_pool(server: socket.socket) -> None:
    while True:
        conn, _ = server.accept()
        idle.put(conn)


def take(channel: bytes, client: socket.socket) -> None:
    """Pair one local client with one of the Mac's idle connections, then relay until either closes."""
    while True:
        try:
            upstream = idle.get(timeout=WAIT_SECONDS)
        except queue.Empty:
            client.close()                  # the Mac is not connected: no way out
            return
        try:
            upstream.sendall(channel)
        except OSError:
            upstream.close()                # a connection the Mac already dropped: take the next
            continue
        pump(client, upstream)
        return


def serve_port(port: int) -> None:
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen(64)
    while True:
        client, _ = server.accept()
        threading.Thread(target=take, args=(CHANNELS[port], client), daemon=True).start()


def accept_watchers(server: socket.socket) -> None:
    while True:
        conn, _ = server.accept()
        with lock:
            watchers.append(conn)


def read_control() -> None:
    if not os.path.exists(CONTROL):
        os.mkfifo(CONTROL, 0o600)
    while True:
        with open(CONTROL, "rb") as stream:
            for line in stream:
                if line.strip() == b"browser":
                    with lock:
                        for conn in list(watchers):
                            try:
                                conn.sendall(b"browser\n")
                            except OSError:
                                watchers.remove(conn)


def main() -> None:
    os.makedirs(SOCKETS, exist_ok=True)
    pool, events = listen_unix("pool.sock"), listen_unix("events.sock")
    for target, args in ((accept_pool, (pool,)), (accept_watchers, (events,)), (read_control, ()),
                         (serve_port, (TERMINAL_PORT,))):
        threading.Thread(target=target, args=args, daemon=True).start()
    print("ready", flush=True)
    serve_port(BROWSER_PORT)


if __name__ == "__main__":
    sys.exit(main())
