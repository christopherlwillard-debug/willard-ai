import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Zap, Shield, CheckCircle2, SkipForward, ScanLine,
  Sparkles, TrendingDown, AlertTriangle, ChevronDown, ChevronRight,
  Download, RotateCcw, ArrowRight, FileBox, Play, X, CheckCheck,
  FolderOpen,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ── Types ─────────────────────────────────────────────────────────────────────

type FormatStatus  = "protected" | "optimal" | "convert" | "skip";
type QualityLoss   = "none" | "minimal" | "moderate" | "high";
type MediaCategory = "image" | "video" | "audio" | "document" | "other";

interface SampleFile {
  path:                string;
  sizeBytes:           number;
  estimatedAfterBytes: number;
}

interface FormatGroup {
  extension:             string;
  fileCount:             number;
  totalBytes:            number;
  category:              MediaCategory;
  status:                FormatStatus;
  targetFormat:          string | null;
  qualityLoss:           QualityLoss | null;
  estimatedSavingsBytes: number;
  estimatedSavingsRatio: number | null;
  reason:                string;
  sampleFiles:           SampleFile[];
}

interface ScanResult {
  scannedAt:         string;
  nasPath:           string;
  totalFiles:        number;
  totalBytes:        number;
  totalSavingsBytes: number;
  groups:            FormatGroup[];
}

type ConversionFileStatus = "success" | "failed" | "skipped";

interface ConversionFileResult {
  filePath:       string;
  destPath?:      string;
  status:         ConversionFileStatus;
  originalBytes?: number;
  convertedBytes?: number;
  savedBytes?:    number;
  error?:         string;
}

interface ConversionProgress {
  stage:       string;
  message:     string;
  progress:    number;
  processed?:  number;
  total?:      number;
  currentFile?: string;
}

interface ConversionSummary {
  totalFiles:      number;
  succeeded:       number;
  failed:          number;
  skipped:         number;
  totalSavedBytes: number;
  backupDir:       string;
  results:         ConversionFileResult[];
}

// ── Helper: status badges ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: FormatStatus }) {
  const map: Record<FormatStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive"; icon: React.ReactNode }> = {
    convert:   { label: "Convert",   variant: "default",     icon: <Zap className="w-3 h-3" /> },
    protected: { label: "Protected", variant: "destructive", icon: <Shield className="w-3 h-3" /> },
    optimal:   { label: "Optimal",   variant: "secondary",   icon: <CheckCircle2 className="w-3 h-3" /> },
    skip:      { label: "Skip",      variant: "outline",     icon: <SkipForward className="w-3 h-3" /> },
  };
  const { label, variant, icon } = map[status];
  return (
    <Badge variant={variant} className="flex items-center gap-1 text-[10px] font-mono">
      {icon}{label}
    </Badge>
  );
}

function QualityBadge({ loss }: { loss: QualityLoss | null }) {
  if (!loss) return null;
  const map: Record<QualityLoss, { label: string; cls: string }> = {
    none:     { label: "No Loss",  cls: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
    minimal:  { label: "Minimal",  cls: "text-blue-400 bg-blue-400/10 border-blue-400/20" },
    moderate: { label: "Moderate", cls: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
    high:     { label: "High",     cls: "text-red-400 bg-red-400/10 border-red-400/20" },
  };
  const { label, cls } = map[loss];
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>{label}</span>
  );
}

function CategoryIcon({ cat }: { cat: MediaCategory }) {
  const icons: Record<MediaCategory, string> = {
    image: "🖼", video: "🎬", audio: "🎵", document: "📄", other: "📁",
  };
  return <span className="text-base">{icons[cat]}</span>;
}

// ── Summary stat cards ────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{label}</p>
            <p className="text-2xl font-bold font-mono mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground font-mono mt-0.5">{sub}</p>}
          </div>
          <div className="text-muted-foreground mt-0.5">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Before/After size preview ─────────────────────────────────────────────────

function SizePreview({ group }: { group: FormatGroup }) {
  if (!group.sampleFiles || group.sampleFiles.length === 0) return null;
  const ratio = group.estimatedSavingsRatio ?? 0;
  return (
    <div className="mt-2 space-y-1">
      <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-1.5">
        Size preview — largest files in this format:
      </p>
      {group.sampleFiles.map((f, i) => {
        const saved = f.sizeBytes - f.estimatedAfterBytes;
        const pct   = f.sizeBytes > 0 ? Math.round((saved / f.sizeBytes) * 100) : 0;
        const name  = f.path.split("/").pop() ?? f.path;
        return (
          <div key={i} className="flex items-center gap-2 text-xs font-mono">
            <FileBox className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground truncate max-w-[220px]" title={f.path}>{name}</span>
            <span className="text-foreground whitespace-nowrap">{formatBytes(f.sizeBytes)}</span>
            <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="text-emerald-400 whitespace-nowrap">
              ~{formatBytes(f.estimatedAfterBytes)}
              <span className="text-muted-foreground ml-1">({pct}% smaller)</span>
            </span>
          </div>
        );
      })}
      {ratio > 0 && (
        <p className="text-[10px] font-mono text-muted-foreground pt-1 border-t border-border/30 mt-1">
          Estimate based on typical {Math.round(ratio * 100)}% compression ratio for {group.extension.toUpperCase()} → {group.targetFormat ?? "target format"}.
          Actual results vary by content.
        </p>
      )}
    </div>
  );
}

// ── Run Conversions dialog ────────────────────────────────────────────────────

function RunConversionsDialog({
  open,
  onClose,
  groups,
  approvedExts,
}: {
  open: boolean;
  onClose: () => void;
  groups: FormatGroup[];
  approvedExts: Set<string>;
}) {
  const { toast } = useToast();
  const [backupDir, setBackupDir] = useState("");
  const [phase, setPhase] = useState<"config" | "running" | "done">("config");
  const [progress, setProgress] = useState<ConversionProgress | null>(null);
  const [fileResults, setFileResults] = useState<ConversionFileResult[]>([]);
  const [summary, setSummary]         = useState<ConversionSummary | null>(null);
  const [runError, setRunError]       = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const approved = groups.filter(g => approvedExts.has(g.extension));
  const totalSavings = approved.reduce((s, g) => s + g.estimatedSavingsBytes, 0);

  function handleClose() {
    if (phase === "running") return; // prevent closing while running
    esRef.current?.close();
    esRef.current = null;
    setPhase("config");
    setProgress(null);
    setFileResults([]);
    setSummary(null);
    setRunError(null);
    onClose();
  }

  async function startConversion() {
    setRunError(null);
    try {
      const resp = await fetch("/api/optimize/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvedExts: approved.map(g => g.extension),
          backupDir: backupDir.trim() || undefined,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setRunError((body as any).error ?? "Failed to start conversion");
        return;
      }
      const job = await resp.json();
      setPhase("running");
      setFileResults([]);

      const es = new EventSource(`/api/optimize/jobs/${job.id}/execute`);
      esRef.current = es;

      es.addEventListener("status", (e) => {
        const data = JSON.parse(e.data) as ConversionProgress;
        setProgress(data);
      });

      es.addEventListener("file_done", (e) => {
        const data = JSON.parse(e.data) as ConversionFileResult & { processed: number; total: number };
        setFileResults(prev => [data, ...prev].slice(0, 200));
        setProgress(prev => prev ? { ...prev, processed: data.processed, total: data.total } : prev);
      });

      es.addEventListener("summary", (e) => {
        const data = JSON.parse(e.data) as ConversionSummary;
        setSummary(data);
        setPhase("done");
        es.close();
        esRef.current = null;
      });

      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data ? JSON.parse((e as MessageEvent).data) : null;
        const msg = data?.message ?? "Connection error";
        setRunError(msg);
        setPhase("done");
        es.close();
        esRef.current = null;
        toast({ title: "Conversion error", description: msg, variant: "destructive" });
      });
    } catch (err: any) {
      setRunError(err.message ?? "Failed to start conversion");
    }
  }

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const isRunning = phase === "running";
  const isDone    = phase === "done";

  return (
    <Dialog open={open} onOpenChange={o => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">RUN_CONVERSIONS</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {phase === "config"
              ? "Originals are backed up before any conversion. Review settings before running."
              : phase === "running"
              ? "Conversion in progress — do not close this window."
              : "Conversion complete. Review the results below."}
          </DialogDescription>
        </DialogHeader>

        {/* ── Config phase ── */}
        {phase === "config" && (
          <div className="space-y-4">
            {/* Format summary */}
            <div className="space-y-2">
              {approved.map(g => (
                <div key={g.extension} className="flex items-center justify-between border border-border rounded px-3 py-2 text-sm font-mono">
                  <div className="flex items-center gap-2">
                    <CategoryIcon cat={g.category} />
                    <span className="font-bold">.{g.extension.toUpperCase()}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-primary">{g.targetFormat}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{g.fileCount.toLocaleString()} files</span>
                    <span className="text-emerald-400">~{formatBytes(g.estimatedSavingsBytes)} savings</span>
                  </div>
                </div>
              ))}
              <div className="text-xs font-mono text-muted-foreground text-right pt-1">
                {approved.length} format{approved.length !== 1 ? "s" : ""} · total estimate ~{formatBytes(totalSavings)} saved
              </div>
            </div>

            {/* Backup dir */}
            <div className="space-y-1.5">
              <Label className="font-mono text-xs">Backup folder (originals saved here before conversion)</Label>
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                <Input
                  className="font-mono text-xs h-8"
                  placeholder="Default: NAS/WillardAI/ConversionBackups/<timestamp>"
                  value={backupDir}
                  onChange={e => setBackupDir(e.target.value)}
                />
              </div>
              <p className="text-[10px] font-mono text-muted-foreground">
                Leave blank to use the default backup path inside your NAS.
              </p>
            </div>

            {/* Safety notice */}
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <p className="text-xs font-mono text-amber-400">
                ⚠ Every original file is copied to the backup folder before conversion.
                If ffmpeg fails for a file, the original is restored automatically.
                Conversion of large video files may take several minutes per file.
              </p>
            </div>

            {runError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
                <p className="text-xs font-mono text-red-400">{runError}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Running phase ── */}
        {(isRunning || (isDone && !summary?.results.length)) && (
          <div className="space-y-4">
            {progress && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono text-muted-foreground">
                  <span>{progress.message}</span>
                  {progress.processed !== undefined && progress.total !== undefined && (
                    <span>{progress.processed}/{progress.total}</span>
                  )}
                </div>
                <Progress value={progress.progress} className="h-2" />
                {progress.currentFile && (
                  <p className="text-[10px] font-mono text-muted-foreground truncate" title={progress.currentFile}>
                    {progress.currentFile.split("/").pop()}
                  </p>
                )}
              </div>
            )}

            {/* Live file results */}
            {fileResults.length > 0 && (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {fileResults.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs font-mono py-0.5">
                    {r.status === "success" ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                    ) : r.status === "failed" ? (
                      <X className="w-3 h-3 text-red-400 shrink-0" />
                    ) : (
                      <SkipForward className="w-3 h-3 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate text-muted-foreground flex-1" title={r.filePath}>
                      {r.filePath.split("/").pop()}
                    </span>
                    {r.status === "success" && r.savedBytes !== undefined && r.savedBytes > 0 && (
                      <span className="text-emerald-400 shrink-0">-{formatBytes(r.savedBytes)}</span>
                    )}
                    {r.status === "failed" && r.error && (
                      <span className="text-red-400 shrink-0 max-w-[200px] truncate" title={r.error}>{r.error}</span>
                    )}
                    {r.status === "skipped" && (
                      <span className="text-muted-foreground shrink-0 text-[10px]">skipped</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {runError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
                <p className="text-xs font-mono text-red-400">{runError}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Done / summary phase ── */}
        {isDone && summary && (
          <div className="space-y-4">
            {/* Stats */}
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "Converted",  value: summary.succeeded, cls: "text-emerald-400" },
                { label: "Failed",     value: summary.failed,    cls: "text-red-400" },
                { label: "Skipped",    value: summary.skipped,   cls: "text-muted-foreground" },
                { label: "Space Saved", value: formatBytes(summary.totalSavedBytes), cls: "text-emerald-400" },
              ].map(({ label, value, cls }) => (
                <div key={label} className="border border-border rounded p-2 text-center">
                  <p className={`text-lg font-bold font-mono ${cls}`}>{value}</p>
                  <p className="text-[10px] font-mono text-muted-foreground uppercase">{label}</p>
                </div>
              ))}
            </div>

            {/* Backup dir note */}
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
              <p className="text-xs font-mono text-muted-foreground">
                <span className="text-foreground">Originals backed up to:</span> {summary.backupDir}
              </p>
            </div>

            {/* File results */}
            {summary.results.length > 0 && (
              <div className="space-y-1 max-h-56 overflow-y-auto border border-border rounded p-2">
                {summary.results.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs font-mono py-0.5">
                    {r.status === "success" ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                    ) : r.status === "failed" ? (
                      <X className="w-3 h-3 text-red-400 shrink-0" />
                    ) : (
                      <SkipForward className="w-3 h-3 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate text-muted-foreground flex-1" title={r.filePath}>
                      {r.filePath.split("/").pop()}
                    </span>
                    {r.status === "success" && r.savedBytes !== undefined && r.savedBytes > 0 && (
                      <span className="text-emerald-400 shrink-0">-{formatBytes(r.savedBytes)}</span>
                    )}
                    {r.status === "failed" && r.error && (
                      <span className="text-red-400 shrink-0 max-w-[200px] truncate" title={r.error}>{r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          {phase === "config" && (
            <>
              <Button variant="outline" size="sm" className="font-mono" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="font-mono gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                onClick={startConversion}
                disabled={approved.length === 0}
              >
                <Play className="w-4 h-4" /> Run {approved.length} Conversion{approved.length !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button variant="outline" size="sm" className="font-mono" disabled>
              Running…
            </Button>
          )}
          {isDone && (
            <Button size="sm" className="font-mono" onClick={handleClose}>
              <CheckCheck className="w-4 h-4 mr-1.5" /> Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Confirm Selections dialog ─────────────────────────────────────────────────

function ConfirmDialog({
  open, onClose, groups, approvedExts, onRunConversions,
}: {
  open: boolean;
  onClose: () => void;
  groups: FormatGroup[];
  approvedExts: Set<string>;
  onRunConversions: () => void;
}) {
  const approved = groups.filter(g => approvedExts.has(g.extension));
  const totalSavings = approved.reduce((s, g) => s + g.estimatedSavingsBytes, 0);

  function exportPlan() {
    const plan = {
      confirmedAt: new Date().toISOString(),
      totalSavingsEstimate: formatBytes(totalSavings),
      conversions: approved.map(g => ({
        extension:        g.extension,
        targetFormat:     g.targetFormat,
        qualityLoss:      g.qualityLoss,
        fileCount:        g.fileCount,
        currentSize:      formatBytes(g.totalBytes),
        estimatedSavings: formatBytes(g.estimatedSavingsBytes),
        sampleFiles:      g.sampleFiles.map(f => ({
          path:              f.path,
          currentSize:       formatBytes(f.sizeBytes),
          estimatedAfterSize: formatBytes(f.estimatedAfterBytes),
        })),
      })),
    };
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `willard-optimize-plan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">CONFIRM_SELECTIONS</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Review your approved conversions. Export the plan as JSON, or run the conversions now.
          </DialogDescription>
        </DialogHeader>

        {approved.length === 0 ? (
          <p className="text-sm text-muted-foreground font-mono py-4 text-center">No formats approved yet.</p>
        ) : (
          <div className="space-y-3 my-2">
            {approved.map(g => (
              <div key={g.extension} className="border border-border rounded-md p-3 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <CategoryIcon cat={g.category} />
                    <span className="font-mono font-bold text-sm">.{g.extension.toUpperCase()}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="font-mono text-sm text-primary">{g.targetFormat}</span>
                  </div>
                  <div className="flex gap-2 items-center">
                    <QualityBadge loss={g.qualityLoss} />
                    <span className="text-xs font-mono text-muted-foreground">{g.fileCount.toLocaleString()} files</span>
                    <span className="text-xs font-mono text-emerald-400">saves ~{formatBytes(g.estimatedSavingsBytes)}</span>
                  </div>
                </div>
                {g.sampleFiles.length > 0 && (
                  <div className="pt-1">
                    <SizePreview group={g} />
                  </div>
                )}
              </div>
            ))}
            <div className="border-t border-border pt-3 flex justify-between items-center font-mono">
              <span className="text-sm text-muted-foreground">{approved.length} format{approved.length !== 1 ? "s" : ""} approved</span>
              <span className="font-bold text-emerald-400">Total estimate: ~{formatBytes(totalSavings)}</span>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" size="sm" className="font-mono gap-1.5" onClick={onClose}>
            Close
          </Button>
          {approved.length > 0 && (
            <Button size="sm" variant="outline" className="font-mono gap-1.5" onClick={exportPlan}>
              <Download className="w-4 h-4" /> Export Plan (.json)
            </Button>
          )}
          {approved.length > 0 && (
            <Button
              size="sm"
              className="font-mono gap-1.5 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => { onClose(); onRunConversions(); }}
            >
              <Play className="w-4 h-4" /> Run Conversions
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Optimize() {
  const { toast } = useToast();
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [approvedExts, setApprovedExts] = useState<Set<string>>(new Set());
  const [skippedExts,  setSkippedExts]  = useState<Set<string>>(new Set());
  const [aiSummary,    setAiSummary]    = useState<string | null>(null);
  const [aiLoading,    setAiLoading]    = useState(false);
  const [expandedExt,  setExpandedExt]  = useState<string | null>(null);
  const [confirmOpen,  setConfirmOpen]  = useState(false);
  const [runOpen,      setRunOpen]      = useState(false);

  // ── Scan ──────────────────────────────────────────────────────────────────
  const scanMutation = useMutation({
    mutationFn: async () => {
      const resp = await fetch("/api/optimize/scan");
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as any).error ?? "Scan failed");
      }
      return resp.json() as Promise<ScanResult>;
    },
    onSuccess: (data) => {
      setScanResult(data);
      setApprovedExts(new Set());
      setSkippedExts(new Set());
      setAiSummary(null);
      fetchAiSummary(data);
    },
    onError: (e: Error) => {
      toast({ title: "Scan failed", description: e.message, variant: "destructive" });
    },
  });

  // ── AI summary ────────────────────────────────────────────────────────────
  async function fetchAiSummary(data: ScanResult) {
    setAiLoading(true);
    try {
      const resp = await fetch("/api/optimize/ai-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groups:            data.groups,
          totalFiles:        data.totalFiles,
          totalBytes:        data.totalBytes,
          totalSavingsBytes: data.totalSavingsBytes,
        }),
      });
      if (resp.ok) {
        const { summary } = await resp.json();
        setAiSummary(summary);
      }
    } catch { /* non-fatal */ }
    setAiLoading(false);
  }

  // ── Approve / skip helpers ────────────────────────────────────────────────
  function toggleApprove(ext: string) {
    setApprovedExts(prev => {
      const next = new Set(prev);
      if (next.has(ext)) {
        next.delete(ext);
      } else {
        next.add(ext);
        setSkippedExts(s => { const ns = new Set(s); ns.delete(ext); return ns; });
      }
      return next;
    });
  }
  function toggleSkip(ext: string) {
    setSkippedExts(prev => {
      const next = new Set(prev);
      if (next.has(ext)) {
        next.delete(ext);
      } else {
        next.add(ext);
        setApprovedExts(s => { const ns = new Set(s); ns.delete(ext); return ns; });
      }
      return next;
    });
  }
  function approveAll() {
    const convertible = (scanResult?.groups ?? []).filter(g => g.status === "convert").map(g => g.extension);
    setApprovedExts(new Set(convertible));
    setSkippedExts(new Set());
  }
  function clearSelections() {
    setApprovedExts(new Set());
    setSkippedExts(new Set());
  }

  // ── Export text report ────────────────────────────────────────────────────
  function exportReport() {
    if (!scanResult) return;
    const lines = [
      "WILLARD AI — OPTIMIZATION REPORT",
      `Generated: ${new Date().toLocaleString()}`,
      `Scanned:   ${scanResult.nasPath}`,
      `Total files: ${scanResult.totalFiles.toLocaleString()}`,
      `Total size:  ${formatBytes(scanResult.totalBytes)}`,
      `Est. savings: ${formatBytes(scanResult.totalSavingsBytes)}`,
      "",
      ...(aiSummary ? ["=== AI SUMMARY ===", aiSummary, ""] : []),
      "=== APPROVED CONVERSIONS ===",
      ...(approvedExts.size === 0 ? ["  (none approved)"] : []),
      ...scanResult.groups
        .filter(g => approvedExts.has(g.extension))
        .map(g => `  .${g.extension} → ${g.targetFormat} | ${g.fileCount} files | ${formatBytes(g.totalBytes)} → saves ~${formatBytes(g.estimatedSavingsBytes)} | Quality: ${g.qualityLoss ?? "—"}`),
      "",
      "=== ALL FORMAT GROUPS ===",
      ...scanResult.groups.map(g =>
        `  .${g.extension.padEnd(6)} [${g.status.padEnd(9)}] ${g.fileCount.toString().padStart(6)} files  ${formatBytes(g.totalBytes).padStart(10)}${g.targetFormat ? `  → ${g.targetFormat}` : ""}${g.estimatedSavingsBytes ? `  saves ~${formatBytes(g.estimatedSavingsBytes)}` : ""}`
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `willard-optimize-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Derived stats ─────────────────────────────────────────────────────────
  const convertibleGroups = scanResult?.groups.filter(g => g.status === "convert") ?? [];
  const protectedGroups   = scanResult?.groups.filter(g => g.status === "protected") ?? [];
  const approvedSavings   = scanResult?.groups
    .filter(g => approvedExts.has(g.extension))
    .reduce((s, g) => s + g.estimatedSavingsBytes, 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold font-mono tracking-tight">OPTIMIZE_CENTER</h1>
          <p className="text-sm text-muted-foreground font-mono mt-1">
            Smart media conversion recommendations — originals are backed up before any changes
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {scanResult && (
            <Button variant="outline" size="sm" className="font-mono gap-2" onClick={exportReport}>
              <Download className="w-4 h-4" /> Export Report
            </Button>
          )}
          {approvedExts.size > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="font-mono gap-2"
                onClick={() => setConfirmOpen(true)}
              >
                <CheckCircle2 className="w-4 h-4" />
                Review ({approvedExts.size})
              </Button>
              <Button
                size="sm"
                className="font-mono gap-2 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => setRunOpen(true)}
              >
                <Play className="w-4 h-4" />
                Run Conversions ({approvedExts.size})
              </Button>
            </>
          )}
          <Button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
            className="font-mono gap-2"
          >
            <ScanLine className="w-4 h-4" />
            {scanMutation.isPending ? "Scanning…" : scanResult ? "Re-scan NAS" : "Scan NAS"}
          </Button>
        </div>
      </div>

      {/* Pre-scan prompt */}
      {!scanResult && !scanMutation.isPending && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
            <div className="rounded-full bg-primary/10 p-4">
              <Zap className="w-8 h-8 text-primary" />
            </div>
            <div>
              <p className="font-mono font-medium">Ready to find optimization opportunities</p>
              <p className="text-sm text-muted-foreground font-mono mt-1">
                Scan your NAS to see which formats can be converted for space savings
              </p>
            </div>
            <Button onClick={() => scanMutation.mutate()} className="font-mono gap-2 mt-2">
              <ScanLine className="w-4 h-4" /> Start Scan
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Scanning state */}
      {scanMutation.isPending && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
            <ScanLine className="w-8 h-8 text-primary animate-pulse" />
            <p className="font-mono text-muted-foreground text-sm">Scanning NAS for media files…</p>
            <div className="w-48 space-y-2">
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-2 w-3/4" />
              <Skeleton className="h-2 w-5/6" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {scanResult && !scanMutation.isPending && (
        <>
          {/* AI Summary */}
          <Card className="border-primary/20 bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base font-mono">
                <Sparkles className="w-4 h-4 text-primary" /> AI Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              {aiLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              ) : aiSummary ? (
                <p className="text-sm font-mono leading-relaxed">{aiSummary}</p>
              ) : (
                <p className="text-sm text-muted-foreground font-mono">AI summary unavailable.</p>
              )}
            </CardContent>
          </Card>

          {/* Stat row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Files Scanned"
              value={scanResult.totalFiles.toLocaleString()}
              sub={formatBytes(scanResult.totalBytes) + " total"}
              icon={<ScanLine className="w-5 h-5" />}
            />
            <StatCard
              label="Potential Savings"
              value={formatBytes(scanResult.totalSavingsBytes)}
              sub={`${convertibleGroups.length} format${convertibleGroups.length !== 1 ? "s" : ""} with savings`}
              icon={<TrendingDown className="w-5 h-5 text-emerald-400" />}
            />
            <StatCard
              label="Protected Formats"
              value={protectedGroups.length.toString()}
              sub="RAW / professional — never convert"
              icon={<Shield className="w-5 h-5 text-red-400" />}
            />
            <StatCard
              label="Approved Savings"
              value={approvedExts.size > 0 ? formatBytes(approvedSavings) : "—"}
              sub={approvedExts.size > 0 ? `${approvedExts.size} format${approvedExts.size !== 1 ? "s" : ""} approved` : "Approve formats below"}
              icon={<CheckCircle2 className="w-5 h-5 text-blue-400" />}
            />
          </div>

          {/* Batch controls */}
          {convertibleGroups.length > 0 && (
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-xs font-mono text-muted-foreground">Batch:</span>
              <Button size="sm" variant="outline" className="font-mono text-xs h-7 gap-1" onClick={approveAll}>
                <CheckCircle2 className="w-3 h-3" /> Approve All Convertible
              </Button>
              {approvedExts.size > 0 && (
                <>
                  <Button size="sm" variant="outline" className="font-mono text-xs h-7 gap-1" onClick={() => setConfirmOpen(true)}>
                    <CheckCircle2 className="w-3 h-3" /> Review ({approvedExts.size})
                  </Button>
                  <Button
                    size="sm"
                    className="font-mono text-xs h-7 gap-1 bg-emerald-600 hover:bg-emerald-700"
                    onClick={() => setRunOpen(true)}
                  >
                    <Play className="w-3 h-3" /> Run Conversions
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" className="font-mono text-xs h-7 gap-1" onClick={clearSelections}>
                <RotateCcw className="w-3 h-3" /> Clear
              </Button>
            </div>
          )}

          {/* Format groups table */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-mono flex items-center gap-2">
                Format Breakdown
                <span className="text-xs font-normal text-muted-foreground">
                  ({scanResult.groups.length} format{scanResult.groups.length !== 1 ? "s" : ""} detected)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 pl-4"></TableHead>
                    <TableHead className="font-mono">Format</TableHead>
                    <TableHead className="font-mono text-right">Files</TableHead>
                    <TableHead className="font-mono text-right">Size</TableHead>
                    <TableHead className="font-mono">Target</TableHead>
                    <TableHead className="font-mono">Est. Savings</TableHead>
                    <TableHead className="font-mono">Quality</TableHead>
                    <TableHead className="font-mono">Status</TableHead>
                    <TableHead className="font-mono text-center">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scanResult.groups.map((group) => {
                    const isApproved = approvedExts.has(group.extension);
                    const isSkipped  = skippedExts.has(group.extension);
                    const expanded   = expandedExt === group.extension;

                    return (
                      <>
                        <TableRow
                          key={group.extension}
                          className={
                            isApproved ? "bg-blue-500/5 border-l-2 border-l-blue-500" :
                            isSkipped  ? "opacity-50" : ""
                          }
                        >
                          <TableCell className="pl-4">
                            <CategoryIcon cat={group.category} />
                          </TableCell>
                          <TableCell>
                            <button
                              className="flex items-center gap-1 font-mono font-bold text-sm hover:text-primary transition-colors"
                              onClick={() => setExpandedExt(expanded ? null : group.extension)}
                            >
                              {expanded
                                ? <ChevronDown className="w-3 h-3" />
                                : <ChevronRight className="w-3 h-3" />
                              }
                              .{group.extension.toUpperCase()}
                            </button>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {group.fileCount.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatBytes(group.totalBytes)}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground max-w-[120px] truncate">
                            {group.targetFormat ?? "—"}
                          </TableCell>
                          <TableCell>
                            {group.estimatedSavingsBytes > 0 ? (
                              <span className="font-mono text-xs text-emerald-400">
                                ~{formatBytes(group.estimatedSavingsBytes)}
                                <span className="text-muted-foreground ml-1">
                                  ({Math.round((group.estimatedSavingsRatio ?? 0) * 100)}%)
                                </span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground font-mono text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <QualityBadge loss={group.qualityLoss} />
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={group.status} />
                          </TableCell>
                          <TableCell className="text-center">
                            {group.status === "convert" ? (
                              <div className="flex gap-1.5 justify-center">
                                <Button
                                  size="sm"
                                  variant={isApproved ? "default" : "outline"}
                                  className="h-6 px-2 text-[10px] font-mono gap-0.5"
                                  onClick={() => toggleApprove(group.extension)}
                                >
                                  <CheckCircle2 className="w-3 h-3" />
                                  {isApproved ? "Approved" : "Approve"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[10px] font-mono text-muted-foreground gap-0.5"
                                  onClick={() => toggleSkip(group.extension)}
                                >
                                  <SkipForward className="w-3 h-3" />
                                  Skip
                                </Button>
                              </div>
                            ) : group.status === "protected" ? (
                              <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1 justify-center">
                                <Shield className="w-3 h-3 text-red-400" /> Protected
                              </span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground font-mono">—</span>
                            )}
                          </TableCell>
                        </TableRow>

                        {/* Expanded detail row: reason + before/after size preview */}
                        {expanded && (
                          <TableRow key={`${group.extension}-detail`} className="bg-secondary/20 hover:bg-secondary/20">
                            <TableCell colSpan={9} className="py-3 pl-10 pr-4">
                              <div className="space-y-3">
                                {/* Reason */}
                                <div className="flex items-start gap-2">
                                  {group.status === "protected" && <Shield className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />}
                                  {group.status === "convert"   && <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />}
                                  {group.status === "optimal"   && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />}
                                  <p className="text-xs font-mono text-muted-foreground">{group.reason}</p>
                                </div>

                                {/* Before/after size preview (convert groups only) */}
                                {group.status === "convert" && group.sampleFiles.length > 0 && (
                                  <SizePreview group={group} />
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Scan metadata footer */}
          <p className="text-xs text-muted-foreground font-mono text-center">
            Scanned {scanResult.totalFiles.toLocaleString()} files in{" "}
            <span className="font-medium">{scanResult.nasPath}</span> ·{" "}
            {new Date(scanResult.scannedAt).toLocaleString()}
          </p>
        </>
      )}

      {/* Confirm Selections dialog */}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        groups={scanResult?.groups ?? []}
        approvedExts={approvedExts}
        onRunConversions={() => setRunOpen(true)}
      />

      {/* Run Conversions dialog */}
      <RunConversionsDialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        groups={scanResult?.groups ?? []}
        approvedExts={approvedExts}
      />
    </div>
  );
}
