import { Router, type IRouter, type Request, type Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { checkNasReachable } from "../lib/nas-storage";

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

function probeCandidate(p: string, label: string, kind: DriveCandidate["kind"]): DriveCandidate | null {
  const reach = checkNasReachable(p);
  if (!reach.online) return null;
  let itemCount: number | null = null;
  try { itemCount = fs.readdirSync(reach.path).length; } catch { itemCount = null; }
  return { path: reach.path, label, kind, online: true, itemCount, message: reach.message };
}

function detectWindowsDrives(): DriveCandidate[] {
  const found: DriveCandidate[] = [];
  // C: is the system drive — list it last so removable/network drives lead.
  const letters = "DEFGHIJKLMNOPQRSTUVWXYZABC".split("");
  for (const letter of letters) {
    const drivePath = `${letter}:\\`;
    try {
      if (!fs.existsSync(drivePath)) continue;
    } catch { continue; }
    const kind: DriveCandidate["kind"] = letter === "C" ? "local" : "external";
    const candidate = probeCandidate(drivePath, `${letter}: drive`, kind);
    if (candidate) found.push(candidate);
  }
  return found;
}

function detectUnixMounts(): DriveCandidate[] {
  const found: DriveCandidate[] = [];
  const roots: Array<{ dir: string; kind: DriveCandidate["kind"] }> = [
    { dir: "/mnt", kind: "network" },
    { dir: "/media", kind: "external" },
    { dir: "/Volumes", kind: "external" },
    { dir: "/srv", kind: "network" },
  ];
  for (const { dir, kind } of roots) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
      const candidate = probeCandidate(full, entry, kind);
      if (candidate) found.push(candidate);
    }
  }
  return found;
}

router.get("/system/drives", (_req: Request, res: Response) => {
  if (isReplit()) {
    // Cloud server: a user's local drive is legitimately unreachable here.
    res.json({ available: false, drives: [] });
    return;
  }
  try {
    const drives = process.platform === "win32" ? detectWindowsDrives() : detectUnixMounts();
    res.json({ available: true, drives });
  } catch {
    res.json({ available: true, drives: [] });
  }
});

export default router;
