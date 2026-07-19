import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Image as ImageIcon,
  Video,
  Music,
  FileText,
  File,
  ScanLine,
  Loader2,
  RefreshCw,
  X,
  FolderOpen,
  Folder,
  ChevronRight,
  Search,
  Download,
  ExternalLink,
  Play,
  Pause,
  CheckCircle2,
  AlertCircle,
  Wand2,
  Layers,
  LayoutGrid,
  List,
  MapPin,
  Camera,
  Calendar,
  Aperture,
  Heart,
  Sparkles,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { MediaViewer } from "@/components/media/MediaViewer";
import type { MediaFile, MediaFilesResponse } from "@/types/media";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// ── Types ─────────────────────────────────────────────────────────────────────


interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

interface JobCounters {
  new: number;
  modified: number;
  moved: number;
  unchanged: number;
  deleted: number;
  hashed: number;
  thumbnails: number;
}

interface SkippedFile {
  path: string;
  reason: string;
}

interface JobSummary {
  newFiles: number;
  modifiedFiles: number;
  movedFiles: number;
  deletedFiles: number;
  unchangedFiles: number;
  hashedFiles: number;
  thumbnailsGenerated: number;
  elapsedMs: number;
  previousElapsedMs: number | null;
  skippedFiles?: number;
  skippedList?: SkippedFile[];
  duplicateGroups?: number;
  scanStartedAt?: string;
  categories?: Record<string, number>;
  reprocessedFiles?: number;
}

interface JobActionFile {
  id: number;
  relativePath: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  modifiedAt: string | null;
}

interface DuplicateGroup {
  contentHash: string;
  sizeBytes: number;
  count: number;
  files: { id: number; relativePath: string; name: string; mediaType: string; sizeBytes: number }[];
}

interface ProgressEvent {
  jobId: number;
  status: "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED";
  phase: string;
  profile: string | null;
  progress: number;
  filesProcessed: number;
  filesTotal: number;
  currentPath: string;
  etaSeconds: number | null;
  speed: number;
  counters: JobCounters;
  summary: JobSummary | null;
}

interface LibraryJob {
  id: number;
  jobType: string;
  profile: string | null;
  status: string;
  cancellationReason: string | null;
  nasPath: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalFiles: number | null;
  processedFiles: number;
  summary: JobSummary | null;
  error: string | null;
  createdAt: string;
}

type MediaType = "all" | "photo" | "video" | "audio" | "document" | "other";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const TYPE_TABS: { key: MediaType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "all",      label: "All",       icon: Layers },
  { key: "photo",    label: "Photos",    icon: ImageIcon },
  { key: "video",    label: "Videos",    icon: Video },
  { key: "audio",    label: "Audio",     icon: Music },
  { key: "document", label: "Documents", icon: FileText },
  { key: "other",    label: "Other",     icon: File },
];

function MediaTypeIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case "photo":    return <ImageIcon className={cn("text-blue-400",           className)} />;
    case "video":    return <Video     className={cn("text-purple-400",         className)} />;
    case "audio":    return <Music     className={cn("text-green-400",          className)} />;
    case "document": return <FileText  className={cn("text-amber-400",          className)} />;
    default:         return <File      className={cn("text-muted-foreground",   className)} />;
  }
}

// ── Thumbnail card ────────────────────────────────────────────────────────────

function ThumbnailCard({
  file,
  selected,
  onClick,
  onToggleFavorite,
}: {
  file: MediaFile;
  selected: boolean;
  onClick: () => void;
  onToggleFavorite?: (file: MediaFile) => void;
}) {
  const [thumbError, setThumbError] = useState(false);
  const canThumb = (file.mediaType === "photo" || file.mediaType === "video" || file.extension === "pdf") && !thumbError;

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className={cn(
        "group relative flex flex-col rounded-lg border overflow-hidden text-left transition-all duration-150",
        "bg-card hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary",
        selected ? "ring-2 ring-primary border-primary" : "border-border",
      )}
    >
      <div className="relative w-full aspect-square bg-muted flex items-center justify-center overflow-hidden">
        {canThumb ? (
          <img
            src={`/api/media/thumbnail/${file.id}`}
            alt={file.name}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
            onError={() => setThumbError(true)}
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground p-2">
            <MediaTypeIcon type={file.mediaType} className="w-6 h-6" />
            <span className="text-xs font-mono uppercase">{file.extension || "—"}</span>
          </div>
        )}
        {file.mediaType === "video" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/50 rounded-full p-2">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
          </div>
        )}
        {file.durationSeconds !== null && (
          <span className="absolute bottom-1 right-1 text-[10px] font-mono bg-black/70 text-white px-1 rounded">
            {formatDuration(file.durationSeconds)}
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="text-xs font-mono truncate text-foreground leading-tight" title={file.name}>
          {file.name}
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {formatBytes(file.sizeBytes)}
        </p>
      </div>
      {onToggleFavorite && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(file); }}
          title={file.favorite ? "Remove from favorites" : "Add to favorites"}
          className={cn(
            "absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/50 transition-opacity",
            file.favorite ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <Heart className={cn("w-3.5 h-3.5", file.favorite ? "text-red-400 fill-red-400" : "text-white")} />
        </button>
      )}
    </div>
  );
}

// ── Scan status banner ────────────────────────────────────────────────────────

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatSpeed(filesPerSec: number): string {
  if (filesPerSec < 1) return `${(filesPerSec * 60).toFixed(1)}/min`;
  return `${filesPerSec.toFixed(1)}/s`;
}

type SummaryDetail = "NEW" | "MODIFIED" | "MOVED" | "DELETED" | "SKIPPED" | "DUPLICATES" | null;

function ScanSummaryCard({ summary, jobId, onDismiss }: { summary: JobSummary; jobId: number; onDismiss: () => void }) {
  const elapsed = summary.elapsedMs / 1000;
  const prev    = summary.previousElapsedMs !== null ? summary.previousElapsedMs / 1000 : null;
  const saved   = prev !== null ? prev - elapsed : null;
  const [detail, setDetail] = useState<SummaryDetail>(null);

  const actionFilesQuery = useQuery({
    queryKey: ["library-job-files", jobId, detail],
    enabled: detail !== null && detail !== "SKIPPED" && detail !== "DUPLICATES",
    queryFn: async () => {
      const r = await fetch(`/api/library/jobs/${jobId}/files?action=${detail}&limit=200`);
      if (!r.ok) throw new Error("Failed to load files");
      return r.json() as Promise<{ files: JobActionFile[]; note?: string }>;
    },
  });

  const duplicatesQuery = useQuery({
    queryKey: ["library-duplicates"],
    enabled: detail === "DUPLICATES",
    queryFn: async () => {
      const r = await fetch("/api/library/duplicates");
      if (!r.ok) throw new Error("Failed to load duplicates");
      return r.json() as Promise<{ groups: DuplicateGroup[] }>;
    },
  });

  const toggle = (d: SummaryDetail) => setDetail((cur) => (cur === d ? null : d));
  const countBtn = "underline decoration-dotted underline-offset-2 hover:text-green-100 cursor-pointer";

  return (
    <div className="rounded-lg border border-green-700/40 bg-green-900/20 px-4 py-3 text-sm font-mono text-green-300">
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        <span className="font-semibold">Scan complete</span>
        <span className="text-green-500 ml-1">({(elapsed).toFixed(1)}s)</span>
        {saved !== null && saved > 0.5 && (
          <span className="text-green-400 text-xs ml-1">— saved {saved.toFixed(1)}s vs full scan</span>
        )}
        <button onClick={onDismiss} className="ml-auto text-green-400 hover:text-green-200" data-testid="button-dismiss-summary">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-green-400">
        {summary.newFiles       > 0 && <button className={countBtn} onClick={() => toggle("NEW")} data-testid="button-summary-new">+{summary.newFiles.toLocaleString()} new</button>}
        {summary.modifiedFiles  > 0 && <button className={countBtn} onClick={() => toggle("MODIFIED")} data-testid="button-summary-modified">~{summary.modifiedFiles.toLocaleString()} modified</button>}
        {summary.movedFiles     > 0 && <button className={countBtn} onClick={() => toggle("MOVED")} data-testid="button-summary-moved">→{summary.movedFiles.toLocaleString()} moved</button>}
        {summary.deletedFiles   > 0 && <button className={cn(countBtn, "text-red-400 hover:text-red-200")} onClick={() => toggle("DELETED")} data-testid="button-summary-deleted">✕{summary.deletedFiles.toLocaleString()} deleted</button>}
        {summary.unchangedFiles > 0 && <span className="text-green-600">{summary.unchangedFiles.toLocaleString()} unchanged</span>}
        {summary.thumbnailsGenerated > 0 && <span>{summary.thumbnailsGenerated.toLocaleString()} thumbnails</span>}
        {(summary.skippedFiles ?? 0) > 0 && (
          <button className={cn(countBtn, "text-amber-400 hover:text-amber-200")} onClick={() => toggle("SKIPPED")} data-testid="button-summary-skipped">
            ⚠{summary.skippedFiles!.toLocaleString()} skipped
          </button>
        )}
        {(summary.duplicateGroups ?? 0) > 0 && (
          <button className={cn(countBtn, "text-cyan-400 hover:text-cyan-200")} onClick={() => toggle("DUPLICATES")} data-testid="button-summary-duplicates">
            ⧉{summary.duplicateGroups!.toLocaleString()} duplicate group{summary.duplicateGroups! > 1 ? "s" : ""}
          </button>
        )}
        {(summary.reprocessedFiles ?? 0) > 0 && <span>{summary.reprocessedFiles!.toLocaleString()} re-processed</span>}
      </div>

      {summary.categories && Object.keys(summary.categories).length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-green-600 mt-1.5">
          {Object.entries(summary.categories)
            .sort((a, b) => b[1] - a[1])
            .map(([type, n]) => (
              <span key={type} className="capitalize">{type}s: {n.toLocaleString()}</span>
            ))}
        </div>
      )}

      {/* ── Expandable detail: files behind a count ── */}
      {detail !== null && detail !== "SKIPPED" && detail !== "DUPLICATES" && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded border border-green-800/40 bg-black/20 p-2 text-xs space-y-0.5" data-testid="panel-summary-files">
          {actionFilesQuery.isLoading && <span className="text-green-600">Loading…</span>}
          {actionFilesQuery.data?.note && <span className="text-green-600">{actionFilesQuery.data.note}</span>}
          {actionFilesQuery.data?.files.map((f) => (
            <div key={f.id} className="flex items-center gap-2 text-green-400/90">
              <span className="truncate flex-1" title={f.relativePath}>{f.relativePath}</span>
              <span className="text-green-700 shrink-0">{formatBytes(f.sizeBytes)}</span>
            </div>
          ))}
          {actionFilesQuery.data && actionFilesQuery.data.files.length === 0 && !actionFilesQuery.data.note && (
            <span className="text-green-600">No files to show.</span>
          )}
        </div>
      )}

      {/* ── Expandable detail: skipped files with plain-English reasons ── */}
      {detail === "SKIPPED" && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded border border-amber-800/40 bg-black/20 p-2 text-xs space-y-0.5" data-testid="panel-summary-skipped">
          {(summary.skippedList ?? []).map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="truncate flex-1 text-amber-300/90" title={s.path}>{s.path}</span>
              <span className="text-amber-500 shrink-0">{s.reason}</span>
            </div>
          ))}
          {(summary.skippedFiles ?? 0) > (summary.skippedList?.length ?? 0) && (
            <div className="text-amber-600 pt-1">
              …and {(summary.skippedFiles! - (summary.skippedList?.length ?? 0)).toLocaleString()} more
            </div>
          )}
          {(summary.skippedList ?? []).length === 0 && <span className="text-amber-600">No details recorded.</span>}
        </div>
      )}

      {/* ── Expandable detail: duplicate groups ── */}
      {detail === "DUPLICATES" && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded border border-cyan-800/40 bg-black/20 p-2 text-xs space-y-2" data-testid="panel-summary-duplicates">
          <div className="text-cyan-600">Current duplicates across the whole library:</div>
          {duplicatesQuery.isLoading && <span className="text-cyan-600">Loading…</span>}
          {duplicatesQuery.data?.groups.map((g) => (
            <div key={g.contentHash} className="space-y-0.5">
              <div className="text-cyan-400 font-semibold">
                {g.count} identical files · {formatBytes(g.sizeBytes)} each
              </div>
              {g.files.map((f) => (
                <div key={f.id} className="pl-3 text-cyan-300/80 truncate" title={f.relativePath}>{f.relativePath}</div>
              ))}
            </div>
          ))}
          {duplicatesQuery.data && duplicatesQuery.data.groups.length === 0 && (
            <span className="text-cyan-600">No duplicates found.</span>
          )}
        </div>
      )}
    </div>
  );
}

function ScanBanner({
  progress,
  onDismiss,
  onPause,
  onResume,
  onCancel,
}: {
  progress: ProgressEvent | null;
  onDismiss: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  if (!progress) return null;

  if (progress.status === "DONE" && progress.summary) {
    return <ScanSummaryCard summary={progress.summary} jobId={progress.jobId} onDismiss={onDismiss} />;
  }

  if (progress.status === "DONE") {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-green-900/30 border border-green-700/40 rounded-lg text-sm text-green-300 font-mono">
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        <span>Scan complete — {progress.filesProcessed.toLocaleString()} files processed.</span>
        <button onClick={onDismiss} className="ml-auto text-green-400 hover:text-green-200">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  if (progress.status === "FAILED" || progress.status === "CANCELLED") {
    const color = progress.status === "CANCELLED" ? "amber" : "red";
    return (
      <div className={`flex items-center gap-2 px-4 py-2 bg-${color}-900/30 border border-${color}-700/40 rounded-lg text-sm text-${color}-300 font-mono`}>
        <AlertCircle className="w-4 h-4 shrink-0" />
        <span>{progress.status === "CANCELLED" ? "Scan cancelled." : `Scan failed.`}</span>
        <button onClick={onDismiss} className="ml-auto">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  const pct  = Math.round(progress.progress * 100);
  const isPaused = progress.status === "PAUSED";

  return (
    <div className="rounded-lg border border-blue-700/40 bg-blue-900/20 px-4 py-3 space-y-2 font-mono text-sm">
      {/* Top row */}
      <div className="flex items-center gap-2 text-blue-300">
        {isPaused
          ? <span className="text-amber-400 font-semibold text-xs uppercase tracking-wide">Paused</span>
          : <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
        }
        <span className="truncate flex-1 text-xs text-blue-400" title={progress.currentPath}>
          {progress.phase}{progress.currentPath ? ` — ${progress.currentPath.split("/").pop()}` : ""}
        </span>
        <span className="text-xs text-blue-500 shrink-0">
          {progress.filesProcessed.toLocaleString()}
          {progress.filesTotal > 0 ? ` / ${progress.filesTotal.toLocaleString()}` : ""} files
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-blue-900/50 rounded-full h-1.5">
        <div
          className="bg-blue-400 h-1.5 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-xs text-blue-400">
        <span>{pct}%</span>
        {progress.etaSeconds !== null && progress.etaSeconds > 0 && (
          <span>ETA {formatEta(progress.etaSeconds)}</span>
        )}
        {progress.speed > 0 && <span>{formatSpeed(progress.speed)}</span>}
        <div className="flex gap-2 ml-auto">
          {progress.counters.new       > 0 && <span className="text-green-400">+{progress.counters.new}</span>}
          {progress.counters.modified  > 0 && <span className="text-yellow-400">~{progress.counters.modified}</span>}
          {progress.counters.moved     > 0 && <span className="text-cyan-400">→{progress.counters.moved}</span>}
          {progress.counters.deleted   > 0 && <span className="text-red-400">✕{progress.counters.deleted}</span>}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 pt-0.5">
        {isPaused ? (
          <button onClick={onResume} className="text-xs text-blue-300 hover:text-blue-100 flex items-center gap-1">
            <Play className="w-3 h-3" /> Resume
          </button>
        ) : (
          <button onClick={onPause} className="text-xs text-blue-400 hover:text-blue-200 flex items-center gap-1">
            <Pause className="w-3 h-3" /> Pause
          </button>
        )}
        <button onClick={onCancel} className="text-xs text-red-400 hover:text-red-200 flex items-center gap-1 ml-2">
          <X className="w-3 h-3" /> Cancel
        </button>
      </div>
    </div>
  );
}

// ── Detail panel helpers ───────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest mb-0.5">{label}</p>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <p className="text-[10px] font-mono font-semibold text-muted-foreground/60 uppercase tracking-widest border-b border-border pb-1">{title}</p>
      {children}
    </div>
  );
}

function cameraLabel(make: string | null, model: string | null): string | null {
  if (!make && !model) return null;
  if (!make) return model;
  if (!model) return make;
  // Avoid duplicating make in model (e.g. "Apple iPhone 15 Pro" vs "Apple" + "iPhone 15 Pro")
  return model.startsWith(make) ? model : `${make} ${model}`;
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({ file, onClose }: { file: MediaFile; onClose: () => void }) {
  const camera = cameraLabel(file.cameraMake, file.cameraModel);
  const hasGps = file.gpsLatitude != null && file.gpsLongitude != null;
  const mapsUrl = hasGps
    ? `https://www.google.com/maps?q=${file.gpsLatitude},${file.gpsLongitude}`
    : null;

  return (
    <div className="flex flex-col h-full border-l border-border bg-card w-72 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <span className="text-xs font-mono font-semibold text-muted-foreground uppercase tracking-widest">Details</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Thumbnail */}
      <div className="w-full aspect-square bg-muted flex items-center justify-center overflow-hidden border-b border-border shrink-0">
        {(file.mediaType === "photo" || file.mediaType === "video" || file.extension === "pdf") ? (
          <img
            src={`/api/media/thumbnail/${file.id}`}
            alt={file.name}
            loading="lazy"
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <MediaTypeIcon type={file.mediaType} className="w-10 h-10" />
            <span className="text-xs font-mono uppercase">{file.extension || "file"}</span>
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ── File info ── */}
        <DetailSection title="File">
          <DetailRow label="Name" value={<span className="break-all">{file.name}</span>} />
          <DetailRow label="Path" value={<span className="text-xs text-muted-foreground font-mono break-all">{file.relativePath}</span>} />
          <div className="grid grid-cols-2 gap-2.5">
            <DetailRow label="Size" value={formatBytes(file.sizeBytes)} />
            <DetailRow
              label="Type"
              value={
                <div className="flex items-center gap-1">
                  <MediaTypeIcon type={file.mediaType} className="w-3.5 h-3.5" />
                  <span className="capitalize">{file.mediaType}</span>
                </div>
              }
            />
            {file.extension && (
              <DetailRow label="Format" value={
                <Badge variant="outline" className="font-mono text-xs uppercase">.{file.extension}</Badge>
              } />
            )}
          </div>
        </DetailSection>

        {/* ── Photo EXIF ── */}
        {file.mediaType === "photo" && (
          <DetailSection title="Photo">
            <div className="grid grid-cols-2 gap-2.5">
              {file.width != null && file.height != null && (
                <DetailRow label="Resolution" value={`${file.width} × ${file.height}`} />
              )}
              {file.dateTaken && (
                <DetailRow
                  label="Date Taken"
                  value={
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-muted-foreground shrink-0" />
                      {formatDate(file.dateTaken)}
                    </span>
                  }
                />
              )}
              {file.modifiedAt && (
                <DetailRow label="Modified" value={formatDate(file.modifiedAt)} />
              )}
            </div>

            {camera && (
              <DetailRow
                label="Camera"
                value={
                  <span className="flex items-center gap-1">
                    <Camera className="w-3 h-3 text-muted-foreground shrink-0" />
                    {camera}
                  </span>
                }
              />
            )}
            {file.lens && <DetailRow label="Lens" value={file.lens} />}

            {(file.iso != null || file.aperture != null || file.exposure || file.focalLength != null) && (
              <div className="grid grid-cols-2 gap-2.5">
                {file.iso != null && <DetailRow label="ISO" value={`ISO ${file.iso}`} />}
                {file.aperture != null && (
                  <DetailRow
                    label="Aperture"
                    value={
                      <span className="flex items-center gap-1">
                        <Aperture className="w-3 h-3 text-muted-foreground shrink-0" />
                        {`ƒ/${file.aperture % 1 === 0 ? file.aperture : file.aperture.toFixed(1)}`}
                      </span>
                    }
                  />
                )}
                {file.exposure && <DetailRow label="Exposure" value={file.exposure} />}
                {file.focalLength != null && <DetailRow label="Focal Length" value={`${file.focalLength}mm`} />}
              </div>
            )}

            {file.flash && <DetailRow label="Flash" value={file.flash} />}
            {file.colorProfile && <DetailRow label="Color Profile" value={file.colorProfile} />}

            {hasGps && (
              <DetailRow
                label="GPS Location"
                value={
                  <a
                    href={mapsUrl!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline"
                  >
                    <MapPin className="w-3 h-3 shrink-0" />
                    {file.gpsLatitude!.toFixed(5)}, {file.gpsLongitude!.toFixed(5)}
                  </a>
                }
              />
            )}
          </DetailSection>
        )}

        {/* ── Video ── */}
        {file.mediaType === "video" && (
          <DetailSection title="Video">
            <div className="grid grid-cols-2 gap-2.5">
              {file.width != null && file.height != null && (
                <DetailRow label="Resolution" value={`${file.width} × ${file.height}`} />
              )}
              {file.durationSeconds != null && (
                <DetailRow label="Duration" value={formatDuration(file.durationSeconds)} />
              )}
              {file.fps != null && (
                <DetailRow label="FPS" value={`${file.fps} fps`} />
              )}
              {file.videoCodec && (
                <DetailRow label="Video Codec" value={<span className="font-mono uppercase">{file.videoCodec}</span>} />
              )}
              {file.audioCodec && (
                <DetailRow label="Audio Codec" value={<span className="font-mono uppercase">{file.audioCodec}</span>} />
              )}
              {file.videoBitrate != null && (
                <DetailRow label="Bitrate" value={`${file.videoBitrate} kbps`} />
              )}
              {(file.dateCreated || file.modifiedAt) && (
                <DetailRow label="Date Created" value={formatDate(file.dateCreated ?? file.modifiedAt)} />
              )}
            </div>
          </DetailSection>
        )}

        {/* ── Audio ── */}
        {file.mediaType === "audio" && file.durationSeconds != null && (
          <DetailSection title="Audio">
            <div className="grid grid-cols-2 gap-2.5">
              <DetailRow label="Duration" value={formatDuration(file.durationSeconds)} />
              {file.modifiedAt && <DetailRow label="Modified" value={formatDate(file.modifiedAt)} />}
            </div>
          </DetailSection>
        )}

        {/* ── PDF ── */}
        {file.extension === "pdf" && (
          <DetailSection title="Document">
            <div className="grid grid-cols-2 gap-2.5">
              {file.pageCount != null && <DetailRow label="Pages" value={`${file.pageCount}`} />}
              {file.modifiedAt && <DetailRow label="Modified" value={formatDate(file.modifiedAt)} />}
            </div>
            {file.pdfTitle   && <DetailRow label="Title"    value={file.pdfTitle} />}
            {file.pdfAuthor  && <DetailRow label="Author"   value={file.pdfAuthor} />}
            {file.pdfSubject && <DetailRow label="Subject"  value={file.pdfSubject} />}
            {file.pdfKeywords && <DetailRow label="Keywords" value={<span className="text-xs text-muted-foreground">{file.pdfKeywords}</span>} />}
          </DetailSection>
        )}

        {/* ── Dates (fallback for non-photo/video/pdf) ── */}
        {file.mediaType !== "photo" && file.mediaType !== "video" && file.extension !== "pdf" && (
          <DetailSection title="Dates">
            <div className="grid grid-cols-2 gap-2.5">
              {file.modifiedAt && <DetailRow label="Modified" value={formatDate(file.modifiedAt)} />}
              <DetailRow label="Indexed" value={formatDate(file.indexedAt)} />
            </div>
          </DetailSection>
        )}

        {/* Indexed at — always shown at bottom */}
        <DetailRow label="Indexed" value={<span className="text-xs text-muted-foreground">{formatDate(file.indexedAt)}</span>} />
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border space-y-2 shrink-0">
        <Link href={`/media/${file.id}`}>
          <Button variant="default" size="sm" className="w-full gap-2 font-mono text-xs" data-testid="button-open-detail">
            <Sparkles className="w-3.5 h-3.5" />
            Open Detail Page
          </Button>
        </Link>
        <a href={`/api/media/file/${file.id}/stream`} download={file.name}>
          <Button variant="outline" size="sm" className="w-full gap-2 font-mono text-xs">
            <Download className="w-3.5 h-3.5" />
            Download
          </Button>
        </a>
        <a href={`/api/media/file/${file.id}/stream`} target="_blank" rel="noopener noreferrer">
          <Button variant="ghost" size="sm" className="w-full gap-2 font-mono text-xs">
            <ExternalLink className="w-3.5 h-3.5" />
            Open Original
          </Button>
        </a>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

// ── Collapsible folder tree node ──────────────────────────────────────────────

function FolderTreeNode({
  node,
  depth,
  selectedFolder,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  selectedFolder: string | null;
  onSelect: (path: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(
    () => selectedFolder !== null && selectedFolder.startsWith(node.path),
  );
  const hasChildren = node.children.length > 0;
  const isSelected  = selectedFolder === node.path;
  const indent      = depth * 12;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-1.5 text-xs font-mono transition-colors cursor-pointer select-none",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        {/* Expand/collapse chevron */}
        <button
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((v) => !v); }}
          className="shrink-0 w-4 h-4 flex items-center justify-center"
        >
          {hasChildren ? (
            <ChevronRight className={cn("w-3 h-3 transition-transform", expanded && "rotate-90")} />
          ) : (
            <span className="w-3" />
          )}
        </button>

        {/* Folder icon + name — clicking selects */}
        <button
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          onClick={() => onSelect(isSelected ? null : node.path)}
        >
          {isSelected ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0 text-primary" />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFolder={selectedFolder}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onScan, isScanning }: { onScan: () => void; isScanning: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
        <ImageIcon className="w-8 h-8 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-lg font-semibold font-mono mb-2">No Media Indexed</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Scan your NAS library to discover and index photos, videos, audio, and documents.
          Thumbnails are generated on-demand as you browse.
        </p>
      </div>
      <Button onClick={onScan} disabled={isScanning} className="gap-2 font-mono">
        {isScanning ? (
          <><Loader2 className="w-4 h-4 animate-spin" />Scanning…</>
        ) : (
          <><ScanLine className="w-4 h-4" />Scan Your Library</>
        )}
      </Button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Media() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeType, setActiveType]   = useState<MediaType>("all");
  const [search, setSearch]           = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedFolder, setSelectedFolder]   = useState<string | null>(null);
  const [selectedFile, setSelectedFile]       = useState<MediaFile | null>(null);
  const [viewerIndex,  setViewerIndex]        = useState<number | null>(null);
  const [page, setPage]               = useState(1);
  const [sort, setSort]               = useState("indexed_desc");
  const [viewMode, setViewMode]       = useState<"grid" | "list">("grid");

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LIMIT = 60;

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(search), 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  useEffect(() => { setPage(1); }, [activeType, debouncedSearch, selectedFolder]);

  // ── Data queries ────────────────────────────────────────────────────────────

  const foldersQuery = useQuery({
    queryKey: ["media-folders"],
    queryFn: async () => {
      const r = await fetch("/api/media/folders");
      if (!r.ok) throw new Error("Failed to load folders");
      return r.json() as Promise<{ tree: FolderNode[] }>;
    },
  });

  const filesQuery = useQuery({
    queryKey: ["media-files", activeType, debouncedSearch, selectedFolder, page, sort],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(LIMIT), page: String(page), sort });
      if (activeType !== "all") params.set("mediaType", activeType);
      if (debouncedSearch)      params.set("search", debouncedSearch);
      if (selectedFolder)       params.set("folder", selectedFolder);
      const r = await fetch(`/api/media/files?${params}`);
      if (!r.ok) throw new Error("Failed to load media files");
      return r.json() as Promise<MediaFilesResponse>;
    },
  });

  // ── Library job progress (active job) ──────────────────────────────────────

  const [dismissedProgress, setDismissedProgress] = useState<boolean>(false);

  const activeJobQuery = useQuery({
    queryKey: ["library-active-job"],
    queryFn: async () => {
      const r = await fetch("/api/library/jobs/active");
      if (!r.ok) throw new Error("Failed to load active job");
      return r.json() as Promise<ProgressEvent | null>;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "RUNNING" || status === "PAUSED" ? 1000 : false;
    },
  });

  const prevActiveStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = activeJobQuery.data?.status;
    if (prevActiveStatus.current !== "DONE" && status === "DONE") {
      queryClient.invalidateQueries({ queryKey: ["media-files"] });
      queryClient.invalidateQueries({ queryKey: ["media-folders"] });
      queryClient.invalidateQueries({ queryKey: ["library-jobs"] });
      setDismissedProgress(false);
    }
    if (status) prevActiveStatus.current = status;
  }, [activeJobQuery.data?.status, queryClient]);

  // ── Scan mutation ───────────────────────────────────────────────────────────

  const scanMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/library/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: "QUICK" }) });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as any).error ?? "Scan failed");
      }
      return r.json();
    },
    onSuccess: () => {
      setDismissedProgress(false);
      queryClient.invalidateQueries({ queryKey: ["library-active-job"] });
    },
    onError: (err: Error) => {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async (jobId: number) => {
      await fetch(`/api/library/jobs/${jobId}/pause`, { method: "POST" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["library-active-job"] }),
  });

  const resumeMutation = useMutation({
    mutationFn: async (jobId: number) => {
      await fetch(`/api/library/jobs/${jobId}/resume`, { method: "POST" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["library-active-job"] }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (jobId: number) => {
      await fetch(`/api/library/jobs/${jobId}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "USER_CANCELLED" }) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["library-active-job"] });
      queryClient.invalidateQueries({ queryKey: ["library-jobs"] });
    },
  });

  const favoriteMutation = useMutation({
    mutationFn: async ({ id, favorite }: { id: number; favorite: boolean }) => {
      const r = await fetch(`/api/media/files/${id}/favorite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorite }),
      });
      if (!r.ok) throw new Error("Failed to update favorite");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-files"] });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      queryClient.invalidateQueries({ queryKey: ["favorite-files"] });
    },
    onError: (err: Error) => {
      toast({ title: "Favorite failed", description: err.message, variant: "destructive" });
    },
  });

  const thumbnailsMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/library/thumbnails", { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: "Unknown error" }));
        throw new Error((body as any).error ?? "Thumbnail job failed");
      }
      return r.json();
    },
    onSuccess: () => {
      setDismissedProgress(false);
      queryClient.invalidateQueries({ queryKey: ["library-active-job"] });
    },
    onError: (err: Error) => {
      toast({ title: "Thumbnail job failed", description: err.message, variant: "destructive" });
    },
  });

  const activeProgress = activeJobQuery.data ?? null;
  const activeStatus   = activeProgress?.status;
  const isScanning     = activeStatus === "RUNNING" || activeStatus === "PAUSED" || scanMutation.isPending || thumbnailsMutation.isPending;
  const showBanner     = activeProgress !== null && !dismissedProgress;

  // ── Library sequence polling (incremental live updates during scan) ──────────
  // Polls GET /api/library/seq every 2 s while a scan is running.
  // When the seq counter changes it means new rows have been flushed to the DB;
  // we invalidate media-files so the grid re-fetches without a full page reload.
  // React reconciles by key={file.id} so existing cards stay mounted in-place —
  // scroll position is preserved and individual thumbnails are not unmounted.

  const seqQuery = useQuery({
    queryKey: ["library-seq"],
    queryFn: async () => {
      const r = await fetch("/api/library/seq");
      if (!r.ok) throw new Error("Failed to fetch seq");
      return r.json() as Promise<{ seq: number; total: number }>;
    },
    refetchInterval: isScanning ? 2000 : false,
  });

  const prevSeq = useRef<number | null>(null);
  useEffect(() => {
    const seq = seqQuery.data?.seq;
    if (seq === undefined) return;
    if (prevSeq.current !== null && seq !== prevSeq.current) {
      queryClient.invalidateQueries({ queryKey: ["media-files"] });
      queryClient.invalidateQueries({ queryKey: ["media-folders"] });
    }
    prevSeq.current = seq;
  }, [seqQuery.data?.seq, queryClient]);

  const files      = filesQuery.data?.files ?? [];
  const total      = filesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const folderTree = foldersQuery.data?.tree ?? [];
  const hasFolders = folderTree.length > 0;

  const handleScan = useCallback(() => {
    scanMutation.mutate();
  }, [scanMutation]);

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Top toolbar ── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0 flex-wrap">
        <h2 className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-widest">
          Media Center
        </h2>

        <div className="flex-1 min-w-0" />

        {/* Search */}
        <div className="relative w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="pl-8 h-8 text-xs font-mono"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Sort */}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="h-8 text-xs font-mono bg-background border border-border rounded-md px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="indexed_desc">Newest indexed</option>
          <option value="modified_desc">Recently modified</option>
          <option value="modified_asc">Oldest modified</option>
          <option value="name_asc">Name A–Z</option>
          <option value="name_desc">Name Z–A</option>
          <option value="size_desc">Largest first</option>
          <option value="size_asc">Smallest first</option>
        </select>

        {/* Scan button */}
        <Button
          size="sm"
          variant={isScanning ? "ghost" : "default"}
          onClick={handleScan}
          disabled={isScanning}
          className="gap-2 font-mono text-xs h-8"
        >
          {isScanning && scanMutation.isPending ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" />Scanning…</>
          ) : (
            <><ScanLine className="w-3.5 h-3.5" />Scan Library</>
          )}
        </Button>

        {/* Thumbnails button */}
        <Button
          size="sm"
          variant="outline"
          onClick={() => thumbnailsMutation.mutate()}
          disabled={isScanning}
          className="gap-2 font-mono text-xs h-8"
          title="Generate thumbnails for all photos, videos and PDFs missing one"
        >
          {thumbnailsMutation.isPending ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" />Starting…</>
          ) : (
            <><Wand2 className="w-3.5 h-3.5" />Gen Thumbnails</>
          )}
        </Button>

        {/* View mode toggle */}
        <div className="flex items-center border border-border rounded-md overflow-hidden">
          <button
            onClick={() => setViewMode("grid")}
            className={cn(
              "h-8 w-8 flex items-center justify-center transition-colors",
              viewMode === "grid" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            title="Grid view"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={cn(
              "h-8 w-8 flex items-center justify-center transition-colors",
              viewMode === "list" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            title="List view"
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ["media-files"] });
            queryClient.invalidateQueries({ queryKey: ["library-active-job"] });
          }}
          className="h-8 w-8 p-0"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* ── Scan banner ── */}
      {showBanner && (
        <div className="px-4 pt-2 shrink-0">
          <ScanBanner
            progress={activeProgress}
            onDismiss={() => setDismissedProgress(true)}
            onPause={() => activeProgress && pauseMutation.mutate(activeProgress.jobId)}
            onResume={() => activeProgress && resumeMutation.mutate(activeProgress.jobId)}
            onCancel={() => activeProgress && cancelMutation.mutate(activeProgress.jobId)}
          />
        </div>
      )}

      {/* ── Type tabs ── */}
      <div className="flex items-center gap-1 px-4 pt-2 border-b border-border shrink-0 overflow-x-auto">
        {TYPE_TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveType(key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-mono rounded-t-md border-b-2 transition-colors whitespace-nowrap",
              activeType === key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Folder sidebar ── */}
        {hasFolders && (
          <div className="w-52 shrink-0 border-r border-border overflow-y-auto py-2">
            <div className="px-3 py-1">
              <span className="text-[10px] font-mono font-semibold text-muted-foreground uppercase tracking-widest">
                Folders
              </span>
            </div>
            {/* All files entry */}
            <button
              onClick={() => setSelectedFolder(null)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono transition-colors",
                selectedFolder === null
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Layers className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">All files</span>
            </button>
            {/* Recursive tree */}
            {folderTree.map((node) => (
              <FolderTreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedFolder={selectedFolder}
                onSelect={setSelectedFolder}
              />
            ))}
          </div>
        )}

        {/* ── Main grid ── */}
        <div className="flex-1 overflow-y-auto">
          {filesQuery.isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : files.length === 0 && total === 0 && !debouncedSearch && activeType === "all" && !selectedFolder ? (
            <EmptyState onScan={handleScan} isScanning={isScanning} />
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-20">
              <Search className="w-8 h-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground font-mono">No files match your filters.</p>
              <Button
                variant="ghost"
                size="sm"
                className="font-mono text-xs"
                onClick={() => { setSearch(""); setActiveType("all"); setSelectedFolder(null); }}
              >
                Clear Filters
              </Button>
            </div>
          ) : (
            <div className="p-4 space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
                  {total.toLocaleString()} file{total !== 1 ? "s" : ""}
                  {debouncedSearch ? ` matching "${debouncedSearch}"` : ""}
                  {selectedFolder ? ` in /${selectedFolder}` : ""}
                </span>
                {isScanning && (
                  <span className="flex items-center gap-1 text-[10px] font-mono text-blue-400 animate-pulse" title="A scan is running — new files will appear automatically">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Syncing…
                  </span>
                )}
                {totalPages > 1 && (
                  <span className="text-xs text-muted-foreground font-mono ml-auto">
                    Page {page} of {totalPages}
                  </span>
                )}
              </div>

              {viewMode === "grid" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3">
                  {files.map((file, i) => (
                    <ThumbnailCard
                      key={file.id}
                      file={file}
                      selected={selectedFile?.id === file.id}
                      onClick={() => { setViewerIndex(i); setSelectedFile(file); }}
                      onToggleFavorite={(f) => favoriteMutation.mutate({ id: f.id, favorite: !f.favorite })}
                    />
                  ))}
                </div>
              ) : (
                <div className="border border-border rounded-md overflow-hidden">
                  <table className="w-full text-xs font-mono">
                    <thead className="bg-muted/50 border-b border-border">
                      <tr>
                        <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider">Name</th>
                        <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider w-24">Type</th>
                        <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider w-20 hidden sm:table-cell">Size</th>
                        <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider w-24 hidden md:table-cell">Dimensions</th>
                        <th className="text-left px-3 py-2 text-muted-foreground font-semibold uppercase tracking-wider w-28 hidden lg:table-cell">Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((file, i) => (
                        <tr
                          key={file.id}
                          onClick={() => { setViewerIndex(i); setSelectedFile(file); }}
                          className={cn(
                            "cursor-pointer border-b border-border last:border-0 transition-colors",
                            i % 2 === 0 ? "bg-card" : "bg-muted/20",
                            selectedFile?.id === file.id ? "bg-accent" : "hover:bg-accent/50",
                          )}
                        >
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <MediaTypeIcon type={file.mediaType} className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate max-w-[200px] sm:max-w-[280px] md:max-w-xs lg:max-w-sm">{file.name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 capitalize text-muted-foreground">{file.mediaType}</td>
                          <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">{formatBytes(file.sizeBytes)}</td>
                          <td className="px-3 py-2 text-muted-foreground hidden md:table-cell">
                            {file.width && file.height
                              ? `${file.width}×${file.height}`
                              : file.durationSeconds != null
                              ? formatDuration(file.durationSeconds)
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground hidden lg:table-cell">{formatDate(file.modifiedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="font-mono text-xs h-8"
                  >
                    ← Prev
                  </Button>
                  <span className="text-xs text-muted-foreground font-mono px-2">
                    {page} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="font-mono text-xs h-8"
                  >
                    Next →
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Detail panel ── */}
        {selectedFile && viewerIndex === null && (
          <DetailPanel file={selectedFile} onClose={() => setSelectedFile(null)} />
        )}
      </div>

      {/* ── Immersive viewer ── */}
      {viewerIndex !== null && files.length > 0 && (
        <MediaViewer
          files={files}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onFavoriteChange={(id, fav) => {
            favoriteMutation.mutate({ id, favorite: fav });
          }}
          onDelete={() => {
            queryClient.invalidateQueries({ queryKey: ["media-files"] });
            setViewerIndex(null);
          }}
        />
      )}
    </div>
  );
}
