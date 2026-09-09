import * as vscode from "vscode";

export type DgcExecutableResolution = {
  command: string;
  ignoredWorkspaceOverride: boolean;
};

/** Resolve the executable only from the user/machine scope. A repository must never be able to
 * choose the process that the extension spawns merely by carrying workspace settings. */
export function resolveDgcExecutable(): DgcExecutableResolution {
  const config = vscode.workspace.getConfiguration("dgc");
  const inspected = config.inspect<string>("command");
  const ignoredWorkspaceOverride = inspected?.workspaceValue !== undefined
    || inspected?.workspaceFolderValue !== undefined;
  const selected = inspected?.globalValue ?? inspected?.defaultValue ?? "dgc";
  const command = typeof selected === "string" ? selected.trim() : "";
  return {
    command: command && command.length <= 4096 && !/[\0\r\n]/u.test(command) ? command : "dgc",
    ignoredWorkspaceOverride,
  };
}

/** Read a string setting from the user/machine scope only. The manifest declares these settings
 * `"scope": "machine"`, and this is the belt to that brace: a value a repository placed in
 * `.vscode/settings.json` must never choose where the conversation is sent or what shell command
 * runs at the end of a turn, even on a host that has not applied the scope yet. */
export function userScopedString(name: string): { value: string; ignoredWorkspaceOverride: boolean } {
  const inspected = vscode.workspace.getConfiguration("dgc").inspect<string>(name);
  const ignoredWorkspaceOverride = inspected?.workspaceValue !== undefined
    || inspected?.workspaceFolderValue !== undefined;
  const selected = inspected?.globalValue ?? inspected?.defaultValue ?? "";
  const value = typeof selected === "string" ? selected.trim() : "";
  return { value: value.length <= 4096 && !/[\0\r\n]/u.test(value) ? value : "", ignoredWorkspaceOverride };
}

