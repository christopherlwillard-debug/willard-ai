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
import { Activity, Play, RefreshCw, Cpu, Database, Clock, TrendingUp, AlertTriangle } from "lucide-react";

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

function statusColor(status: string) {
  if (status === "DONE") return "text-green-500";
  if (status === "FAILED" || status === "CANCELLED") return "text-destructive";
  return "text-muted-foreground";
}

function cacheHitRate(d: ScanDiagnostics): string {
  const total = d.dirCacheHits + d.dirCacheMisses;
  if (total === 0) return "—";
  return `${Math.round((d.dirCacheHits / total) * 100)}%`;
}

// ── Diagnostics page ──────────────────────────────────────────────────────────

export default function Diagnostics() {
  const { toast } = useToast();
  const [benchmarkSize, setBenchmarkSize] = useState("1000");
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkResult | null>(null);

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
      toast({ title: "Benchmark complete", description: `${result.sampleSize.toLocaleString()} files in ${fmtMs(result.elapsedMs)}` });
    },
    onError: (err: any) => {
      toast({ title: "Benchmark failed", description: err.message, variant: "destructive" });
    },
  });

  const scans = data?.scans ?? [];

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
            Walk a sample of your NAS files and measure raw I/O latency + metadata extraction speed without affecting your library.
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
              <MetricTile label="Walk time" value={fmtMs(benchmarkResult.diagnostics.walkTimeMs)} />
              <MetricTile label="Avg NAS latency" value={`${benchmarkResult.diagnostics.avgNasLatencyMs}ms`} />
              <MetricTile label="Max NAS latency" value={`${benchmarkResult.diagnostics.maxNasLatencyMs}ms`} />
              <MetricTile label="Metadata extracted" value={benchmarkResult.diagnostics.metadataExtracted.toLocaleString()} />
              <MetricTile label="Files walked" value={benchmarkResult.filesWalked.toLocaleString()} />
              <MetricTile label="Sample size" value={benchmarkResult.sampleSize.toLocaleString()} />
              <MetricTile label="Elapsed" value={fmtMs(benchmarkResult.elapsedMs)} />
              <MetricTile label="Meta extraction" value={fmtMs(benchmarkResult.diagnostics.metadataExtractionTimeMs)} />
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
            <p className="text-muted-foreground text-sm text-center py-8">No scan records found. Run a scan to collect diagnostics.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="font-mono text-xs">
                    <TableHead>Date</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">Files/sec</TableHead>
                    <TableHead className="text-right">MB/sec</TableHead>
                    <TableHead className="text-right">Peak Workers</TableHead>
                    <TableHead className="text-right">Avg NAS</TableHead>
                    <TableHead className="text-right">Max NAS</TableHead>
                    <TableHead className="text-right">DB Batches</TableHead>
                    <TableHead className="text-right">Dir Cache</TableHead>
                    <TableHead className="text-right">Peak Queue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map(scan => {
                    const d = scan.diagnostics;
                    const summary = scan.summary as any;
                    const elapsedMs = summary?.elapsedMs as number | undefined;
                    return (
                      <TableRow key={scan.id} className="font-mono text-xs">
                        <TableCell className="whitespace-nowrap">
                          {scan.startedAt ? new Date(scan.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] font-mono">{scan.profile ?? "—"}</Badge>
                        </TableCell>
                        <TableCell className={`font-bold ${statusColor(scan.status)}`}>{scan.status}</TableCell>
                        <TableCell className="text-right">{scan.processedFiles.toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          {d ? fmtMs(d.walkTimeMs + (elapsedMs ?? 0)) : elapsedMs ? fmtMs(elapsedMs) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? fmtNum(d.throughputFilesPerSec) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? fmtNum(d.throughputMBPerSec, 2) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? d.peakConcurrency : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? `${d.avgNasLatencyMs}ms` : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? `${d.maxNasLatencyMs}ms` : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? d.dbWriteBatches : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {d ? cacheHitRate(d) : "—"}
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
        <LegendItem icon={<Database className="w-4 h-4" />} label="Dir Cache" desc="% of directories skipped via mtime cache" />
        <LegendItem icon={<Clock className="w-4 h-4" />} label="Avg/Max NAS" desc="Rolling I/O latency per file operation" />
        <LegendItem icon={<Cpu className="w-4 h-4" />} label="Peak Workers" desc="Max concurrent file processor goroutines" />
      </div>
    </div>
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
