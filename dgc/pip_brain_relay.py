"""The one MCP server a Pip's subscription CLI is given (pip_brain): a relay to DGC's Pip tools.

The CLI starts this as a stdio MCP server. It connects to the run's private socket, presents the token minted
for this run, and then carries MCP's newline-delimited JSON-RPC both ways, unchanged. It knows nothing of the
tools: DGC's worker answers every request, so every Pip rule stays in DGC.

Standard library only, run as ``python -I pip_brain_relay.py``: it imports nothing from the folder it is in or
from the CLI's environment, which reaches it only as the two variables below.
"""
import json
import os
import socket
import sys
import threading


def main() -> int:
    path = os.environ.get("DGC_PIP_MCP_SOCKET", "")
    token = os.environ.get("DGC_PIP_MCP_TOKEN", "")
    if not path or not token:
        sys.stderr.write("dgc pip tools: no run to reach\n")
        return 2
    try:
        link = socket.socket(socket.AF_UNIX)
        link.connect(path)
        link.sendall(json.dumps({"token": token}).encode("ascii") + b"\n")
    except OSError as error:
        sys.stderr.write(f"dgc pip tools: the run is gone ({error})\n")
        return 1

    def upstream():
        # The CLI's requests, line by line. Its stdin closing ends this run's tools.
        try:
            while True:
                line = sys.stdin.buffer.readline()
                if not line:
                    break
                link.sendall(line if line.endswith(b"\n") else line + b"\n")
        except OSError:
            pass
        try:
            link.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=upstream, daemon=True).start()
    out = sys.stdout.buffer
    try:
        while True:
            chunk = link.recv(1 << 16)
            if not chunk:
                break
            out.write(chunk)
            out.flush()
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
