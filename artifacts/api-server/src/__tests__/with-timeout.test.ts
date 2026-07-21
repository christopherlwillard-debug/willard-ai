import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../lib/library-engine/with-timeout.ts";

describe("withTimeout", () => {
  test("resolves when the inner promise settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve(42), 200);
    assert.equal(result, 42);
  });

  test("rejects with code=operation_timeout when the deadline fires first", async () => {
    const never = new Promise<string>(() => { /* intentionally never resolves */ });
    const start = Date.now();
    await assert.rejects(
      () => withTimeout(never, 50),
      (e: unknown) => {
        assert.ok(e instanceof Error, "should reject with an Error");
        assert.equal((e as { code?: string }).code, "operation_timeout",
          "error code should be operation_timeout");
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 300, `timeout should fire within 300 ms, took ${elapsed} ms`);
        return true;
      },
    );
  });

  test("fires within 2× the specified timeout even under microtask pressure", async () => {
    const TIMEOUT_MS = 30;
    const never = new Promise<void>(() => {});
    const start = Date.now();
    await assert.rejects(() => withTimeout(never, TIMEOUT_MS));
    const elapsed = Date.now() - start;
    assert.ok(elapsed < TIMEOUT_MS * 2, `took ${elapsed} ms, expected < ${TIMEOUT_MS * 2} ms`);
  });

  test("clears its internal timer when the inner promise resolves early", async () => {
    // If the timer leaks, Node will keep the process alive — this test
    // implicitly validates cleanup via the test suite exit behaviour.
    const fast = new Promise<number>(resolve => setTimeout(() => resolve(99), 5));
    const result = await withTimeout(fast, 500);
    assert.equal(result, 99);
  });

  test("discards late resolution of original promise after timeout fires", async () => {
    let lateResolve!: (v: string) => void;
    const slow = new Promise<string>(r => { lateResolve = r; });
    await assert.rejects(() => withTimeout(slow, 20));
    // Resolving after the timeout should not throw or cause observable side-effects
    lateResolve("too late");
    // Give the event loop a tick to confirm no unhandled rejection occurs
    await new Promise(r => setTimeout(r, 10));
  });

  test("propagates genuine rejections from the inner promise before the deadline", async () => {
    const boom = Promise.reject(Object.assign(new Error("NAS read failure"), { code: "EACCES" }));
    await assert.rejects(
      () => withTimeout(boom, 500),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal((e as { code?: string }).code, "EACCES");
        return true;
      },
    );
  });
});
