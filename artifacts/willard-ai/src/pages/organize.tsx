import { useState, useRef, useEffect, type ReactNode } from "react";
import {
  useListOrganizeJobs, getListOrganizeJobsQueryKey,
  useCreateOrganizeJob,
  useGetOrganizeJob, getGetOrganizeJobQueryKey,
  useDeleteOrganizeJob,
  useAnalyzeOrganizeJob,
  usePreflightOrganizeJob,
  useUpdateOrganizeJobPlan,
  useApplyOrganizeJobDisposition,
  useListArchives,
} from "@workspace/api-client-react";
import type { OrganizationJob } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatBytes, formatDate } from "@/lib/format";
import {
  Boxes, Plus, ChevronRight, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Archive, FolderOpen, Trash2, Eye, Play, RotateCcw, Sparkles, HardDrive,
  FileText, Image, Video, File, ArrowRight, Ban, FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

const STEPS = ["Setup", "Analyze", "Pre-flight", "Execute", "Done"] as const;
type Step = 0 | 1 | 2 | 3 | 4;

const FILE_CATEGORIES = [
  { key: "image",    label: "Photos / Images", icon: <Image className="w-3.5 h-3.5 text-blue-400" />,    summaryKey: "images" },
  { key: "video",    label: "Videos",           icon: <Video className="w-3.5 h-3.5 text-purple-400" />,  summaryKey: "videos" },
  { key: "document", label: "Documents",        icon: <FileText className="w-3.5 h-3.5 text-amber-400" />, summaryKey: "documents" },
  { key: "other",    label: "Other Files",      icon: <File className="w-3.5 h-3.5 text-muted-foreground" />, summaryKey: "other" },
] as const;

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:     { label: "Pending",     cls: "bg-secondary text-muted-foreground" },
    analyzing:   { label: "Analyzing",   cls: "bg-blue-500/20 text-blue-400" },
    planned:     { label: "Planned",     cls: "bg-blue-500/20 text-blue-400" },
    verified:    { label: "Verified",    cls: "bg-amber-500/20 text-amber-400" },
    executing:   { label: "Executing",   cls: "bg-primary/20 text-primary animate-pulse" },
    completed:   { label: "Completed",   cls: "bg-green-500/20 text-green-400" },
    failed:      { label: "Failed",      cls: "bg-destructive/20 text-destructive" },
    rolled_back: { label: "Rolled Back", cls: "bg-orange-500/20 text-orange-400" },
  };
  const m = map[status] ?? { label: status, cls: "bg-secondary text-muted-foreground" };
  return <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

function StepIndicator({ current }: { current: Step }) {
  return (
    <div className="flex items-center gap-1 text-xs font-mono mb-6 flex-wrap">
      {STEPS.map((label, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className={`px-2 py-0.5 rounded ${i === current ? "bg-primary text-primary-foreground" : i < current ? "text-green-400" : "text-muted-foreground"}`}>
            {i < current ? "✓" : `${i + 1}`}. {label}
          </span>
          {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-muted-foreground" />}
        </div>
      ))}
    </div>
  );
}

// ── Setup Step ──────────────────────────────────────────────────────────────

function SetupStep({ onCreated }: { onCreated: (id: number) => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ sourceType: "archive", sourcePath: "", archiveId: "", archiveDisposition: "keep" });
  const { data: archivesData } = useListArchives({ limit: 200, offset: 0 });
  const createMutation = useCreateOrganizeJob({
    mutation: {
      onSuccess: (job) => onCreated(job.id),
      onError:   () => toast({ title: "Failed to create job", variant: "destructive" }),
    },
  });

  const peekedArchives = archivesData?.archives?.filter(a => a.peekStatus === "peeked") ?? [];

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>Source Type</Label>
        <Select value={form.sourceType} onValueChange={v => setForm({ ...form, sourceType: v, archiveId: "" })}>
          <SelectTrigger className="font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="archive"><span className="flex items-center gap-2"><Archive className="w-3.5 h-3.5" /> Archive file (ZIP, RAR, 7z…)</span></SelectItem>
            <SelectItem value="folder"><span className="flex items-center gap-2"><FolderOpen className="w-3.5 h-3.5" /> Folder</span></SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Full path on NAS</Label>
        <Input
          className="font-mono text-sm"
          placeholder={form.sourceType === "archive" ? "/mnt/nas/old-backup.zip" : "/mnt/nas/Unsorted/"}
          value={form.sourcePath}
          onChange={e => setForm({ ...form, sourcePath: e.target.value })}
        />
        {form.sourceType === "archive" && peekedArchives.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Or pick from indexed archives:</p>
            <Select value={form.archiveId} onValueChange={v => {
              const arc = peekedArchives.find(a => String(a.id) === v);
              setForm({ ...form, archiveId: v, sourcePath: arc?.path ?? form.sourcePath });
            }}>
              <SelectTrigger className="font-mono text-xs h-8"><SelectValue placeholder="— select indexed archive —" /></SelectTrigger>
              <SelectContent>
                {peekedArchives.map(a => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    <span className="font-mono text-xs">{a.filename} ({formatBytes(a.sizeBytes)})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {form.sourceType === "archive" && (
        <div className="space-y-2">
          <Label>After successful move, the archive should…</Label>
          <Select value={form.archiveDisposition} onValueChange={v => setForm({ ...form, archiveDisposition: v })}>
            <SelectTrigger className="font-mono text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="keep">Keep in place (safe default)</SelectItem>
              <SelectItem value="move_to_processed">Move to WillardAI/archive-index/processed/</SelectItem>
              <SelectItem value="delete">Delete archive (⚠ requires confirmation)</SelectItem>
            </SelectContent>
          </Select>
          {form.archiveDisposition === "delete" && (
            <p className="text-xs text-amber-400/80 font-mono">You will be prompted to confirm deletion <em>after</em> verifying all files moved successfully.</p>
          )}
        </div>
      )}

      <Button
        className="w-full font-mono font-bold"
        onClick={() => {
          if (!form.sourcePath.trim()) { toast({ title: "Source path is required", variant: "destructive" }); return; }
          createMutation.mutate({ data: { sourceType: form.sourceType as "archive"|"folder", sourcePath: form.sourcePath.trim(), archiveId: form.archiveId ? parseInt(form.archiveId) : null, archiveDisposition: form.archiveDisposition as any } });
        }}
        disabled={createMutation.isPending || !form.sourcePath.trim()}
      >
        {createMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating…</> : "CREATE_JOB →"}
      </Button>
    </div>
  );
}

const FILE_ICONS: Record<string, ReactNode> = {
  image:    <Image    className="w-3 h-3 text-blue-400 shrink-0"   />,
  video:    <Video    className="w-3 h-3 text-purple-400 shrink-0" />,
  document: <FileText className="w-3 h-3 text-amber-400 shrink-0"  />,
  other:    <File     className="w-3 h-3 text-muted-foreground shrink-0" />,
};

const FILE_LIST_PAGE = 40;

// ── Analyze Step ─────────────────────────────────────────────────────────────

function AnalyzeStep({ job, onDone }: { job: OrganizationJob; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const analyzeMutation = useAnalyzeOrganizeJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOrganizeJobQueryKey(job.id) });
        queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() });
      },
      onError: () => toast({ title: "Analysis failed", variant: "destructive" }),
    },
  });

  const updatePlanMutation = useUpdateOrganizeJobPlan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOrganizeJobQueryKey(job.id) });
        queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() });
      },
      onError: () => toast({ title: "Failed to update plan", variant: "destructive" }),
    },
  });

  const plan = job.planJson as any;
  const isAnalyzing = job.status === "analyzing" || analyzeMutation.isPending;
  const allRoutes: any[] = plan?.routes ?? [];

  // Local excluded categories state (mirrors planJson.excludeCategories)
  const [excludedCats, setExcludedCats] = useState<Set<string>>(
    () => new Set(plan?.excludeCategories ?? [])
  );
  // Local excluded individual paths (mirrors planJson.excludePaths)
  const [excludedPaths, setExcludedPaths] = useState<Set<string>>(
    () => new Set(plan?.excludePaths ?? [])
  );
  const [fileSearch, setFileSearch] = useState("");
  const [fileListPage, setFileListPage] = useState(1);
  const [showFileList, setShowFileList] = useState(false);

  useEffect(() => {
    if (job.status === "pending") {
      analyzeMutation.mutate({ id: job.id });
    }
  }, [job.id]);

  const sendUpdate = (cats: Set<string>, paths: Set<string>) => {
    updatePlanMutation.mutate({
      id: job.id,
      data: {
        excludeCategories: [...cats] as Array<"image" | "video" | "document" | "other">,
        excludePaths: [...paths],
      },
    });
  };

  const toggleCategory = (cat: string) => {
    const next = new Set(excludedCats);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    setExcludedCats(next);
    sendUpdate(next, excludedPaths);
  };

  const toggleFilePath = (relativePath: string, fileType: string) => {
    // Category-excluded files cannot be individually re-included from this toggle
    if (excludedCats.has(fileType)) return;
    const next = new Set(excludedPaths);
    if (next.has(relativePath)) next.delete(relativePath); else next.add(relativePath);
    setExcludedPaths(next);
    sendUpdate(excludedCats, next);
  };

  if (isAnalyzing) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4 text-muted-foreground">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="font-mono text-sm">Analyzing source and routing files…</p>
        <p className="text-xs">Calling AI for confidence score…</p>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="space-y-4">
        {job.status === "failed" && <p className="text-destructive text-sm font-mono">{(job as any).error}</p>}
        <Button onClick={() => analyzeMutation.mutate({ id: job.id })} className="w-full font-mono"><RotateCcw className="w-4 h-4 mr-2" /> Re-analyze</Button>
      </div>
    );
  }

  const summary    = plan.activeSummary ?? plan.summary ?? {};
  const confidence = typeof plan.aiConfidence === "number" ? plan.aiConfidence : null;
  const confColor  = confidence === null ? "text-muted-foreground" : confidence >= 0.8 ? "text-green-400" : confidence >= 0.5 ? "text-amber-400" : "text-destructive";
  const totalActive = plan.totalFiles ?? 0;
  const totalExcluded = excludedPaths.size + [...excludedCats].reduce((n, cat) =>
    n + allRoutes.filter(r => r.fileType === cat && !excludedPaths.has(r.relativePath)).length, 0
  );

  // Filtered file list for per-file section
  const filteredRoutes = allRoutes.filter(r =>
    !fileSearch.trim() || r.filename.toLowerCase().includes(fileSearch.trim().toLowerCase()) || r.relativePath.toLowerCase().includes(fileSearch.trim().toLowerCase())
  );
  const visibleRoutes  = filteredRoutes.slice(0, fileListPage * FILE_LIST_PAGE);
  const hasMore        = filteredRoutes.length > visibleRoutes.length;

  return (
    <div className="space-y-5">
      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-secondary/40 rounded-lg border text-center">
          <div className="text-2xl font-mono font-bold">{totalActive.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground font-mono">active files</div>
        </div>
        <div className="p-3 bg-secondary/40 rounded-lg border text-center">
          <div className="text-lg font-mono font-bold">{formatBytes(plan.totalSizeBytes ?? 0)}</div>
          <div className="text-xs text-muted-foreground font-mono">total size</div>
        </div>
      </div>

      {/* AI confidence */}
      {confidence !== null && (
        <div className="flex items-start gap-3 p-3 bg-secondary/30 rounded-lg border">
          <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted-foreground">AI Confidence</span>
              <span className={`text-sm font-mono font-bold ${confColor}`}>{Math.round(confidence * 100)}%</span>
            </div>
            {(plan.aiReason || plan.aiRecommendation) && (
              <p className="text-xs text-muted-foreground italic mt-1">
                {plan.aiReason ?? plan.aiRecommendation}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Category toggles ── */}
      <div className="space-y-2">
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Categories — uncheck to exclude entire type</p>
        {FILE_CATEGORIES.map(({ key, label, icon, summaryKey }) => {
          const count = (summary as any)[summaryKey] ?? 0;
          const dest  = (plan.destinations as any)?.[summaryKey === "images" ? "images" : summaryKey === "videos" ? "videos" : summaryKey === "documents" ? "documents" : "other"];
          const excluded = excludedCats.has(key);
          if (count === 0 && !excluded) return null;
          return (
            <div key={key} className={`flex items-center gap-3 p-2.5 rounded border transition-opacity ${excluded ? "opacity-40 border-dashed border-muted" : "border-border/40 bg-secondary/20"}`}>
              <Checkbox
                id={`cat-${key}`}
                checked={!excluded}
                onCheckedChange={() => toggleCategory(key)}
                disabled={updatePlanMutation.isPending}
              />
              <label htmlFor={`cat-${key}`} className="flex items-center gap-2 flex-1 cursor-pointer">
                {icon}
                <span className="text-sm font-mono font-medium w-10">{excluded ? <s>{count.toLocaleString()}</s> : count.toLocaleString()}</span>
                <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-xs font-mono text-muted-foreground truncate" title={dest}>{dest ?? "—"}</span>
              </label>
              {excluded && <Ban className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
            </div>
          );
        })}
      </div>

      {/* ── Per-file list ── */}
      {allRoutes.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors w-full text-left"
            onClick={() => setShowFileList(v => !v)}
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${showFileList ? "rotate-90" : ""}`} />
            Individual Files ({allRoutes.length.toLocaleString()})
            {totalExcluded > 0 && <span className="text-amber-400 ml-1">— {totalExcluded} excluded</span>}
          </button>

          {showFileList && (
            <div className="space-y-2">
              <Input
                className="h-7 text-xs font-mono"
                placeholder="Filter files…"
                value={fileSearch}
                onChange={e => { setFileSearch(e.target.value); setFileListPage(1); }}
              />
              <ScrollArea className="h-64 rounded border bg-secondary/10">
                <div className="p-1 space-y-px">
                  {visibleRoutes.map((route: any) => {
                    const catExcluded  = excludedCats.has(route.fileType);
                    const pathExcluded = excludedPaths.has(route.relativePath);
                    const isExcluded   = catExcluded || pathExcluded;
                    return (
                      <div
                        key={route.relativePath}
                        className={`flex items-center gap-2 px-2 py-1 rounded text-xs font-mono transition-opacity ${isExcluded ? "opacity-40" : "hover:bg-secondary/40"}`}
                      >
                        <Checkbox
                          checked={!isExcluded}
                          onCheckedChange={() => toggleFilePath(route.relativePath, route.fileType)}
                          disabled={updatePlanMutation.isPending || catExcluded}
                          className="h-3 w-3 shrink-0"
                        />
                        {FILE_ICONS[route.fileType] ?? FILE_ICONS.other}
                        <span className="flex-1 truncate text-foreground/80" title={route.relativePath}>
                          {route.filename}
                        </span>
                        <ArrowRight className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
                        <span className="text-muted-foreground truncate max-w-[90px]" title={route.destination}>
                          {route.destination?.split("/").pop() ?? "—"}
                        </span>
                        {catExcluded && <span className="text-muted-foreground/60 text-[9px] shrink-0">cat</span>}
                      </div>
                    );
                  })}
                  {hasMore && (
                    <button
                      type="button"
                      className="w-full py-2 text-xs font-mono text-primary hover:underline"
                      onClick={() => setFileListPage(p => p + 1)}
                    >
                      Show more ({filteredRoutes.length - visibleRoutes.length} remaining)
                    </button>
                  )}
                  {filteredRoutes.length === 0 && (
                    <p className="text-center py-4 text-xs text-muted-foreground">No files match filter</p>
                  )}
                </div>
              </ScrollArea>
              <p className="text-xs text-muted-foreground font-mono">
                {visibleRoutes.length} of {filteredRoutes.length.toLocaleString()} files shown
                {excludedPaths.size > 0 && ` · ${excludedPaths.size} individually excluded`}
              </p>
            </div>
          )}
        </div>
      )}

      {(excludedCats.size > 0 || excludedPaths.size > 0) && (
        <p className="text-xs text-amber-400/80 font-mono">
          {totalExcluded} file{totalExcluded !== 1 ? "s" : ""} excluded — pre-flight must be re-run after changes.
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1 font-mono text-xs" onClick={() => analyzeMutation.mutate({ id: job.id })} disabled={analyzeMutation.isPending || updatePlanMutation.isPending}>
          <RotateCcw className="w-3 h-3 mr-1.5" /> Re-analyze
        </Button>
        <Button size="sm" className="flex-1 font-mono font-bold" onClick={onDone} disabled={totalActive === 0}>
          {totalActive === 0 ? "No files selected" : "Run Pre-flight →"}
        </Button>
      </div>
    </div>
  );
}

// ── Pre-flight Step ──────────────────────────────────────────────────────────

function PreflightStep({ job, onDone }: { job: OrganizationJob; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const preflightMutation = usePreflightOrganizeJob({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOrganizeJobQueryKey(job.id) });
        queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() });
      },
      onError: () => toast({ title: "Pre-flight failed", variant: "destructive" }),
    },
  });

  const preflight = job.preflightJson as any;

  if (preflightMutation.isPending) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4 text-muted-foreground">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="font-mono text-sm">Running pre-flight checks…</p>
      </div>
    );
  }

  if (!preflight) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground font-mono">Validates disk space, destination writability, and file collision detection.</p>
        <Button className="w-full font-mono font-bold" onClick={() => preflightMutation.mutate({ id: job.id })}>
          <Play className="w-4 h-4 mr-2" /> RUN_CHECKS
        </Button>
      </div>
    );
  }

  const checks = preflight.checks ?? [];
  const allOk  = preflight.ok;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {checks.map((c: any, i: number) => (
          <div key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${c.ok ? "border-green-500/30 bg-green-500/5" : c.warning ? "border-amber-500/30 bg-amber-500/5" : "border-destructive/30 bg-destructive/5"}`}>
            {c.ok
              ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
              : c.warning
                ? <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                : <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />}
            <div>
              <p className="text-sm font-mono font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">{c.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1 font-mono text-xs" onClick={() => preflightMutation.mutate({ id: job.id })} disabled={preflightMutation.isPending}>
          <RotateCcw className="w-3 h-3 mr-1.5" /> Re-check
        </Button>
        <Button size="sm" className="flex-1 font-mono font-bold" onClick={onDone} disabled={!allOk} title={!allOk ? "Fix critical issues before executing" : undefined}>
          {allOk ? "Execute →" : "Fix Issues First"}
        </Button>
      </div>
    </div>
  );
}

// ── Execute Step ─────────────────────────────────────────────────────────────

interface SseProgress { stage?: string; message?: string; progress?: number; index?: number; total?: number; filename?: string; moved?: number; action?: string }

function ExecuteStep({ job, onDone }: { job: OrganizationJob; onDone: (result: any) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [started, setStarted]         = useState(false);
  const [progress, setProgress]       = useState(0);
  const [stage, setStage]             = useState("");
  const [log, setLog]                 = useState<string[]>([]);
  const [done, setDone]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [dryRunResult, setDryRunResult] = useState<any>(null);
  const [isDryRunning, setIsDryRunning] = useState(false);
  const esRef    = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const runDryRun = async () => {
    setIsDryRunning(true);
    try {
      const resp = await fetch(`/api/organize/jobs/${job.id}/dry-run`);
      if (!resp.ok) throw new Error("Dry-run failed");
      setDryRunResult(await resp.json());
    } catch {
      toast({ title: "Simulation failed", description: "Could not run simulation", variant: "destructive" });
    } finally {
      setIsDryRunning(false);
    }
  };

  const addLog = (msg: string) => setLog(prev => [...prev.slice(-60), msg]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [log]);
  useEffect(() => () => { esRef.current?.close(); }, []);

  const startExecute = () => {
    if (started) return;
    setStarted(true);
    setError(null);
    setLog([]);

    const es = new EventSource(`/api/organize/jobs/${job.id}/execute`);
    esRef.current = es;

    es.addEventListener("status", (e: MessageEvent) => {
      const d: SseProgress = JSON.parse(e.data);
      setStage(d.message ?? d.stage ?? "");
      if (typeof d.progress === "number" && d.progress >= 0) setProgress(d.progress);
      addLog(`[${(d.stage ?? "info").toUpperCase()}] ${d.message ?? ""}`);
    });

    es.addEventListener("progress", (e: MessageEvent) => {
      const d: SseProgress = JSON.parse(e.data);
      if (typeof d.progress === "number" && d.progress >= 0) setProgress(d.progress);
      if (d.filename) addLog(`→ ${d.filename}`);
    });

    es.addEventListener("complete", (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      setProgress(100);
      setStage("Complete");
      setDone(true);
      addLog(`✓ Done — ${d.filesMoved} moved, ${d.filesVerified} verified`);
      es.close();
      queryClient.invalidateQueries({ queryKey: getGetOrganizeJobQueryKey(job.id) });
      queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() });
      onDone(d);
    });

    es.addEventListener("error", (e: MessageEvent) => {
      let msg = "Execution failed";
      try { msg = JSON.parse(e.data).message ?? msg; } catch { /* raw error */ }
      setError(msg);
      setStarted(false);
      es.close();
      queryClient.invalidateQueries({ queryKey: getGetOrganizeJobQueryKey(job.id) });
      queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() });
      toast({ title: "Execution failed — rolled back", description: msg, variant: "destructive" });
    });
  };

  const plan = job.planJson as any;

  if (!started && !done && !error) {
    // ── Simulation report view ──
    if (dryRunResult) {
      const s = dryRunResult.summary ?? {};
      const hasConflicts = (dryRunResult.diskConflictCount ?? 0) + (dryRunResult.intraConflictCount ?? 0) > 0;
      const hasWarnings  = (dryRunResult.warnings ?? []).length > 0;
      return (
        <div className="space-y-4">
          <div className="flex items-center gap-2 font-mono text-sm font-bold text-blue-400">
            <FlaskConical className="w-4 h-4" /> Simulation Report
          </div>

          {/* Summary grid */}
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Files",   value: (s.filesToProcess ?? 0).toLocaleString() },
              { label: "Folders", value: (s.foldersToCreate ?? 0).toLocaleString() },
              { label: "Size",    value: formatBytes(s.totalBytes ?? 0) },
            ].map(c => (
              <div key={c.label} className="p-2 bg-secondary/40 rounded border">
                <div className="text-sm font-mono font-bold">{c.value}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{c.label}</div>
              </div>
            ))}
          </div>

          {/* Per-type breakdown */}
          {s.byType && (
            <div className="grid grid-cols-4 gap-1.5 text-center">
              {[
                { label: "Photos",    value: s.byType.images,    color: "text-blue-400" },
                { label: "Videos",    value: s.byType.videos,    color: "text-purple-400" },
                { label: "Documents", value: s.byType.documents, color: "text-amber-400" },
                { label: "Other",     value: s.byType.other,     color: "text-muted-foreground" },
              ].map(c => (
                <div key={c.label} className="p-1.5 bg-secondary/20 rounded border">
                  <div className={`text-sm font-mono font-bold ${c.color}`}>{c.value}</div>
                  <div className="text-[9px] text-muted-foreground font-mono">{c.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Blank destination warnings */}
          {hasWarnings && (
            <div className="space-y-1.5">
              {(dryRunResult.warnings as any[]).map((w: any, i: number) => (
                <div key={i} className="flex items-start gap-2 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded text-xs font-mono text-amber-300">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span><strong>{w.label}</strong> destination not set — using default: <span className="opacity-70">{w.using}</span>. Configure in Settings.</span>
                </div>
              ))}
            </div>
          )}

          {/* Conflicts */}
          {hasConflicts && (
            <div className="space-y-1.5">
              {(dryRunResult.diskConflictCount ?? 0) > 0 && (
                <div className="p-2.5 bg-destructive/10 border border-destructive/30 rounded text-xs font-mono text-destructive">
                  <strong>{dryRunResult.diskConflictCount} file{dryRunResult.diskConflictCount !== 1 ? "s" : ""} already exist</strong> at destination
                  {dryRunResult.diskConflicts?.length > 0 && <span className="opacity-70"> — e.g. {dryRunResult.diskConflicts.slice(0, 3).join(", ")}</span>}
                </div>
              )}
              {(dryRunResult.intraConflictCount ?? 0) > 0 && (
                <div className="p-2.5 bg-destructive/10 border border-destructive/30 rounded text-xs font-mono text-destructive">
                  <strong>{dryRunResult.intraConflictCount} intra-job conflict{dryRunResult.intraConflictCount !== 1 ? "s" : ""}</strong> — duplicate filenames routing to same folder
                  {dryRunResult.intraConflicts?.length > 0 && <span className="opacity-70"> — e.g. {dryRunResult.intraConflicts.slice(0, 3).join(", ")}</span>}
                </div>
              )}
            </div>
          )}

          {!hasConflicts && !hasWarnings && (
            <div className="flex items-center gap-2 p-2.5 bg-green-500/10 border border-green-500/30 rounded text-xs font-mono text-green-400">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              No conflicts or warnings — safe to execute
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="outline" size="sm" className="font-mono text-xs" onClick={() => setDryRunResult(null)}>
              ← Back
            </Button>
            <Button className="flex-1 font-mono font-bold" onClick={startExecute}>
              <Play className="w-4 h-4 mr-2" /> EXECUTE_FOR_REAL
            </Button>
          </div>
        </div>
      );
    }

    // ── Default pre-execute view ──
    return (
      <div className="space-y-5">
        <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg space-y-2">
          <div className="flex items-center gap-2 font-mono text-sm font-bold text-amber-400">
            <AlertTriangle className="w-4 h-4" /> Ready to Execute
          </div>
          <p className="text-xs text-muted-foreground">
            This will move <strong>{plan?.totalFiles?.toLocaleString() ?? "?"} files</strong> ({formatBytes(plan?.totalSizeBytes ?? 0)}) to their destinations.
            Any unexpected collision or integrity failure will trigger automatic rollback.
          </p>
          {plan?.archiveDisposition === "delete" && (
            <p className="text-xs text-amber-400/80 font-mono">
              Archive deletion will require your explicit confirmation after successful verification.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 font-mono"
            onClick={runDryRun}
            disabled={isDryRunning}
          >
            {isDryRunning
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Simulating…</>
              : <><FlaskConical className="w-4 h-4 mr-2" /> Simulate First</>}
          </Button>
          <Button className="flex-1 font-mono font-bold" onClick={startExecute}>
            <Play className="w-4 h-4 mr-2" /> Execute Now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
          <span>{stage}</span>
          <span>{progress}%</span>
        </div>
        <Progress value={Math.max(0, progress)} className="h-2" />
      </div>

      <ScrollArea className="h-48 rounded-md border bg-secondary/20 p-3">
        <div className="space-y-0.5 font-mono text-xs">
          {log.map((line, i) => (
            <div key={i} className={line.startsWith("✓") ? "text-green-400" : line.startsWith("[ROLLING") ? "text-orange-400" : "text-foreground/70"}>
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </ScrollArea>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive font-mono">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Execution failed — all moves rolled back</p>
            <p className="text-xs mt-1 opacity-80">{error}</p>
          </div>
        </div>
      )}

      {done && !error && (
        <Button className="w-full font-mono" onClick={() => onDone(null)}>
          View Summary →
        </Button>
      )}
    </div>
  );
}

// ── Done Step ─────────────────────────────────────────────────────────────────

function DoneStep({ job }: { job: OrganizationJob }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dispositionDone, setDispositionDone]   = useState(false);

  const applyDispositionMutation = useApplyOrganizeJobDisposition({
    mutation: {
      onSuccess: (result) => {
        setConfirmingDelete(false);
        setDispositionDone(true);
        queryClient.invalidateQueries({ queryKey: getGetOrganizeJobQueryKey(job.id) });
        queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() });
        toast({ title: `Archive ${result.dispositionResult === "deleted" ? "deleted" : "disposed"}` });
      },
      onError: (err: any) => {
        toast({ title: "Disposition failed", description: err?.message, variant: "destructive" });
      },
    },
  });

  const plan      = job.planJson as any;
  const report    = (job as any).reportJson as any ?? null;
  const isRolledBack = job.status === "rolled_back";
  const needsDeleteConfirm = !isRolledBack
    && job.archiveDisposition === "delete"
    && job.sourceType === "archive"
    && !dispositionDone;

  // Immich data comes from the execute report, not from planJson
  const immichVerification = report?.immichVerification ?? null;
  const immichRescan       = report?.immichRescan ?? null;

  // Per-type counts from report (populated after execute) or derived from plan routes
  const routes: any[] = plan?.routes ?? [];
  const excludedCats  = new Set<string>(plan?.excludeCategories ?? []);
  const excludedPaths = new Set<string>(plan?.excludePaths ?? []);
  const activeRoutes  = routes.filter((r: any) => !excludedCats.has(r.fileType) && !excludedPaths.has(r.relativePath));
  const photoCount    = activeRoutes.filter((r: any) => r.fileType === "image").length;
  const videoCount    = activeRoutes.filter((r: any) => r.fileType === "video").length;
  const docCount      = activeRoutes.filter((r: any) => r.fileType === "document").length;
  const otherCount    = activeRoutes.filter((r: any) => r.fileType === "other").length;

  const immichVerifyColor = immichVerification?.status === "verified"
    ? "border-green-500/30 bg-green-500/5 text-green-400"
    : immichVerification?.status === "timeout"
    ? "border-amber-500/30 bg-amber-500/5 text-amber-400"
    : "border-blue-500/30 bg-blue-500/5 text-blue-400";

  return (
    <div className="space-y-5">
      {/* Status banner */}
      <div className={`flex items-center gap-3 p-4 rounded-lg border ${isRolledBack ? "border-orange-500/40 bg-orange-500/10" : "border-green-500/40 bg-green-500/10"}`}>
        {isRolledBack
          ? <RotateCcw className="w-8 h-8 text-orange-400 shrink-0" />
          : <CheckCircle2 className="w-8 h-8 text-green-400 shrink-0" />}
        <div>
          <p className={`font-mono font-bold text-lg ${isRolledBack ? "text-orange-400" : "text-green-400"}`}>
            {isRolledBack ? "ROLLED_BACK" : "COMPLETE"}
          </p>
          <p className="text-xs text-muted-foreground font-mono">
            {isRolledBack ? "An error occurred — all moves reversed" : `Completed ${formatDate(job.completedAt)}`}
          </p>
        </div>
      </div>

      {/* Stats — moved + per-type breakdown */}
      {!isRolledBack && (
        <>
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { label: "Moved",    value: Array.isArray(job.fileMoves) ? job.fileMoves.length : (report?.filesMoved ?? "?") },
              { label: "Verified", value: Array.isArray(job.fileMoves) ? job.fileMoves.length : (report?.filesVerified ?? "?") },
              { label: "AI Score", value: plan?.aiConfidence != null ? `${Math.round(plan.aiConfidence * 100)}%` : "N/A" },
            ].map(s => (
              <div key={s.label} className="p-3 bg-secondary/40 rounded-lg border">
                <div className="text-xl font-mono font-bold">{s.value}</div>
                <div className="text-xs text-muted-foreground font-mono">{s.label}</div>
              </div>
            ))}
          </div>
          {/* Per-type breakdown */}
          {(photoCount + videoCount + docCount + otherCount) > 0 && (
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: "Photos",    value: photoCount,  color: "text-blue-400" },
                { label: "Videos",    value: videoCount,  color: "text-purple-400" },
                { label: "Documents", value: docCount,    color: "text-amber-400" },
                { label: "Other",     value: otherCount,  color: "text-muted-foreground" },
              ].map(s => (
                <div key={s.label} className="p-2 bg-secondary/20 rounded border">
                  <div className={`text-base font-mono font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">{s.label}</div>
                </div>
              ))}
            </div>
          )}
          {/* AI reason + recommendation */}
          {(plan?.aiReason || plan?.aiRecommendation) && (
            <div className="p-3 bg-secondary/20 rounded-lg border text-xs font-mono space-y-1">
              {plan.aiReason && <p className="text-muted-foreground"><span className="text-primary/60">Reason:</span> {plan.aiReason}</p>}
              {plan.aiRecommendation && <p className="text-muted-foreground"><span className="text-primary/60">Suggestion:</span> {plan.aiRecommendation}</p>}
            </div>
          )}
        </>
      )}

      {/* Immich verification result (from execute report) */}
      {immichVerification && (
        <div className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs font-mono ${immichVerifyColor}`}>
          <Image className="w-3.5 h-3.5 shrink-0" />
          <span>
            Immich: {immichVerification.status === "verified"
              ? `✓ ${immichVerification.imported}/${immichVerification.expected} assets imported`
              : immichVerification.status === "timeout"
              ? `⏱ Still importing — ${immichVerification.imported}/${immichVerification.expected} confirmed so far`
              : immichVerification.detail}
          </span>
        </div>
      )}
      {/* Fallback: show raw rescan result if no verification data */}
      {!immichVerification && immichRescan && (
        <div className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs font-mono ${immichRescan.triggered ? "border-blue-500/30 bg-blue-500/5 text-blue-400" : "border-muted text-muted-foreground"}`}>
          <Image className="w-3.5 h-3.5 shrink-0" />
          <span>{immichRescan.detail}</span>
        </div>
      )}

      {/* Log + Report path */}
      {(job.reportPath || report?.logPath) && (
        <div className="space-y-1">
          {job.reportPath && (
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground p-2 bg-secondary/20 rounded border">
              <HardDrive className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate" title={job.reportPath}>Report: {job.reportPath.split("/").slice(-2).join("/")}</span>
            </div>
          )}
          {report?.logPath && (
            <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground p-2 bg-secondary/20 rounded border">
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate" title={report.logPath}>Log: {report.logPath.split("/").slice(-2).join("/")}</span>
            </div>
          )}
        </div>
      )}

      {/* Error detail */}
      {isRolledBack && (job as any).error && (
        <div className="text-xs font-mono text-destructive/80 p-2 bg-destructive/5 rounded border border-destructive/20">
          {(job as any).error}
        </div>
      )}

      {/* Delete confirmation gate — required after completion */}
      {needsDeleteConfirm && !dispositionDone && (
        <div className="space-y-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-mono font-bold text-destructive">Archive Deletion — Confirmation Required</p>
              <p className="text-xs text-muted-foreground">
                All <strong>{Array.isArray(job.fileMoves) ? job.fileMoves.length : "?"} files</strong> have been verified at their destinations.
                Permanently delete the original archive?
              </p>
              <p className="text-xs font-mono text-muted-foreground opacity-60 truncate" title={job.sourcePath}>{job.sourcePath}</p>
            </div>
          </div>
          {confirmingDelete ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                className="flex-1 font-mono font-bold"
                disabled={applyDispositionMutation.isPending}
                onClick={() => applyDispositionMutation.mutate({ id: job.id, data: { confirm: true } })}
              >
                {applyDispositionMutation.isPending ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Deleting…</> : "YES — DELETE PERMANENTLY"}
              </Button>
              <Button size="sm" variant="outline" className="font-mono" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="w-full font-mono border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => setConfirmingDelete(true)}>
              I understand — confirm deletion
            </Button>
          )}
        </div>
      )}

      {dispositionDone && (
        <div className="flex items-center gap-2 p-2.5 text-xs font-mono text-green-400 border border-green-500/30 bg-green-500/5 rounded-lg">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          Archive deleted successfully.
        </div>
      )}
    </div>
  );
}

// ── Job Wizard Sheet ──────────────────────────────────────────────────────────

function JobWizardSheet({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const queryClient = useQueryClient();

  const { data: job, isLoading } = useGetOrganizeJob(jobId, {
    query: {
      queryKey: getGetOrganizeJobQueryKey(jobId),
      enabled: !!jobId,
      refetchInterval: (data) => {
        const s = (data as any)?.status;
        return s === "analyzing" || s === "executing" ? 1500 : false;
      },
    },
  });

  useEffect(() => {
    if (!job) return;
    if (job.status === "pending" || job.status === "analyzing") setStep(1);
    else if (job.status === "planned") setStep(1);
    else if (job.status === "verified") setStep(2);
    else if (job.status === "executing") setStep(3);
    else if (job.status === "completed" || job.status === "rolled_back" || job.status === "failed") setStep(4);
  }, [job?.status]);

  return (
    <Sheet open={!!jobId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-primary">
            Job #{jobId} — {job?.sourceType === "archive" ? "Archive" : "Folder"}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-6">
          <StepIndicator current={step} />
          {isLoading && <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-32 w-full" /></div>}
          {!isLoading && job && step === 1 && <AnalyzeStep job={job} onDone={() => setStep(2)} />}
          {!isLoading && job && step === 2 && <PreflightStep job={job} onDone={() => setStep(3)} />}
          {!isLoading && job && step === 3 && <ExecuteStep job={job} onDone={() => setStep(4)} />}
          {!isLoading && job && step === 4 && <DoneStep job={job} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Organize() {
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [showNew, setShowNew]         = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: jobs, isLoading } = useListOrganizeJobs({
    query: { queryKey: getListOrganizeJobsQueryKey(), refetchInterval: 5000 },
  });

  const deleteMutation = useDeleteOrganizeJob({
    mutation: {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() }); toast({ title: "Job deleted" }); },
      onError:   (err: any) => toast({ title: "Failed to delete", description: err?.message, variant: "destructive" }),
    },
  });

  const closeSheet = () => { setActiveJobId(null); setShowNew(false); };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold font-mono tracking-tight">OPERATIONS_CENTER</h1>
          <p className="text-muted-foreground mt-1 font-mono text-sm">Extract archives and route files to the right destination</p>
        </div>
        <Button onClick={() => { setActiveJobId(null); setShowNew(true); }} className="font-mono font-bold">
          <Plus className="w-4 h-4 mr-2" /> New Job
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Files</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-20"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-24 w-full" /></TableCell></TableRow>
            ) : (jobs?.length ?? 0) === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12">
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <Boxes className="w-10 h-10 opacity-30" />
                    <p className="font-mono text-sm">No operations jobs yet</p>
                    <Button size="sm" variant="outline" onClick={() => setShowNew(true)} className="font-mono">
                      <Plus className="w-3.5 h-3.5 mr-1.5" /> Create First Job
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : jobs?.map((job) => {
              const plan = job.planJson as any;
              return (
                <TableRow key={job.id} className="cursor-pointer hover:bg-secondary/30" onClick={() => { setActiveJobId(job.id); setShowNew(false); }}>
                  <TableCell className="font-mono text-xs max-w-[180px] truncate" title={job.sourcePath}>
                    <span className="font-medium">{job.sourcePath.split("/").pop()}</span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
                      {job.sourceType === "archive" ? <Archive className="w-3.5 h-3.5" /> : <FolderOpen className="w-3.5 h-3.5" />}
                      {job.sourceType}
                    </span>
                  </TableCell>
                  <TableCell>{statusBadge(job.status)}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {plan?.totalFiles != null ? plan.totalFiles.toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(job.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      {/* View Report / Open button */}
                      {job.status === "completed" || job.status === "rolled_back" ? (
                        <Button
                          variant="ghost" size="sm" className="h-7 px-2 text-xs font-mono text-primary/80 hover:text-primary"
                          onClick={() => { setActiveJobId(job.id); setShowNew(false); }}
                          title="View Report"
                        >
                          <FileText className="w-3.5 h-3.5 mr-1" /> Report
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { setActiveJobId(job.id); setShowNew(false); }}>
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        disabled={job.status === "executing" || deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate({ id: job.id })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* New job sheet */}
      {showNew && (
        <Sheet open={showNew} onOpenChange={(open) => !open && closeSheet()}>
          <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
            <SheetHeader>
              <SheetTitle className="font-mono text-primary">New Organization Job</SheetTitle>
            </SheetHeader>
            <div className="mt-6">
              <StepIndicator current={0} />
              <SetupStep onCreated={(id) => {
                queryClient.invalidateQueries({ queryKey: getListOrganizeJobsQueryKey() });
                setShowNew(false);
                setActiveJobId(id);
              }} />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Existing job wizard */}
      {activeJobId && <JobWizardSheet jobId={activeJobId} onClose={closeSheet} />}
    </div>
  );
}
