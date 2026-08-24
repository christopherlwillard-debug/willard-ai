import { useState } from "react";
import { CheckCircle2, ImagePlus, Loader2, Pause, Play, ScanLine, Square, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useLibraryJobStream, formatEta, type LibraryJobProgress } from "@/hooks/use-library-job-stream";
import { apiUrl } from "@/lib/api";

function jobName(job: LibraryJobProgress) {
  return job.jobType === "THUMBNAILS" ? "Thumbnail Generation" : "Library Scan";
}

function JobRow({ job, onRefresh }: { job: LibraryJobProgress; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const paused = job.status === "PAUSED";
  const action = async (kind: "pause" | "resume" | "cancel") => {
    setBusy(true);
    try {
      await fetch(apiUrl(`/library/jobs/${job.jobId}/${kind}`), { method: "POST" });
      onRefresh();
    } finally { setBusy(false); }
  };
  const Icon = job.jobType === "THUMBNAILS" ? ImagePlus : ScanLine;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary shrink-0" />
        <span className="text-sm font-medium flex-1">{jobName(job)}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{job.progress}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${job.progress}%` }} />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{job.filesProcessed.toLocaleString()} / {job.filesTotal.toLocaleString()} files</span>
        <span className="truncate flex-1" title={job.currentPath}>{job.currentPath || formatEta(job.etaSeconds)}</span>
        <button disabled={busy} onClick={() => action(paused ? "resume" : "pause")} className="p-1 hover:text-foreground" title={paused ? "Resume" : "Pause"}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
        </button>
        <button disabled={busy} onClick={() => action("cancel")} className="p-1 hover:text-destructive" title="Cancel">
          <Square className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function BackgroundTasksPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { jobs } = useLibraryJobStream();
  const [, setRefresh] = useState(0);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader><SheetTitle className="font-mono">Background Tasks</SheetTitle></SheetHeader>
        <div className="mt-5 space-y-3">
          {jobs.map(job => <JobRow key={job.jobId} job={job} onRefresh={() => setRefresh(v => v + 1)} />)}
          {jobs.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-3 text-green-500/70" />
              No background tasks are running.
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function BackgroundTasksButton({ onClick, count }: { onClick: () => void; count: number }) {
  return (
    <button onClick={onClick} className="relative p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Background Tasks">
      <Loader2 className={`w-4 h-4 ${count ? "animate-spin text-amber-400" : ""}`} />
      {count > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-primary text-[9px] text-primary-foreground text-center">{count}</span>}
    </button>
  );
}