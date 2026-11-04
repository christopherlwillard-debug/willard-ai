export function setPrivateMediaResponseHeaders(response: { setHeader(name: string, value: string): unknown }): void {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

/**
 * Only formats used by the in-app viewer are allowed to render inline.
 * Active document formats (notably HTML and SVG) are forced to download so
 * untrusted library content cannot execute as a same-origin document.
 */
export function setMediaStreamContentHeaders(
  response: { setHeader(name: string, value: string): unknown },
  mimeType: string | null | undefined,
): string {
  const normalized = typeof mimeType === "string"
    ? mimeType.split(";", 1)[0].trim().toLowerCase()
    : "";
  const safeInline =
    /^image\/(?:jpeg|png|gif|webp|avif|bmp|tiff|heic|heif)$/.test(normalized) ||
    /^(?:video|audio)\/[a-z0-9.+-]+$/.test(normalized) ||
    normalized === "application/pdf";
  const contentType = safeInline ? normalized : "application/octet-stream";
  response.setHeader("Content-Type", contentType);
  if (!safeInline) response.setHeader("Content-Disposition", "attachment");
  return contentType;
}
