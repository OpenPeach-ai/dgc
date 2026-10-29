/** Read-only checks for an imported app. A reachable login page is not an ERP health check. */
import * as http from "http";
import * as https from "https";

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; ms: number };

function request(url: string, method: "HEAD" | "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(target, { method, timeout: 5000, headers: { "User-Agent": "DGC-Apps/experiment" } }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { if (body.length < 8192) body += String(chunk).slice(0, 8192 - body.length); });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body, ms: Date.now() - start }));
    });
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", reject);
    req.end();
  });
}

export type AppHealth = { state: "ready" | "reachable" | "attention" | "offline"; detail: string; ms?: number;
                          checks?: { name: string; ok: boolean }[] };

export async function checkWorkApp(url: string): Promise<AppHealth> {
  try {
    const response = await request(url, "GET");
    if (response.status < 200 || response.status >= 300)
      return { state: "attention", detail: `Health check returned HTTP ${response.status}.`, ms: response.ms };
    let parsed: any;
    try { parsed = JSON.parse(response.body); } catch { /* A page can be reachable without a JSON health report. */ }
    const checks = parsed?.checks && typeof parsed.checks === "object" && !Array.isArray(parsed.checks)
      ? Object.entries(parsed.checks).slice(0, 12).map(([name, value]) => ({ name: name.slice(0, 60),
          ok: value && typeof value === "object" ? (value as any).ok === true : value === true })) : undefined;
    const ready = parsed?.status === "ok" && (!checks || checks.every(check => check.ok));
    const bad = parsed?.status === "error" || !!checks?.some(check => !check.ok);
    return { state: bad ? "attention" : ready ? "ready" : "reachable",
             detail: bad ? "The app reported a failing check." : ready ? "The app reports ready." : "The address responds; app readiness is unknown.",
             ms: response.ms, ...(checks ? { checks } : {}) };
  } catch (error: any) {
    return { state: "offline", detail: String(error?.message || "The app did not answer.").slice(0, 160) };
  }
}

/** Conservative: only an address with no framing restriction may open inside a DGC webview. */
export function frameDecision(headers: http.IncomingHttpHeaders): { embedded: boolean; reason: string } {
  const xfo = String(headers["x-frame-options"] || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin"))
    return { embedded: false, reason: "This app requires a same-origin browser window." };
  const csp = String(headers["content-security-policy"] || "");
  const clause = csp.split(";").map(part => part.trim()).find(part => /^frame-ancestors\b/i.test(part));
  if (clause && !/^frame-ancestors\s+\*\s*$/i.test(clause))
    return { embedded: false, reason: "This app restricts which windows may embed it." };
  return { embedded: true, reason: "" };
}

export async function canEmbedWorkApp(url: string): Promise<{ embedded: boolean; reason: string }> {
  try {
    const response = await request(url, "HEAD");
    if (response.status >= 300 && response.status < 400)
      return { embedded: false, reason: "This app redirects; open it in the browser for sign-in." };
    if (response.status < 200 || response.status >= 300)
      return { embedded: false, reason: `The app returned HTTP ${response.status}.` };
    return frameDecision(response.headers);
  } catch {
    return { embedded: false, reason: "The app could not be checked for editor embedding." };
  }
}
