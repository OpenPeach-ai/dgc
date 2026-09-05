#!/usr/bin/env node

import {createReadStream, existsSync, readFileSync, statSync} from "node:fs";
import {createServer} from "node:http";
import {extname, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SITE = resolve(ROOT, "site");
const routes = new Set(JSON.parse(readFileSync(resolve(SITE, "routes.json"), "utf8")).html);
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex === -1 ? 4173 : process.argv[portIndex + 1]);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("--port must be an integer between 0 and 65535");
}

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
  [".vsix", "application/octet-stream"],
]);
const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".svg", ".txt", ".webmanifest", ".xml"]);

function routeFile(pathname) {
  if (routes.has(pathname)) {
    if (pathname === "/") return "index.html";
    if (["/docs", "/vscode"].includes(pathname)) {
      return `${pathname.slice(1)}/index.html`;
    }
    return `${pathname.slice(1)}.html`;
  }
  return pathname.replace(/^\/+/, "");
}

function sendFile(request, response, file, status = 200) {
  const size = statSync(file).size;
  const extension = extname(file).toLowerCase();
  const contentType = MIME.get(extension) || "application/octet-stream";
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  };

  if (range && status === 200) {
    const requestedStart = range[1] === "" ? 0 : Number(range[1]);
    const requestedEnd = range[2] === "" ? size - 1 : Number(range[2]);
    const start = Math.max(0, Math.min(requestedStart, size - 1));
    const end = Math.max(start, Math.min(requestedEnd, size - 1));
    response.writeHead(206, {
      ...headers,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
    });
    if (request.method === "HEAD") return response.end();
    return createReadStream(file, {start, end}).pipe(response);
  }

  if (COMPRESSIBLE.has(extension) && /(?:^|,)\s*gzip(?:\s*;|\s*,|$)/i.test(request.headers["accept-encoding"] || "")) {
    const body = gzipSync(readFileSync(file), {level: 9});
    response.writeHead(status, {
      ...headers,
      "Content-Encoding": "gzip",
      "Content-Length": body.length,
      Vary: "Accept-Encoding",
    });
    if (request.method === "HEAD") return response.end();
    return response.end(body);
  }

  response.writeHead(status, {...headers, "Content-Length": size});
  if (request.method === "HEAD") return response.end();
  return createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (pathname === "/__qa/ready") {
    response.writeHead(204, {"Cache-Control": "no-store"}).end();
    return;
  }
  if (pathname.startsWith("/api/") && request.method === "POST") {
    request.resume();
    const body = JSON.stringify({error: "Unknown QA API endpoint"});
    response.writeHead(404, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json; charset=utf-8",
    }).end(body);
    return;
  }
  if (!new Set(["GET", "HEAD"]).has(request.method || "")) {
    response.writeHead(405, {Allow: "GET, HEAD"}).end("Method not allowed");
    return;
  }

  const file = resolve(SITE, routeFile(pathname));
  if (file !== SITE && !file.startsWith(`${SITE}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (existsSync(file) && statSync(file).isFile()) {
    sendFile(request, response, file);
    return;
  }
  sendFile(request, response, resolve(SITE, "404.html"), 404);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`DGC site QA server ready at http://127.0.0.1:${actualPort}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
