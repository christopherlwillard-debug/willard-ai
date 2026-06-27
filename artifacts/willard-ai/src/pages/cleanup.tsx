import { useGetCleanupSummary, getGetCleanupSummaryQueryKey, useGetDuplicateFiles, getGetDuplicateFilesQueryKey } from "@workspace/api-client-react";
import { formatBytes } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Copy, FileWarning, Clock, FolderArchive } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export default function Cleanup() {
  const { data: summary, isLoading: summaryLoading } = useGetCleanupSummary({
    query: { queryKey: getGetCleanupSummaryQueryKey() }
  });

  const { data: duplicates, isLoading: dupesLoading } = useGetDuplicateFiles(
    { limit: 20 },
    { query: { queryKey: getGetDuplicateFilesQueryKey({ limit: 20 }) } }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold font-mono tracking-tight">CLEANUP_SUGGESTIONS</h1>
        <div className="flex items-center space-x-2 text-destructive bg-destructive/10 px-3 py-1.5 rounded-md font-mono">
          <Trash2 className="w-4 h-4" />
          <span>Potential savings: {summary ? formatBytes(summary.duplicateWastedBytes + summary.largeFilesBytes) : '---'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-destructive">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Duplicates</CardTitle>
            <Copy className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.duplicateGroups.toLocaleString() ?? '--'} groups</div>
            <p className="text-xs text-muted-foreground mt-1">Wasting {summary ? formatBytes(summary.duplicateWastedBytes) : '--'}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Large Files {'>'}500MB</CardTitle>
            <FileWarning className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.largeFileCount.toLocaleString() ?? '--'}</div>
            <p className="text-xs text-muted-foreground mt-1">Totaling {summary ? formatBytes(summary.largeFilesBytes) : '--'}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-blue-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Old Files {'>'}5yrs</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.oldFileCount.toLocaleString() ?? '--'}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-green-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Empty Folders</CardTitle>
            <FolderArchive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.emptyFolderCount.toLocaleString() ?? '--'}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Duplicate Groups</CardTitle>
        </CardHeader>
        <CardContent>
          {dupesLoading ? (
            <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : (
            <Accordion type="single" collapsible className="w-full">
              {duplicates?.groups.map((group, i) => (
                <AccordionItem key={group.hash} value={`item-${i}`}>
                  <AccordionTrigger className="hover:no-underline py-3 px-4 bg-secondary/30 rounded-md mb-2">
                    <div className="flex justify-between items-center w-full pr-4">
                      <span className="font-mono text-sm">Hash: {group.hash.substring(0,8)}... ({group.fileCount} files)</span>
                      <span className="text-destructive font-medium bg-destructive/10 px-2 py-0.5 rounded text-xs">
                        Wastes {formatBytes(group.totalWastedBytes)}
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pt-2 pb-4">
                    <div className="space-y-2">
                      {group.files.map(file => (
                        <div key={file.id} className="flex justify-between items-center text-sm p-2 bg-secondary/10 border rounded">
                          <span className="truncate font-mono text-xs text-muted-foreground">{file.path}</span>
                          <span className="whitespace-nowrap ml-4">{formatBytes(file.sizeBytes)}</span>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>
    </div>
  );
}