import { useGetStorageStats, getGetStorageStatsQueryKey, useGetTopFolders, getGetTopFoldersQueryKey, useGetTopFiles, getGetTopFilesQueryKey } from "@workspace/api-client-react";
import { formatBytes } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Folder, File } from "lucide-react";

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

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold font-mono tracking-tight">STORAGE_ANALYSIS</h1>

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