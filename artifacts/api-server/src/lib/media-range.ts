import type { Response } from "express";
import * as fs from "node:fs";

export type ByteRange = {
  start: number;
  end: number;
};

/**
 * Parse exactly one RFC 9110 byte range. Multiple ranges are intentionally
 * rejected because the media endpoint returns one stream, not multipart data.
 */
export function parseSingleByteRange(header: unknown, size: number): ByteRange | null {
  if (header === undefined) return null;
  if (typeof header !== "string" || !Number.isSafeInteger(size) || size < 0) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;

  const requestedStart = match[1] === "" ? undefined : Number(match[1]);
  const requestedEnd = match[2] === "" ? undefined : Number(match[2]);
  if (
    (requestedStart !== undefined && !Number.isSafeInteger(requestedStart)) ||
    (requestedEnd !== undefined && !Number.isSafeInteger(requestedEnd))
  ) {
    return null;
  }

  if (requestedStart === undefined) {
    if (requestedEnd === undefined || requestedEnd <= 0 || size === 0) return null;
    return { start: Math.max(0, size - requestedEnd), end: size - 1 };
  }

  if (requestedStart >= size || (requestedEnd !== undefined && requestedStart > requestedEnd)) {
    return null;
  }
  return {
    start: requestedStart,
    end: Math.min(requestedEnd ?? size - 1, size - 1),
  };
}

export function sendRangeNotSatisfiable(res: Response, size: number): void {
  res.status(416);
  res.setHeader("Content-Range", `bytes */${size}`);
  res.setHeader("Accept-Ranges", "bytes");
  res.json({ error: "Requested range is not satisfiable" });
}

export function streamFileWithErrorHandling(
  res: Response,
  filePath: string,
  options?: { start?: number; end?: number },
): void {
  const stream = fs.createReadStream(filePath, options);
  stream.once("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "File stream failed" });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}