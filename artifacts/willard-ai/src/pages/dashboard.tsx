import { useState } from "react";
import { Link } from "wouter";
import {
  useGetDashboard, getGetDashboardQueryKey,
  useStartScan, useGetScanStatus, getGetScanStatusQueryKey,
  useGetImmichRecentPhotos, getGetImmichRecentPhotosQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, FileArchive, FileText, Copy, Activity, ScanLine, Loader2, Image as ImageIcon, Video, HardDrive, Settings2, ArrowRight } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useQueryClient } from "@tanstack/react-query";

const COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];
const DISK_COLORS = ["hsl(var(--destructive))", "hsl(var(--muted))"];

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [scanPolling, setScanPolling] = useState(false);

  const { data, isLoading, error } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: scanPolling ? 3000 : false,
    },
  });

  const { data: scanStatus } = useGetScanStatus({
    query: {
      queryKey: getGetScanStatusQueryKey(),
      refetchInterval: scanPolling ? 2000 : false,
      enabled: scanPolling,
    },
  });

  const { data: recentPhotos } = useGetImmichRecentPhotos(
    { limit: 12 },
    {
      query: {
        queryKey: getGetImmichRecentPhotosQueryKey({ limit: 12 }),
        enabled: data?.immichConnected === true,
      },
    }
  );

  const scanMutation = useStartScan({
    mutation: {
      onSuccess: () => { setScanPolling(true); },
    },
  });

  const isScanning = data?.isScanning || (scanPolling && (scanStatus?.isRunning ?? false));
  const scanProgress = scanStatus?.current;

  if (scanPolling && scanStatus && !scanStatus.isRunning) {
    setScanPolling(false);
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !data) {
    return <div className="text-red-500 font-mono">Failed to load dashboard data</div>;
  }

  const hasDiskStats = (data as any).diskTotal != null && (data as any).diskTotal > 0;
  const diskTotal: number = (data as any).diskTotal ?? 0;
  const diskUsed: number = (data as any).diskUsed ?? 0;
  const diskFree: number = (data as any).diskFree ?? 0;
  const diskUsedPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  const diskChartData = hasDiskStats
    ? [{ name: "Used", value: diskUsed }, { name: "Free", value: diskFree }]
    : [];

  return (
    <div className="space-y-8">
      {/* Header + Scan Now */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold font-mono tracking-tight">SYSTEM_OVERVIEW</h1>
          <p className="text-muted-foreground mt-2 font-mono text-sm">
            Last scanned: {formatDate(data.lastScanAt)} | Status:{" "}
            <span className={isScanning ? "text-amber-400" : "text-green-500"}>
              {isScanning ? "SCANNING" : "IDLE"}
            </span>
          </p>
          {isScanning && scanProgress && (
            <div className="mt-2 space-y-1">
              <p className="text-xs text-muted-foreground font-mono">
                {scanProgress.stage} — {scanProgress.filesScanned?.toLocaleString() ?? 0} files indexed
              </p>
              <div className="h-1 w-64 bg-secondary rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-primary rounded-full animate-[slide_1.5s_linear_infinite]" />
              </div>
            </div>
          )}
        </div>
        <Button
          onClick={() => scanMutation.mutate()}
          disabled={isScanning || scanMutation.isPending}
          className="font-mono shrink-0"
        >
          {isScanning ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Scanning...</>
          ) : (
            <><ScanLine className="w-4 h-4 mr-2" /> Scan Now</>
          )}
        </Button>
      </div>

      {/* First-run onboarding banner */}
      {data.totalFiles === 0 && !isScanning && (
        <div className="flex items-start gap-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <Settings2 className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-mono font-bold text-sm text-primary">NO_FILES_INDEXED</p>
            <p className="text-sm text-muted-foreground mt-1">
              To get started: go to <strong>Settings</strong>, enter your NAS mount path, click <strong>Save</strong>, then click <strong>Scan Now</strong> (or use the button above).
            </p>
          </div>
          <Link href="/settings">
            <Button variant="outline" size="sm" className="font-mono shrink-0">
              Open Settings <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
            </Button>
          </Link>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Indexed</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(data.totalSizeBytes)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {data.totalFiles.toLocaleString()} files indexed
            </p>
            {hasDiskStats && (
              <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                of {formatBytes(diskTotal)} disk
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Archives</CardTitle>
            <FileArchive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.archiveCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Documents</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.documentCount.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Duplicates</CardTitle>
            <Copy className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.duplicateCount.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">by content hash</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Disk Usage Ring */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-muted-foreground" />
              Disk Usage
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasDiskStats ? (
              <div className="h-[220px] flex flex-col items-center justify-center gap-2 text-muted-foreground">
                <HardDrive className="w-8 h-8 opacity-30" />
                <p className="font-mono text-xs text-center">Set NAS path in Settings<br />to show disk stats</p>
              </div>
            ) : (
              <>
                <div className="h-[180px] relative">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={diskChartData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                        startAngle={90}
                        endAngle={-270}
                      >
                        {diskChartData.map((_e, i) => (
                          <Cell key={i} fill={DISK_COLORS[i]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v: number) => formatBytes(v)}
                        contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center label */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-2xl font-bold font-mono">{diskUsedPct}%</span>
                    <span className="text-[10px] text-muted-foreground font-mono">USED</span>
                  </div>
                </div>
                <div className="space-y-2 mt-1">
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-destructive inline-block" /> Used
                    </span>
                    <span>{formatBytes(diskUsed)}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-muted inline-block" /> Free
                    </span>
                    <span className="text-green-500">{formatBytes(diskFree)}</span>
                  </div>
                  <div className="flex justify-between items-center text-xs font-mono border-t pt-2 mt-1">
                    <span className="text-muted-foreground">Total</span>
                    <span>{formatBytes(diskTotal)}</span>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Storage Breakdown by type */}
        <Card>
          <CardHeader>
            <CardTitle>Storage Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {data.typeBreakdown.length === 0 ? (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground font-mono text-sm">
                No data — run a scan to populate
              </div>
            ) : (
              <>
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.typeBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={72}
                        paddingAngle={4}
                        dataKey="sizeBytes"
                        nameKey="fileType"
                      >
                        {data.typeBreakdown.map((_e, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v: number) => formatBytes(v)}
                        contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex flex-wrap gap-2 mt-1 justify-center">
                  {data.typeBreakdown.map((entry, i) => (
                    <div key={entry.fileType} className="flex items-center gap-1.5 text-xs font-mono">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                      <span className="text-muted-foreground">{entry.fileType}</span>
                      <span>{formatBytes(entry.sizeBytes)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Immich Integration */}
        <Card>
          <CardHeader>
            <CardTitle>Immich Integration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <Activity className={`h-4 w-4 ${data.immichConnected ? "text-green-500" : "text-red-500"}`} />
                <span className="font-mono text-sm">
                  {data.immichConnected ? "CONNECTED" : "DISCONNECTED"}
                </span>
              </div>
              {data.immichConnected ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-secondary p-3 rounded-md">
                    <p className="text-xs text-muted-foreground">Photos</p>
                    <p className="text-xl font-bold">{data.immichPhotoCount.toLocaleString()}</p>
                  </div>
                  <div className="bg-secondary p-3 rounded-md">
                    <p className="text-xs text-muted-foreground">Videos</p>
                    <p className="text-xl font-bold">{data.immichVideoCount.toLocaleString()}</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground font-mono">
                  Configure Immich URL + API key in Settings to connect your photo library
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent photos strip — only when Immich connected */}
      {data.immichConnected && (
        <Card>
          <CardHeader>
            <CardTitle className="font-mono text-sm">RECENT_MEDIA</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-6 md:grid-cols-12 gap-2">
              {recentPhotos
                ? recentPhotos.slice(0, 12).map((asset) => (
                    <div
                      key={asset.id}
                      className="aspect-square bg-secondary rounded overflow-hidden relative group"
                    >
                      {asset.thumbUrl ? (
                        <img
                          src={asset.thumbUrl}
                          alt={asset.filename}
                          className="object-cover w-full h-full group-hover:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          {(asset as { type?: string }).type === "VIDEO"
                            ? <Video className="w-4 h-4 text-muted-foreground" />
                            : <ImageIcon className="w-4 h-4 text-muted-foreground" />}
                        </div>
                      )}
                    </div>
                  ))
                : [...Array(12)].map((_, i) => (
                    <Skeleton key={i} className="aspect-square w-full rounded" />
                  ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
