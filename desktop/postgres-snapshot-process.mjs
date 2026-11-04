const SNAPSHOT_QUERY = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n";
const MAX_SNAPSHOT_OUTPUT_BYTES = 64 * 1024;

export function waitForExportedSnapshot(child, {
  timeoutMs = 10_000,
  killGraceMs = 1_000,
} = {}) {
  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let childClosed = false;
    let stopping = false;
    let timeout;
    let killTimer;

    const cleanupTimers = () => {
      clearTimeout(timeout);
      if (childClosed) clearTimeout(killTimer);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      callback(value);
    };
    const stopChild = () => {
      if (stopping || childClosed) return;
      stopping = true;
      try { child.kill("SIGTERM"); } catch { /* process may already have exited */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
      }, killGraceMs);
      killTimer.unref?.();
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_SNAPSHOT_OUTPUT_BYTES) {
        stopChild();
        settle(reject, new Error("PostgreSQL snapshot holder produced excessive output."));
        return;
      }
      stdout += chunk.toString("utf8");
      const snapshot = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^[0-9a-f]+-[0-9a-f]+-\d+$/i.test(line));
      if (snapshot) settle(resolve, snapshot);
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });

    child.stdin.once("error", (error) => {
      stopChild();
      settle(reject, new Error(`PostgreSQL snapshot holder input failed: ${error.message}`));
    });
    child.once("error", (error) => {
      settle(reject, new Error(`PostgreSQL snapshot holder could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      childClosed = true;
      cleanupTimers();
      settle(reject, new Error(
        `PostgreSQL snapshot holder exited early: ${stderr.trim() || (signal ? `signal ${signal}` : `exit code ${code}`)}`,
      ));
    });

    timeout = setTimeout(() => {
      stopChild();
      settle(reject, new Error("Timed out while exporting the PostgreSQL backup snapshot."));
    }, timeoutMs);

    // Register every failure listener before writing. If psql exits immediately,
    // EPIPE on stdin is handled rather than becoming an unhandled stream error.
    try {
      child.stdin.write(SNAPSHOT_QUERY, (error) => {
        if (error) {
          stopChild();
          settle(reject, new Error(`PostgreSQL snapshot holder input failed: ${error.message}`));
        }
      });
    } catch (error) {
      stopChild();
      settle(reject, new Error(
        `PostgreSQL snapshot holder input failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  });
}
