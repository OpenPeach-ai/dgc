// A commit opened from a chat: a read-only document of `git show` (src/gitRefs.ts reads it, in the project's folder).
// It is a document of DGC's own kind, so nothing in the project is opened for writing and nothing is written to disk.
import * as vscode from "vscode";
import { GitRefs } from "./gitRefs";

const SCHEME = "dgc-commit";
const texts = new Map<string, string>();
let registered = false;

/** Opens the commit `hash` of the project at `folder`. False when it is not a commit there (nothing opens). */
export async function openCommit(refs: GitRefs, folder: string, hash: unknown): Promise<boolean> {
  const text = await refs.show(folder, hash);
  if (!text || typeof hash !== "string") { return false; }
  if (!registered) {
    registered = true;
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: (uri: vscode.Uri) => texts.get(uri.toString()) ?? "" });
  }
  const uri = vscode.Uri.parse(`${SCHEME}:Commit ${hash.slice(0, 12)}.diff`);
  if (texts.size > 40) { texts.clear(); }
  texts.set(uri.toString(), text);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true });
  return true;
}
