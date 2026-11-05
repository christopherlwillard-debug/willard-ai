import { ApiRequestError } from "./api-errors.ts";

export class RequestValidationError extends ApiRequestError {
  constructor(message: string) {
    super(400, message);
    this.name = "RequestValidationError";
  }
}

type IntegerOptions = {
  name: string;
  min: number;
  max: number;
  defaultValue?: number;
};

export function parseBoundedInteger(value: unknown, options: IntegerOptions): number {
  if (value === undefined) {
    if (options.defaultValue !== undefined) return options.defaultValue;
    throw new RequestValidationError(`Invalid ${options.name}`);
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new RequestValidationError(`Invalid ${options.name}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new RequestValidationError(`Invalid ${options.name}`);
  }
  return parsed;
}

/** Parse a canonical positive safe-integer path parameter without accepting parseInt/Number coercions. */
export function parsePositiveIntegerParam(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse a positive safe-integer identifier supplied as a JSON number or canonical decimal string. */
export function parsePositiveIntegerValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  return parsePositiveIntegerParam(value);
}

export function parseOptionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new RequestValidationError(`Invalid ${name}`);

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RequestValidationError(`Invalid ${name}`);
  }
  return parsed;
}

/** Parse an optional scalar query string; repeated query parameters are rejected. */
export function parseOptionalQueryString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new RequestValidationError(`Invalid ${name}`);
  return value;
}

/** Parse a strict YYYY-MM-DD calendar date at UTC midnight. */
export function parseOptionalDateOnly(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestValidationError(`Invalid ${name}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RequestValidationError(`Invalid ${name}`);
  }
  return parsed;
}

/** Convert an inclusive date-only range to a half-open UTC range for timestamp comparisons. */
export function parseOptionalDateOnlyRange(
  fromValue: unknown,
  toValue: unknown,
): { from?: Date; toExclusive?: Date } {
  const from = parseOptionalDateOnly(fromValue, "dateFrom");
  const to = parseOptionalDateOnly(toValue, "dateTo");
  if (from && to && from.getTime() > to.getTime()) {
    throw new RequestValidationError("Invalid date range: dateFrom must be on or before dateTo");
  }
  return {
    from,
    toExclusive: to ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : undefined,
  };
}
