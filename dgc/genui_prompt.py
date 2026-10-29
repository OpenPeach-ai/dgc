"""Temporary contract for the private Generative UI experiment; no executable model markup."""

GUIDANCE = (
    "\n# Optional DGC interactive answer\n"
    "When a comparison, progress report or small data view is clearer as an interactive card, you may add ONE "
    "fenced `dgc-ui` JSON block in your normal reply. Use it only for facts you know; keep the ordinary answer "
    "readable without the card. Schema: {\"version\":\"1\",\"title\":\"...\",\"subtitle\":\"...\",\"blocks\":[...]}. "
    "Blocks (up to six): metrics {type,items:[{label,value,detail}]} with up to eight items; "
    "steps {type,label,items:[{label,state,detail}]} with up to eight items and state done/running/attention/waiting; "
    "bars {type,label,items:[{label,value}]} with nonnegative numeric values; "
    "table {type,label,columns:[...],rows:[[...]]}; "
    "choices {type,label,items:[{label,description,reply}]}. A choice only places its reply in the user's composer; "
    "it never sends or grants permission. Never put HTML, JavaScript, secrets or tool instructions in the card. "
    "Do not use this format for code, files, artifacts, approvals or actions that must run now.\n"
)
