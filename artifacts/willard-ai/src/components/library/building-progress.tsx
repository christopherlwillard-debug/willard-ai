import {
  useGetDashboard,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { useLibraryHealth } from "./library-status";
import { Progress } from "@/components/ui/progress";
import { Loader2, Image as ImageIcon, Film, FileText } from "lucide-react";
import { formatEta, useLibraryJobStream } from "@/hooks/use-library-job-stream";
import { useLocation } from "wouter";

/**
 * "Building your media library…" card, shown on the dashboard while a scan
 * job is running. Per-category counts come from the live dashboard breakdown
 * (they grow as the scan indexes files); overall progress comes from the
 * active job. The user keeps full access to the app while it runs.
 */
export function BuildingLibraryProgress() {
  const { data: health } = useLibraryHealth(5000);
  const { jobs } = useLibraryJobStream();
  const [, navigate] = useLocation();
  const { data: dashboard } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: health?.activeJob ? 4000 : false,
    },
  });

  const streamedJob = jobs.find((item) => item.jobType === "SCAN" || item.jobType === "THUMBNAILS");
  const job = (streamedJob ?? health?.activeJob) as {
    jobType?: string;
    filesProcessed?: number;
    filesTotal?: number | null;
    currentPath?: string;
    etaSeconds?: number | null;
    phase?: string | null;
    counters?: { thumbnails?: number; thumbnailsFailed?: number } | null;
  } | null | undefined;

  if (!job) return null;

  const isThumbnailJob = job.jobType === "THUMBNAILS" || job.phase === "thumbnailing";
  const scanned = job.filesProcessed ?? 0;
  const total = job.filesTotal ?? null;
  const pct = total && total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : null;
  const thumbsWritten = job.counters?.thumbnails ?? 0;
  const thumbsFailed = job.counters?.thumbnailsFailed ?? 0;

  const count = (type: string) =>
    dashboard?.typeBreakdown?.find((b: { fileType: string; count: number }) => b.fileType === type)?.count ?? 0;

  const categories = [
    { label: "Photos", value: count("image"), icon: ImageIcon, color: "text-purple-400" },
    { label: "Videos", value: count("video"), icon: Film, color: "text-blue-400" },
    { label: "Documents", value: count("document"), icon: FileText, color: "text-green-400" },
  ];

  return (
    <button type="button" onClick={() => navigate("/media")} className="w-full text-left rounded-lg border border-border bg-card/60 px-5 py-4 space-y-3 hover:border-primary/50 transition-colors">
      <div className="flex items-center gap-3">
        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {isThumbnailJob ? "Generating thumbnails" : "Syncing library in background"}
          </p>
          <p className="text-xs text-muted-foreground">
            {isThumbnailJob
              ? (() => {
                  const parts = [`${thumbsWritten.toLocaleString()} written`];
                  if (thumbsFailed > 0) parts.push(`${thumbsFailed.toLocaleString()} failed`);
                  return `${parts.join(", ")} · ${scanned.toLocaleString()} of ${total?.toLocaleString() ?? "?"} examined`;
                })()
              : (total
                ? `${scanned.toLocaleString()} / ${total.toLocaleString()} files on disk`
                : `${scanned.toLocaleString()} files discovered so far`)}
            {" — your library is fully usable while this runs."}
          </p>
          <p className="text-[11px] text-muted-foreground/80 truncate mt-1" title={job.currentPath}>
            {job.currentPath || formatEta(job.etaSeconds)}
          </p>
        </div>
        {pct != null && <span className="text-xs font-medium tabular-nums text-muted-foreground shrink-0">{pct}%</span>}
      </div>
      {pct != null && <Progress value={pct} className="h-1" />}
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {categories.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className={`w-3.5 h-3.5 ${color}`} />
            <span>{label}</span>
            <span className="font-medium text-foreground tabular-nums">{value.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-primary/80">Open scan progress center →</p>
    </button>
  );
}
