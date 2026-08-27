import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger.ts";

export type ApiErrorBody = {
  error: string;
};

export class ApiRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.statusCode = statusCode;
  }
}

function isBodyParserError(error: unknown): error is { type: string; status?: number } {
  return typeof error === "object" && error !== null &&
    "type" in error && typeof error.type === "string";
}

function getStatusCode(error: unknown): number {
  if (error instanceof ApiRequestError) return error.statusCode;
  if (isBodyParserError(error) && error.status) return error.status;
  return 500;
}

function getPublicMessage(error: unknown, statusCode: number): string {
  if (error instanceof ApiRequestError) return error.message;
  if (isBodyParserError(error)) {
    if (error.type === "entity.too.large") return "Request body is too large.";
    if (error.type === "entity.parse.failed") return "Malformed request body.";
  }
  if (statusCode === 404) return "Not found.";
  if (statusCode >= 500) return "Internal server error.";
  return "Request could not be completed.";
}

function normalizeStatusCode(statusCode: number): number {
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
}

export function apiNotFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new ApiRequestError(404, "Not found."));
}

export function apiErrorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = normalizeStatusCode(getStatusCode(error));
  const requestId = String(req.id ?? "unknown");
  const log = req.log ?? logger;

  log.error({ err: error, requestId, statusCode, method: req.method }, "API request failed");

  // Streaming endpoints may have already committed their headers. Ending the
  // stream prevents Express's default handler from appending HTML or a stack.
  if (res.headersSent) {
    res.end();
    return;
  }

  const body: ApiErrorBody = { error: getPublicMessage(error, statusCode) };
  res.status(statusCode).type("application/json").json(body);
}