import { useState, useEffect, useRef } from "react";
import { 
  useGetSettings, getGetSettingsQueryKey,
  useUpdateSettings,
  useTestNasPath,
  useGetScanStatus, getGetScanStatusQueryKey,
  useGetScanHistory, getGetScanHistoryQueryKey,
  useStartScan,
  useChangePassword,
  useListSessions, getListSessionsQueryKey,
  useRevokeSession,
  useRevokeOtherSessions,
  useGetNasDirStatus, getGetNasDirStatusQueryKey,
  useReinitNasDirs,
  uploadSettingsLogo,
  useDeleteSettingsLogo,
  getGetSettingsLogoUrl,
  useGetLibraryHealth, getGetLibraryHealthQueryKey,
  usePauseIndexing,
  useResumeIndexing,
} from "@workspace/api-client-react";
import { LibrarySetup } from "@/components/library/library-setup";
import { useMutation } from "@tanstack/react-query";
import type { NasTestResult } from "@workspace/api-client-react";
import { formatBytes, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Settings2, Play, CheckCircle2, XCircle, Activity, Loader2, FolderOpen, AlertCircle, Lock, Shield, Monitor, Trash2, HardDrive, RefreshCw, Image as ImageIcon, UploadCloud, Layers, BarChart2, AlertTriangle, Filter, Plus, X as XIcon, Eye } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useQueryClient } from "@tanstack/react-query";

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: settings, isLoading: settingsLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() }
  });

  const { data: scanStatus } = useGetScanStatus({
    query: { 
      queryKey: getGetScanStatusQueryKey(),
      refetchInterval: 3000 // poll every 3s
    }
  });

  const { data: scanHistory, isLoading: historyLoading } = useGetScanHistory({
    query: { queryKey: getGetScanHistoryQueryKey() }
  });

  const { data: diagScans } = useQuery<{
    scans: Array<{
      status: string;
      startedAt:  string | null;
      finishedAt: string | null;
      diagnostics: { throughputFilesPerSec: number } | null;
    }>;
  }>({
    queryKey: ["diagnostics-scans-typical"],
    queryFn: async () => {
      const res = await fetch("/api/diagnostics/scans");
      if (!res.ok) return { scans: [] };
      return res.json();
    },
    staleTime: 60_000,
  });

  const { typicalFilesPerSec, typicalScanDurationMs } = (() => {
    const recent = (diagScans?.scans ?? [])
      .filter(s => s.status === "DONE" && (s.diagnostics?.throughputFilesPerSec ?? 0) > 0)
      .slice(0, 5);
    if (recent.length === 0) return { typicalFilesPerSec: null, typicalScanDurationMs: null };

    const fps = recent.reduce((a, s) => a + s.diagnostics!.throughputFilesPerSec, 0) / recent.length;

    const durations = recent
      .filter(s => s.startedAt && s.finishedAt)
      .map(s => new Date(s.finishedAt!).getTime() - new Date(s.startedAt!).getTime());
    const avgDur = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    return { typicalFilesPerSec: fps, typicalScanDurationMs: avgDur };
  })();

  function fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  const updateMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Settings updated successfully" });
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      },
      onError: (err: any) => toast({ title: "Failed to update", description: err.message, variant: "destructive" })
    }
  });

  const startScanMutation = useStartScan({
    mutation: {
      onSuccess: () => {
        toast({ title: "Scan started" });
        queryClient.invalidateQueries({ queryKey: getGetScanStatusQueryKey() });
      }
    }
  });

  const [nasTestResult, setNasTestResult] = useState<NasTestResult | null>(null);

  const testNasMutation = useTestNasPath({
    mutation: {
      onSuccess: (data) => setNasTestResult(data),
      onError: () => setNasTestResult(null),
    }
  });

  const [form, setForm] = useState({
    nasPath: "",
    photosDestination: "",
    videosDestination: "",
    documentsDestination: "",
    otherFilesDestination: "",
    scanPerformance: "BALANCED" as "HIGH" | "BALANCED" | "LOW",
  });

  useEffect(() => {
    if (settings) {
      setForm({
        nasPath: settings.nasPath,
        photosDestination: settings.photosDestination ?? "",
        videosDestination: settings.videosDestination ?? "",
        documentsDestination: settings.documentsDestination ?? "",
        otherFilesDestination: settings.otherFilesDestination ?? "",
        scanPerformance: (settings.scanPerformance ?? "BALANCED") as "HIGH" | "BALANCED" | "LOW",
      });
    }
  }, [settings]);

  const handleSave = () => {
    updateMutation.mutate({ data: form });
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight">SYSTEM_CONFIGURATION</h1>
      </div>

      <LibrarySection />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center"><Settings2 className="w-5 h-5 mr-2"/> NAS Configuration</CardTitle>
            <CardDescription>Path to your mounted WD My Cloud</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settingsLoading ? <Skeleton className="h-10 w-full" /> : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>NAS Root Path</Label>
                  <Input 
                    value={form.nasPath} 
                    onChange={e => { setForm({...form, nasPath: e.target.value}); setNasTestResult(null); }} 
                    placeholder="/mnt/nas  or  /Volumes/Public"
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Mount your NAS share first, then enter the mount path here. e.g. <code className="bg-secondary px-1 rounded">/mnt/nas</code> or <code className="bg-secondary px-1 rounded">/Volumes/Public</code>
                  </p>
                </div>
                {nasTestResult && (
                  <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                    nasTestResult.accessible
                      ? "border-green-500/40 bg-green-500/10 text-green-400"
                      : "border-destructive/40 bg-destructive/10 text-destructive"
                  }`}>
                    {nasTestResult.accessible
                      ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                      : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                    <span className="font-mono text-xs">{nasTestResult.message}</span>
                  </div>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full font-mono"
                  disabled={testNasMutation.isPending || !form.nasPath}
                  onClick={() => testNasMutation.mutate({ data: { path: form.nasPath } })}
                >
                  {testNasMutation.isPending
                    ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Testing…</>
                    : <><FolderOpen className="w-3.5 h-3.5 mr-2" /> Test NAS Path</>}
                </Button>
              </div>
            )}
          </CardContent>
          <CardFooter>
            <Button onClick={handleSave} disabled={updateMutation.isPending || settingsLoading} className="w-full font-mono font-bold">
              {updateMutation.isPending ? "SAVING..." : "SAVE_CONFIG"}
            </Button>
          </CardFooter>
        </Card>

      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center"><HardDrive className="w-5 h-5 mr-2"/> Organize Destinations</CardTitle>
          <CardDescription>Where the Organization Center routes each file type. Leave blank to use NAS root subfolders (Photos/, Videos/, Documents/, Files/).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {settingsLoading ? <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div> : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { label: "Photos Destination", key: "photosDestination", placeholder: "e.g. /mnt/nas/Photos" },
                { label: "Videos Destination", key: "videosDestination", placeholder: "e.g. /mnt/nas/Videos" },
                { label: "Documents Destination", key: "documentsDestination", placeholder: "e.g. /mnt/nas/Documents" },
                { label: "Other Files Destination", key: "otherFilesDestination", placeholder: "e.g. /mnt/nas/Files" },
              ].map(({ label, key, placeholder }) => (
                <div key={key} className="space-y-2">
                  <Label>{label}</Label>
                  <Input
                    value={(form as any)[key]}
                    onChange={e => setForm({ ...form, [key]: e.target.value })}
                    placeholder={placeholder}
                    className="font-mono text-sm"
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
        <CardFooter>
          <Button onClick={handleSave} disabled={updateMutation.isPending || settingsLoading} className="w-full font-mono font-bold">
            {updateMutation.isPending ? "SAVING..." : "SAVE_DESTINATIONS"}
          </Button>
        </CardFooter>
      </Card>

      <BrandingSection />

      <ThumbnailManagerSection />

      <ScannerSettingsSection />

      <Card className="border-primary/50">
        <CardHeader>
          <CardTitle className="flex items-center text-primary">
            <Activity className="w-5 h-5 mr-2" /> Scanner Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 bg-secondary/50 rounded-lg border border-border space-y-2">
            <Label>Scan Performance</Label>
            <select
              value={form.scanPerformance}
              onChange={(e) => {
                const scanPerformance = e.target.value as "HIGH" | "BALANCED" | "LOW";
                setForm({ ...form, scanPerformance });
                updateMutation.mutate({ data: { scanPerformance } });
              }}
              className="w-full h-9 text-sm font-mono bg-background border border-border rounded-md px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="select-scan-performance"
            >
              <option value="HIGH">High — fastest scan, heaviest NAS load</option>
              <option value="BALANCED">Balanced — good speed, NAS stays responsive</option>
              <option value="LOW">Low impact — slowest scan, minimal NAS load</option>
            </select>
            <p className="text-xs text-muted-foreground font-mono">
              Applies to the next scan. Balanced is recommended for daily use.
            </p>
          </div>
          <div className="flex items-center justify-between p-4 bg-secondary/50 rounded-lg border border-primary/20">
            <div>
              <h3 className="font-mono font-bold text-lg">
                {scanStatus?.isRunning ? "SCAN_IN_PROGRESS" : "SYSTEM_IDLE"}
              </h3>
              {scanStatus?.isRunning && scanStatus.current ? (
                <p className="text-sm text-muted-foreground mt-1 font-mono">
                  Stage: {scanStatus.current.stage} | Files: {scanStatus.current.filesScanned}
                </p>
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground mt-1 font-mono">
                    Total indexed: {settings?.totalFilesIndexed.toLocaleString()} files
                  </p>
                  {typicalFilesPerSec !== null && (
                    <p className="text-xs text-muted-foreground/70 font-mono">
                      Typical speed: {typicalFilesPerSec.toFixed(1)} files/sec
                      {typicalScanDurationMs !== null && (
                        <> · avg scan: {fmtDuration(typicalScanDurationMs)}</>
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
            <Button 
              size="lg"
              disabled={scanStatus?.isRunning || startScanMutation.isPending}
              onClick={() => startScanMutation.mutate()}
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-mono font-bold"
            >
              {scanStatus?.isRunning ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> SCANNING</>
              ) : (
                <><Play className="w-4 h-4 mr-2" /> START_INDEX_SCAN</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scan History</CardTitle>
        </CardHeader>
        <CardContent>
          {historyLoading ? <Skeleton className="h-32 w-full" /> : (
            <div className="space-y-2">
              {scanHistory?.map(job => (
                <div key={job.id} className="p-3 text-sm bg-secondary/20 rounded border space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      {job.status === 'completed' ? <CheckCircle2 className="text-green-500 w-4 h-4 shrink-0" /> : 
                       job.status === 'failed' ? <XCircle className="text-destructive w-4 h-4 shrink-0" /> : 
                       <Activity className="text-primary w-4 h-4 shrink-0" />}
                      <span className="font-mono">{formatDate(job.startedAt)}</span>
                    </div>
                    <div className="flex items-center space-x-4 font-mono text-muted-foreground">
                      <span>{job.filesScanned} files</span>
                      <span className={`uppercase text-xs font-bold ${job.status === 'failed' ? 'text-destructive' : job.status === 'completed' ? 'text-green-500' : ''}`}>{job.status}</span>
                    </div>
                  </div>
                  {job.status === 'failed' && job.error && (
                    <div className="flex items-start gap-1.5 ml-7 text-xs text-destructive/80 font-mono">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{job.error}</span>
                    </div>
                  )}
                </div>
              ))}
              {scanHistory?.length === 0 && <p className="text-muted-foreground text-center py-4">No scan history available</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <SecuritySection />
      <StorageSection />
    </div>
  );
}

function LibrarySection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);

  const { data: health } = useGetLibraryHealth({
    query: { queryKey: getGetLibraryHealthQueryKey(), refetchInterval: 10000 },
  });
  const { data: settings } = useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
  const { data: scanStatus } = useGetScanStatus({
    query: { queryKey: getGetScanStatusQueryKey(), refetchInterval: 5000 },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetLibraryHealthQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
  };

  const rescanMutation = useStartScan({
    mutation: {
      onSuccess: () => {
        toast({ title: "Rescan started" });
        queryClient.invalidateQueries({ queryKey: getGetScanStatusQueryKey() });
        invalidate();
      },
      onError: (err: any) => toast({ title: "Couldn't start rescan", description: err?.message, variant: "destructive" }),
    },
  });
  const pauseMutation = usePauseIndexing({
    mutation: { onSuccess: () => { toast({ title: "Indexing paused" }); invalidate(); } },
  });
  const resumeMutation = useResumeIndexing({
    mutation: { onSuccess: () => { toast({ title: "Indexing resumed" }); invalidate(); } },
  });

  const online = health?.status === "online";
  const offline = health?.status === "offline";
  const paused = health?.indexingPaused ?? false;
  const lastSync = health?.lastCheckAt ? formatDate(health.lastCheckAt) : "—";

  const statusRows = [
    { label: "Connected", ok: online, detail: offline ? (health?.message || "Library unreachable") : null },
    { label: "Watching for changes", ok: Boolean(health?.watching) && !paused, detail: paused ? "Indexing paused" : null },
    { label: "AI Index up to date", ok: online && !scanStatus?.isRunning && Boolean(settings?.lastScanAt), detail: scanStatus?.isRunning ? "Indexing in progress" : null },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center"><HardDrive className="w-5 h-5 mr-2" /> Libraries</CardTitle>
        <CardDescription>Your media library location, health, and indexing controls.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {changing || !settings?.nasPath ? (
          <div className="py-2">
            <LibrarySetup
              title={settings?.nasPath ? "Change your media library" : "Set up your media library"}
              subtitle="Pick a detected drive or enter the folder path where your media lives."
              onDone={() => { setChanging(false); invalidate(); }}
            />
            {settings?.nasPath && (
              <Button variant="ghost" size="sm" className="w-full mt-3" onClick={() => setChanging(false)}>
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Currently Watching</p>
                <p className="text-sm font-mono truncate" title={health?.path || settings.nasPath}>{health?.path || settings.nasPath}</p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Last Scan</p>
                <p className="text-sm">{settings.lastScanAt ? formatDate(settings.lastScanAt) : "Never"}</p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Last Sync Check</p>
                <p className="text-sm">{lastSync}</p>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3 space-y-2">
              {statusRows.map(({ label, ok, detail }) => (
                <div key={label} className="flex items-center gap-2 text-sm">
                  {ok
                    ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                    : <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />}
                  <span>{label}</span>
                  {detail && <span className="text-xs text-muted-foreground ml-auto">{detail}</span>}
                </div>
              ))}
              {offline && (
                <p className="text-xs text-amber-400 pt-1">
                  Your media library is currently offline{health?.lastOnlineAt ? ` — last successful connection ${formatDate(health.lastOnlineAt)}` : ""}. Willard AI will reconnect automatically.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={rescanMutation.isPending || scanStatus?.isRunning || offline}
                onClick={() => rescanMutation.mutate()}
              >
                {scanStatus?.isRunning
                  ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Scanning…</>
                  : <><RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Rescan</>}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={pauseMutation.isPending || resumeMutation.isPending}
                onClick={() => (paused ? resumeMutation.mutate() : pauseMutation.mutate())}
              >
                {paused ? <><Play className="w-3.5 h-3.5 mr-1.5" /> Resume Indexing</> : <><Lock className="w-3.5 h-3.5 mr-1.5" /> Pause Indexing</>}
              </Button>
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setChanging(true)}>
                <FolderOpen className="w-3.5 h-3.5 mr-1.5" /> Change Library
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface ScannerSettings {
  ignoredFolders:    string[];
  ignoredExtensions: string[];
  ignoreHiddenFiles:  boolean;
  ignoreSystemFiles:  boolean;
  ignoreTempFiles:    boolean;
  ignoreSidecarFiles: boolean;
  ignoreEmptyFolders: boolean;
  followSymlinks:     boolean;
  indexOtherFiles:    boolean;
}

const SCANNER_DEFAULTS: ScannerSettings = {
  ignoredFolders: [], ignoredExtensions: [],
  ignoreHiddenFiles: true, ignoreSystemFiles: true,
  ignoreTempFiles: true, ignoreSidecarFiles: true,
  ignoreEmptyFolders: false, followSymlinks: false,
  indexOtherFiles: true,
};

function ScannerSettingsSection() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<ScannerSettings>(SCANNER_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [folderInput, setFolderInput] = useState("");
  const [extInput, setExtInput] = useState("");
  const [dryRun, setDryRun] = useState<{ wouldScan: number; skipped: Record<string, number> } | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);

  useEffect(() => {
    fetch("/api/settings/scanner")
      .then(r => r.json())
      .then(data => { setSettings(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const save = async (patch: Partial<ScannerSettings>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/scanner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Save failed");
      const updated = await res.json() as ScannerSettings;
      setSettings(updated);
      toast({ title: "Scanner settings saved" });
    } catch {
      toast({ title: "Failed to save scanner settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: keyof ScannerSettings) => {
    const next = { ...settings, [key]: !settings[key as keyof ScannerSettings] };
    setSettings(next);
    void save({ [key]: next[key as keyof ScannerSettings] });
  };

  const addFolder = () => {
    const val = folderInput.trim();
    if (!val || settings.ignoredFolders.includes(val)) { setFolderInput(""); return; }
    const next = [...settings.ignoredFolders, val];
    setFolderInput("");
    void save({ ignoredFolders: next });
  };

  const removeFolder = (f: string) => {
    void save({ ignoredFolders: settings.ignoredFolders.filter(x => x !== f) });
  };

  const addExt = () => {
    const val = extInput.trim().toLowerCase().replace(/^\./, "");
    if (!val || settings.ignoredExtensions.includes(val)) { setExtInput(""); return; }
    const next = [...settings.ignoredExtensions, val];
    setExtInput("");
    void save({ ignoredExtensions: next });
  };

  const removeExt = (e: string) => {
    void save({ ignoredExtensions: settings.ignoredExtensions.filter(x => x !== e) });
  };

  const runDryRun = async () => {
    setDryRunLoading(true);
    setDryRun(null);
    try {
      const res = await fetch("/api/library/scan/dry-run", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Dry-run failed");
      setDryRun(await res.json());
    } catch (err: any) {
      toast({ title: "Dry-run failed", description: err?.message, variant: "destructive" });
    } finally {
      setDryRunLoading(false);
    }
  };

  const TOGGLES: { key: keyof ScannerSettings; label: string; description: string }[] = [
    { key: "ignoreHiddenFiles",  label: "Skip hidden files",       description: "Files starting with a dot (e.g. .gitignore, .DS_Store)" },
    { key: "ignoreSystemFiles",  label: "Skip system files",       description: "OS metadata files (Thumbs.db, desktop.ini, ._resource forks)" },
    { key: "ignoreTempFiles",    label: "Skip temp files",         description: "Files with .tmp or .temp extensions" },
    { key: "ignoreSidecarFiles", label: "Skip sidecar files",      description: "Camera sidecar thumbnails (.thm)" },
    { key: "ignoreEmptyFolders", label: "Skip empty folders",      description: "Don't record folders with no indexable files" },
    { key: "followSymlinks",     label: "Follow symbolic links",   description: "Index files reached via symlinks (use with care to avoid loops)" },
    { key: "indexOtherFiles",    label: "Index other file types",  description: "Include executables, archives, disk images, and other non-media files (exe, dll, iso, zip…)" },
  ];

  if (loading) return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-48 w-full" />
    </div>
  );

  return (
    <>
      <div className="pt-4">
        <h2 className="text-xl font-bold font-mono tracking-tight flex items-center gap-2">
          <Filter className="w-5 h-5 text-primary" />
          SCANNER_EXCLUSIONS
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Control which files and folders the scanner ignores. Changes take effect on the next scan.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exclusion Toggles</CardTitle>
          <CardDescription>Built-in filters — enable or disable each category.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {TOGGLES.map(({ key, label, description }) => (
            <div key={key} className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground font-mono">{description}</p>
              </div>
              <Switch
                checked={!!settings[key]}
                onCheckedChange={() => toggle(key)}
                disabled={saving}
              />
            </div>
          ))}
          {!settings.indexOtherFiles && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 font-mono flex items-start gap-2">
              <span className="shrink-0 mt-px">⚠</span>
              <span>
                Other file types excluded from indexing — executables, archives, disk images, and similar
                files (exe, dll, iso, zip…) will be skipped by the scanner.
                Enable <strong>Index other file types</strong> above to include them.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ignored Folders</CardTitle>
          <CardDescription>Relative paths from your NAS root that the scanner will skip entirely.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={folderInput}
              onChange={e => setFolderInput(e.target.value)}
              placeholder="e.g. Archive/OldProjects"
              className="font-mono text-sm"
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addFolder(); } }}
            />
            <Button size="sm" variant="secondary" onClick={addFolder} disabled={saving || !folderInput.trim()}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          {settings.ignoredFolders.length === 0 ? (
            <p className="text-xs text-muted-foreground font-mono">No folders ignored.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {settings.ignoredFolders.map(f => (
                <Badge key={f} variant="secondary" className="font-mono text-xs gap-1.5 pl-2 pr-1 py-1">
                  {f}
                  <button onClick={() => removeFolder(f)} className="rounded hover:bg-destructive/20 hover:text-destructive transition-colors">
                    <XIcon className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ignored Extensions</CardTitle>
          <CardDescription>File extensions (without the dot) to skip during scanning.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={extInput}
              onChange={e => setExtInput(e.target.value)}
              placeholder="e.g. bak, log, zip"
              className="font-mono text-sm"
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addExt(); } }}
            />
            <Button size="sm" variant="secondary" onClick={addExt} disabled={saving || !extInput.trim()}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          {settings.ignoredExtensions.length === 0 ? (
            <p className="text-xs text-muted-foreground font-mono">No extensions ignored.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {settings.ignoredExtensions.map(e => (
                <Badge key={e} variant="secondary" className="font-mono text-xs gap-1.5 pl-2 pr-1 py-1">
                  .{e}
                  <button onClick={() => removeExt(e)} className="rounded hover:bg-destructive/20 hover:text-destructive transition-colors">
                    <XIcon className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Eye className="w-4 h-4" /> Dry Run</CardTitle>
          <CardDescription>Preview how many files would be scanned with current exclusion settings — without changing anything.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!settings.indexOtherFiles && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 font-mono flex items-start gap-2">
              <span className="shrink-0 mt-px">⚠</span>
              <span>
                <strong>Other file types excluded</strong> — executables, archives, disk images, and similar
                files (exe, dll, iso, zip, rar, 7z, msi, bin, dat, bak, cfg, bat, sh…) are skipped by the scanner.
                These will also appear as <em>other_type_excluded</em> in the dry-run skipped breakdown below.
              </span>
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="font-mono"
            onClick={runDryRun}
            disabled={dryRunLoading}
          >
            {dryRunLoading
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Running…</>
              : <><Play className="w-3.5 h-3.5 mr-1.5" /> Run Dry-Run Scan</>}
          </Button>
          {dryRun && (
            <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3 font-mono text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                <span className="font-bold">{dryRun.wouldScan.toLocaleString()} files would be scanned</span>
              </div>
              {Object.entries(dryRun.skipped).length > 0 && (
                <div className="space-y-1 pl-6 text-xs text-muted-foreground">
                  <p className="text-foreground font-semibold mb-1">Skipped:</p>
                  {Object.entries(dryRun.skipped)
                    .sort(([,a],[,b]) => b - a)
                    .map(([reason, count]) => (
                      <div key={reason} className="flex justify-between gap-4">
                        <span>{reason.replace(/_/g, " ")}</span>
                        <span>{count.toLocaleString()}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ThumbnailManagerSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings } = useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
  const thumbnailQuality = (settings as any)?.thumbnailQuality ?? "BALANCED";
  const [localQuality, setLocalQuality] = useState<string | null>(null);
  const displayQuality = localQuality ?? thumbnailQuality;

  const [thumbStats, setThumbStats] = useState<{ total: number; built: number; missing: number; cacheSizeBytes: number } | null>(null);
  const [thumbLoading, setThumbLoading] = useState(true);
  const [thumbError, setThumbError] = useState<string | null>(null);

  const fetchStats = async () => {
    setThumbLoading(true);
    setThumbError(null);
    try {
      const res = await fetch("/api/library/thumbnails/status");
      if (!res.ok) throw new Error("Failed to fetch stats");
      const data = await res.json();
      setThumbStats(data);
    } catch (err: any) {
      setThumbError(err?.message ?? "Failed to load stats");
    } finally {
      setThumbLoading(false);
    }
  };

  useEffect(() => { void fetchStats(); }, []);

  const updateMutation = useMutation({
    mutationFn: async (q: string) => {
      const res = await fetch("/api/library/thumbnails/quality", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: q }),
      });
      if (!res.ok) throw new Error("Failed to update");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
      toast({ title: "Thumbnail quality updated" });
    },
    onError: () => toast({ title: "Failed to update quality", variant: "destructive" }),
  });

  const rebuildMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/library/thumbnails/rebuild", { method: "POST" });
      if (!res.ok) throw new Error("Failed to start rebuild");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Thumbnail rebuild started", description: "Existing thumbnails cleared and regeneration begun." });
      void fetchStats();
    },
    onError: (err: any) => toast({ title: "Failed to rebuild cache", description: err?.message, variant: "destructive" }),
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/library/thumbnails/cache", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear cache");
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: `Cleared ${data.deleted ?? 0} thumbnails` });
      void fetchStats();
    },
    onError: (err: any) => toast({ title: "Failed to clear cache", description: err?.message, variant: "destructive" }),
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/library/thumbnails", { method: "POST" });
      if (!res.ok) throw new Error("Failed to start");
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data.alreadyRunning) {
        toast({ title: "Thumbnail job already running" });
      } else {
        toast({ title: "Thumbnail generation started" });
      }
      void fetchStats();
    },
    onError: (err: any) => toast({ title: "Failed to start", description: err?.message, variant: "destructive" }),
  });

  const pct = thumbStats && thumbStats.total > 0
    ? Math.round((thumbStats.built / thumbStats.total) * 100)
    : thumbStats?.total === 0 ? 100 : 0;

  return (
    <>
      <div className="pt-4">
        <h2 className="text-xl font-bold font-mono tracking-tight flex items-center gap-2">
          <Layers className="w-5 h-5 text-primary" />
          THUMBNAIL_CACHE
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage thumbnail generation quality and cache. Thumbnails speed up the media library browser.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart2 className="w-4 h-4" /> Cache Status
          </CardTitle>
          <CardDescription>
            How many thumbnails have been generated vs. total eligible files
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {thumbLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-3 w-full rounded-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : thumbError ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono p-3 bg-secondary/20 rounded border border-dashed">
              <AlertCircle className="w-4 h-4 shrink-0 text-amber-500" />
              {thumbError}
            </div>
          ) : thumbStats ? (
            <>
              {/* Progress bar */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground font-mono">
                  <span>{thumbStats.built.toLocaleString()} built</span>
                  <span>{pct}%</span>
                </div>
                <div className="h-2 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground font-mono">
                  <span>{thumbStats.missing.toLocaleString()} missing</span>
                  <span>{thumbStats.total.toLocaleString()} total</span>
                </div>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col items-center p-3 rounded-lg bg-secondary/30 border border-border">
                  <span className="text-lg font-bold tabular-nums">{thumbStats.built.toLocaleString()}</span>
                  <span className="text-[10px] text-muted-foreground font-mono mt-0.5">BUILT</span>
                </div>
                <div className="flex flex-col items-center p-3 rounded-lg bg-secondary/30 border border-border">
                  <span className={`text-lg font-bold tabular-nums ${thumbStats.missing > 0 ? "text-amber-400" : "text-green-400"}`}>
                    {thumbStats.missing.toLocaleString()}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono mt-0.5">MISSING</span>
                </div>
                <div className="flex flex-col items-center p-3 rounded-lg bg-secondary/30 border border-border">
                  <span className="text-lg font-bold tabular-nums">{formatBytes(thumbStats.cacheSizeBytes)}</span>
                  <span className="text-[10px] text-muted-foreground font-mono mt-0.5">CACHE SIZE</span>
                </div>
              </div>
            </>
          ) : null}

          {/* Quality selector */}
          <div className="space-y-2 pt-2 border-t border-border">
            <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Thumbnail Quality
            </Label>
            <select
              value={displayQuality}
              onChange={(e) => {
                const q = e.target.value;
                setLocalQuality(q);
                updateMutation.mutate(q);
              }}
              className="w-full h-9 text-sm font-mono bg-background border border-border rounded-md px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="FAST">Fast — 256px · smaller files, lower detail</option>
              <option value="BALANCED">Balanced — 512px · good quality, moderate size</option>
              <option value="HIGH">High — 1024px · sharpest detail, larger cache</option>
            </select>
            <p className="text-xs text-muted-foreground font-mono">
              Applies to newly generated thumbnails. Use Rebuild to regenerate existing thumbnails at the new quality.
            </p>
          </div>
        </CardContent>
        <CardFooter className="gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            className="font-mono"
            disabled={startMutation.isPending || rebuildMutation.isPending}
            onClick={() => startMutation.mutate()}
          >
            {startMutation.isPending
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Starting…</>
              : <><Play className="w-3.5 h-3.5 mr-1.5" /> Generate Missing</>}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="font-mono"
            disabled={rebuildMutation.isPending || startMutation.isPending}
            onClick={() => rebuildMutation.mutate()}
          >
            {rebuildMutation.isPending
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Rebuilding…</>
              : <><RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Rebuild Cache</>}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="font-mono text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate()}
          >
            {clearMutation.isPending
              ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Clearing…</>
              : <><Trash2 className="w-3.5 h-3.5 mr-1.5" /> Clear Cache</>}
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}

function BrandingSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: settings } = useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
  const hasLogo = !!settings?.logoPath;

  // Cache-busting key so the preview/sidebar/hero refresh after upload or delete
  const [logoVersion, setLogoVersion] = useState(0);
  const logoSrc = `${getGetSettingsLogoUrl()}?v=${logoVersion}`;

  const refreshLogoEverywhere = () => {
    setLogoVersion((v) => v + 1);
    queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
    window.dispatchEvent(new Event("willard-logo-updated"));
  };

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadSettingsLogo({ file }),
    onSuccess: () => {
      toast({ title: "Logo updated" });
      refreshLogoEverywhere();
    },
    onError: (err: any) => toast({
      title: "Failed to upload logo",
      description: err?.message ?? "Something went wrong.",
      variant: "destructive",
    }),
  });

  const deleteMutation = useDeleteSettingsLogo({
    mutation: {
      onSuccess: () => {
        toast({ title: "Logo removed" });
        refreshLogoEverywhere();
      },
      onError: () => toast({ title: "Failed to remove logo", variant: "destructive" }),
    },
  });

  const ACCEPTED = ["image/png", "image/jpeg", "image/svg+xml"];
  const MAX_BYTES = 2 * 1024 * 1024;

  const handleFile = (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      toast({ title: "Unsupported file type", description: "Please use a PNG, JPG, or SVG image.", variant: "destructive" });
      return;
    }
    if (file.size > MAX_BYTES) {
      toast({ title: "File too large", description: "Maximum size is 2MB.", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(file);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ImageIcon className="w-5 h-5" /> Branding</CardTitle>
        <CardDescription>Upload a logo to display in the sidebar and on the dashboard banner. PNG, JPG, or SVG, up to 2MB.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          <div className="flex h-20 w-40 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/30 overflow-hidden">
            {hasLogo ? (
              <img
                key={logoVersion}
                src={logoSrc}
                alt="Current logo"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">No logo set</span>
            )}
          </div>
          <div className="flex-1 space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="font-mono"
                disabled={uploadMutation.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadMutation.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Uploading…</>
                ) : (
                  <><UploadCloud className="w-3.5 h-3.5 mr-2" /> {hasLogo ? "Replace Logo" : "Upload Logo"}</>
                )}
              </Button>
              {hasLogo && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="font-mono text-destructive hover:text-destructive hover:bg-destructive/10"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                >
                  {deleteMutation.isPending ? (
                    <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Removing…</>
                  ) : (
                    <><Trash2 className="w-3.5 h-3.5 mr-2" /> Remove</>
                  )}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Your logo replaces the WILLARD_AI text in the sidebar and appears on the dashboard banner.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SecuritySection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });

  const changePasswordMutation = useChangePassword({
    mutation: {
      onSuccess: () => {
        toast({ title: "Password changed successfully" });
        setPwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      },
      onError: (err: any) => toast({
        title: "Failed to change password",
        description: err?.response?.data?.error ?? "Something went wrong.",
        variant: "destructive",
      }),
    },
  });

  const { data: sessionsData, isLoading: sessionsLoading } = useListSessions({
    query: { queryKey: getListSessionsQueryKey() },
  });

  const revokeSessionMutation = useRevokeSession({
    mutation: {
      onSuccess: () => {
        toast({ title: "Session revoked" });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      },
      onError: () => toast({ title: "Failed to revoke session", variant: "destructive" }),
    },
  });

  const revokeOthersMutation = useRevokeOtherSessions({
    mutation: {
      onSuccess: () => {
        toast({ title: "All other sessions revoked" });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      },
      onError: () => toast({ title: "Failed to revoke sessions", variant: "destructive" }),
    },
  });

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (pwForm.newPassword.length < 6) {
      toast({ title: "Password too short", description: "Must be at least 6 characters.", variant: "destructive" });
      return;
    }
    changePasswordMutation.mutate({
      data: { currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword },
    });
  };

  const formatRelativeTime = (dateStr: string | null | undefined) => {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr);
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <>
      <div className="pt-4">
        <h2 className="text-xl font-bold font-mono tracking-tight flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          SECURITY
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="w-4 h-4" /> Change Password
            </CardTitle>
            <CardDescription>Update your login password</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleChangePassword} className="space-y-4" id="change-password-form">
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Current password</Label>
                <Input
                  type="password"
                  value={pwForm.currentPassword}
                  onChange={e => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                  className="font-mono"
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">New password</Label>
                <Input
                  type="password"
                  value={pwForm.newPassword}
                  onChange={e => setPwForm({ ...pwForm, newPassword: e.target.value })}
                  className="font-mono"
                  placeholder="Min. 6 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Confirm new password</Label>
                <Input
                  type="password"
                  value={pwForm.confirmPassword}
                  onChange={e => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
                  className="font-mono"
                  autoComplete="new-password"
                />
              </div>
            </form>
          </CardContent>
          <CardFooter>
            <Button
              type="submit"
              form="change-password-form"
              className="w-full font-mono font-bold"
              disabled={changePasswordMutation.isPending || !pwForm.currentPassword || !pwForm.newPassword}
            >
              {changePasswordMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Changing…</>
              ) : (
                "CHANGE_PASSWORD"
              )}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Monitor className="w-4 h-4" /> Active Sessions
            </CardTitle>
            <CardDescription>Devices currently logged into this app</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessionsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : (
              sessionsData?.sessions.map(session => (
                <div
                  key={session.sid}
                  className={`flex items-center justify-between p-3 rounded-md border text-sm ${
                    session.isCurrent ? "border-primary/40 bg-primary/5" : "border-border bg-secondary/20"
                  }`}
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 font-mono font-medium">
                      <Monitor className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{session.deviceName}</span>
                      {session.isCurrent && (
                        <span className="text-xs text-primary font-bold shrink-0">THIS DEVICE</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono pl-5">
                      {session.ip || "Unknown IP"} · Last seen {formatRelativeTime(session.lastSeenAt)}
                    </div>
                  </div>
                  {!session.isCurrent && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-2 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                      disabled={revokeSessionMutation.isPending}
                      onClick={() => revokeSessionMutation.mutate({ sid: session.sid })}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              ))
            )}
            {!sessionsLoading && (!sessionsData?.sessions || sessionsData.sessions.length === 0) && (
              <p className="text-center text-sm text-muted-foreground font-mono py-4">No active sessions</p>
            )}
          </CardContent>
          {sessionsData && sessionsData.sessions.length > 1 && (
            <CardFooter>
              <Button
                variant="destructive"
                size="sm"
                className="w-full font-mono"
                disabled={revokeOthersMutation.isPending}
                onClick={() => revokeOthersMutation.mutate()}
              >
                {revokeOthersMutation.isPending ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Revoking…</>
                ) : (
                  "REVOKE_ALL_OTHER_SESSIONS"
                )}
              </Button>
            </CardFooter>
          )}
        </Card>
      </div>
    </>
  );
}

function StorageSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: dirStatus, isLoading } = useGetNasDirStatus({
    query: { queryKey: getGetNasDirStatusQueryKey() },
  });

  const reinitMutation = useReinitNasDirs({
    mutation: {
      onSuccess: () => {
        toast({ title: "Directories reinitialized" });
        queryClient.invalidateQueries({ queryKey: getGetNasDirStatusQueryKey() });
      },
      onError: () => toast({ title: "Failed to reinitialize directories", variant: "destructive" }),
    },
  });

  return (
    <>
      <div className="pt-4">
        <h2 className="text-xl font-bold font-mono tracking-tight flex items-center gap-2">
          <HardDrive className="w-5 h-5 text-primary" />
          NAS STORAGE
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          App data stored on the NAS under <code className="bg-secondary px-1 rounded font-mono text-xs">WillardAI/</code>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="w-4 h-4" /> WillardAI Directory Status
          </CardTitle>
          <CardDescription>
            Logs, scan history, temp files, and reports are stored here on your NAS
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !dirStatus?.nasPath ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono p-3 bg-secondary/20 rounded border border-dashed">
              <AlertCircle className="w-4 h-4 shrink-0" />
              Configure a NAS path in settings above to enable NAS storage
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground px-1">
                <span className="truncate">{dirStatus.willardAiPath}</span>
                {dirStatus.allPresent ? (
                  <span className="shrink-0 text-green-500 font-bold">ALL PRESENT</span>
                ) : (
                  <span className="shrink-0 text-amber-500 font-bold">INCOMPLETE</span>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {dirStatus.subdirs.map((subdir) => (
                  <div
                    key={subdir.name}
                    className={`flex items-center gap-2 px-3 py-2 rounded border text-sm font-mono ${
                      subdir.exists
                        ? "border-green-500/30 bg-green-500/5 text-green-400"
                        : "border-destructive/30 bg-destructive/5 text-destructive"
                    }`}
                  >
                    {subdir.exists ? (
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="truncate text-xs">{subdir.name}/</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
        {dirStatus?.nasPath && (
          <CardFooter>
            <Button
              variant="secondary"
              size="sm"
              className="font-mono"
              disabled={reinitMutation.isPending || (dirStatus?.allPresent ?? false)}
              onClick={() => reinitMutation.mutate()}
            >
              {reinitMutation.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Reinitializing…</>
              ) : (
                <><RefreshCw className="w-3.5 h-3.5 mr-2" /> REINITIALIZE_DIRS</>
              )}
            </Button>
          </CardFooter>
        )}
      </Card>
    </>
  );
}