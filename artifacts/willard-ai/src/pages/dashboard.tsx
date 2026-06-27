import { useGetDashboard, getGetDashboardQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatDate } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, FileArchive, FileText, Copy, Activity } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

export default function Dashboard() {
  const { data, isLoading, error } = useGetDashboard({
    query: { queryKey: getGetDashboardQueryKey() },
  });

  if (isLoading) {
    return <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="h-64" />
    </div>;
  }

  if (error || !data) {
    return <div className="text-red-500">Failed to load dashboard data</div>;
  }

  const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">SYSTEM_OVERVIEW</h1>
        <p className="text-muted-foreground mt-2 font-mono">
          Last scanned: {formatDate(data.lastScanAt)} | Status: {data.isScanning ? "SCANNING" : "IDLE"}
        </p>
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
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Storage Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
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
                    {data.typeBreakdown.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(value: number) => formatBytes(value)}
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-1">
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
              {data.immichConnected && (
                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div className="bg-secondary p-4 rounded-md">
                    <p className="text-sm text-muted-foreground">Photos</p>
                    <p className="text-2xl font-bold">{data.immichPhotoCount.toLocaleString()}</p>
                  </div>
                  <div className="bg-secondary p-4 rounded-md">
                    <p className="text-sm text-muted-foreground">Videos</p>
                    <p className="text-2xl font-bold">{data.immichVideoCount.toLocaleString()}</p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
