import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, FolderCheck, HardDrive, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { apiUrl } from "@/lib/api";

type Report = {
  checkedAt: string;
  libraryPath: string | null;
  libraryKey?: string | null;
  indexedFiles?: number;
  status: "healthy" | "attention" | "action_required";
  issues: Record<string, number>;
  error?: string;
};

const checks = [
  ["missingFiles", "Missing files", "Indexed files that no longer exist on the NAS"],
  ["orphanedIndexRecords", "Orphaned index records", "Stale catalog records with no matching file"],
  ["missingThumbnails", "Missing thumbnails", "Media that needs a thumbnail regenerated"],
  ["orphanedThumbnails", "Orphaned thumbnails", "Cache images with no matching catalog record"],
  ["emptyFolders", "Empty folders", "Folders containing no files or subfolders"],
  ["brokenMetadataReferences", "Broken metadata references", "Derived metadata pointing to missing media"],
  ["unusedCacheBytes", "Unused cache", "Non-thumbnail cache data that can be reviewed"],
] as const;

const actions = [
  ["orphanedRecords", "Remove orphaned database records"],
  ["orphanedDerivedData", "Remove orphaned AI and face data"],
  ["orphanedThumbnails", "Delete orphaned thumbnails"],
  ["missingThumbnails", "Regenerate missing thumbnails"],
  ["emptyFolders", "Remove empty folders"],
  ["rebuildMetadata", "Rebuild metadata on the next scan"],
  ["fullThumbnailRebuild", "Full thumbnail rebuild"],
] as const;

export default function Health() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number; message: string } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(apiUrl("/media/health"));
      if (!response.ok) throw new Error("Health scan failed");
      setReport(await response.json());
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Health scan failed"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const issueCount = useMemo(() => Object.entries(report?.issues ?? {}).reduce((sum, [key, value]) => sum + (key === "unusedCacheBytes" ? 0 : value), 0), [report]);
  const statusLabel = report?.status === "healthy" ? "Library Healthy" : report?.status === "action_required" ? "Action Required" : "Attention Needed";
  const statusColor = report?.status === "healthy" ? "text-emerald-400" : report?.status === "action_required" ? "text-red-400" : "text-amber-400";

  const runCleanup = async () => {
    setRunning(true); setProgress({ processed: 0, total: 1, message: "Checking media index…" }); setError("");
    try {
      const response = await fetch(apiUrl("/media/cleanup"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actions: selected }),
      });
      if (!response.ok || !response.body) throw new Error("Cleanup could not start");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event.match(/^data: (.+)$/m)?.[1];
          if (!data) continue;
          const parsed = JSON.parse(data) as { processed?: number; total?: number; message?: string };
          if (parsed.message) setProgress({ processed: parsed.processed ?? 0, total: parsed.total ?? 1, message: parsed.message });
        }
      }
      setSelected([]);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Cleanup failed"); }
    finally { setRunning(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-primary">Library maintenance</p>
          <h1 className="text-3xl font-bold tracking-tight mt-1">Health Center</h1>
          <p className="text-muted-foreground mt-1">Review index, cache, metadata, and folder integrity without touching original media.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" /> Verify now</Button>
      </div>

      <Card className="border-border">
        <CardContent className="flex flex-wrap items-center gap-4 py-5">
          {report?.status === "healthy" ? <CheckCircle2 className="h-10 w-10 text-emerald-400" /> : <AlertTriangle className={`h-10 w-10 ${statusColor}`} />}
          <div className="flex-1 min-w-[220px]">
            <p className={`text-xl font-semibold ${statusColor}`}>{loading ? "Checking library…" : statusLabel}</p>
             <p className="text-sm text-muted-foreground">
               {report?.libraryPath ?? "No library configured"}
               {report?.libraryPath ? ` · ${(report.indexedFiles ?? 0).toLocaleString()} indexed files` : ""}
               {issueCount > 0 ? ` · ${issueCount.toLocaleString()} issue${issueCount === 1 ? "" : "s"} found` : ""}
             </p>
          </div>
          <div className="text-right text-xs text-muted-foreground font-mono">
            <p>LAST VERIFIED</p><p>{report?.checkedAt ? new Date(report.checkedAt).toLocaleString() : "—"}</p>
          </div>
        </CardContent>
      </Card>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map(([key, label, description]) => (
          <Card key={key}>
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-medium">{label}</p><p className="text-xs text-muted-foreground mt-1">{description}</p></div>
                <span className={`text-2xl font-bold tabular-nums ${((report?.issues[key] ?? 0) > 0) ? "text-amber-400" : "text-emerald-400"}`}>{key === "unusedCacheBytes" ? formatBytes(report?.issues[key] ?? 0) : (report?.issues[key] ?? 0).toLocaleString()}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /> Selective cleanup</CardTitle><p className="text-sm text-muted-foreground">Only checked maintenance actions will run. Original NAS media is never deleted.</p></CardHeader>
        <CardContent className="space-y-3">
          {actions.map(([key, label]) => <label key={key} className="flex items-center gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-muted/40"><input type="checkbox" checked={selected.includes(key)} disabled={running} onChange={(e) => setSelected(current => e.target.checked ? [...current, key] : current.filter(item => item !== key))} /><span className="text-sm">{label}</span></label>)}
          {progress && running && <div className="rounded-md bg-muted/40 p-3"><div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin text-primary" />{progress.message}</div><div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (progress.processed / Math.max(progress.total, 1)) * 100)}%` }} /></div><p className="mt-1 text-xs text-muted-foreground">{progress.processed} / {progress.total}</p></div>}
          <Button onClick={() => void runCleanup()} disabled={running || selected.length === 0}><Trash2 className="mr-2 h-4 w-4" /> {running ? "Running cleanup…" : "Run Cleanup"}</Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {[["Verify Media Index", "Recheck indexed paths against the NAS"], ["Verify Thumbnail Cache", "Compare cache files with active media"], ["Verify Metadata", "Find derived records without media"], ["Verify Folder Structure", "Find empty folders under the library"]].map(([title, description]) => <Button key={title} variant="outline" className="h-auto justify-start py-3" onClick={() => void load()}><FolderCheck className="mr-3 h-4 w-4 text-primary" /><span className="text-left"><span className="block">{title}</span><span className="block text-xs font-normal text-muted-foreground">{description}</span></span></Button>)}
      </div>
      <p className="text-xs text-muted-foreground">Need to change the library location? <Link href="/settings" className="text-primary hover:underline">Open Settings</Link>.</p>
    </div>
  );
}