// media/shared/modelpicker.js, as the extension's host sees it (src/panel.ts): which mark a saved connection wears, so
// a page that is never told an address (ChatDGC, a Pip's chat) can still draw it.
declare const picker: {
  /** {mark, badge}: mark "" is a lettered tile; badge "cli" a subscription app, "key" an API key, "cloud" ollama.com, "" a local server. */
  markOf(from: { engine?: string; base_url?: string; name?: string; plan?: boolean }): { mark: string; badge: string };
  tipOf(name: string, badge: string): string;
  versionLabel(full: string): string;
  facts(id: string): string[];
  readonly MARK_NAMES: Readonly<Record<string, string>>;
  readonly PLAN_NAME: string;
};
export = picker;
