import { useState, useEffect, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCleanupSummary, getGetCleanupSummaryQueryKey,
  useGetDuplicateFiles, getGetDuplicateFilesQueryKey,
  useGetLargeFiles, getGetLargeFilesQueryKey,
  useGetOldFiles, getGetOldFilesQueryKey,
  useGetEmptyFolders, getGetEmptyFoldersQueryKey,
  useListArchives, getListArchivesQueryKey,
  useExecuteCleanup,
  useGetCleanupHistory, getGetCleanupHistoryQueryKey,
} from "@workspace/api-client-react";
import type { DuplicateFileInfo, DuplicateGroup } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { readQueue, writeQueue, type CleanupQueueEntry } from "@/lib/cleanup-queue";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Trash2, Copy, FileWarning, Clock, FolderOpen, Package, Download,
  Star, Image as ImageIcon, CheckCircle2, XCircle, History, ListChecks,
  ShieldCheck, AlertTriangle, X,
} from "lucide-react";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

type KeepPreset = "oldest" | "newest" | "highest_res" | "shortest_path";

interface KeepDecision {
  keepId: number;
  deleteIds: number[];
  reason: string;
  evidence: string;
}

// ─── Keep-preset engine ───────────────────────────────────────────────────────

function computeKeepDecision(files: DuplicateFileInfo[], preset: KeepPreset): KeepDecision {
  if (files.length === 0) return { keepId: -1, deleteIds: [], reason: "", evidence: "" };

  let keepFile: DuplicateFileInfo;

  switch (preset) {
    case "oldest": {
      keepFile = [...files].sort((a, b) => {
        const aDate = a.dateTaken ?? a.dateCreated ?? a.modifiedAt ?? null;
        const bDate = b.dateTaken ?? b.dateCreated ?? b.modifiedAt ?? null;
        if (!aDate) return 1;
        if (!bDate) return -1;
        return new Date(aDate).getTime() - new Date(bDate).getTime();
      })[0];
      const keepDate = keepFile.dateTaken ?? keepFile.dateCreated ?? keepFile.modifiedAt ?? null;
      return {
        keepId:    keepFile.id,
        deleteIds: files.filter(f => f.id !== keepFile.id).map(f => f.id),
        reason:    "Oldest file — likely original camera import",
        evidence:  keepDate ? `Created ${formatDate(keepDate)}` : "Earliest in scan order",
      };
    }
    case "newest": {
      keepFile = [...files].sort((a, b) => {
        const aDate = a.modifiedAt ?? a.dateCreated ?? null;
        const bDate = b.modifiedAt ?? b.dateCreated ?? null;
        if (!aDate) return 1;
        if (!bDate) return -1;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      })[0];
      return {
        keepId:    keepFile.id,
        deleteIds: files.filter(f => f.id !== keepFile.id).map(f => f.id),
        reason:    "Newest file — most recently touched or imported",
        evidence:  keepFile.modifiedAt ? `Modified ${formatDate(keepFile.modifiedAt)}` : "Most recent",
      };
    }
    case "highest_res": {
      keepFile = [...files].sort((a, b) => {
        return ((b.width ?? 0) * (b.height ?? 0)) - ((a.width ?? 0) * (a.height ?? 0));
      })[0];
      const px = (keepFile.width && keepFile.height) ? `${keepFile.width} × ${keepFile.height}` : "Unknown resolution";
      return {
        keepId:    keepFile.id,
        deleteIds: files.filter(f => f.id !== keepFile.id).map(f => f.id),
        reason:    "Highest resolution — maximum detail preserved",
        evidence:  px,
      };
    }
    case "shortest_path": {
      keepFile = [...files].sort((a, b) =>
        a.path.split(/[/\\]/).length - b.path.split(/[/\\]/).length
      )[0];
      const parts = keepFile.path.split(/[/\\]/);
      const shortFolder = parts.slice(-3, -1).join("/") || keepFile.folder;
      return {
        keepId:    keepFile.id,
        deleteIds: files.filter(f => f.id !== keepFile.id).map(f => f.id),
        reason:    "Shortest path — closest to root, likely original location",
        evidence:  `Folder: …/${shortFolder}`,
      };
    }
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DuplicateTypeBadge({ matchType, confidence }: { matchType: string; confidence: number }) {
  const stars = Math.min(5, Math.max(0, confidence));
  const label = matchType === "HASH_IDENTICAL" ? "Hash Identical" : matchType.replace(/_/g, " ");
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={`w-3 h-3 ${i < stars ? "fill-amber-400 text-amber-400" : "fill-muted text-muted"}`}
          />
        ))}
      </div>
      <span className="text-xs font-mono text-muted-foreground">{label}</span>
    </div>
  );
}

function FileThumbnail({ file, ring }: { file: DuplicateFileInfo; ring: "keep" | "delete" | "neutral" }) {
  const [imgError, setImgError] = useState(false);
  const thumbUrl = file.mediaId ? `/api/media/thumbnail/${file.mediaId}` : null;
  const ringClass = ring === "keep"
    ? "ring-2 ring-green-500"
    : ring === "delete"
    ? "ring-2 ring-destructive"
    : "ring-1 ring-border";

  return (
    <div className={`relative w-full aspect-square bg-secondary/30 rounded overflow-hidden flex items-center justify-center ${ringClass}`}>
      {thumbUrl && !imgError ? (
        <img
          src={thumbUrl}
          alt={file.filename}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
      )}
      {ring === "keep" && (
        <div className="absolute top-1 right-1 bg-green-500 rounded-full p-0.5">
          <CheckCircle2 className="w-3 h-3 text-white" />
        </div>
      )}
      {ring === "delete" && (
        <div className="absolute top-1 right-1 bg-destructive rounded-full p-0.5">
          <XCircle className="w-3 h-3 text-white" />
        </div>
      )}
    </div>
  );
}

function DuplicateGroupCard({
  group,
  onStage,
  alreadyStaged,
}: {
  group: DuplicateGroup;
  onStage: (entry: CleanupQueueEntry) => void;
  alreadyStaged: boolean;
}) {
  const [preset, setPreset] = useState<KeepPreset>("oldest");
  const [manualKeepId, setManualKeepId] = useState<number | null>(null);

  const autoDecision = useMemo(() => computeKeepDecision(group.files, preset), [group.files, preset]);
  const decision = useMemo<KeepDecision>(() => {
    if (manualKeepId !== null) {
      return {
        keepId:    manualKeepId,
        deleteIds: group.files.filter(f => f.id !== manualKeepId).map(f => f.id),
        reason:    "Manual selection",
        evidence:  "User-selected",
      };
    }
    return autoDecision;
  }, [autoDecision, manualKeepId, group.files]);

  const keepFile = group.files.find(f => f.id === decision.keepId);

  function handleStage() {
    if (!keepFile) return;
    const deleteFiles = group.files.filter(f => decision.deleteIds.includes(f.id));
    onStage({
      groupHash:      group.hash,
      keepFileId:     decision.keepId,
      deleteFileIds:  decision.deleteIds,
      keepFilename:   keepFile.filename,
      keepFolder:     keepFile.folder,
      deleteFilenames: deleteFiles.map(f => f.filename),
      totalSavedBytes: group.totalWastedBytes,
      reason:         decision.reason,
      evidence:       decision.evidence,
      addedAt:        new Date().toISOString(),
    });
  }

  const PRESETS: { key: KeepPreset; label: string }[] = [
    { key: "oldest",       label: "Keep Oldest" },
    { key: "newest",       label: "Keep Newest" },
    { key: "highest_res",  label: "Highest Res" },
    { key: "shortest_path", label: "Shortest Path" },
  ];

  return (
    <Card className={`border ${alreadyStaged ? "border-green-500/50 bg-green-500/5" : ""}`}>
      <CardContent className="pt-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <DuplicateTypeBadge matchType={group.matchType} confidence={group.matchConfidence} />
            <Badge variant="secondary" className="font-mono text-xs">{group.fileCount} copies</Badge>
            <span className="text-xs text-destructive font-mono bg-destructive/10 px-2 py-0.5 rounded">
              Wastes {formatBytes(group.totalWastedBytes)}
            </span>
          </div>
          {alreadyStaged && (
            <Badge className="bg-green-600 text-white font-mono text-xs">Staged</Badge>
          )}
        </div>

        <div className="flex gap-1.5 flex-wrap">
          {PRESETS.map(p => (
            <Button
              key={p.key}
              size="sm"
              variant={preset === p.key && manualKeepId === null ? "default" : "outline"}
              className="text-xs h-7 font-mono"
              onClick={() => { setPreset(p.key); setManualKeepId(null); }}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {decision.keepId !== -1 && (
          <div className="text-xs text-muted-foreground font-mono bg-secondary/20 rounded px-3 py-1.5 flex items-center gap-2">
            <ShieldCheck className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
            <span className="text-green-500 font-semibold">Keep:</span>
            <span>{decision.reason}</span>
            <span className="text-muted-foreground/60">· {decision.evidence}</span>
          </div>
        )}

        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(group.files.length, 4)}, minmax(0, 1fr))` }}>
          {group.files.map(file => {
            const isKeep   = file.id === decision.keepId;
            const isDelete = decision.deleteIds.includes(file.id);
            const ring = isKeep ? "keep" : isDelete ? "delete" : "neutral";
            return (
              <div key={file.id} className="space-y-1.5 cursor-pointer" onClick={() => setManualKeepId(file.id)}>
                <FileThumbnail file={file} ring={ring} />
                <div className={`text-[10px] font-mono space-y-0.5 ${isKeep ? "text-green-400" : isDelete ? "text-destructive/70 line-through" : "text-muted-foreground"}`}>
                  <div className="truncate font-medium" title={file.filename}>{file.filename}</div>
                  <div className="truncate text-muted-foreground" title={file.folder}>{file.folder.split(/[/\\]/).slice(-2).join("/")}</div>
                  <div>{formatBytes(file.sizeBytes)}</div>
                  {(file.width && file.height) && <div>{file.width} × {file.height}</div>}
                  {(file.dateTaken ?? file.modifiedAt) && (
                    <div>{formatDate(file.dateTaken ?? file.modifiedAt)}</div>
                  )}
                  {file.cameraModel && <div className="text-muted-foreground/60">{file.cameraModel}</div>}
                </div>
                <div className={`text-[10px] font-mono text-center py-0.5 rounded ${isKeep ? "bg-green-500/10 text-green-500" : isDelete ? "bg-destructive/10 text-destructive" : "bg-secondary/30 text-muted-foreground"}`}>
                  {isKeep ? "✓ KEEP" : isDelete ? "✕ DELETE" : "click to keep"}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end">
          <Button
            size="sm"
            className={`font-mono text-xs ${alreadyStaged ? "bg-green-700 hover:bg-green-600" : ""}`}
            onClick={handleStage}
            disabled={decision.keepId === -1}
          >
            {alreadyStaged ? "Update staged decision" : "Stage for Cleanup ▸"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Export report ────────────────────────────────────────────────────────────

function exportReport(summary: any, duplicates: any, largeFiles: any, oldFiles: any, emptyFolders: any, archives: any) {
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
      for (const f of g.files) lines.push(`    - ${f.path}`);
    }
    lines.push("");
  }
  if (largeFiles?.files?.length) {
    lines.push("=== LARGE FILES (>500MB) ===");
    for (const f of largeFiles.files) lines.push(`  - ${f.path} (${formatBytes(f.sizeBytes)})`);
    lines.push("");
  }
  if (oldFiles?.files?.length) {
    lines.push("=== OLD FILES (>5 years) ===");
    for (const f of oldFiles.files) lines.push(`  - ${f.path} (modified ${formatDate(f.modifiedAt)})`);
    lines.push("");
  }
  if (emptyFolders?.length) {
    lines.push("=== EMPTY FOLDERS ===");
    for (const f of emptyFolders) lines.push(`  - ${f.path}`);
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
      const totalSize = items.reduce((s: number, a: any) => s + (a.sizeBytes ?? 0), 0);
      lines.push(`  ${cat.toUpperCase()} (${items.length} archives, ${formatBytes(totalSize)}):`);
      for (const a of items.slice(0, 5)) lines.push(`    - ${a.filename} (${formatBytes(a.sizeBytes)})`);
      if (items.length > 5) lines.push(`    ... and ${items.length - 5} more`);
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `willard-cleanup-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Cleanup() {
  const qc = useQueryClient();

  const { data: summary }                              = useGetCleanupSummary({ query: { queryKey: getGetCleanupSummaryQueryKey() } });
  const { data: duplicates, isLoading: dupesLoading }  = useGetDuplicateFiles({ limit: 20 }, { query: { queryKey: getGetDuplicateFilesQueryKey({ limit: 20 }) } });
  const { data: largeFiles, isLoading: largeLoading }  = useGetLargeFiles({ limit: 100 }, { query: { queryKey: getGetLargeFilesQueryKey({ limit: 100 }) } });
  const { data: oldFiles,   isLoading: oldLoading }    = useGetOldFiles({ limit: 100 }, { query: { queryKey: getGetOldFilesQueryKey({ limit: 100 }) } });
  const { data: emptyFolders, isLoading: emptyLoading } = useGetEmptyFolders({ query: { queryKey: getGetEmptyFoldersQueryKey() } });
  const { data: archives, isLoading: archivesLoading } = useListArchives({ limit: 200 }, { query: { queryKey: getListArchivesQueryKey({ limit: 200 }) } });
  const { data: historyData }                          = useGetCleanupHistory({ query: { queryKey: getGetCleanupHistoryQueryKey() } });

  const [queue, setQueue] = useState<CleanupQueueEntry[]>(() => readQueue(localStorage));
  const [showExecuteModal, setShowExecuteModal] = useState(false);
  const [executeResult, setExecuteResult] = useState<{ recycled: number; recoveredBytes: number; errors: string[] } | null>(null);

  const { mutate: executeCleanup, isPending: isExecuting } = useExecuteCleanup();

  const stagedHashes = useMemo(() => new Set(queue.map(q => q.groupHash)), [queue]);

  useEffect(() => { writeQueue(queue, localStorage); }, [queue]);

  const handleStage = useCallback((entry: CleanupQueueEntry) => {
    setQueue(prev => {
      const without = prev.filter(e => e.groupHash !== entry.groupHash);
      return [...without, entry];
    });
  }, []);

  const handleRemoveFromQueue = useCallback((groupHash: string) => {
    setQueue(prev => prev.filter(e => e.groupHash !== groupHash));
  }, []);

  const handleExecute = () => {
    const allDeleteIds = queue.flatMap(e => e.deleteFileIds);
    executeCleanup({ data: { deleteFileIds: allDeleteIds } }, {
      onSuccess: (result) => {
        setExecuteResult(result);
        setQueue([]);
        qc.invalidateQueries({ queryKey: getGetCleanupHistoryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetCleanupSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDuplicateFilesQueryKey({ limit: 20 }) });
        setShowExecuteModal(false);
      },
      onError: () => {
        setExecuteResult({ recycled: 0, recoveredBytes: 0, errors: ["Execute failed — check API logs"] });
        setShowExecuteModal(false);
      },
    });
  };

  const totalSavings = (summary?.duplicateWastedBytes ?? 0) + (summary?.largeFilesBytes ?? 0);
  const queueSavings = queue.reduce((s, e) => s + e.totalSavedBytes, 0);
  const queueDeleteCount = queue.reduce((s, e) => s + e.deleteFileIds.length, 0);

  const archiveClusters: Record<string, { items: any[]; totalSize: number }> = {};
  for (const a of archives?.archives ?? []) {
    const cat = a.category ?? "general";
    if (!archiveClusters[cat]) archiveClusters[cat] = { items: [], totalSize: 0 };
    archiveClusters[cat].items.push(a);
    archiveClusters[cat].totalSize += a.sizeBytes ?? 0;
  }
  const clusterEntries = Object.entries(archiveClusters).sort((a, b) => b[1].totalSize - a[1].totalSize);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-3xl font-bold font-mono tracking-tight">CLEANUP_SUGGESTIONS</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center space-x-2 text-destructive bg-destructive/10 px-3 py-1.5 rounded-md font-mono text-sm">
            <Trash2 className="w-4 h-4" />
            <span>Potential savings: {formatBytes(totalSavings)}</span>
          </div>
          <Button
            variant="outline" size="sm" className="font-mono"
            onClick={() => exportReport(summary, duplicates, largeFiles, oldFiles, emptyFolders, archives)}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" /> Export Report
          </Button>
        </div>
      </div>

      {executeResult && (
        <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-md border font-mono text-sm ${executeResult.errors.length === 0 ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-amber-500/10 border-amber-500/30 text-amber-400"}`}>
          <div className="flex items-center gap-2">
            {executeResult.errors.length === 0
              ? <CheckCircle2 className="w-4 h-4" />
              : <AlertTriangle className="w-4 h-4" />
            }
            <span>
              Moved {executeResult.recycled} file{executeResult.recycled !== 1 ? "s" : ""} to Trash — recovered {formatBytes(executeResult.recoveredBytes)}
              {executeResult.errors.length > 0 && ` · ${executeResult.errors.length} error(s)`}
            </span>
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setExecuteResult(null)}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-destructive">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Duplicates</CardTitle>
            <Copy className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.duplicateGroups?.toLocaleString() ?? "--"}</div>
            <p className="text-xs text-muted-foreground mt-1">Wasting {formatBytes(summary?.duplicateWastedBytes ?? 0)}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-amber-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Large &gt;500MB</CardTitle>
            <FileWarning className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.largeFileCount?.toLocaleString() ?? "--"}</div>
            <p className="text-xs text-muted-foreground mt-1">{formatBytes(summary?.largeFilesBytes ?? 0)}</p>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-blue-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Old &gt;5 Years</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.oldFileCount?.toLocaleString() ?? "--"}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-green-500">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Empty Folders</CardTitle>
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary?.emptyFolderCount?.toLocaleString() ?? "--"}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="duplicates">
        <TabsList className="flex-wrap">
          <TabsTrigger value="duplicates">Duplicate Groups</TabsTrigger>
          <TabsTrigger value="queue" className="relative">
            Cleanup Queue
            {queue.length > 0 && (
              <span className="ml-1.5 bg-green-600 text-white text-[10px] rounded-full px-1.5 py-0.5 font-mono">
                {queue.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="large">Large Files</TabsTrigger>
          <TabsTrigger value="old">Old Files</TabsTrigger>
          <TabsTrigger value="empty">Empty Folders</TabsTrigger>
          <TabsTrigger value="archives">Archive Clusters</TabsTrigger>
        </TabsList>

        {/* ── DUPLICATE GROUPS ──────────────────────────────────────────── */}
        <TabsContent value="duplicates" className="mt-4">
          {dupesLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-48 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : !duplicates?.groups.length ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground font-mono text-sm">
              No duplicate groups found — run a full scan first
            </CardContent></Card>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground font-mono">
                {duplicates.totalGroups} groups · {formatBytes(duplicates.totalWastedBytes)} wasted · Click a card to select which copy to keep, then "Stage for Cleanup"
              </p>
              {duplicates.groups.map((group) => (
                <DuplicateGroupCard
                  key={group.hash}
                  group={group}
                  onStage={handleStage}
                  alreadyStaged={stagedHashes.has(group.hash)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── CLEANUP QUEUE ─────────────────────────────────────────────── */}
        <TabsContent value="queue" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <div>
                <CardTitle className="text-sm font-mono flex items-center gap-2">
                  <ListChecks className="w-4 h-4" /> CLEANUP_QUEUE
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  {queue.length} group{queue.length !== 1 ? "s" : ""} staged · {queueDeleteCount} file{queueDeleteCount !== 1 ? "s" : ""} to delete · Recovers {formatBytes(queueSavings)}
                </p>
              </div>
              <div className="flex gap-2">
                {queue.length > 0 && (
                  <>
                    <Button
                      variant="outline" size="sm" className="font-mono text-xs text-destructive"
                      onClick={() => setQueue([])}
                    >
                      Clear Queue
                    </Button>
                    <Button
                      size="sm" className="font-mono text-xs bg-destructive hover:bg-destructive/90"
                      onClick={() => setShowExecuteModal(true)}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1" /> Execute Cleanup ▸
                    </Button>
                  </>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {queue.length === 0 ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">
                  No groups staged yet — review Duplicate Groups and click "Stage for Cleanup"
                </p>
              ) : (
                <div className="space-y-2">
                  {queue.map(entry => (
                    <div key={entry.groupHash} className="border rounded-md p-3 bg-secondary/5 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] bg-green-500/10 text-green-500 font-mono px-1.5 rounded">KEEP</span>
                            <span className="font-mono text-xs truncate">{entry.keepFilename}</span>
                            <span className="text-[10px] text-muted-foreground font-mono truncate">…/{entry.keepFolder.split(/[/\\]/).slice(-2).join("/")}</span>
                          </div>
                          {entry.deleteFilenames.map((name, i) => (
                            <div key={i} className="flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] bg-destructive/10 text-destructive font-mono px-1.5 rounded">DELETE</span>
                              <span className="font-mono text-xs text-muted-foreground line-through truncate">{name}</span>
                            </div>
                          ))}
                          <p className="text-[10px] text-muted-foreground font-mono">
                            {entry.reason} · {entry.evidence} · saves {formatBytes(entry.totalSavedBytes)}
                          </p>
                        </div>
                        <Button
                          variant="ghost" size="icon" className="h-6 w-6 flex-shrink-0"
                          onClick={() => handleRemoveFromQueue(entry.groupHash)}
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── HISTORY ───────────────────────────────────────────────────── */}
        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-mono flex items-center gap-2">
                <History className="w-4 h-4" /> CLEANUP_HISTORY
              </CardTitle>
              <p className="text-xs text-muted-foreground">Last 50 cleanup sessions, newest first</p>
            </CardHeader>
            <CardContent>
              {!historyData?.sessions.length ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">
                  No cleanup history yet — execute a cleanup to see sessions here
                </p>
              ) : (
                <Accordion type="single" collapsible className="w-full">
                  {historyData.sessions.map((session, i) => (
                    <AccordionItem key={i} value={`session-${i}`}>
                      <AccordionTrigger className="hover:no-underline py-2 px-3 bg-secondary/20 rounded mb-1">
                        <div className="flex justify-between items-center w-full pr-4 font-mono text-xs">
                          <span className="text-muted-foreground">{formatDate(session.ts)}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-green-400">{session.recycled} files moved</span>
                            <span className="text-blue-400">{formatBytes(session.recoveredBytes)} recovered</span>
                            {session.errors.length > 0 && (
                              <span className="text-amber-400">{session.errors.length} error{session.errors.length !== 1 ? "s" : ""}</span>
                            )}
                          </div>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pt-2 pb-3 px-2 space-y-2">
                        <p className="text-[10px] text-muted-foreground font-mono">Platform: {session.platform}</p>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {session.files.map((f, fi) => (
                            <div key={fi} className="font-mono text-[10px] text-muted-foreground truncate">
                              {f.path} · {formatBytes(f.sizeBytes)}
                            </div>
                          ))}
                        </div>
                        {session.errors.length > 0 && (
                          <div className="space-y-1">
                            {session.errors.map((e, ei) => (
                              <div key={ei} className="font-mono text-[10px] text-amber-400">{e}</div>
                            ))}
                          </div>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── LARGE FILES ───────────────────────────────────────────────── */}
        <TabsContent value="large" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-mono">LARGE_FILES &gt; 500MB</CardTitle>
              <p className="text-xs text-muted-foreground">Files consuming the most space — candidates for compression or archiving</p>
            </CardHeader>
            <CardContent>
              {largeLoading ? (
                <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              ) : !largeFiles?.files.length ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">No large files found — run a scan first</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Filename</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="text-right">Modified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {largeFiles.files.map((f) => (
                      <TableRow key={f.id}>
                        <TableCell className="font-mono text-sm">{f.filename}</TableCell>
                        <TableCell className="text-muted-foreground text-xs truncate max-w-[200px]" title={f.folder ?? ""}>{f.folder}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-amber-500">{formatBytes(f.sizeBytes)}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">{formatDate(f.modifiedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── OLD FILES ─────────────────────────────────────────────────── */}
        <TabsContent value="old" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-mono">OLD_FILES &gt; 5 YEARS</CardTitle>
              <p className="text-xs text-muted-foreground">Files not modified in over 5 years — review for archiving or deletion</p>
            </CardHeader>
            <CardContent>
              {oldLoading ? (
                <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              ) : !oldFiles?.files.length ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">No old files found — run a scan first</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Filename</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="text-right">Last Modified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {oldFiles.files.map((f) => (
                      <TableRow key={f.id}>
                        <TableCell className="font-mono text-sm">{f.filename}</TableCell>
                        <TableCell className="text-muted-foreground text-xs truncate max-w-[200px]" title={f.folder ?? ""}>{f.folder}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{formatBytes(f.sizeBytes)}</TableCell>
                        <TableCell className="text-right text-xs text-blue-400">{formatDate(f.modifiedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── EMPTY FOLDERS ─────────────────────────────────────────────── */}
        <TabsContent value="empty" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-mono">EMPTY_FOLDERS</CardTitle>
              <p className="text-xs text-muted-foreground">Folders with no files — safe to remove to keep directory structure clean</p>
            </CardHeader>
            <CardContent>
              {emptyLoading ? (
                <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              ) : !emptyFolders?.length ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">No empty folders found</p>
              ) : (
                <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
                  {emptyFolders.map((folder, i) => (
                    <div key={i} className="flex items-center justify-between p-2 border rounded bg-secondary/10">
                      <div className="flex items-center gap-2">
                        <FolderOpen className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="font-mono text-xs text-muted-foreground">{folder.path}</span>
                      </div>
                      <span className="text-[10px] text-green-600 bg-green-600/10 px-1.5 py-0.5 rounded font-mono">EMPTY</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── ARCHIVE CLUSTERS ──────────────────────────────────────────── */}
        <TabsContent value="archives" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-mono">ARCHIVE_CLUSTERS</CardTitle>
              <p className="text-xs text-muted-foreground">Archives grouped by category — identify large backup clusters</p>
            </CardHeader>
            <CardContent>
              {archivesLoading ? (
                <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
              ) : clusterEntries.length === 0 ? (
                <p className="text-center text-muted-foreground font-mono text-sm py-8">No archives indexed — run a scan first</p>
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
                          <span className="bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded text-xs font-mono">{formatBytes(cluster.totalSize)}</span>
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
                          <p className="text-xs text-muted-foreground font-mono mt-2 text-center">… and {cluster.items.length - 20} more (export report to see all)</p>
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

      {/* ── EXECUTE CONFIRM MODAL ────────────────────────────────────────── */}
      <Dialog open={showExecuteModal} onOpenChange={setShowExecuteModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-destructive" /> CONFIRM_CLEANUP
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 flex gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400 font-mono">
                Files will be moved to Recycle Bin / WillardAI/.Trash — recoverable for 30 days.
                This action cannot be undone from Willard AI.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 font-mono text-sm">
              <div className="text-center border rounded p-2">
                <div className="text-foreground font-bold">{queue.length}</div>
                <div className="text-[10px] text-muted-foreground">groups</div>
              </div>
              <div className="text-center border border-destructive/30 rounded p-2">
                <div className="text-destructive font-bold">{queueDeleteCount}</div>
                <div className="text-[10px] text-muted-foreground">files to delete</div>
              </div>
              <div className="text-center border border-green-500/30 rounded p-2">
                <div className="text-green-400 font-bold">{formatBytes(queueSavings)}</div>
                <div className="text-[10px] text-muted-foreground">recovered</div>
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Files to be deleted</p>
              <div className="max-h-48 overflow-y-auto space-y-1 border rounded p-2 bg-secondary/5">
                {queue.flatMap(entry =>
                  entry.deleteFilenames.map((name, i) => (
                    <div key={`${entry.groupHash}-${i}`} className="flex items-center gap-2 font-mono text-[10px]">
                      <XCircle className="w-3 h-3 text-destructive flex-shrink-0" />
                      <span className="text-destructive/80 truncate flex-1" title={name}>{name}</span>
                      <span className="text-muted-foreground/60 whitespace-nowrap">{formatBytes(entry.totalSavedBytes)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Files to keep</p>
              <div className="max-h-24 overflow-y-auto space-y-1 border rounded p-2 bg-secondary/5">
                {queue.map(entry => (
                  <div key={entry.groupHash} className="flex items-center gap-2 font-mono text-[10px]">
                    <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
                    <span className="text-green-400/80 truncate flex-1" title={entry.keepFilename}>{entry.keepFilename}</span>
                    <span className="text-muted-foreground/60 whitespace-nowrap truncate max-w-[120px]">{entry.reason.split(" — ")[0]}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="font-mono" onClick={() => setShowExecuteModal(false)}>
              Cancel
            </Button>
            <Button
              className="font-mono bg-destructive hover:bg-destructive/90"
              onClick={handleExecute}
              disabled={isExecuting}
            >
              {isExecuting ? "Moving to Trash…" : `Delete ${queueDeleteCount} file${queueDeleteCount !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
