import fs from "node:fs";
import path from "node:path";
export function resolveApiProxyTarget(requestUrl, apiOrigin) {
  if (typeof requestUrl !== "string" || !requestUrl.startsWith("/") || requestUrl.startsWith("//")) throw new Error("Only origin-form API request targets are allowed.");
  const origin = new URL(apiOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("Invalid local API origin.");
  const target = new URL(requestUrl, origin);
  if (target.origin !== origin.origin || !target.pathname.startsWith("/api/")) throw new Error("API proxy target escaped its configured origin.");
  return target;
}
export function resolveStaticFile(root, pathname) {
  const rootReal = fs.realpathSync(root);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const candidate = path.resolve(rootReal, "." + requested);
  if (!candidate.startsWith(rootReal + path.sep) && candidate !== path.join(rootReal, "index.html")) return null;
  let real;
  try { real = fs.realpathSync(candidate); }
  catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    real = fs.realpathSync(path.join(rootReal, "index.html"));
  }
  const relative = path.relative(rootReal, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return fs.statSync(real).isFile() ? real : fs.realpathSync(path.join(rootReal, "index.html"));
}

export function parseDesktopRequestUrl(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl.length === 0) {
    throw new Error("Missing request URL.");
  }
  const parsed = new URL(requestUrl, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error("Invalid request path encoding.");
  }
  return { parsed, pathname };
}

export function staticFileReadErrorStatus(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? 404 : 500;
}

export function isAllowedDesktopRequestHost(hostHeader, originHeader, port) {
  if (typeof hostHeader !== "string" || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  const host = hostHeader.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (originHeader === undefined) return true;
  if (typeof originHeader !== "string") return false;
  try {
    const origin = new URL(originHeader);
    return origin.protocol === "http:" && origin.host.toLowerCase() === host;
  } catch {
    return false;
  }
}
