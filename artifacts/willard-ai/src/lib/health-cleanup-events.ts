export type HealthCleanupEvent =
  | { type: "progress"; processed: number; total: number; message: string }
  | { type: "done"; ok: boolean; processed?: number; total?: number }
  | { type: "error"; message: string };

function readCount(value: unknown, fallback: number, allowZero = true): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    return fallback;
  }
  return value;
}

/** Parse one complete named Server-Sent Event block from the Health Center cleanup stream. */
export function parseHealthCleanupEvent(block: string): HealthCleanupEvent | null {
  let eventName = "message";
  const data: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    else if (field === "data") data.push(value);
  }

  if (data.length === 0) return null;
  if (eventName !== "progress" && eventName !== "done" && eventName !== "error") {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    throw new Error("Cleanup stream returned invalid event data.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Cleanup stream returned an invalid event payload.");
  }

  const record = payload as Record<string, unknown>;
  if (eventName === "progress") {
    if (typeof record.message !== "string" || record.message.length === 0) {
      throw new Error("Cleanup progress event did not include a message.");
    }
    return {
      type: "progress",
      processed: readCount(record.processed, 0),
      total: readCount(record.total, 1, false),
      message: record.message,
    };
  }

  if (eventName === "done") {
    if (typeof record.ok !== "boolean") {
      throw new Error("Cleanup completion event did not include a success status.");
    }
    const processed = Number.isSafeInteger(record.processed) && Number(record.processed) >= 0
      ? Number(record.processed)
      : undefined;
    const total = Number.isSafeInteger(record.total) && Number(record.total) > 0
      ? Number(record.total)
      : undefined;
    return {
      type: "done",
      ok: record.ok,
      ...(processed === undefined ? {} : { processed }),
      ...(total === undefined ? {} : { total }),
    };
  }

  return {
    type: "error",
    message: typeof record.message === "string" && record.message.length > 0
      ? record.message
      : "Cleanup failed.",
  };
}
