import { useGetCleanupSummary, getGetCleanupSummaryQueryKey, useGetDuplicateFiles, getGetDuplicateFilesQueryKey, useListArchives, getListArchivesQueryKey } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Copy, FileWarning, Clock, FolderOpen, Package, Download } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function exportReport(summary: any, duplicates: any, archives: any) {
  const lines: string[] = [
    "WILLARD AI — CLEANUP REPORT",
    `Generated: ${new Date().toLocaleString()}`,
    "",
    "=== SUMMARY ===",
    `Duplicate groups:    ${summary?.duplicateGroups ?? 0}  (wasting ${formatBytes(summary?.duplicateWastedBytes ?? 0)})`,
    `Large files >500MB:  ${summary?.largeFileCount ?? 0}  (totaling ${formatBytes(summary?.largeFilesBytes ?? 0)})`,
    `Old files >5yrs:     ${summary?.oldFileCount ?? 0}`,
    `Empty folders:       ${summary?.emptyFolderCount ?? 0}`,
    "",
  ];

  if (duplicates?.groups?.length) {
    lines.push("=== DUPLICATE GROUPS ===");
    for (const g of duplicates.groups) {
      lines.push(`  Hash ${g.hash} (${g.fileCount} copies, wastes ${formatBytes(g.totalWastedBytes)}):`);
      for (const f of g.files) {
        lines.push(`    - ${f.path}`);
      }
    }
    lines.push("");
  }

  if (archives?.archives?.length) {
    lines.push("=== ARCHIVE CLUSTERS ===");
    const byCategory: Record<string, any[]> = {};
    for (const a of archives.archives) {
      const cat = a.category ?? "general";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(a);
    }
    for (const [cat, items] of Object.entries(byCategory)) {
      const totalSize = items.reduce((s, a) => s + (a.sizeBytes ?? 0), 0);
      lines.push(`  ${cat.toUpperCase()} (${items.length} archives, ${formatBytes(totalSize)}):`);
      for (const a of items.slice(0, 5)) {
        lines.push(`    - ${a.filename} (${formatBytes(a.sizeBytes)})`);
      }
      if (items.length > 5) lines.push(`    ... and ${items.length - 5} more`);
    }
    lines.push("");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `willard-cleanup-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Cleanup() {
  const { data: summary, isLoading: summaryLoading } = useGetCleanupSummary({
    query: { queryKey: getGetCleanupSummaryQueryKey() },
  });

  const { data: duplicates, isLoading: dupesLoading } = useGetDuplicateFiles(
    { limit: 20 },
    { query: { queryKey: getGetDuplicateFilesQueryKey({ limit: 20 }) } }
  );

  const { data: archives, isLoading: archivesLoading } = useListArchives(
    { limit: 200 },
    { query: { queryKey: getListArchivesQueryKey({ limit: 200 }) } }
  );

  // Cluster archives by category
  const archiveClusters: Record<string, { items: any[]; totalSize: number }> = {};
  for (const a of archives?.archives ?? []) {
    const cat = a.category ?? "general";
    if (!archiveClusters[cat]) archiveClusters[cat] = { items: [], totalSize: 0 };
    archiveClusters[cat].items.push(a);
    archiveClusters[cat].totalSize += a.sizeBytes ?? 0;
  }
  const clusterEntries = Object.entries(archiveClusters).sort((a, b) => b[1].totalSize - a[1].totalSize);

  const totalSavings = (summary?.duplicateWastedBytes ?? 0) + (summary?.largeFilesBytes ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-3xl font-bold font-mono tracking-tight">CLEANUP_SUGGESTIONS</h1>
        <div className="flex items-center gap-2">
          <div className="flex items-center space-x-2 text-destructive bg-destructive/10 px-3 py-1.5 rounded-md font-mono text-sm">
            <Trash2 className="w-4 h-4" />
            <span>Potential savings: {formatBytes(totalSavings)}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="font-mono"
            onClick={() => exportReport(summary, duplicates, archives)}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" /> Export Report
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-destructive">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Duplicates</CardTitle>
            <Copy className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.duplicateGroups.toLocaleString() ?? "--"}</div>
            <p className="text-xs text-muted-foreground mt-1">Wasting {formatBytes(summary?.duplicateWastedBytes ?? 0)}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Large &gt;500MB</CardTitle>
            <FileWarning className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.largeFileCount.toLocaleString() ?? "--"}</div>
            <p className="text-xs text-muted-foreground mt-1">{formatBytes(summary?.largeFilesBytes ?? 0)}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-blue-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Old &gt;5 Years</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.oldFileCount.toLocaleString() ?? "--"}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-green-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Empty Folders</CardTitle>
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.emptyFolderCount.toLocaleString() ?? "--"}</div>
          </CardContent>
        </Card>
      </div>

      {/* Detail tabs */}
      <Tabs defaultValue="duplicates">
        <TabsList>
          <TabsTrigger value="duplicates">Duplicate Groups</TabsTrigger>
          <TabsTrigger value="archives">Archive Clusters</TabsTrigger>
        </TabsList>

        <TabsContent value="duplicates" className="mt-4">
          <Card>
            <CardContent className="pt-4">
              {dupesLoading || summaryLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : !duplicates?.groups.length ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">
                  No duplicate groups found — run a full scan first (hashing enabled)
                </p>
              ) : (
                <Accordion type="single" collapsible className="w-full">
                  {duplicates.groups.map((group, i) => (
                    <AccordionItem key={group.hash} value={`item-${i}`}>
                      <AccordionTrigger className="hover:no-underline py-3 px-4 bg-secondary/30 rounded-md mb-2">
                        <div className="flex justify-between items-center w-full pr-4">
                          <span className="font-mono text-sm">
                            Hash: {group.hash.substring(0, 8)}… ({group.fileCount} copies)
                          </span>
                          <span className="text-destructive font-medium bg-destructive/10 px-2 py-0.5 rounded text-xs">
                            Wastes {formatBytes(group.totalWastedBytes)}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pt-2 pb-4">
                        <div className="space-y-1.5">
                          {group.files.map((file) => (
                            <div key={file.id} className="flex justify-between items-center text-sm p-2 bg-secondary/10 border rounded">
                              <span className="truncate font-mono text-xs text-muted-foreground">{file.path}</span>
                              <span className="whitespace-nowrap ml-4 font-mono text-xs">{formatBytes(file.sizeBytes)}</span>
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
        </TabsContent>

        <TabsContent value="archives" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-mono">ARCHIVE_CLUSTERS</CardTitle>
              <p className="text-xs text-muted-foreground">Archives grouped by category — identify large backup clusters</p>
            </CardHeader>
            <CardContent>
              {archivesLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : clusterEntries.length === 0 ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">
                  No archives indexed — run a scan first
                </p>
              ) : (
                <Accordion type="single" collapsible className="w-full">
                  {clusterEntries.map(([cat, cluster]) => (
                    <AccordionItem key={cat} value={cat}>
                      <AccordionTrigger className="hover:no-underline py-3 px-4 bg-secondary/30 rounded-md mb-2">
                        <div className="flex justify-between items-center w-full pr-4">
                          <span className="flex items-center gap-2 font-mono text-sm">
                            <Package className="w-4 h-4 text-amber-500" />
                            {cat.toUpperCase()} ({cluster.items.length} archives)
                          </span>
                          <span className="bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded text-xs font-mono">
                            {formatBytes(cluster.totalSize)}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pb-4">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Filename</TableHead>
                              <TableHead>Folder</TableHead>
                              <TableHead className="text-right">Size</TableHead>
                              <TableHead className="text-right">Modified</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {cluster.items.slice(0, 20).map((a) => (
                              <TableRow key={a.id}>
                                <TableCell className="font-mono text-xs">{a.filename}</TableCell>
                                <TableCell className="text-muted-foreground text-xs truncate max-w-[160px]">{a.folder}</TableCell>
                                <TableCell className="text-right font-mono text-xs">{formatBytes(a.sizeBytes)}</TableCell>
                                <TableCell className="text-right text-xs text-muted-foreground">{formatDate(a.modifiedAt)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        {cluster.items.length > 20 && (
                          <p className="text-xs text-muted-foreground font-mono mt-2 text-center">
                            … and {cluster.items.length - 20} more (export report to see all)
                          </p>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
