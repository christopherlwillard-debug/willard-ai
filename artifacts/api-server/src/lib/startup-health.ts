type StartupFailure = {
  operation: string;
  message: string;
  recordedAt: string;
};

const failures = new Map<string, StartupFailure>();

export function markStartupDegraded(operation: string, message: string): void {
  failures.set(operation, {
    operation,
    message,
    recordedAt: new Date().toISOString(),
  });
}

export function clearStartupDegraded(operation: string): void {
  failures.delete(operation);
}

export function getStartupHealth(): { status: "ok" | "degraded"; failures: StartupFailure[] } {
  return {
    status: failures.size > 0 ? "degraded" : "ok",
    failures: [...failures.values()],
  };
}