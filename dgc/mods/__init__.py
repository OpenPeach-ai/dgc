"""Mods: small programs, in Python or TypeScript, that add the user's own panels, status lines, commands and guards
to DGC. Each says what it can touch (manifest.py) and the user allows it once (consent.py); each runs in a sandbox of
its own (runtime.py) and talks to DGC over JSON-RPC; host.py runs a session's mods and can only ever make DGC more
careful, never less. DGC ships three of its own (builtin/): Context, Tally and Guard."""
