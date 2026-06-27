import { useState, useRef } from "react";
import { useSearchFiles, getSearchFilesQueryKey } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Search as SearchIcon, File, Database, Image as ImageIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function Search() {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<string>("all");
  
  const debouncedQ = useRef(q);
  // simplified for the demo, we use a basic immediate search on enter or blur
  
  const { data, isLoading } = useSearchFiles(
    { q: q || undefined, source: source !== "all" ? source as any : undefined, limit: 50 },
    { query: { queryKey: getSearchFilesQueryKey({ q: q || undefined, source: source !== "all" ? source as any : undefined, limit: 50 }), enabled: q.length > 2 } }
  );

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-4rem)]">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">UNIVERSAL_SEARCH</h1>
      </div>

      <div className="flex gap-4 p-4 bg-secondary/30 rounded-lg border">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-primary" />
          <Input 
            placeholder="Search across all indexed files... (type at least 3 chars)" 
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-10 font-mono h-12 text-lg"
          />
        </div>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="w-[200px] h-12 font-mono">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="local">Local Files</SelectItem>
            <SelectItem value="immich">Immich Media</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead>Filename</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="w-24 text-center">Source</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!q || q.length < 3 ? (
              <TableRow><TableCell colSpan={6} className="h-64 text-center text-muted-foreground font-mono">Enter a search query to begin</TableCell></TableRow>
            ) : isLoading ? (
               <TableRow><TableCell colSpan={6} className="h-24"><Skeleton className="h-full w-full"/></TableCell></TableRow>
            ) : data?.files.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground font-mono">No results found.</TableCell></TableRow>
            ) : data?.files.map((file) => (
              <TableRow key={file.id}>
                <TableCell>
                  {file.source === 'immich' ? <ImageIcon className="h-4 w-4 text-purple-400" /> : <File className="h-4 w-4 text-blue-400" />}
                </TableCell>
                <TableCell className="font-medium">
                  {file.filename}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs truncate max-w-[200px]" title={file.folder}>
                  {file.folder}
                </TableCell>
                <TableCell className="text-center">
                  <span className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase ${file.source === 'immich' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>
                    {file.source}
                  </span>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {formatBytes(file.sizeBytes)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground text-sm">
                  {formatDate(file.modifiedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}