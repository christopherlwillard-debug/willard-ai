import { useState } from "react";
import { useListDocuments, getListDocumentsQueryKey } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { FileText, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Documents() {
  const [q, setQ] = useState("");
  const [fileType, setFileType] = useState<string>("all");
  
  const { data, isLoading } = useListDocuments(
    { 
      q: q || undefined, 
      fileType: fileType !== "all" ? fileType as any : undefined,
      limit: 100 
    },
    { 
      query: { 
        queryKey: getListDocumentsQueryKey({ 
          q: q || undefined, 
          fileType: fileType !== "all" ? fileType as any : undefined,
          limit: 100 
        }) 
      } 
    }
  );

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-4rem)]">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">DOCUMENT_VAULT</h1>
        <p className="text-muted-foreground mt-2 font-mono">
          Found {data?.total ?? 0} indexed documents
        </p>
      </div>

      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search documents..." 
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9 font-mono"
          />
        </div>
        <Select value={fileType} onValueChange={setFileType}>
          <SelectTrigger className="w-[180px] font-mono">
            <SelectValue placeholder="File Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="pdf">PDF</SelectItem>
            <SelectItem value="docx">Word (DOCX)</SelectItem>
            <SelectItem value="xlsx">Excel (XLSX)</SelectItem>
            <SelectItem value="pptx">PowerPoint</SelectItem>
            <SelectItem value="txt">Text (TXT)</SelectItem>
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
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
               <TableRow><TableCell colSpan={5}><Skeleton className="h-24 w-full"/></TableCell></TableRow>
            ) : data?.documents.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No documents found.</TableCell></TableRow>
            ) : data?.documents.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell>
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </TableCell>
                <TableCell className="font-medium">
                  {doc.filename}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm truncate max-w-[250px]" title={doc.folder}>
                  {doc.folder}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {formatBytes(doc.sizeBytes)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                  {formatDate(doc.modifiedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}