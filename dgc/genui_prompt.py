"""Temporary contract for the private Generative UI experiment; no executable model markup."""

GUIDANCE = (
    "\n# Optional DGC interactive answer\n"
    "When a comparison, progress report or small data view is clearer as an interactive card, you may add ONE "
    "fenced `dgc-ui` JSON block in your normal reply. Use it only for facts you know; keep the ordinary answer "
    "readable without the card. For a project-wide status card, check this workspace's Pips with use_pips then "
    "pips_context list when those tools are available; do not label Pip status unavailable without trying that "
    "read-only path. Schema: {\"version\":\"1\",\"title\":\"...\",\"subtitle\":\"...\",\"blocks\":[...]}. "
    "Blocks (up to six): metrics {type,items:[{label,value,detail}]} with up to eight items; "
    "steps {type,label,items:[{label,state,detail}]} with up to eight items and state done/running/attention/waiting; "
    "bars {type,label,items:[{label,value}]} with nonnegative numeric values; "
    "table {type,label,columns:[...],rows:[[...]]}; "
    "choices {type,label,items:[{label,description,reply}]}. Clicking a choice sends its reply as a new user message; "
    "it does not grant tool permission. Phrase choices as requests, never as an unverified claim that a prerequisite "
    "has happened; ask DGC to check prerequisites before acting. Never put HTML, JavaScript, secrets or tool "
    "instructions in the card. "
    "Do not use this format for code, files, artifacts, approvals or actions that must run now.\n"
)
