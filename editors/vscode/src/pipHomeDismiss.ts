// Dismiss all on the home's Pips row (src/pipHomeStrip.js): what was unread when it was dismissed, per Pip, kept in the
// extension's global state so a reload doesn't bring the old count back. Nothing here marks a message read: the Pips page
// still shows every one until its chat is opened. The home drops a Pip's entry once it is read, or its Pip is gone.
import type * as vscode from "vscode";

const STORE = "dgc.pipHomeDismissed";
const KEEP = 500;
const PIP = /^pip_[a-f0-9]{32}$/;
const WORKSPACE = /^ws_[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9_|-]{1,260}$/;

/** A Pip's unread when it was dismissed: its project, and each feed's count and newest id (messages, run posts). */
export type PipHomeSnapshot = { w: string; m: number; mid: string | null; p: number; pid: string | null };

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const id = (value: unknown) => value === null || (typeof value === "string" && ID.test(value));

/** One entry, checked: anything malformed is left out, never half-kept. */
export function pipHomeSnapshot(value: any): PipHomeSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.w !== "string" || !WORKSPACE.test(value.w) || !count(value.m) || !count(value.p) || !id(value.mid) || !id(value.pid)) return null;
  return { w: value.w, m: value.m, mid: value.mid, p: value.p, pid: value.pid };
}

function kept(context: vscode.ExtensionContext): Record<string, PipHomeSnapshot> {
  const saved = context?.globalState?.get?.<Record<string, unknown>>(STORE);
  const out: Record<string, PipHomeSnapshot> = {};
  if (saved && typeof saved === "object") {
    for (const [pip, value] of Object.entries(saved)) {
      const snapshot = PIP.test(pip) ? pipHomeSnapshot(value) : null;
      if (snapshot) out[pip] = snapshot;
    }
  }
  return out;
}

/** The home page's attribute: every Pip dismissed there, read when the page is built (a reload builds it again). */
export function pipHomeDismissedAttr(context: vscode.ExtensionContext): string {
  const value = kept(context);
  if (!Object.keys(value).length) return "";
  const json = JSON.stringify(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return ` data-pip-home-dismissed="${json}"`;
}

/** The home's {type: "pipHomeDismissed", set, drop}: entries kept or dropped (the oldest go past KEEP). False when it isn't one. */
export function rememberPipHomeDismissed(context: vscode.ExtensionContext, message: any): boolean {
  if (!message || message.type !== "pipHomeDismissed") return false;
  if (typeof context?.globalState?.update !== "function") return true;
  const value = kept(context);
  for (const pip of Array.isArray(message.drop) ? message.drop.slice(0, KEEP) : []) if (typeof pip === "string") delete value[pip];
  const set = message.set && typeof message.set === "object" && !Array.isArray(message.set) ? message.set : {};
  for (const [pip, entry] of Object.entries(set).slice(0, KEEP)) {
    const snapshot = PIP.test(pip) ? pipHomeSnapshot(entry) : null;
    if (snapshot) { delete value[pip]; value[pip] = snapshot; }
  }
  const keys = Object.keys(value);
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete value[old];
  void Promise.resolve(context.globalState.update(STORE, value)).catch(() => { /* kept for this window still */ });
  return true;
}
