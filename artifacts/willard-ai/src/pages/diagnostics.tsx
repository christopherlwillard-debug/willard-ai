import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Activity, Play, RefreshCw, Cpu, Database, Clock, TrendingUp,
  AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScanDiagnostics {
  walkTimeMs:               number;
  dirCacheHits:             number;
  dirCacheMisses:           number;
  skippedByReason:          Record<string, number>;
  metadataExtracted:        number;
  hashesGenerated:          number;
  dbWriteBatches:           number;
  avgNasLatencyMs:          number;
  maxNasLatencyMs:          number;
  peakConcurrency:          number;
  throughputFilesPerSec:    number;
  throughputMBPerSec:       number;
  peakQueueDepth:           number;
  dbWriteTimeMs:            number;
  metadataExtractionTimeMs: number;
  totalSizeBytes:           number;
}

interface ScanRecord {
  id:             number;
  profile:        string | null;
  status:         string;
  startedAt:      string | null;
  finishedAt:     string | null;
  processedFiles: number;
  totalFiles:     number | null;
  summary:        Record<string, unknown> | null;
  diagnostics:    ScanDiagnostics | null;
}

interface BenchmarkResult {
  jobId:       number | undefined;
  filesWalked: number;
  sampleSize:  number;
  elapsedMs:   number;
  diagnostics: ScanDiagnostics;
}

// ── Sort types ────────────────────────────────────────────────────────────────

type SortKey = "date" | "files" | "duration" | "filesPerSec" | "mbPerSec" | "peakWorkers" | "dirCache";
type SortDir = "asc" | "desc";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtNum(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function scanDurationMs(scan: ScanRecord): number {
  if (!scan.startedAt || !scan.finishedAt) {
    const summary = scan.summary as any;
    return summary?.elapsedMs ?? 0;
  }
  return new Date(scan.finishedAt).getTime() - new Date(scan.startedAt).getTime();
}

function cacheHitRate(d: ScanDiagnostics): number {
  const total = d.dirCacheHits + d.dirCacheMisses;
  return total === 0 ? 0 : Math.round((d.dirCacheHits / total) * 100);
}

function sortScans(scans: ScanRecord[], key: SortKey, dir: SortDir): ScanRecord[] {
  const multiplier = dir === "asc" ? 1 : -1;
  return [...scans].sort((a, b) => {
    let av = 0, bv = 0;
    switch (key) {
      case "date":
        av = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        bv = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        break;
      case "files":
        av = a.processedFiles; bv = b.processedFiles; break;
      case "duration":
        av = scanDurationMs(a); bv = scanDurationMs(b); break;
      case "filesPerSec":
        av = a.diagnostics?.throughputFilesPerSec ?? 0;
        bv = b.diagnostics?.throughputFilesPerSec ?? 0;
        break;
      case "mbPerSec":
        av = a.diagnostics?.throughputMBPerSec ?? 0;
        bv = b.diagnostics?.throughputMBPerSec ?? 0;
        break;
      case "peakWorkers":
        av = a.diagnostics?.peakConcurrency ?? 0;
        bv = b.diagnostics?.peakConcurrency ?? 0;
        break;
      case "dirCache":
        av = a.diagnostics ? cacheHitRate(a.diagnostics) : 0;
        bv = b.diagnostics ? cacheHitRate(b.diagnostics) : 0;
        break;
    }
    return (av - bv) * multiplier;
  });
}

// ── Diagnostics page ──────────────────────────────────────────────────────────

export default function Diagnostics() {
  const { toast } = useToast();
  const [benchmarkSize, setBenchmarkSize] = useState("1000");
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkResult | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading, refetch } = useQuery<{ scans: ScanRecord[] }>({
    queryKey: ["diagnostics-scans"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/scans");
      if (!res.ok) throw new Error("Failed to fetch diagnostics");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const benchmarkMutation = useMutation({
    mutationFn: async (size: string) => {
      const res = await fetch(`/api/library/scan/benchmark?size=${size}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? "Benchmark failed");
      }
      return res.json() as Promise<BenchmarkResult>;
    },
    onSuccess: (result) => {
      setBenchmarkResult(result);
      refetch();
      toast({
        title: "Benchmark complete",
        description: `${result.sampleSize.toLocaleString()} files in ${fmtMs(result.elapsedMs)}`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Benchmark failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const rawScans = data?.scans ?? [];
  const scans    = sortScans(rawScans, sortKey, sortDir);

  return (
    <div className="space-y-8 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">SCAN_DIAGNOSTICS</h1>
        <p className="text-muted-foreground mt-1 text-sm">Per-scan performance metrics and benchmark mode</p>
      </div>

      {/* ── Benchmark ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="w-5 h-5" /> Benchmark Mode
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Runs the full hash + metadata + DB-write pipeline on a sample of your NAS files —
            identical to a real scan but without permanently modifying your library.
            Results are directly comparable to actual scan diagnostics.
          </p>
          <div className="flex items-center gap-3">
            <Select value={benchmarkSize} onValueChange={setBenchmarkSize}>
              <SelectTrigger className="w-40 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1000">1,000 files</SelectItem>
                <SelectItem value="5000">5,000 files</SelectItem>
                <SelectItem value="10000">10,000 files</SelectItem>
                <SelectItem value="full">Full library</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => benchmarkMutation.mutate(benchmarkSize)}
              disabled={benchmarkMutation.isPending}
              className="font-mono"
            >
              {benchmarkMutation.isPending ? (
                <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Running…</>
              ) : (
                <><Play className="w-4 h-4 mr-2" /> Run Benchmark</>
              )}
            </Button>
          </div>

          {benchmarkResult && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
              <MetricTile label="Walk time"         value={fmtMs(benchmarkResult.diagnostics.walkTimeMs)} />
              <MetricTile label="Files/sec"         value={fmtNum(benchmarkResult.diagnostics.throughputFilesPerSec)} />
              <MetricTile label="MB/sec"            value={fmtNum(benchmarkResult.diagnostics.throughputMBPerSec, 2)} />
              <MetricTile label="Peak workers"      value={String(benchmarkResult.diagnostics.peakConcurrency)} />
              <MetricTile label="Hashes computed"   value={benchmarkResult.diagnostics.hashesGenerated.toLocaleString()} />
              <MetricTile label="Metadata extracted" value={benchmarkResult.diagnostics.metadataExtracted.toLocaleString()} />
              <MetricTile label="DB batches"        value={String(benchmarkResult.diagnostics.dbWriteBatches)} />
              <MetricTile label="Total elapsed"     value={fmtMs(benchmarkResult.elapsedMs)} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Scan History with Diagnostics ────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5" /> Scan Diagnostics History
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="font-mono">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : scans.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              No completed scan records found. Run a scan to collect diagnostics.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="font-mono text-xs">
                    <SortHead label="Date"         col="date"        active={sortKey} dir={sortDir} onSort={toggleSort} />
                    <TableHead>Profile</TableHead>
                    <SortHead label="Files"        col="files"       active={sortKey} dir={sortDir} onSort={toggleSort} right />
                    <SortHead label="Duration"     col="duration"    active={sortKey} dir={sortDir} onSort={toggleSort} right />
                    <SortHead label="Files/sec"    col="filesPerSec" active={sortKey} dir={sortDir} onSort={toggleSort} right />
                    <SortHead label="MB/sec"       col="mbPerSec"    active={sortKey} dir={sortDir} onSort={toggleSort} right />
                    <SortHead label="Peak Workers" col="peakWorkers" active={sortKey} dir={sortDir} onSort={toggleSort} right />
                    <TableHead className="text-right">Avg NAS</TableHead>
                    <TableHead className="text-right">Max NAS</TableHead>
                    <TableHead className="text-right">DB Batches</TableHead>
                    <SortHead label="Dir Cache"    col="dirCache"    active={sortKey} dir={sortDir} onSort={toggleSort} right />
                    <TableHead className="text-right">Peak Queue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map(scan => {
                    const d        = scan.diagnostics;
                    const durMs    = scanDurationMs(scan);
                    return (
                      <TableRow key={scan.id} className="font-mono text-xs">
                        <TableCell className="whitespace-nowrap">
                          {scan.startedAt
                            ? new Date(scan.startedAt).toLocaleString(undefined, {
                                month: "short", day: "numeric",
                                hour: "2-digit", minute: "2-digit",
                              })
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] font-mono">
                            {scan.profile ?? "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{scan.processedFiles.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{durMs ? fmtMs(durMs) : "—"}</TableCell>
                        <TableCell className="text-right">{d ? fmtNum(d.throughputFilesPerSec) : "—"}</TableCell>
                        <TableCell className="text-right">{d ? fmtNum(d.throughputMBPerSec, 2) : "—"}</TableCell>
                        <TableCell className="text-right">{d ? d.peakConcurrency : "—"}</TableCell>
                        <TableCell className="text-right">{d ? `${d.avgNasLatencyMs}ms` : "—"}</TableCell>
                        <TableCell className="text-right">{d ? `${d.maxNasLatencyMs}ms` : "—"}</TableCell>
                        <TableCell className="text-right">{d ? d.dbWriteBatches : "—"}</TableCell>
                        <TableCell className="text-right">
                          {d ? `${cacheHitRate(d)}%` : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? d.peakQueueDepth.toLocaleString() : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Skipped-by-reason breakdown (most recent scan) ─────────────── */}
      {scans[0]?.diagnostics && Object.keys(scans[0].diagnostics.skippedByReason).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" /> Skipped Files — Most Recent Scan
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {Object.entries(scans[0].diagnostics.skippedByReason).map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between p-3 rounded border bg-secondary/20">
                  <span className="text-xs font-mono text-muted-foreground">{reason.replace(/_/g, " ")}</span>
                  <Badge variant="secondary" className="font-mono text-xs">{count}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Legend ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <LegendItem icon={<TrendingUp className="w-4 h-4" />} label="Files/sec" desc="Processed files ÷ total elapsed" />
        <LegendItem icon={<Database className="w-4 h-4" />}   label="Dir Cache"  desc="% of directories skipped via mtime cache" />
        <LegendItem icon={<Clock className="w-4 h-4" />}      label="Avg/Max NAS" desc="Rolling I/O latency per file operation" />
        <LegendItem icon={<Cpu className="w-4 h-4" />}        label="Peak Workers" desc="Max concurrent file processor goroutines" />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SortHead({
  label, col, active, dir, onSort, right,
}: {
  label: string; col: SortKey; active: SortKey; dir: SortDir;
  onSort: (k: SortKey) => void; right?: boolean;
}) {
  const isActive = active === col;
  return (
    <TableHead className={right ? "text-right" : ""}>
      <button
        onClick={() => onSort(col)}
        className="flex items-center gap-1 font-mono text-xs hover:text-foreground transition-colors group"
        style={right ? { marginLeft: "auto" } : undefined}
      >
        {label}
        {isActive
          ? dir === "desc"
            ? <ArrowDown className="w-3 h-3 text-primary" />
            : <ArrowUp   className="w-3 h-3 text-primary" />
          : <ArrowUpDown className="w-3 h-3 opacity-30 group-hover:opacity-60" />}
      </button>
    </TableHead>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded border bg-secondary/20">
      <p className="text-xs text-muted-foreground font-mono">{label}</p>
      <p className="text-lg font-bold font-mono mt-0.5">{value}</p>
    </div>
  );
}

function LegendItem({ icon, label, desc }: { icon: React.ReactNode; label: string; desc: string }) {
  return (
    <div className="flex gap-2 items-start p-3 rounded border bg-secondary/10">
      <div className="text-muted-foreground mt-0.5">{icon}</div>
      <div>
        <p className="text-xs font-bold font-mono">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
    </div>
  );
}
