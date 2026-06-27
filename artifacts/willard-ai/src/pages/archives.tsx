import { useState } from "react";
import { useListArchives, getListArchivesQueryKey, usePeekArchive, useGetArchive } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Archive, Lock, Layers, Eye, File, Folder, Image, Video, FileText, Package } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryClient } from "@tanstack/react-query";

function fileIcon(fileType: string) {
  switch (fileType) {
    case "image": return <Image className="w-3.5 h-3.5 text-blue-400" />;
    case "video": return <Video className="w-3.5 h-3.5 text-purple-400" />;
    case "document": return <FileText className="w-3.5 h-3.5 text-amber-400" />;
    case "archive": return <Package className="w-3.5 h-3.5 text-orange-400" />;
    default: return <File className="w-3.5 h-3.5 text-muted-foreground" />;
  }
}

function ArchivePeekDialog({ archiveId, onClose }: { archiveId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: archiveData, isLoading: archiveLoading } = useGetArchive(archiveId);
  const peekMutation = usePeekArchive({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListArchivesQueryKey({}) });
      },
    },
  });

  const entries = (archiveData?.peekEntries as any[]) ?? [];
  const hasPeeked = archiveData?.peekStatus === "peeked";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono flex items-center gap-2">
            <Archive className="w-4 h-4" />
            {archiveData?.filename ?? "Archive"}
          </DialogTitle>
          {archiveData && (
            <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground font-mono">
              <span>{formatBytes(archiveData.sizeBytes)}</span>
              {archiveData.containedFileCount != null && (
                <span>{archiveData.containedFileCount} files</span>
              )}
              {archiveData.estimatedExtractionSize != null && archiveData.estimatedExtractionSize > 0 && (
                <span>~{formatBytes(archiveData.estimatedExtractionSize)} extracted</span>
              )}
              {archiveData.isPasswordProtected && (
                <span className="text-destructive flex items-center gap-1"><Lock className="w-3 h-3" /> Encrypted</span>
              )}
              {archiveData.hasNestedArchives && (
                <span className="text-amber-500 flex items-center gap-1"><Layers className="w-3 h-3" /> Nested archives</span>
              )}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-3">
          {!hasPeeked && !archiveLoading && (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-muted-foreground">
              <Archive className="w-10 h-10 opacity-30" />
              <p className="text-sm font-mono">Archive not yet inspected</p>
              <Button
                size="sm"
                onClick={() => peekMutation.mutate({ id: archiveId })}
                disabled={peekMutation.isPending}
              >
                {peekMutation.isPending ? "Reading..." : "Peek Inside"}
              </Button>
              {peekMutation.isError && (
                <p className="text-xs text-destructive">Failed to peek — file may be inaccessible</p>
              )}
            </div>
          )}

          {archiveLoading && (
            <div className="space-y-2 p-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          )}

          {hasPeeked && entries.length === 0 && (
            <p className="text-sm text-muted-foreground font-mono text-center py-8">Archive is empty or could not be read</p>
          )}

          {hasPeeked && entries.length > 0 && (
            <ScrollArea className="flex-1 rounded-md border">
              <div className="font-mono text-xs">
                <div className="grid grid-cols-[1.5rem_1fr_auto_auto] gap-x-3 px-3 py-2 border-b text-muted-foreground uppercase tracking-wider">
                  <span></span>
                  <span>Path</span>
                  <span>Type</span>
                  <span className="text-right">Size</span>
                </div>
                {entries.map((entry: any, i: number) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1.5rem_1fr_auto_auto] gap-x-3 px-3 py-1.5 hover:bg-muted/40 items-center border-b border-border/30"
                  >
                    <span className="flex items-center justify-center">
                      {entry.isDirectory ? <Folder className="w-3.5 h-3.5 text-muted-foreground" /> : fileIcon(entry.fileType)}
                    </span>
                    <span className="truncate text-foreground/80" title={entry.path}>{entry.path}</span>
                    <span className="text-muted-foreground">{entry.fileType ?? "—"}</span>
                    <span className="text-right text-muted-foreground">
                      {entry.isDirectory ? "—" : formatBytes(entry.sizeBytes ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Archives() {
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = useListArchives(
    { limit, offset: page * limit },
    { query: { queryKey: getListArchivesQueryKey({ limit, offset: page * limit }) } }
  );

  const [selectedArchiveId, setSelectedArchiveId] = useState<number | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">ARCHIVE_INDEX</h1>
        <p className="text-muted-foreground mt-2 font-mono">
          Found {data?.total ?? 0} indexed archives
        </p>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead>Filename</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Status</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-24 w-full" /></TableCell></TableRow>
            ) : data?.archives.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8 font-mono text-sm">
                  No archives indexed yet — run a scan first
                </TableCell>
              </TableRow>
            ) : data?.archives.map((archive) => (
              <TableRow key={archive.id}>
                <TableCell>
                  <Archive className="h-4 w-4 text-muted-foreground" />
                </TableCell>
                <TableCell className="font-medium">
                  {archive.filename}
                  <div className="flex gap-2 mt-1">
                    {archive.isPasswordProtected && (
                      <span className="inline-flex items-center text-[10px] bg-destructive/10 text-destructive px-1.5 py-0.5 rounded">
                        <Lock className="w-3 h-3 mr-1" /> Encrypted
                      </span>
                    )}
                    {archive.hasNestedArchives && (
                      <span className="inline-flex items-center text-[10px] bg-amber-500/10 text-amber-500 px-1.5 py-0.5 rounded">
                        <Layers className="w-3 h-3 mr-1" /> Nested
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm truncate max-w-[200px]" title={archive.folder}>
                  {archive.folder}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {formatBytes(archive.sizeBytes)}
                </TableCell>
                <TableCell className="text-right">
                  <span className={`text-xs px-2 py-1 rounded font-mono ${archive.peekStatus === "peeked" ? "bg-green-500/20 text-green-500" : "bg-secondary text-muted-foreground"}`}>
                    {archive.peekStatus}
                  </span>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedArchiveId(archive.id)}>
                    <Eye className="w-4 h-4 mr-2" /> Peek
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {data && data.total > limit && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <Button variant="outline" size="sm" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}

      {selectedArchiveId !== null && (
        <ArchivePeekDialog archiveId={selectedArchiveId} onClose={() => setSelectedArchiveId(null)} />
      )}
    </div>
  );
}
