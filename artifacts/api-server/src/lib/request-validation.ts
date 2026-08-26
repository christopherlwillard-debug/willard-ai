export class RequestValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
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

export function parseOptionalDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new RequestValidationError(`Invalid ${name}`);

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RequestValidationError(`Invalid ${name}`);
  }
  return parsed;
}