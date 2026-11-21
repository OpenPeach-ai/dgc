// What a plugin may do without asking: one list for Pips settings → Plugins and a plugin's page in Settings, the same
// setting (DGC's plugin state, plugins.permission). Work honours Always ask (each use asks, in auto mode too); a Pip
// honours every level.
export const PLUGIN_LEVELS = [
  ['always_ask', 'Always ask', 'Asks before it reads or changes anything'],
  ['any_changes', 'Ask before any change', 'Reads at once, asks before it changes anything'],
  ['important', 'Ask before important actions', 'Reads at once, asks before it sends, creates, edits, deletes, shares or pays'],
  ['never_ask', 'Never ask', 'Reads and acts without asking'],
];
