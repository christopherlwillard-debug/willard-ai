import { Router, type IRouter, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { checkNasReachableAsync } from "../lib/nas-storage";

const router: IRouter = Router();

/**
 * Environment awareness for the web app.
 *
 * "Local" means the server runs on the user's own machine (a normal desktop
 * install), where drive auto-detection makes sense. On Replit/cloud the
 * server can never see the user's local drives, so detection is disabled and
 * behavior is unchanged.
 */
function isReplit(): boolean {
  return process.env["REPL_ID"] !== undefined;
}

router.get("/system/environment", (_req: Request, res: Response) => {
  const replit = isReplit();
  res.json({
    isReplit: replit,
    isLocal: !replit,
    platform: process.platform,
    isWindows: process.platform === "win32",
    driveDetectionAvailable: !replit,
  });
});

// ── Drive / mount auto-detection (local servers only) ────────────────────────

interface DriveCandidate {
  path: string;
  label: string;
  kind: "network" | "external" | "local";
  online: boolean;
  itemCount: number | null;
  message: string;
}

// Async — uses checkNasReachableAsync so network drive probing never blocks
// the event loop even when a Windows drive letter is unresponsive.
async function probeCandidate(p: string, label: string, kind: DriveCandidate["kind"]): Promise<DriveCandidate | null> {
  const reach = await checkNasReachableAsync(p);
  if (!reach.online) return null;
  let itemCount: number | null = null;
  try {
    const entries = await fs.promises.readdir(reach.path);
    itemCount = entries.length;
  } catch { itemCount = null; }
  return { path: reach.path, label, kind, online: true, itemCount, message: reach.message };
}

async function detectWindowsDrives(): Promise<DriveCandidate[]> {
  // C: is the system drive — list it last so removable/network drives lead.
  const letters = "DEFGHIJKLMNOPQRSTUVWXYZABC".split("");
  // Probe all drive letters in parallel — each runs in its own worker thread
  // via checkNasReachableAsync so a hung drive can't block the others.
  const results = await Promise.allSettled(
    letters.map(letter =>
      probeCandidate(`${letter}:\\`, `${letter}: drive`, letter === "C" ? "local" : "external")
    )
  );
  return results
    .filter((r): r is PromiseFulfilledResult<DriveCandidate> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value!);
}

async function detectUnixMounts(): Promise<DriveCandidate[]> {
  const roots: Array<{ dir: string; kind: DriveCandidate["kind"] }> = [
    { dir: "/mnt", kind: "network" },
    { dir: "/media", kind: "external" },
    { dir: "/Volumes", kind: "external" },
    { dir: "/srv", kind: "network" },
  ];
  const all: DriveCandidate[] = [];
  for (const { dir, kind } of roots) {
    let entries: string[] = [];
    try { entries = await fs.promises.readdir(dir); } catch { continue; }
    const results = await Promise.allSettled(
      entries.map(async entry => {
        const full = path.join(dir, entry);
        try {
          const st = await fs.promises.stat(full);
          if (!st.isDirectory()) return null;
        } catch { return null; }
        return probeCandidate(full, entry, kind);
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) all.push(r.value);
    }
  }
  return all;
}

router.get("/system/drives", async (_req: Request, res: Response) => {
  if (isReplit()) {
    // Cloud server: a user's local drive is legitimately unreachable here.
    res.json({ available: false, drives: [] });
    return;
  }
  try {
    const drives = await (process.platform === "win32" ? detectWindowsDrives() : detectUnixMounts());
    res.json({ available: true, drives });
  } catch {
    res.json({ available: true, drives: [] });
  }
});

export default router;
