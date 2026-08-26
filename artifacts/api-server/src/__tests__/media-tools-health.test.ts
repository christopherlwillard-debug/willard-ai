import { test, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("child_process", {
  namedExports: {
    spawnSync: () => ({ status: 0, error: undefined }),
    execFile: (bin: string, _args: string[], _options: unknown, callback: (error: NodeJS.ErrnoException | null) => void) => {
      const error = Object.assign(new Error(`${bin} missing`), { code: "ENOENT" });
      callback(error);
    },
  },
});

const { getMediaToolsHealth } = await import("../lib/media-tools.ts");

test("reports thumbnail capability as degraded when FFmpeg is unavailable", async () => {
  const health = await getMediaToolsHealth();

  assert.equal(health.ffmpegAvailable, false);
  assert.equal(health.ffprobeAvailable, false);
  assert.equal(health.thumbnailGenerationAvailable, false);
  assert.match(health.message ?? "", /ffmpeg.*ffprobe unavailable/i);
  assert.match(health.message ?? "", /Install FFmpeg/i);
});