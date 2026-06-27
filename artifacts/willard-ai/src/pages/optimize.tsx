import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Zap, Shield, CheckCircle2, SkipForward, ScanLine,
  Sparkles, TrendingDown, AlertTriangle, ChevronDown, ChevronRight,
  Download, RotateCcw,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type FormatStatus = "protected" | "optimal" | "convert" | "skip";
type QualityLoss  = "none" | "minimal" | "moderate" | "high";
type MediaCategory = "image" | "video" | "audio" | "document" | "other";

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
}

interface ScanResult {
  scannedAt:         string;
  nasPath:           string;
  totalFiles:        number;
  totalBytes:        number;
  totalSavingsBytes: number;
  groups:            FormatGroup[];
}

// ── Helper: status presentation ───────────────────────────────────────────────

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Optimize() {
  const { toast } = useToast();
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [approvedExts, setApprovedExts] = useState<Set<string>>(new Set());
  const [skippedExts, setSkippedExts] = useState<Set<string>>(new Set());
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [expandedReason, setExpandedReason] = useState<string | null>(null);

  // ── Scan ──────────────────────────────────────────────────────────────────
  const scanMutation = useMutation({
    mutationFn: async () => {
      const resp = await fetch("/api/optimize/scan");
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error ?? "Scan failed");
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
          groups: data.groups,
          totalFiles: data.totalFiles,
          totalBytes: data.totalBytes,
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
      if (next.has(ext)) { next.delete(ext); } else { next.add(ext); skippedExts.delete(ext); setSkippedExts(new Set(skippedExts)); }
      return next;
    });
  }
  function toggleSkip(ext: string) {
    setSkippedExts(prev => {
      const next = new Set(prev);
      if (next.has(ext)) { next.delete(ext); } else { next.add(ext); approvedExts.delete(ext); setApprovedExts(new Set(approvedExts)); }
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

  // ── Export recommendations ────────────────────────────────────────────────
  function exportReport() {
    if (!scanResult) return;
    const lines = [
      "WILLARD AI — OPTIMIZATION REPORT",
      `Generated: ${new Date().toLocaleString()}`,
      `Scanned: ${scanResult.nasPath}`,
      `Total files: ${scanResult.totalFiles.toLocaleString()}`,
      `Total size: ${formatBytes(scanResult.totalBytes)}`,
      `Estimated savings: ${formatBytes(scanResult.totalSavingsBytes)}`,
      "",
      ...(aiSummary ? ["=== AI SUMMARY ===", aiSummary, ""] : []),
      "=== APPROVED CONVERSIONS ===",
      ...(approvedExts.size === 0 ? ["  (none approved)"] : []),
      ...scanResult.groups
        .filter(g => approvedExts.has(g.extension))
        .map(g => `  .${g.extension} → ${g.targetFormat} | ${g.fileCount} files | ${formatBytes(g.totalBytes)} → saves ~${formatBytes(g.estimatedSavingsBytes)} | Quality: ${g.qualityLoss}`),
      "",
      "=== ALL FORMAT GROUPS ===",
      ...scanResult.groups.map(g =>
        `  .${g.extension.padEnd(6)} [${g.status.padEnd(9)}] ${g.fileCount.toString().padStart(6)} files  ${formatBytes(g.totalBytes).padStart(10)}${g.targetFormat ? `  → ${g.targetFormat}` : ""}${g.estimatedSavingsBytes ? `  saves ~${formatBytes(g.estimatedSavingsBytes)}` : ""}`
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `willard-optimize-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click(); URL.revokeObjectURL(url);
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
            Smart media conversion recommendations — no files are modified without your approval
          </p>
        </div>
        <div className="flex gap-2">
          {scanResult && (
            <Button variant="outline" size="sm" className="font-mono gap-2" onClick={exportReport}>
              <Download className="w-4 h-4" /> Export Report
            </Button>
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

          {/* Approve-all / clear controls */}
          {convertibleGroups.length > 0 && (
            <div className="flex gap-2 items-center">
              <span className="text-xs font-mono text-muted-foreground">Batch actions:</span>
              <Button size="sm" variant="outline" className="font-mono text-xs h-7 gap-1" onClick={approveAll}>
                <CheckCircle2 className="w-3 h-3" /> Approve All Convertible
              </Button>
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
                    const expanded   = expandedReason === group.extension;

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
                              onClick={() => setExpandedReason(expanded ? null : group.extension)}
                            >
                              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
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

                        {/* Expanded reason row */}
                        {expanded && (
                          <TableRow key={`${group.extension}-reason`} className="bg-secondary/20">
                            <TableCell colSpan={9} className="py-2 pl-10 pr-4">
                              <div className="flex items-start gap-2">
                                {group.status === "protected" && <Shield className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />}
                                {group.status === "convert"   && <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />}
                                {group.status === "optimal"   && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />}
                                <p className="text-xs font-mono text-muted-foreground">{group.reason}</p>
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

          {/* Approval summary */}
          {approvedExts.size > 0 && (
            <Card className="border-blue-500/30 bg-blue-500/5">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-mono flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-400" />
                  Approved Conversions ({approvedExts.size} format{approvedExts.size !== 1 ? "s" : ""})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {scanResult.groups
                  .filter(g => approvedExts.has(g.extension))
                  .map(g => (
                    <div key={g.extension} className="flex items-center justify-between text-sm font-mono py-1 border-b border-border/40 last:border-0">
                      <span>
                        <span className="font-bold">.{g.extension.toUpperCase()}</span>
                        <span className="text-muted-foreground ml-2">→ {g.targetFormat}</span>
                      </span>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-muted-foreground">{g.fileCount.toLocaleString()} files · {formatBytes(g.totalBytes)}</span>
                        <span className="text-emerald-400">saves ~{formatBytes(g.estimatedSavingsBytes)}</span>
                        <QualityBadge loss={g.qualityLoss} />
                      </div>
                    </div>
                  ))}
                <div className="pt-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-mono">Total estimated savings</span>
                  <span className="font-mono font-bold text-emerald-400">{formatBytes(approvedSavings)}</span>
                </div>
                <div className="pt-1">
                  <p className="text-xs text-muted-foreground font-mono border border-amber-500/30 bg-amber-500/5 rounded px-3 py-2">
                    ⚠ Conversion execution is not available yet — this list will be the input for the upcoming conversion pipeline.
                    Original files will be preserved in a configurable originals folder before any conversion runs.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Scan metadata footer */}
          <p className="text-xs text-muted-foreground font-mono text-center">
            Scanned {scanResult.totalFiles.toLocaleString()} files in{" "}
            <span className="font-medium">{scanResult.nasPath}</span> ·{" "}
            {new Date(scanResult.scannedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
