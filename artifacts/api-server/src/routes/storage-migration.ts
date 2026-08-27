import { Router, type IRouter } from "express";
import { storageMigrationService } from "../lib/storage-migration.ts";

const router: IRouter = Router();

function inputString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

router.post("/storage/migrations/preview", async (req, res) => {
  try {
    const sourceRoot = inputString(req.body?.sourceRoot, "sourceRoot");
    const destinationRoot = inputString(req.body?.destinationRoot, "destinationRoot");
    const manifest = await storageMigrationService.preview({
      sourceRoot,
      destinationRoot,
      sourceLabel: typeof req.body?.sourceLabel === "string" ? req.body.sourceLabel : undefined,
      destinationLabel: typeof req.body?.destinationLabel === "string" ? req.body.destinationLabel : undefined,
    });
    res.json(manifest);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/storage/migrations", async (_req, res) => {
  try {
    res.json(await storageMigrationService.list());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/storage/migrations/:id", async (req, res) => {
  try {
    res.json(await storageMigrationService.get(req.params.id));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/storage/migrations/:id/copy", async (req, res) => {
  try {
    res.json(await storageMigrationService.copy(req.params.id));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/storage/migrations/:id/cleanup/confirm", async (req, res) => {
  try {
    res.json(await storageMigrationService.confirmCleanup(req.params.id));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/storage/migrations/:id/cleanup", async (req, res) => {
  try {
    res.json(await storageMigrationService.cleanup(req.params.id));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;