import * as vscode from "vscode";

import * as http from "http";

export type McpBrowserRequest = { url: string; callbackUrl?: string; deviceCode?: string; deviceOffer?: boolean; opening?: boolean };

/** Is this window's browser on another computer than DGC? A remote window (SSH, WSL, a container, Codespaces), or
 *  DGC_EDITOR_REMOTE set for an editor shown from elsewhere (a desktop over VNC or X forwarding). */
export function editorIsRemote(): boolean {
  return !!(vscode.env?.remoteName || String(process.env.DGC_EDITOR_REMOTE || "").trim());
}

/** "Signed in but nothing happened?": the address the browser ended on, handed to the sign-in still waiting here.
 *  It must be that sign-in's own callback (the loopback address, port and path DGC opened it with) carrying the
 *  service's answer; it is then opened on this computer, exactly as the browser would have, and the listener says
 *  whether it took it. */
export async function handSignInBack(callbackUrl: string, pasted: string): Promise<{ ok: boolean; message: string }> {
  let callback: URL, ended: URL;
  try { callback = new URL(callbackUrl); } catch { return { ok: false, message: "No sign-in is waiting now. Choose Connect again." }; }
  try { ended = new URL(String(pasted || "").trim()); } catch {
    return { ok: false, message: "Paste the whole address from the browser's address bar, starting with http://localhost." };
  }
  const local = (host: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  const path = (u: URL) => u.pathname || "/";
  if (ended.protocol !== "http:" || !local(ended.hostname) || ended.port !== callback.port || path(ended) !== path(callback)
      || ended.username || ended.password) {
    return { ok: false, message: `That isn't the address this sign-in returns to. It starts with http://localhost:${callback.port}${path(callback) === "/" ? "" : path(callback)}.` };
  }
  if (!ended.searchParams.get("state") || !(ended.searchParams.get("code") || ended.searchParams.get("error"))) {
    return { ok: false, message: "That address has no sign-in answer in it. Paste it from the page the service sent you to after you signed in." };
  }
  const target = `http://127.0.0.1:${callback.port}${path(callback)}${ended.search}`;
  return await new Promise((resolve) => {
    const request = http.get(target, { timeout: 10000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { if (body.length < 4096) body += chunk; });
      response.on("end", () => {
        const said = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
        resolve(response.statusCode === 200
          ? { ok: true, message: "Handed to DGC. It finishes signing in now." }
          : { ok: false, message: said || "DGC didn't take that address." });
      });
    });
    request.on("timeout", () => { request.destroy(); resolve({ ok: false, message: "DGC didn't answer. Choose Connect again." }); });
    request.on("error", () => resolve({ ok: false, message: "DGC stopped waiting for this sign-in. Choose Connect again." }));
  });
}
const loopback = (host: string): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(host);

/** Forward DGC's own loopback callback before opening its authorization page. Never rewrite
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
        // DGC's callback path, or none: an app registered with a bare loopback address (Microsoft's
        // http://localhost) is called back at the port alone.
        || !["/oauth/callback", "/"].includes(callback.pathname) || redirects.length !== 1
        || redirects[0] !== request.callbackUrl) {
      throw new Error("The MCP callback does not match this sign-in request.");
    }
    if (vscode.env?.remoteName) {
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
          + `DGC's sign-in needs a desktop editor with loopback forwarding.`);
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
