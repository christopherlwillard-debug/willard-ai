import { useState } from "react";
import { useListFolder, getListFolderQueryKey } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Folder, File, ChevronRight, CornerLeftUp, HardDrive, ArrowUp, ArrowDown, X, Archive } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

type SortKey = "name" | "size" | "modified";
type SortDir = "asc" | "desc";

interface FolderEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isArchive?: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  fileType?: string;
}

function SortableHead({ label, sortKey, current, dir, onClick }: {
  label: string; sortKey: SortKey; current: SortKey; dir: SortDir; onClick: (k: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <TableHead
      className="cursor-pointer select-none hover:text-foreground transition-colors"
      onClick={() => onClick(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : null}
      </span>
    </TableHead>
  );
}

export default function Explorer() {
  const [currentPath, setCurrentPath] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selectedFile, setSelectedFile] = useState<FolderEntry | null>(null);

  const { data, isLoading } = useListFolder(
    { path: currentPath },
    { query: { queryKey: getListFolderQueryKey({ path: currentPath }) } }
  );

  const navigateTo = (newPath: string) => setCurrentPath(newPath);

  const navigateUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join("/"));
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const breadcrumbs = currentPath.split("/").filter(Boolean);

  const sorted = [...(data?.entries ?? [])].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "name") cmp = a.name.localeCompare(b.name);
    else if (sortKey === "size") cmp = (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
    else if (sortKey === "modified") cmp = (a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? "");
    // Always directories first
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return sortDir === "asc" ? cmp : -cmp;
  });

  return (
    <div className="space-y-4 flex flex-col h-[calc(100vh-4rem)]">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">FILE_EXPLORER</h1>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center flex-wrap gap-1 bg-secondary/50 p-2.5 rounded-md font-mono text-sm">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigateTo("")}>
          <HardDrive className="h-4 w-4" />
        </Button>
        {breadcrumbs.map((crumb, index) => {
          const path = breadcrumbs.slice(0, index + 1).join("/");
          return (
            <div key={path} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <Button variant="ghost" className="h-6 px-2 text-xs hover:bg-secondary" onClick={() => navigateTo(path)}>
                {crumb}
              </Button>
            </div>
          );
        })}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <SortableHead label="Name" sortKey="name" current={sortKey} dir={sortDir} onClick={handleSort} />
              <SortableHead label="Size" sortKey="size" current={sortKey} dir={sortDir} onClick={handleSort} />
              <SortableHead label="Modified" sortKey="modified" current={sortKey} dir={sortDir} onClick={handleSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {currentPath !== "" && (
              <TableRow className="cursor-pointer hover:bg-secondary/50" onClick={navigateUp}>
                <TableCell><CornerLeftUp className="h-4 w-4 text-muted-foreground" /></TableCell>
                <TableCell className="font-medium text-muted-foreground" colSpan={3}>..</TableCell>
              </TableRow>
            )}
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center">
                  <div className="space-y-2 p-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-full" /></div>
                </TableCell>
              </TableRow>
            ) : sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground font-mono text-sm">
                  {currentPath === "" ? "Configure NAS path in Settings to browse files" : "Empty folder"}
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((entry) => (
                <TableRow
                  key={entry.path}
                  className="cursor-pointer hover:bg-secondary/50"
                  onClick={() => {
                    if (entry.isDirectory) navigateTo(entry.path);
                    else setSelectedFile(entry as FolderEntry);
                  }}
                >
                  <TableCell>
                    {entry.isDirectory ? (
                      <Folder className="h-4 w-4 text-blue-400 fill-blue-400/20" />
                    ) : entry.isArchive ? (
                      <Archive className="h-4 w-4 text-orange-400" />
                    ) : (
                      <File className="h-4 w-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="font-medium">
                    <span className="truncate">{entry.name}</span>
                    {entry.isArchive && (
                      <span className="ml-2 text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded font-mono">Archive</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground font-mono text-xs">
                    {entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : (entry.isDirectory ? "—" : "--")}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-xs">
                    {entry.modifiedAt ? formatDate(entry.modifiedAt) : "--"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* File Detail Sheet */}
      <Sheet open={!!selectedFile} onOpenChange={(open) => !open && setSelectedFile(null)}>
        <SheetContent side="right" className="w-80">
          <SheetHeader>
            <SheetTitle className="font-mono text-sm truncate">{selectedFile?.name}</SheetTitle>
          </SheetHeader>
          {selectedFile && (
            <div className="mt-6 space-y-4">
              <div className="flex items-center justify-center p-8 bg-secondary/30 rounded-lg">
                {selectedFile.isArchive
                  ? <Archive className="w-12 h-12 text-orange-400" />
                  : <File className="w-12 h-12 text-muted-foreground" />}
              </div>
              <div className="space-y-3">
                {[
                  { label: "Name", value: selectedFile.name },
                  { label: "Path", value: selectedFile.path },
                  { label: "Size", value: selectedFile.sizeBytes !== null ? formatBytes(selectedFile.sizeBytes) : "Unknown" },
                  { label: "Modified", value: selectedFile.modifiedAt ? formatDate(selectedFile.modifiedAt) : "Unknown" },
                  { label: "Type", value: selectedFile.fileType ?? (selectedFile.isArchive ? "archive" : "file") },
                ].map(({ label, value }) => (
                  <div key={label} className="space-y-0.5">
                    <p className="text-xs text-muted-foreground font-mono uppercase">{label}</p>
                    <p className="text-sm break-all">{value}</p>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" className="w-full font-mono" onClick={() => setSelectedFile(null)}>
                <X className="w-3.5 h-3.5 mr-1.5" /> Close
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
