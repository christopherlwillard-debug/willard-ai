import { useState } from "react";
import { useSearchFiles, getSearchFilesQueryKey } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Search as SearchIcon, File, Image as ImageIcon, Video, FileText, Archive } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

const FILE_TYPES = [
  { value: "all", label: "All Types" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "document", label: "Documents" },
  { value: "archive", label: "Archives" },
  { value: "audio", label: "Audio" },
  { value: "code", label: "Code" },
  { value: "other", label: "Other" },
];

function fileTypeIcon(fileType: string | undefined, source: string | undefined) {
  if (source === "immich") return <ImageIcon className="h-4 w-4 text-purple-400" />;
  switch (fileType) {
    case "image": return <ImageIcon className="h-4 w-4 text-blue-400" />;
    case "video": return <Video className="h-4 w-4 text-purple-400" />;
    case "document": return <FileText className="h-4 w-4 text-amber-400" />;
    case "archive": return <Archive className="h-4 w-4 text-orange-400" />;
    default: return <File className="h-4 w-4 text-muted-foreground" />;
  }
}

export default function Search() {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<string>("all");
  const [fileType, setFileType] = useState<string>("all");

  const params = {
    q: q || undefined,
    source: source !== "all" ? (source as any) : undefined,
    fileType: fileType !== "all" ? fileType : undefined,
    limit: 50,
  };

  const { data, isLoading } = useSearchFiles(params, {
    query: {
      queryKey: getSearchFilesQueryKey(params),
      enabled: q.length >= 2,
    },
  });

  const total = (data as any)?.total ?? data?.files.length ?? 0;
  const sources = (data as any)?.sources;

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-4rem)]">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">UNIVERSAL_SEARCH</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Search across local NAS files and Immich media library
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 p-4 bg-secondary/30 rounded-lg border">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-primary" />
          <Input
            placeholder="Search files by name… (min 2 chars)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-10 font-mono h-11"
            autoFocus
          />
        </div>
        <Select value={fileType} onValueChange={setFileType}>
          <SelectTrigger className="w-full sm:w-[160px] h-11 font-mono">
            <SelectValue placeholder="File type" />
          </SelectTrigger>
          <SelectContent>
            {FILE_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="w-full sm:w-[160px] h-11 font-mono">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="local">Local Files</SelectItem>
            <SelectItem value="immich">Immich Media</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {q.length >= 2 && data && (
        <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground px-1">
          <span>{total.toLocaleString()} results</span>
          {sources && (
            <>
              <span className="text-blue-400">local: {sources.local}</span>
              <span className="text-purple-400">immich: {sources.immich}</span>
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead>Filename</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="w-20 text-center">Type</TableHead>
              <TableHead className="w-20 text-center">Source</TableHead>
              <TableHead className="text-right w-24">Size</TableHead>
              <TableHead className="text-right w-28">Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.length < 2 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-64 text-center text-muted-foreground font-mono">
                  Enter a search query to begin
                </TableCell>
              </TableRow>
            ) : isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24">
                  <Skeleton className="h-full w-full" />
                </TableCell>
              </TableRow>
            ) : !data?.files.length ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-16 text-muted-foreground font-mono">
                  No results found for "{q}"
                </TableCell>
              </TableRow>
            ) : (
              data.files.map((file) => (
                <TableRow key={file.id}>
                  <TableCell>{fileTypeIcon(file.fileType, file.source)}</TableCell>
                  <TableCell className="font-medium font-mono text-sm">{file.filename}</TableCell>
                  <TableCell
                    className="text-muted-foreground font-mono text-xs truncate max-w-[200px]"
                    title={file.folder}
                  >
                    {file.folder}
                  </TableCell>
                  <TableCell className="text-center">
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-secondary text-muted-foreground uppercase">
                      {file.fileType ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase ${
                        file.source === "immich"
                          ? "bg-purple-500/20 text-purple-400"
                          : "bg-blue-500/20 text-blue-400"
                      }`}
                    >
                      {file.source}
                    </span>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap font-mono text-xs">
                    {formatBytes(file.sizeBytes)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap text-muted-foreground text-xs">
                    {formatDate(file.modifiedAt)}
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
