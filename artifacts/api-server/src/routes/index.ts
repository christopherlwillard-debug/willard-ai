import { Router, type IRouter } from "express";
import healthRouter from "./health";
import settingsRouter from "./settings";
import scanRouter from "./scan";
import dashboardRouter from "./dashboard";
import filesRouter from "./files";
import explorerRouter from "./explorer";
import archivesRouter from "./archives";
import documentsRouter from "./documents";
import storageRouter from "./storage";
import cleanupRouter from "./cleanup";
import immichRouter from "./immich";
import openaiRouter from "./openai/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use(settingsRouter);
router.use(scanRouter);
router.use(dashboardRouter);
router.use(filesRouter);
router.use(explorerRouter);
router.use(archivesRouter);
router.use(documentsRouter);
router.use(storageRouter);
router.use(cleanupRouter);
router.use(immichRouter);
router.use(openaiRouter);

export default router;
