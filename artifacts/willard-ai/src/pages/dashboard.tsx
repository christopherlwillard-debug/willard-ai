import { useState } from "react";
import { useGetDashboard, getGetDashboardQueryKey, useStartScan, useGetScanStatus, getGetScanStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, FileArchive, FileText, Copy, Activity, ScanLine, Loader2 } from "lucide-react";
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

  const scanMutation = useStartScan({
    mutation: {
      onSuccess: () => {
        setScanPolling(true);
      },
    },
  });

  const isScanning = data?.isScanning || (scanPolling && (scanStatus?.isRunning ?? false));

  // Stop polling once scan finishes
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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold font-mono tracking-tight">SYSTEM_OVERVIEW</h1>
          <p className="text-muted-foreground mt-2 font-mono text-sm">
            Last scanned: {formatDate(data.lastScanAt)} | Status:{" "}
            <span className={isScanning ? "text-amber-400" : "text-green-500"}>
              {isScanning ? "SCANNING" : "IDLE"}
            </span>
          </p>
          {isScanning && scanStatus?.current && (
            <p className="text-xs text-muted-foreground font-mono mt-1">
              {(scanStatus.current as any).stage} — {(scanStatus.current as any).filesScanned?.toLocaleString()} files indexed
            </p>
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Storage Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {data.typeBreakdown.length === 0 ? (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground font-mono text-sm">
                No data — run a scan to populate
              </div>
            ) : (
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.typeBreakdown}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="sizeBytes"
                      nameKey="fileType"
                    >
                      {data.typeBreakdown.map((_entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) => formatBytes(value)}
                      contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-3 mt-2 justify-center">
                  {data.typeBreakdown.map((entry, index) => (
                    <div key={entry.fileType} className="flex items-center gap-1.5 text-xs font-mono">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                      <span className="text-muted-foreground">{entry.fileType}</span>
                      <span>{formatBytes(entry.sizeBytes)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Immich Integration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col space-y-4">
              <div className="flex items-center space-x-2">
                <Activity className={`h-4 w-4 ${data.immichConnected ? "text-green-500" : "text-red-500"}`} />
                <span className="font-mono text-sm">
                  {data.immichConnected ? "CONNECTED" : "DISCONNECTED"}
                </span>
              </div>
              {data.immichConnected ? (
                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div className="bg-secondary p-4 rounded-md">
                    <p className="text-sm text-muted-foreground">Photos</p>
                    <p className="text-2xl font-bold">{data.immichPhotoCount.toLocaleString()}</p>
                  </div>
                  <div className="bg-secondary p-4 rounded-md">
                    <p className="text-sm text-muted-foreground">Videos</p>
                    <p className="text-2xl font-bold">{data.immichVideoCount.toLocaleString()}</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground font-mono">
                  Configure Immich in Settings to connect your photo library
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
