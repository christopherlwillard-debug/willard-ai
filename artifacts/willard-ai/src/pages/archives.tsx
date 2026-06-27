import { useState } from "react";
import { useListArchives, getListArchivesQueryKey, usePeekArchive } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Archive, Lock, Layers, Eye, File, Folder } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function Archives() {
  const [page, setPage] = useState(0);
  const limit = 50;
  
  const { data, isLoading } = useListArchives(
    { limit, offset: page * limit },
    { query: { queryKey: getListArchivesQueryKey({ limit, offset: page * limit }) } }
  );

  const [selectedArchiveId, setSelectedArchiveId] = useState<number | null>(null);
  
  const peekMutation = usePeekArchive({
    mutation: {
      onSuccess: () => {
        // In a real app we might refetch or set data locally
      }
    }
  });

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
               <TableRow><TableCell colSpan={6}><Skeleton className="h-24 w-full"/></TableCell></TableRow>
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
                <TableCell className="text-right">
                  {formatBytes(archive.sizeBytes)}
                </TableCell>
                <TableCell className="text-right">
                  <span className={`text-xs px-2 py-1 rounded ${archive.peekStatus === 'success' ? 'bg-green-500/20 text-green-500' : 'bg-secondary text-muted-foreground'}`}>
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

      <Dialog open={!!selectedArchiveId} onOpenChange={(open) => !open && setSelectedArchiveId(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Archive Contents</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
             <div className="p-4 text-center text-muted-foreground">
               Peek functionality details would load here for archive ID: {selectedArchiveId}
             </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}