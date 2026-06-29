import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import settingsRouter from "./settings";
import scanRouter from "./scan";
import dashboardRouter from "./dashboard";
import filesRouter from "./files";
import explorerRouter from "./explorer";
import archivesRouter from "./archives";
import documentsRouter from "./documents";
import storageRouter from "./storage";
import cleanupRouter from "./cleanup";
import openaiRouter from "./openai/index";
import organizeRouter from "./organize";
import optimizeRouter from "./optimize";
import mediaRouter from "./media";
import libraryRouter from "./library";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(settingsRouter);
router.use(scanRouter);
router.use(dashboardRouter);
router.use(filesRouter);
router.use(explorerRouter);
router.use(archivesRouter);
router.use(documentsRouter);
router.use(storageRouter);
router.use(cleanupRouter);
router.use(openaiRouter);
router.use(organizeRouter);
router.use(optimizeRouter);
router.use(mediaRouter);
router.use(libraryRouter);

export default router;
