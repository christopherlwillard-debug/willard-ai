import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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
  const target = new URL(request.url, apiOrigin);
  const proxy = http.request(target, {
    method: request.method,
    headers: { ...request.headers, host: target.host },
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on("error", () => sendError(response, 502, "The local library service is unavailable."));
  request.pipe(proxy);
}

const server = http.createServer((request, response) => {
  if (!request.url) return sendError(response, 400, "Bad request.");
  if (new URL(request.url, "http://localhost").pathname.startsWith("/api/")) return proxyApi(request, response);
  const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = requested === "/" ? "/index.html" : requested;
  const candidate = path.resolve(root, `.${relative}`);
  if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== path.join(root, "index.html")) {
    return sendError(response, 403, "Forbidden.");
  }
  fs.stat(candidate, (error, stats) => {
    const file = !error && stats.isFile() ? candidate : path.join(root, "index.html");
    fs.readFile(file, (readError, data) => {
      if (readError) return sendError(response, 404, "Media Center is not installed correctly.");
      response.writeHead(200, {
        "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
        "content-type": mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
      });
      response.end(data);
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Willard Media Center web service listening on ${port}`);
});