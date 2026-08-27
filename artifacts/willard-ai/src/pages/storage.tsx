import {
  useGetStorageStats, getGetStorageStatsQueryKey,
  useGetTopFolders, getGetTopFoldersQueryKey,
  useGetTopFiles, getGetTopFilesQueryKey,
  useGetStoragePolicyDiagnostics, getGetStoragePolicyDiagnosticsQueryKey,
} from "@workspace/api-client-react";
import { formatBytes } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, File, Folder, HardDrive, PauseCircle, ShieldCheck } from "lucide-react";

export default function Storage() {
  const { data: stats, isLoading: statsLoading } = useGetStorageStats({
    query: { queryKey: getGetStorageStatsQueryKey() }
  });

  const { data: topFolders, isLoading: foldersLoading } = useGetTopFolders({
    query: { queryKey: getGetTopFoldersQueryKey() }
  });

  const { data: topFiles, isLoading: filesLoading } = useGetTopFiles({
    query: { queryKey: getGetTopFilesQueryKey() }
  });

  const { data: policy, isLoading: policyLoading } = useGetStoragePolicyDiagnostics({
    query: {
      queryKey: getGetStoragePolicyDiagnosticsQueryKey(),
      refetchInterval: 30_000,
    },
  });

  const stateLabel = policy?.state === "READY"
    ? "NAS storage ready"
    : policy?.state === "READ_ONLY"
      ? "NAS is read-only"
      : policy?.state === "PAUSED"
        ? "NAS work paused"
        : "Library not configured";
  const stateClass = policy?.state === "READY"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-300";

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold font-mono tracking-tight">STORAGE_ANALYSIS</h1>

      <Card className={`border ${stateClass}`}>
        <CardContent className="space-y-5 p-5">
          <div className="flex flex-wrap items-start gap-4">
            {policyLoading ? <Skeleton className="h-10 w-10 rounded-full" /> : policy?.state === "READY" ? <CheckCircle2 className="h-10 w-10 shrink-0 text-emerald-400" /> : policy?.state === "READ_ONLY" ? <ShieldCheck className="h-10 w-10 shrink-0 text-amber-400" /> : <PauseCircle className="h-10 w-10 shrink-0 text-amber-400" />}
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold">{policyLoading ? "Reading storage policy…" : stateLabel}</p>
              <p className="mt-1 text-sm text-muted-foreground">{policy?.stateMessage ?? "Storage policy diagnostics are unavailable."}</p>
              <p className="mt-2 text-xs font-mono text-muted-foreground">POLICY {policy?.policyVersion ?? "—"} · NAS-required writes never fall back to local temp</p>
            </div>
            <HardDrive className="hidden h-6 w-6 opacity-60 sm:block" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border/60 bg-background/30 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Filesystem free</p>
              <p className="mt-1 text-xl font-semibold">{policy?.capacity.known && policy.capacity.freeBytes !== null ? formatBytes(policy.capacity.freeBytes) : "Unknown"}</p>
            </div>
            <div className="rounded-md border border-border/60 bg-background/30 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Accounted now</p>
              <p className="mt-1 text-xl font-semibold">{policy ? formatBytes(policy.currentBytes) : "—"}</p>
            </div>
            <div className="rounded-md border border-border/60 bg-background/30 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Projected inventory</p>
              <p className="mt-1 text-xl font-semibold">{policy ? formatBytes(policy.projectedBytes) : "—"}</p>
            </div>
          </div>
          {policy && policy.usage.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Policy</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead className="text-right">Current</TableHead>
                    <TableHead className="text-right">Projected</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policy.usage.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.category}</TableCell>
                      <TableCell>
                        <span className={`text-xs font-mono ${item.protected ? "text-amber-300" : "text-muted-foreground"}`}>
                          {item.storageClass}{item.protected ? " · PROTECTED" : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{item.destination.replaceAll("_", " ")}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{item.currentBytes === null ? "Unknown" : formatBytes(item.currentBytes)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{item.projectedBytes === null ? "Unknown" : formatBytes(item.projectedBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {policy && policy.state !== "READY" && (
            <div className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 shrink-0" /> NAS-required jobs are refused or paused until the library is safely available.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>File Types Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            {statsLoading ? <Skeleton className="w-full h-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats?.typeBreakdown || []} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={true} vertical={false} />
                  <XAxis type="number" tickFormatter={(value) => formatBytes(value)} stroke="hsl(var(--muted-foreground))" />
                  <YAxis dataKey="fileType" type="category" width={100} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip 
                    formatter={(value: number) => formatBytes(value)}
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: 'var(--radius)' }}
                  />
                  <Bar dataKey="sizeBytes" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Largest Folders</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {foldersLoading ? (
                  <TableRow><TableCell colSpan={3}><Skeleton className="h-32 w-full"/></TableCell></TableRow>
                ) : topFolders?.map((folder, i) => (
                  <TableRow key={i}>
                    <TableCell><Folder className="w-4 h-4 text-blue-400" /></TableCell>
                    <TableCell className="font-medium font-mono text-xs truncate max-w-[200px]" title={folder.folder}>{folder.folder}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatBytes(folder.totalSizeBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Largest Files</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filesLoading ? (
                  <TableRow><TableCell colSpan={3}><Skeleton className="h-32 w-full"/></TableCell></TableRow>
                ) : topFiles?.map((file, i) => (
                  <TableRow key={i}>
                    <TableCell><File className="w-4 h-4 text-muted-foreground" /></TableCell>
                    <TableCell className="font-medium text-sm truncate max-w-[200px]" title={file.path}>{file.filename}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{formatBytes(file.sizeBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}