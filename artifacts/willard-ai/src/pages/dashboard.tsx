import { useState } from "react";
import {
  useGetDashboard, getGetDashboardQueryKey,
  useStartScan, useGetScanStatus, getGetScanStatusQueryKey,
  useGetImmichRecentPhotos, getGetImmichRecentPhotosQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, FileArchive, FileText, Copy, Activity, ScanLine, Loader2, Image as ImageIcon, Video } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useQueryClient } from "@tanstack/react-query";

const COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

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
      onSuccess: () => {
        setScanPolling(true);
      },
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
              {/* indeterminate progress bar */}
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

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Storage</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(data.totalSizeBytes)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {data.totalFiles.toLocaleString()} files indexed
            </p>
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Storage Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {data.typeBreakdown.length === 0 ? (
              <div className="h-[260px] flex items-center justify-center text-muted-foreground font-mono text-sm">
                No data — run a scan to populate
              </div>
            ) : (
              <>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.typeBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={80}
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
                <div className="flex flex-wrap gap-3 mt-1 justify-center">
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

      {/* Recent photos strip — 12 thumbnails, only when Immich connected */}
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
