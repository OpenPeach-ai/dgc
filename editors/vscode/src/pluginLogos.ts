import * as vscode from "vscode";
import * as fs from "fs";
import { dgcHome } from "./wslSetup";
import * as path from "path";
import { readBoundedFileSync } from "./boundedFile";

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
      const root = fs.realpathSync(path.join(dgcHome(), "plugins", "logos"));
      const file = fs.realpathSync(item.logo_file);
      if (file.startsWith(root + path.sep) && file.endsWith(".png")) {
        const data = readBoundedFileSync(file, MAX_BYTES);
        if (data?.subarray(0, 8).equals(PNG)) return { data: `data:image/png;base64,${data.toString("base64")}` };
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

/** An app a Pip reaches through Composio, as DGC names its toolkit (dgc/pip_app_links.py, TOOLKIT). */
export const APP_ID = /^[a-z0-9][a-z0-9_]{1,39}$/;

// The logo DGC ships for such an app, by its toolkit id: a small fixed list of the files in media/plugin-logos (the
// same pictures the Google Workspace and Microsoft plugins use for these services). An app not listed has none.
const APP_LOGOS: Record<string, string> = {
  gmail: "gmail.png", googlecalendar: "calendar.png", googledrive: "drive.png", googlecontacts: "contacts.png",
  googledocs: "docs.png", googleslides: "slides.png", notion: "notion.png", outlook: "outlook.png", onedrive: "onedrive.png",
  github: "github.png", linear: "linear.png", dropbox: "dropbox.png", zoom: "zoom.png",
};

/** The logo of an app in a Pip's "Apps it can use", as a data: URI, by its toolkit id; "" when DGC ships none. The
 *  file is chosen from the list above, never made from the id: the page only ever names the app. */
export function appLogoData(extensionUri: vscode.Uri, toolkit: string): string {
  if (typeof toolkit !== "string" || !APP_ID.test(toolkit) || !Object.hasOwn(APP_LOGOS, toolkit)) return "";
  try {
    const file = vscode.Uri.joinPath(extensionUri, "media", "plugin-logos", APP_LOGOS[toolkit]);
    const data = readBoundedFileSync(fs.realpathSync(file.fsPath), MAX_BYTES);
    return data?.subarray(0, 8).equals(PNG) ? `data:image/png;base64,${data.toString("base64")}` : "";
  } catch {
    return "";
  }
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
    if (!type) return "";
    const data = readBoundedFileSync(fs.realpathSync(found.file.fsPath), MAX_BYTES);
    return data ? `data:${type};base64,${data.toString("base64")}` : "";
  } catch {
    return "";
  }
}
