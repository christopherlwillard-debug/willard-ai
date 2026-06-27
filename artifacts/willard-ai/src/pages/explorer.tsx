import { useState } from "react";
import { useListFolder, getListFolderQueryKey } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Folder, File, ChevronRight, CornerLeftUp, HardDrive } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export default function Explorer() {
  const [currentPath, setCurrentPath] = useState("");
  
  const { data, isLoading } = useListFolder(
    { path: currentPath },
    { query: { queryKey: getListFolderQueryKey({ path: currentPath }) } }
  );

  const navigateTo = (newPath: string) => setCurrentPath(newPath);
  
  const navigateUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join('/'));
  };

  const breadcrumbs = currentPath.split('/').filter(Boolean);

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center space-x-2 bg-secondary/50 p-3 rounded-md font-mono text-sm">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => navigateTo("")}>
          <HardDrive className="h-4 w-4" />
        </Button>
        {breadcrumbs.map((crumb, index) => {
          const path = breadcrumbs.slice(0, index + 1).join('/');
          return (
            <div key={path} className="flex items-center space-x-2">
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <Button 
                variant="ghost" 
                className="h-6 px-2 hover:bg-secondary"
                onClick={() => navigateTo(path)}
              >
                {crumb}
              </Button>
            </div>
          );
        })}
      </div>

      <div className="flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {currentPath !== "" && (
              <TableRow className="cursor-pointer hover:bg-secondary/50" onClick={navigateUp}>
                <TableCell><CornerLeftUp className="h-4 w-4 text-muted-foreground" /></TableCell>
                <TableCell className="font-medium text-muted-foreground">..</TableCell>
                <TableCell></TableCell>
                <TableCell></TableCell>
              </TableRow>
            )}
            
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                </TableCell>
              </TableRow>
            ) : data?.entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  Empty folder
                </TableCell>
              </TableRow>
            ) : (
              data?.entries.map((entry) => (
                <TableRow 
                  key={entry.path}
                  className={entry.isDirectory ? "cursor-pointer hover:bg-secondary/50" : ""}
                  onClick={() => entry.isDirectory && navigateTo(entry.path)}
                >
                  <TableCell>
                    {entry.isDirectory ? (
                      <Folder className="h-4 w-4 text-blue-400 fill-blue-400/20" />
                    ) : (
                      <File className="h-4 w-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="font-medium">
                    {entry.name}
                    {entry.isArchive && <span className="ml-2 text-xs bg-primary/20 text-primary px-2 py-0.5 rounded">Archive</span>}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '--'}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {entry.modifiedAt ? formatDate(entry.modifiedAt) : '--'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}