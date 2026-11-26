"""The dgc_browser tool's shape (0.52): one tool for a Pip's run and for a Work session, the same steps in both
(dgc_browser_lane drives a Pip's tab, dgc_browser_work a Work session's). Kept apart from both so Work's tool list can
offer it without loading DGC Browser itself."""
from __future__ import annotations

TOOL = "dgc_browser"
OPS = ("open", "read", "click", "type", "press", "choose", "scroll", "back", "forward", "reload", "wait", "check",
       "uncheck", "hover", "tabs", "status", "dialog", "sign_in", "look")
TAB_ACTIONS = ("list", "open", "switch", "close")


def schema(eyes: str | None = None, *, work: bool = False) -> dict:
    """The dgc_browser tool as this run's model is offered it: the computer tool's browser steps on its own lane, by
    text. ``eyes`` ("own" or "relay"): its model can see (or a seeing model looks for it), so look is offered too.
    ``work``: a Work session's (dgc_browser_work): opening a site is what asks the user, and nothing waits on a card."""
    sees = eyes in ("own", "relay")
    ops = [o for o in OPS if o != "look" or sees]
    sites = ("Opening a site asks the user first (DGC shows them a card); after their yes it opens, and so does any "
             "page of it. open goes to an address; " if work else
             "Only the sites the user lets you use there open; any other is refused, and then you ask the user to "
             "allow it. open goes to an address on one of those sites; ")
    return {"type": "function", "function": {
        "name": TOOL,
        "description": ("Use your own tab in the user's DGC Browser: their own Google Chrome on this computer, where "
                        "they are signed in to their accounts" + (" (when the user says \"the DGC browser\", this is it)"
                        ". Use it only when the user asks for DGC Browser, or when the browser tool couldn't show what "
                        "they mean because the page needs their sign-in; for any other page use the browser tool. "
                        "Even for \"my browser\" or a page that needs a sign-in, open it with the browser tool first, "
                        "and come here when it shows a sign-in instead of what they mean"
                        if work else "") + ". " + sites + "read gives your tab's page as text, with refs like e12 for things you can use; "
                        "click/type/choose act on a ref from the latest read (type's submit true then presses Enter); "
                        "check/uncheck a box; hover over a ref; press sends a key such as Enter; scroll moves the page "
                        "(dy pixels, negative is up); back, forward, reload. wait (seconds, at most 30) until text shows "
                        "(gone true: until it goes), a ref or selector shows, the address has url, or the page loads. "
                        "tabs with action list, open (url), switch or close (tab: t2) for your own tabs there. status: "
                        "where you are and an open dialog. dialog answers the page's confirm or prompt: accept true (OK) "
                        "or false (Cancel), text for a prompt. sign_in, when a site needs the user signed in: DGC asks "
                        "the user to sign in themselves, in their own window; you never type a password or a code here."
                        + (" look shows you your tab as a picture (password fields blacked out)." if sees else "")),
        "parameters": {"type": "object", "additionalProperties": False, "required": ["op"],
                       "properties": {"op": {"type": "string", "enum": ops},
                                      "url": {"type": "string", "maxLength": 2048},
                                      "ref": {"type": "string", "maxLength": 16},
                                      "text": {"type": "string", "maxLength": 2000},
                                      "key": {"type": "string", "maxLength": 32},
                                      "value": {"type": "string", "maxLength": 500},
                                      "submit": {"type": "boolean"}, "dy": {"type": "number"},
                                      "seconds": {"type": "number"}, "gone": {"type": "boolean"},
                                      "selector": {"type": "string", "maxLength": 500},
                                      "action": {"type": "string", "enum": list(TAB_ACTIONS)},
                                      "tab": {"type": "string", "maxLength": 8}, "accept": {"type": "boolean"},
                                      "site": {"type": "string", "maxLength": 2048},
                                      **({} if work else {"confirm": {"type": "boolean", "description": "true: a held step, after the user's yes"}}),
                                      **({"question": {"type": "string", "maxLength": 1000}} if eyes == "relay" else {})}}}}
