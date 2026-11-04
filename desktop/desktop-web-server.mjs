import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveApiProxyTarget, resolveStaticFile } from "./web-server-safety.mjs";
import { URL } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const [key, value] = process.argv[i].split("=", 2);
  if (key?.startsWith("--")) args.set(key.slice(2), value ?? process.argv[i + 1] ?? "");
}

const root = path.resolve(args.get("root") || ".");
const port = Number(args.get("port") || 5000);
const apiOrigin = args.get("api") || "http://127.0.0.1:8080";
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendError(response, status, message) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function proxyApi(request, response) {
  let target;
  try { target = resolveApiProxyTarget(request.url, apiOrigin); }
  catch { return sendError(response, 400, "Invalid API request target."); }
  const proxy = http.request(target, {
    method: request.method,
    headers: { ...request.headers, host: target.host },
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendError(response, 502, "The local library service is unavailable.");
  });
  request.once("aborted", () => proxy.destroy());
  response.once("close", () => {
    if (!response.writableEnded) proxy.destroy();
  });
  request.pipe(proxy);
}

const server = http.createServer((request, response) => {
  if (!request.url) return sendError(response, 400, "Bad request.");
  if (new URL(request.url, "http://localhost").pathname.startsWith("/api/")) return proxyApi(request, response);
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
  catch { return sendError(response, 400, "Invalid request path."); }
  const file = resolveStaticFile(root, pathname);
  if (!file) return sendError(response, 403, "Forbidden.");
  fs.readFile(file, (readError, data) => {
    if (readError) return sendError(response, 404, "Media Center is not installed correctly.");
    response.writeHead(200, {
      "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "content-type": mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    response.end(data);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Willard Media Center web service listening on ${port}`);
});
