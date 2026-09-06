import * as vscode from "vscode";

export type McpBrowserRequest = { url: string; callbackUrl?: string; opening?: boolean };
const loopback = (host: string): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(host);

/** Forward a bridge-owned loopback callback before opening its authorization page. Never rewrite
 * redirect_uri: registration, PKCE completion and token exchange must use the same exact value. */
export async function openMcpBrowser(request: McpBrowserRequest, current: () => boolean): Promise<boolean> {
  const target = new URL(request.url);
  if (target.username || target.password || !(target.protocol === "https:"
      || (target.protocol === "http:" && loopback(target.hostname)))) {
    throw new Error("The MCP sign-in URL is not supported.");
  }
  if (request.callbackUrl) {
    const callback = new URL(request.callbackUrl);
    const redirects = target.searchParams.getAll("redirect_uri");
    if (callback.protocol !== "http:" || !loopback(callback.hostname) || Number(callback.port) < 1
        || callback.username || callback.password || callback.search || callback.hash
        || callback.pathname !== "/oauth/callback" || redirects.length !== 1
        || redirects[0] !== request.callbackUrl) {
      throw new Error("The MCP callback does not match this sign-in request.");
    }
    if (vscode.env.remoteName) {
      if (!current()) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let external: vscode.Uri;
      try {
        external = await Promise.race([
          vscode.env.asExternalUri(vscode.Uri.parse(request.callbackUrl, true)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("MCP callback forwarding timed out. Reconnect the server to retry.")), 10000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!current()) return false;
      const mapped = new URL(external.toString());
      // A different port/origin/path would require a different OAuth registration and token
      // exchange. The pinned bridge cannot make that transition after authorization starts.
      const sameHost = mapped.hostname === callback.hostname
        || (["localhost", "127.0.0.1"].includes(mapped.hostname)
          && ["localhost", "127.0.0.1"].includes(callback.hostname));
      if (mapped.protocol !== callback.protocol || !sameHost || mapped.port !== callback.port
          || mapped.pathname !== callback.pathname || mapped.search || mapped.hash
          || mapped.username || mapped.password) {
        throw new Error(`The editor could not forward MCP callback port ${callback.port} unchanged. `
          + `Forward that remote port to the same local port in the Ports panel, then reconnect the MCP server. `
          + `This bridge sign-in flow requires a desktop editor with loopback forwarding.`);
      }
    }
  }
  if (!current()) return false;
  try {
    return await vscode.env.openExternal(vscode.Uri.parse(request.url, true));
  } catch {
    throw new Error("MCP sign-in could not open in the browser. Reconnect the server to retry.");
  }
}
