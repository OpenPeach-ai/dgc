"""A Pip's deep research (0.52; his "yes to your full add list", and "one capability, one module"): the ONE engine
ChatDGC and Work run (dgc.deep_research), in the Pip's worker with the Pip's own model. The worker has no web of its
own: each search and each page goes through the run's socket (pip_app_links.RunSocket, ops RESEARCH_OPS) to the
controller, which reads it under careful mode and DGC's leak guard exactly as the Pip's web_search and web_fetch do.
A refused or failed read is an error the engine logs and goes past; nothing here writes or sends anything else.
"""
from __future__ import annotations

import copy

TOOLS = ("deep_research",)

PIP_NOTE = (" As a Pip: research only what the user asked for or your job needs, and say in your reply what you found "
            "with its sources; keep a long report as a page with make_artifact when the user would want to keep it.")


def schemas() -> list:
    from .deep_research import TOOL_SCHEMA
    schema = copy.deepcopy(TOOL_SCHEMA)
    schema["function"]["description"] = str(schema["function"].get("description") or "") + PIP_NOTE
    return [schema]


def run(agent, pin: dict, args) -> str:
    """Run the research for the Pip ``agent`` (its client, its window, its Stop); reads through ``pin``'s socket."""
    from . import deep_research
    from .pip_app_links import worker_reply
    args = args if isinstance(args, dict) else {}
    question = str(args.get("question") or "").strip()
    if not question:
        return "error: say what to research (question)."
    main = agent.client
    room = deep_research.room_for(main)

    def client_for():
        made = agent._new_client(main.base_url, main.api_key, main.model,
                                 api_mode=getattr(main, "api_mode", None), source="research")
        try:
            made.context_size = room
        except Exception:                              # noqa: BLE001 -- a client without the setting still works
            pass
        return made

    def ask(op, payload, timeout):
        reply = worker_reply(pin, op, payload, timeout=timeout)
        if "data" not in reply:
            raise ValueError(" ".join(str(reply.get("text") or "no reply").split())[:200])
        return reply["data"]

    def search(query):
        found = ask("research_search", {"query": str(query)}, 60)
        return [r for r in found if isinstance(r, dict)] if isinstance(found, list) else []

    def fetch(url):
        page = ask("research_page", {"url": str(url)}, 120)
        if not isinstance(page, dict):
            raise ValueError("the page couldn't be read")
        return str(page.get("url") or url), str(page.get("text") or "")
    try:
        result = deep_research.run_report(
            question, client_for=client_for, room=room, search=search, fetch=fetch,
            depth=args.get("depth") or deep_research.TOOL_DEFAULT_DEPTH, cancel=agent.cancelled,
            thinking=str((getattr(agent, "config", None) or {}).get("thinking", "off") or "off"))
    except deep_research.ResearchError as exc:
        return f"error: {exc}"
    return deep_research.tool_text(result)
