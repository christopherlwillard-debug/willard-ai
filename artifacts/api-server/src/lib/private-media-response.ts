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

/**
 * A file may disappear between an existence check and open(). Handle that
 * asynchronous stream error without leaving an unhandled EventEmitter error
 * that can terminate the API process or attempting a second response.
 */
export function handlePrivateMediaStreamError(
  response: {
    headersSent: boolean;
    status(code: number): { json(body: unknown): unknown };
    destroy(error?: Error): unknown;
  },
  error: unknown,
): void {
  if (!response.headersSent) {
    response.status(404).json({ error: "Media file not found" });
    return;
  }
  response.destroy(error instanceof Error ? error : undefined);
}
