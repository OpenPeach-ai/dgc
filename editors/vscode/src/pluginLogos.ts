import * as vscode from "vscode";
import * as fs from "fs";
import { homedir } from "os";
import * as path from "path";

/** What the plugin catalog knows of a plugin, for its logo. */
export interface PluginLogoItem { name?: string; icon?: string; logo_file?: string; developer?: string }

/** A plugin id, as DGC names plugins (pip_plugins.NAME): nothing that could leave the logos folder. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BYTES = 512 * 1024;

/** A plugin's logo: the package's own PNG (as a data: URI) or the one shipped with DGC (a file), or nothing. */
export function pluginLogoSource(extensionUri: vscode.Uri, item: PluginLogoItem): { data?: string; file?: vscode.Uri } {
  if (item.logo_file) {
    try {
      const root = fs.realpathSync(path.join(homedir(), ".dgc", "plugins", "logos"));
      const file = fs.realpathSync(item.logo_file);
      if (file.startsWith(root + path.sep) && file.endsWith(".png") && fs.statSync(file).size <= MAX_BYTES) {
        const data = fs.readFileSync(file);
        if (data.subarray(0, 8).equals(PNG)) return { data: `data:image/png;base64,${data.toString("base64")}` };
      }
    } catch { /* use the shipped logo when a package asset is unavailable */ }
  }
  // A catalog name, never a path (a marketplace's names are looser than an installed plugin's id).
  if (!item.name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name) || item.name.includes("..")) return {};
  const logos = vscode.Uri.joinPath(extensionUri, "media", "plugin-logos");
  const png = vscode.Uri.joinPath(logos, `${item.name}.png`);
  const shipped: Record<string, string> = { composio: "composio.svg", zapier: "zapier.ico", make: "make.ico", n8n: "n8n.ico", arcade: "arcade.svg", "google-workspace": "google.png" };
  const mark = Object.hasOwn(shipped, item.name)
    ? vscode.Uri.joinPath(logos, shipped[item.name])
    : item.icon === "dgc" && item.name.startsWith("dgc-")
    ? vscode.Uri.joinPath(logos, "dgc.svg")
    // Anthropic's own plugins declare no logo of their own: they show Anthropic's mark, as their developer.
    : item.developer === "Anthropic"
    ? vscode.Uri.joinPath(logos, "anthropic.png")
    : undefined;
  const file = fs.existsSync(png.fsPath) ? png : mark && fs.existsSync(mark.fsPath) ? mark : undefined;
  return file ? { file } : {};
}

const TYPES: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

/** The logo as a data: URI, for a reply's "Used Aave" line: it works in any webview (each allows img-src data:),
 *  whichever one shows the reply -- the side bar, a Pips tab, a ChatDGC tab. "" when there is none. */
export function pluginLogoData(extensionUri: vscode.Uri, item: PluginLogoItem): string {
  const found = pluginLogoSource(extensionUri, item);
  if (found.data) return found.data;
  if (!found.file) return "";
  try {
    const type = TYPES[path.extname(found.file.fsPath).toLowerCase()];
    if (!type || fs.statSync(found.file.fsPath).size > MAX_BYTES) return "";
    return `data:${type};base64,${fs.readFileSync(found.file.fsPath).toString("base64")}`;
  } catch {
    return "";
  }
}
