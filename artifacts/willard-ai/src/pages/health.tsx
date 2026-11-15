import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, FolderCheck, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { apiUrl } from "@/lib/api";
import {
  getFollowUpHealthJobId,
  shouldClearCleanupActions,
  shouldPollHealthJob,
  type HealthJobSnapshot,
} from "@/lib/health-job-state";

type Report = {
  checkedAt: string | null;
  libraryPath: string | null;
  libraryKey?: string | null;
  indexedFiles?: number;
  hasReport?: boolean;
  activeJob?: HealthJob | null;
  recoverableCleanup?: HealthJob | null;
  status: "healthy" | "attention" | "action_required";
  issues: Record<string, number>;
  error?: string;
};

type HealthJob = HealthJobSnapshot;

const checks = [
  ["missingFiles", "Missing files", "Indexed files that no longer exist on the NAS"],
  ["orphanedIndexRecords", "Orphaned index records", "Stale catalog records with no matching file"],
  ["missingThumbnails", "Missing thumbnails", "Media that needs a thumbnail regenerated"],
  ["orphanedThumbnails", "Orphaned thumbnails", "Cache images with no matching catalog record"],
  ["emptyFolders", "Empty folders", "Folders containing no files or subfolders"],
  ["brokenMetadataReferences", "Broken metadata references", "Derived metadata pointing to missing media"],
  ["unusedCacheBytes", "Unused cache", "Non-thumbnail cache data that can be reviewed"],
] as const;

const actions = [
  ["orphanedRecords", "Hide missing files from library (reversible)"],
  ["orphanedDerivedData", "Remove orphaned AI and face data"],
  ["orphanedThumbnails", "Delete orphaned thumbnails"],
  ["missingThumbnails", "Regenerate missing thumbnails"],
  ["emptyFolders", "Remove empty folders"],
  ["rebuildMetadata", "Rebuild outdated metadata now"],
  ["fullThumbnailRebuild", "Full thumbnail rebuild"],
] as const;

export default function Health() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [activeJob, setActiveJob] = useState<HealthJob | null>(null);
  const [trackedJobId, setTrackedJobId] = useState<number | null>(null);
  const [cleanupStartedByThisPage, setCleanupStartedByThisPage] = useState<number | null>(null);
  const [followUpParentJobId, setFollowUpParentJobId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const libraryKeyRef = useRef<string | null>(null);
  const reloadStatusRef = useRef<(() => Promise<Report | null>) | null>(null);

  const startScan = useCallback(async (preserveNotice = false) => {
    const libraryKeyAtStart = libraryKeyRef.current;
    setRunning(true);
    setError("");
    if (!preserveNotice) setNotice("");
    try {
      const response = await fetch(apiUrl("/media/health/scan"), { method: "POST" });
      const body = await response.json();
      if (libraryKeyRef.current !== libraryKeyAtStart) {
        await reloadStatusRef.current?.();
        return;
      }
      if (!response.ok && body.job?.id) {
        setActiveJob(body.job as HealthJob);
        setTrackedJobId(body.job.id);
        return;
      }
      if (!response.ok) throw new Error(body.error ?? "Health verification could not start");
      const job = body.job as HealthJob;
      setActiveJob(job);
      setTrackedJobId(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Health verification could not start");
      setRunning(false);
    }
  }, []);

  const loadStatus = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const response = await fetch(apiUrl("/media/health"));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Health status could not be loaded");
      const nextReport = body as Report;
      const nextLibraryKey = nextReport.libraryKey ?? null;
      const libraryChanged = libraryKeyRef.current !== null && libraryKeyRef.current !== nextLibraryKey;
      libraryKeyRef.current = nextLibraryKey;
      if (libraryChanged) {
        setSelected([]);
        setCleanupStartedByThisPage(null);
        setFollowUpParentJobId(null);
        setNotice("");
      }
      setReport(nextReport);
      setError(libraryChanged ? "The library location changed. The Health Center has been refreshed; review the current library before continuing." : "");
      const runningJob = nextReport.activeJob ?? null;
      const job = runningJob ?? nextReport.recoverableCleanup ?? null;
      setActiveJob(job);
      if (runningJob) {
        setTrackedJobId(runningJob.id);
        setRunning(true);
      } else if (!nextReport.hasReport) {
        setTrackedJobId(null);
        setRunning(false);
        if (!nextReport.recoverableCleanup) void startScan();
      } else {
        setRunning(false);
        setTrackedJobId(null);
      }
      return nextReport;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Health status could not be loaded");
      return null;
    } finally {
      if (initial) setLoading(false);
    }
  }, [startScan]);
  reloadStatusRef.current = () => loadStatus();

  useEffect(() => { void loadStatus(true); }, [loadStatus]);

  useEffect(() => {
    if (trackedJobId === null) return;
    const pollLibraryKey = libraryKeyRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(apiUrl(`/media/health/jobs/${trackedJobId}`));
        const body = await response.json();
        if (cancelled || libraryKeyRef.current !== pollLibraryKey) return;
        if (response.status === 404) {
          setReport(null);
          setActiveJob(null);
          setTrackedJobId(null);
          setRunning(false);
          setSelected([]);
          await loadStatus();
          return;
        }
        if (!response.ok) throw new Error(body.error ?? "Could not reconnect to the library task");
        const job = body.job as HealthJob;
        if (cancelled || libraryKeyRef.current !== pollLibraryKey) return;
        setActiveJob(job);
        const summary = job.summary ?? {};
        if (job.jobType === "HEALTH_CLEANUP" && job.status === "FAILED" && job.error) {
          setNotice(job.error);
        }
        if (shouldPollHealthJob(job)) {
          setRunning(true);
          timer = setTimeout(poll, 1500);
          return;
        }

        const followUpJobId = getFollowUpHealthJobId(job);
        if (followUpJobId !== null) {
          if (
            job.jobType === "HEALTH_CLEANUP" &&
            shouldClearCleanupActions(job) &&
            cleanupStartedByThisPage === job.id
          ) {
            setFollowUpParentJobId(job.id);
          }
          setTrackedJobId(followUpJobId);
          return;
        }

        setRunning(false);
        setTrackedJobId(null);
        if (job.jobType === "HEALTH_CLEANUP") {
          if (shouldClearCleanupActions(job)) {
            if (cleanupStartedByThisPage === job.id && typeof summary.followUpRequest === "undefined") {
              setSelected([]);
              setNotice(typeof summary.message === "string" ? summary.message : "Cleanup completed.");
            }
          } else if (job.status !== "FAILED") {
            setError(job.error ?? `Cleanup ended with status ${job.status}.`);
          } else {
            setNotice(job.error ?? "Cleanup finished with items needing attention. Review the results before retrying.");
          }
          if (typeof summary.followUpError === "string") setError(summary.followUpError);
          await loadStatus();
          void startScan(true);
        } else if (job.jobType === "HEALTH_SCAN") {
          if (job.status === "DONE") await loadStatus();
          else setError(job.error ?? "Health verification did not complete.");
        } else {
          if (job.status === "DONE") {
            if (followUpParentJobId === cleanupStartedByThisPage) {
              setSelected([]);
              setFollowUpParentJobId(null);
              setNotice("Cleanup and its follow-up task completed.");
            } else {
              setNotice("The library follow-up task completed.");
            }
          } else {
            setError(job.error ?? "The library follow-up task did not complete.");
            setFollowUpParentJobId(null);
          }
          void startScan(true);
        }
      } catch (e) {
        if (cancelled || libraryKeyRef.current !== pollLibraryKey) return;
        setError(e instanceof Error ? e.message : "Could not reconnect to the library task");
        timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [trackedJobId, cleanupStartedByThisPage, followUpParentJobId, loadStatus, startScan]);

  const issueCount = useMemo(() => Object.entries(report?.issues ?? {}).reduce((sum, [key, value]) => sum + (key === "unusedCacheBytes" ? 0 : value), 0), [report]);
  const statusLabel = report?.status === "healthy" ? "Library Healthy" : report?.status === "action_required" ? "Action Required" : "Attention Needed";
  const statusColor = report?.status === "healthy" ? "text-emerald-400" : report?.status === "action_required" ? "text-red-400" : "text-amber-400";

  const runCleanup = async () => {
    const displayedLibraryKey = report?.libraryKey;
    if (!displayedLibraryKey) {
      setError("The current library could not be confirmed. Refresh the Health Center before starting cleanup.");
      return;
    }
    setRunning(true); setError(""); setNotice("");
    try {
      const currentReport = await loadStatus();
      if (!currentReport || currentReport.libraryKey !== displayedLibraryKey) {
        setError("The library location changed. The selected cleanup was not started; review the current library and select actions again.");
        return;
      }
      if (currentReport.activeJob || !currentReport.hasReport) {
        setError("A library task is already running. Wait for it to finish before starting cleanup.");
        return;
      }
      const response = await fetch(apiUrl("/media/cleanup"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actions: selected, libraryKey: displayedLibraryKey }),
      });
      const body = await response.json();
      if (!response.ok && body.job?.id) {
        setCleanupStartedByThisPage(null);
        setActiveJob(body.job as HealthJob);
        setTrackedJobId(body.job.id);
        return;
      }
      if (!response.ok) throw new Error(body.error ?? "Cleanup could not start");
      const job = body.job as HealthJob;
      setCleanupStartedByThisPage(body.alreadyRunning === true ? null : job.id);
      setActiveJob(job);
      setTrackedJobId(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cleanup failed");
      setRunning(false);
    }
  };

  const retryCleanup = async () => {
    if (!activeJob?.retryAvailable) return;
    const displayedLibraryKey = report?.libraryKey;
    if (!displayedLibraryKey) {
      setError("The current library could not be confirmed. Refresh the Health Center before retrying cleanup.");
      return;
    }
    setRunning(true);
    setError("");
    setNotice("");
    try {
      const currentReport = await loadStatus();
      if (
        !currentReport ||
        currentReport.libraryKey !== displayedLibraryKey ||
        currentReport.recoverableCleanup?.id !== activeJob.id
      ) {
        setError("The library location or cleanup changed. The saved actions were not retried; review the current library first.");
        return;
      }
      const response = await fetch(apiUrl(`/media/cleanup/jobs/${activeJob.id}/retry`), { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Cleanup could not be retried");
      const job = body.job as HealthJob;
      setCleanupStartedByThisPage(body.alreadyRunning === true ? null : job.id);
      setActiveJob(job);
      setTrackedJobId(job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cleanup could not be retried");
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-primary">Library maintenance</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Health Center</h1>
          <p className="text-muted-foreground mt-1">Review index, cache, metadata, and folder integrity without touching original media.</p>
        </div>
        <Button className="w-full sm:w-auto" variant="outline" onClick={() => void startScan()} disabled={loading || running}><RefreshCw className="mr-2 h-4 w-4" /> Verify now</Button>
      </div>

      <Card className="border-border">
        <CardContent className="flex flex-wrap items-center gap-4 py-5">
          {report?.status === "healthy" ? <CheckCircle2 className="h-10 w-10 text-emerald-400" /> : <AlertTriangle className={`h-10 w-10 ${statusColor}`} />}
          <div className="min-w-0 flex-1 basis-full sm:basis-auto sm:min-w-[220px]">
            <p className={`text-xl font-semibold ${statusColor}`}>{loading ? "Loading health status…" : running && activeJob?.jobType === "HEALTH_SCAN" ? "Verifying library…" : statusLabel}</p>
             <p className="text-sm text-muted-foreground">
               {report?.libraryPath ?? "No library configured"}
               {report?.libraryPath ? ` · ${(report.indexedFiles ?? 0).toLocaleString()} indexed files` : ""}
               {issueCount > 0 ? ` · ${issueCount.toLocaleString()} issue${issueCount === 1 ? "" : "s"} found` : ""}
             </p>
          </div>
          <div className="min-w-0 break-words text-left text-xs text-muted-foreground font-mono sm:ml-auto sm:text-right">
            <p>LAST VERIFIED</p><p>{report?.checkedAt ? new Date(report.checkedAt).toLocaleString() : "—"}</p>
          </div>
        </CardContent>
      </Card>

      {error && <div role="alert" className="break-words rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}
      {notice && <div role="status" className="break-words rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{notice}</div>}
      {activeJob && (running || activeJob.retryAvailable) && <div role={running ? "status" : "alert"} aria-live="polite" className={`rounded-lg border p-4 ${activeJob.retryAvailable && !running ? "border-amber-500/30 bg-amber-500/10" : "border-primary/30 bg-primary/5"}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {running
            ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
            : <AlertTriangle className="h-4 w-4 text-amber-400" />}
          <span className="min-w-0 flex-1 break-words">{activeJob.message ?? `Running ${activeJob.jobType.toLowerCase().replaceAll("_", " ")}…`}</span>
          {activeJob.retryAvailable && <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void retryCleanup()} disabled={running}>Retry cleanup</Button>}
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground">Task #{activeJob.id} · {activeJob.phase ?? activeJob.status.toLowerCase()}</p>
        {activeJob.retryAvailable && <p className="mt-2 text-xs text-muted-foreground">Retry rechecks the library and skips changes that are already complete. Selected actions: {(activeJob.actions ?? []).map(action => actions.find(([key]) => key === action)?.[1] ?? action).join(", ") || "none"}.</p>}
        {activeJob.total !== null && <div className="mt-2">
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (activeJob.processed / Math.max(activeJob.total, 1)) * 100)}%` }} /></div>
          <p className="mt-1 text-xs text-muted-foreground">{activeJob.processed.toLocaleString()} / {activeJob.total.toLocaleString()}</p>
        </div>}
      </div>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map(([key, label, description]) => (
          <Card key={key}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-medium">{label}</p><p className="text-xs text-muted-foreground mt-1">{description}</p></div>
                <span className={`text-2xl font-bold tabular-nums ${((report?.issues[key] ?? 0) > 0) ? "text-amber-400" : "text-emerald-400"}`}>{key === "unusedCacheBytes" ? formatBytes(report?.issues[key] ?? 0) : (report?.issues[key] ?? 0).toLocaleString()}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /> Selective cleanup</CardTitle><p className="text-sm text-muted-foreground">Only checked maintenance actions will run. Original NAS media is never deleted. Run a thumbnail rebuild or metadata refresh separately; other actions can be combined.</p></CardHeader>
        <CardContent className="space-y-3">
          {actions.map(([key, label]) => <label key={key} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/40"><input className="mt-1 shrink-0" type="checkbox" checked={selected.includes(key)} disabled={running} onChange={(e) => setSelected(current => e.target.checked ? [...current, key] : current.filter(item => item !== key))} /><span className="min-w-0 break-words text-sm">{label}</span></label>)}
          <Button className="w-full sm:w-auto" onClick={() => void runCleanup()} disabled={running || selected.length === 0}><Trash2 className="mr-2 h-4 w-4" /> {running ? "Running cleanup…" : "Run Cleanup"}</Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {[["Verify Media Index", "Recheck indexed paths against the NAS"], ["Verify Thumbnail Cache", "Compare cache files with active media"], ["Verify Metadata", "Find derived records without media"], ["Verify Folder Structure", "Find empty folders under the library"]].map(([title, description]) => <Button key={title} variant="outline" className="h-auto justify-start py-3" disabled={running} onClick={() => void startScan()}><FolderCheck className="mr-3 h-4 w-4 text-primary" /><span className="text-left"><span className="block">{title}</span><span className="block text-xs font-normal text-muted-foreground">{description}</span></span></Button>)}
      </div>
      <p className="text-xs text-muted-foreground">Need to change the library location? <Link href="/settings" className="text-primary hover:underline">Open Settings</Link>.</p>
    </div>
  );
}