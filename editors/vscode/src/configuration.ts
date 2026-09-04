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
