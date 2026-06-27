import { useState } from "react";
import { useListDocuments, getListDocumentsQueryKey } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { FileText, Search, File, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

const EXT_COLORS: Record<string, string> = {
  pdf: "text-red-400 bg-red-400/10",
  docx: "text-blue-400 bg-blue-400/10",
  doc: "text-blue-400 bg-blue-400/10",
  xlsx: "text-green-400 bg-green-400/10",
  xls: "text-green-400 bg-green-400/10",
  pptx: "text-orange-400 bg-orange-400/10",
  ppt: "text-orange-400 bg-orange-400/10",
  txt: "text-muted-foreground bg-secondary",
};

function docExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "file";
}

function DocIcon({ filename }: { filename: string }) {
  const ext = docExtension(filename);
  const cls = EXT_COLORS[ext] ?? "text-muted-foreground bg-secondary";
  return (
    <span className={`text-[9px] font-mono font-bold px-1 py-0.5 rounded uppercase ${cls}`}>
      {ext}
    </span>
  );
}

function DocumentDetailSheet({ doc, onClose }: { doc: any; onClose: () => void }) {
  const ext = docExtension(doc.filename);
  const cls = EXT_COLORS[ext] ?? "text-muted-foreground bg-secondary";
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-80">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm break-all">{doc.filename}</SheetTitle>
        </SheetHeader>
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-center p-8 bg-secondary/30 rounded-lg">
            <div className="flex flex-col items-center gap-2">
              <FileText className="w-10 h-10 text-muted-foreground" />
              <span className={`text-sm font-mono font-bold px-2 py-0.5 rounded uppercase ${cls}`}>{ext}</span>
            </div>
          </div>
          <div className="space-y-3">
            {[
              { label: "Filename", value: doc.filename },
              { label: "Full Path", value: doc.path ?? doc.folder },
              { label: "Folder", value: doc.folder },
              { label: "Extension", value: `.${ext}` },
              { label: "Size", value: doc.sizeBytes ? formatBytes(doc.sizeBytes) : "Unknown" },
              { label: "Modified", value: doc.modifiedAt ? formatDate(doc.modifiedAt) : "Unknown" },
            ].map(({ label, value }) => (
              <div key={label} className="space-y-0.5">
                <p className="text-xs text-muted-foreground font-mono uppercase">{label}</p>
                <p className="text-sm break-all">{value}</p>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" className="w-full font-mono" onClick={onClose}>
            <X className="w-3.5 h-3.5 mr-1.5" /> Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Documents() {
  const [q, setQ] = useState("");
  const [fileType, setFileType] = useState<string>("all");
  const [selectedDoc, setSelectedDoc] = useState<any | null>(null);

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
          {data?.total ?? 0} indexed documents
          <span className="ml-3 text-[10px] opacity-60">Click any row for details</span>
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
              <TableHead className="w-12">Ext</TableHead>
              <TableHead>Filename</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5}><Skeleton className="h-24 w-full" /></TableCell></TableRow>
            ) : data?.documents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground font-mono text-sm">
                  No documents found — run a scan first
                </TableCell>
              </TableRow>
            ) : data?.documents.map((doc) => (
              <TableRow
                key={doc.id}
                className="cursor-pointer hover:bg-secondary/60"
                onClick={() => setSelectedDoc(doc)}
              >
                <TableCell>
                  <DocIcon filename={doc.filename} />
                </TableCell>
                <TableCell className="font-medium">{doc.filename}</TableCell>
                <TableCell
                  className="text-muted-foreground text-xs truncate max-w-[250px]"
                  title={doc.folder}
                >
                  {doc.folder}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap font-mono text-xs">
                  {formatBytes(doc.sizeBytes)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground text-xs">
                  {formatDate(doc.modifiedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {selectedDoc && (
        <DocumentDetailSheet doc={selectedDoc} onClose={() => setSelectedDoc(null)} />
      )}
    </div>
  );
}
