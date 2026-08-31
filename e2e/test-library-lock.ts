import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOCK_PATH = path.join(os.tmpdir(), "willard-ai-library-test.lock");
const RETRY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize integration suites that temporarily replace the singleton NAS
 * setting. The API scopes durable jobs by that setting, so separate test
 * processes must not scan different roots at the same time.
 */
export async function acquireLibraryTestLock(): Promise<() => void> {
  while (true) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);

      return () => {
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let ownerPid = 0;
      try {
        ownerPid = Number.parseInt(fs.readFileSync(LOCK_PATH, "utf8").trim(), 10);
      } catch {
        // The owner may be between creating and writing the lock file.
      }

      if (ownerPid > 0 && processIsAlive(ownerPid)) {
        await sleep(RETRY_MS);
        continue;
      }

      try {
        fs.unlinkSync(LOCK_PATH);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
}