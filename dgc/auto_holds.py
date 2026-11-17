"""Whether DGC's own editor is on the wire: auto mode's chat-first rules are that window's (17 Nov).

His call for Work's auto mode: no approval card; what needs the user is asked in the chat, and the user's own words
answer it. That is how a person working in DGC's editor talks to it. A program on DGC's SDK in auto mode answers each
permission request itself, in code (its on_permission), and the terminal shows its own prompts: for them auto mode
stays as it was. So the rules that turn a card into a question in the chat (agent._auto_ask), make a paid picture or
video without a card, and let a look on the network or a Pip workflow's routing run, apply while an editor window that
named itself (the editor_app command) holds this process's wire, and only then.
"""
from __future__ import annotations

_editor_on_wire = False


def set_editor(on: bool) -> None:
    """The Host says whether an editor window named itself on the wire (editor_app), or the wire changed hands."""
    global _editor_on_wire
    _editor_on_wire = bool(on)


def wanted() -> bool:
    """True while DGC's own editor is the client: auto mode asks in the chat instead of with a card."""
    return _editor_on_wire
