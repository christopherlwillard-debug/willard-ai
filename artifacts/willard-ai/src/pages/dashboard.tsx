import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  useGetDashboard,
  getGetDashboardQueryKey,
  useStartScan,
  useGetSettings,
  useSearchFiles,
  useGetHealthStatus,
  useGetScanStatus,
  getGetScanStatusQueryKey,
  getGetSettingsLogoUrl,
} from "@workspace/api-client-react";
import { formatBytes } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Image as ImageIcon,
  Film,
  FileText,
  HardDrive,
  Copy,
  Download,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Database,
  Layers,
  ArrowUpFromLine,
  Maximize2,
  HeartPulse,
  FolderOpen,
  ScanLine,
  CloudOff,
  ImagePlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LibraryStatusIndicator, LibraryStatusBanner } from "@/components/library/library-status";
import { LibraryActivityFeed } from "@/components/library/library-activity";
import { OnboardingChecklist } from "@/components/library/onboarding-checklist";
import { BuildingLibraryProgress } from "@/components/library/building-progress";
import { LibraryReadyCelebration } from "@/components/library/celebration";
import { useQueryClient } from "@tanstack/react-query";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";

function formatRelativeDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return `Today • ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function getTypeCount(breakdown: Array<{ fileType: string; count: number; sizeBytes: number }>, type: string) {
  return breakdown.find((b) => b.fileType === type) ?? { count: 0, sizeBytes: 0, percentage: 0 };
}

function StatBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/5 rounded-b-lg overflow-hidden">
      <div
        className={cn("h-full rounded-full transition-all duration-700", color)}
        style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
      />
    </div>
  );
}

function FileTypeIcon({ fileType, className }: { fileType: string; className?: string }) {
  const cls = cn("w-full h-full", className);
  switch (fileType) {
    case "image": return <ImageIcon className={cls} />;
    case "video": return <Film className={cls} />;
    case "document": return <FileText className={cls} />;
    default: return <HardDrive className={cls} />;
  }
}

function ThumbnailCard({ file, ext, badgeColor }: {
  file: { id: number; filename: string; fileType: string; modifiedAt: string | null };
  ext: string;
  badgeColor: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const canThumbnail = file.fileType === "image" || file.fileType === "video";

  return (
    <div className="shrink-0 w-36">
      <div className="relative h-24 w-36 rounded-lg bg-muted flex items-center justify-center overflow-hidden border border-border">
        {canThumbnail && !imgFailed ? (
          <img
            src={`/api/media/thumbnail/${file.id}`}
            alt={file.filename}
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <FileTypeIcon fileType={file.fileType} className="text-muted-foreground/40 w-10 h-10" />
        )}
        <span className={cn("absolute bottom-2 left-2 text-[10px] font-bold text-white px-1.5 py-0.5 rounded z-10", badgeColor)}>
          {ext}
        </span>
      </div>
      <p className="text-xs truncate mt-1.5 text-foreground/90">{file.filename}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5">{formatRelativeDate(file.modifiedAt)}</p>
    </div>
  );
}

function ThumbnailJobProgress() {
  const [stats, setStats] = useState<{ total: number; built: number; missing: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/library/thumbnails/status");
        if (res.ok && !cancelled) {
          const data = await res.json();
          setStats(data);
        }
      } catch { /* ignore */ }
    };
    void poll();
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (!stats || stats.total === 0 || stats.missing === 0) return null;

  const pct = Math.round((stats.built / stats.total) * 100);

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-3 flex items-center gap-4">
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center">
          <ImagePlus className="w-4 h-4 text-blue-400 animate-pulse" />
        </div>
        <div>
          <p className="text-sm font-semibold text-blue-400">Generating Thumbnails</p>
          <p className="text-xs text-muted-foreground">{stats.built.toLocaleString()} of {stats.total.toLocaleString()} built · {stats.missing.toLocaleString()} remaining</p>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between text-[10px] text-muted-foreground font-mono mb-1">
          <span>{pct}% complete</span>
          <Link href="/settings" className="text-primary hover:underline">Manage</Link>
        </div>
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function HeroLogo() {
  const [logoVersion, setLogoVersion] = useState(0);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    const onUpdate = () => {
      setLogoFailed(false);
      setLogoVersion((v) => v + 1);
    };
    window.addEventListener("willard-logo-updated", onUpdate);
    return () => window.removeEventListener("willard-logo-updated", onUpdate);
  }, []);

  if (logoFailed) {
    return (
      <div className="flex h-28 w-28 items-center justify-center rounded-xl bg-white/5 border border-white/10">
        <Database className="w-10 h-10 text-blue-300/60" />
      </div>
    );
  }

  return (
    <img
      key={logoVersion}
      src={`${getGetSettingsLogoUrl()}?v=${logoVersion}`}
      alt="Willard's Media Center"
      className="h-28 w-auto object-contain"
      onError={() => setLogoFailed(true)}
    />
  );
}

const TYPE_COLORS: Record<string, string> = {
  image: "#8b5cf6",
  video: "#3b82f6",
  document: "#22c55e",
  audio: "#f59e0b",
  other: "#6b7280",
};

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [scanTriggered, setScanTriggered] = useState(false);

  const { data, isLoading, error } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: scanTriggered ? 3000 : 30000,
    },
  });

  const scanMutation = useStartScan({
    mutation: { onSuccess: () => setScanTriggered(true) },
  });

  const { data: settings } = useGetSettings();
  const { data: recentFiles } = useSearchFiles({ limit: 5 });
  const { data: healthData } = useGetHealthStatus();
  const { data: scanStatus } = useGetScanStatus({
    query: { queryKey: getGetScanStatusQueryKey(), refetchInterval: scanTriggered ? 3000 : 30000 },
  });

  const isScanning = data?.isScanning || scanTriggered;

  useEffect(() => {
    if (scanTriggered && data && !data.isScanning) {
      setScanTriggered(false);
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }
  }, [scanTriggered, data, queryClient]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-36 rounded-xl" />
        <div className="grid grid-cols-6 gap-3">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        </div>
        <Skeleton className="h-20 rounded-lg" />
        <div className="grid grid-cols-5 gap-4">
          <Skeleton className="col-span-3 h-64 rounded-lg" />
          <Skeleton className="col-span-2 h-64 rounded-lg" />
        </div>
        <Skeleton className="h-32 rounded-lg" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <HeartPulse className="w-12 h-12 text-muted-foreground mb-4" />
        <p className="text-lg font-semibold">Could not load dashboard</p>
        <p className="text-sm text-muted-foreground mt-1">Sign in to view your library</p>
      </div>
    );
  }

  const photos = getTypeCount(data.typeBreakdown, "image");
  const videos = getTypeCount(data.typeBreakdown, "video");
  const docs = getTypeCount(data.typeBreakdown, "document");
  const totalSz = Number(data.totalSizeBytes) || 1;

  const hasDisk = data.diskTotal != null && (data.diskTotal as number) > 0;
  const diskTotal = (data.diskTotal as number) ?? 0;
  const diskUsed = (data.diskUsed as number) ?? 0;
  const diskFree = (data.diskFree as number) ?? 0;
  const nasPath = settings?.nasPath ?? "";

  const duplicateSizeBytes = (data as any).duplicateSizeBytes ?? 0;
  const incomingCount = (data as any).incomingCount ?? 0;

  const storageUsedPct = hasDisk ? (diskUsed / diskTotal) * 100 : (diskUsed / totalSz) * 100;

  const statCards = [
    {
      label: "Photos",
      value: photos.count.toLocaleString(),
      sub: formatBytes(photos.sizeBytes),
      icon: ImageIcon,
      iconBg: "bg-purple-500/20",
      iconColor: "text-purple-400",
      barColor: "bg-purple-500",
      barPct: (photos.sizeBytes / totalSz) * 100,
    },
    {
      label: "Videos",
      value: videos.count.toLocaleString(),
      sub: formatBytes(videos.sizeBytes),
      icon: Film,
      iconBg: "bg-blue-500/20",
      iconColor: "text-blue-400",
      barColor: "bg-blue-500",
      barPct: (videos.sizeBytes / totalSz) * 100,
    },
    {
      label: "Documents",
      value: docs.count.toLocaleString(),
      sub: formatBytes(docs.sizeBytes),
      icon: FileText,
      iconBg: "bg-green-500/20",
      iconColor: "text-green-400",
      barColor: "bg-green-500",
      barPct: (docs.sizeBytes / totalSz) * 100,
    },
    {
      label: "Storage Used",
      value: hasDisk ? formatBytes(diskUsed) : formatBytes(data.totalSizeBytes),
      sub: hasDisk ? `of ${formatBytes(diskTotal)} (${Math.round(storageUsedPct)}%)` : `${data.totalFiles.toLocaleString()} files`,
      icon: HardDrive,
      iconBg: "bg-amber-500/20",
      iconColor: "text-amber-400",
      barColor: "bg-amber-500",
      barPct: storageUsedPct,
    },
    {
      label: "Duplicates",
      value: data.duplicateCount.toLocaleString(),
      sub: formatBytes(duplicateSizeBytes),
      icon: Copy,
      iconBg: "bg-red-500/20",
      iconColor: "text-red-400",
      barColor: "bg-red-500",
      barPct: data.totalFiles > 0 ? (data.duplicateCount / data.totalFiles) * 100 : 0,
    },
    {
      label: "Incoming",
      value: incomingCount.toLocaleString(),
      sub: incomingCount > 0 ? "Awaiting review" : "Queue empty",
      icon: Download,
      iconBg: "bg-sky-500/20",
      iconColor: "text-sky-400",
      barColor: "bg-sky-500",
      barPct: data.totalFiles > 0 ? (incomingCount / Math.max(data.totalFiles, 1)) * 100 : 0,
    },
  ];

  const libraryOnline = data.libraryOnline ?? true;
  const libraryMessage = data.libraryMessage ?? "";
  const libraryPath = data.libraryPath || nasPath;

  // Surface a failed scan (e.g. "Library Offline") in the Last Scan panel when it
  // is more recent than the last successful scan — otherwise a stale "completed"
  // timestamp would hide the failure.
  const lastFailed = scanStatus?.lastFailed as { error?: string | null; finishedAt?: string | null } | null | undefined;
  const lastCompleted = scanStatus?.lastCompleted as { finishedAt?: string | null } | null | undefined;
  const failedAt = lastFailed?.finishedAt ? new Date(lastFailed.finishedAt).getTime() : 0;
  const completedAt = lastCompleted?.finishedAt ? new Date(lastCompleted.finishedAt).getTime() : (data.lastScanAt ? new Date(data.lastScanAt).getTime() : 0);
  const showScanFailure = !isScanning && lastFailed != null && failedAt > completedAt;
  const scanFailureMessage = lastFailed?.error || "Scan failed";

  const allHealthy = !isScanning && libraryOnline && (healthData?.database ?? true) && (healthData?.thumbnailsOk ?? true) && (healthData?.missingFiles ?? 0) === 0;

  const healthItems = [
    { label: "Library", ok: libraryOnline, value: libraryOnline ? null : "Offline" },
    { label: "Database", ok: healthData?.database ?? true, value: null },
    { label: "Thumbnails", ok: libraryOnline && (healthData?.thumbnailsOk ?? true), value: null },
    { label: "Duplicates", ok: data.duplicateCount === 0, value: data.duplicateCount > 0 ? `${data.duplicateCount} items` : null },
    { label: "Metadata", ok: true, value: null },
    { label: "Corrupt Files", ok: (healthData?.corruptFiles ?? 0) === 0, value: healthData?.corruptFiles ?? null },
  ];

  const quickActions = [
    { label: "Import Media", sub: "Add files to your library", icon: ArrowUpFromLine, href: "/organize" },
    { label: "Find Duplicates", sub: "Locate duplicate files", icon: Copy, href: "/cleanup" },
    { label: "Optimize Library", sub: "Free up space", icon: Maximize2, href: "/optimize" },
    { label: "Open Library", sub: "Browse all media", icon: FolderOpen, href: "/library" },
    { label: "Health Center", sub: "Check library health", icon: HeartPulse, href: "/cleanup" },
  ];

  const chartData = data.typeBreakdown
    .filter(b => b.sizeBytes > 0)
    .map(b => ({
      name: b.fileType.charAt(0).toUpperCase() + b.fileType.slice(1),
      value: b.sizeBytes,
      pct: b.percentage,
      color: TYPE_COLORS[b.fileType] ?? "#6b7280",
    }));

  const files = recentFiles?.files ?? [];

  return (
    <div className="space-y-4">
      <LibraryReadyCelebration />
      <LibraryStatusBanner />
      <BuildingLibraryProgress />
      <ThumbnailJobProgress />
      <OnboardingChecklist />

      {/* ── Hero Banner ─────────────────────────────────────────────────── */}
      <div
        className="relative flex items-center justify-between rounded-xl border border-border overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #0f1117 0%, #141b2d 60%, #0c1520 100%)",
          minHeight: 140,
        }}
      >
        <div className="px-8 py-6 z-10">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-white">Welcome back, Willard!</h1>
            <LibraryStatusIndicator />
          </div>
          <p className="text-blue-200/70 mt-1.5 text-sm">
            Here&apos;s what&apos;s happening with your media library today.
          </p>
        </div>
        <div className="relative shrink-0 pr-8">
          <HeroLogo />
        </div>
      </div>

      {/* ── Stat Cards Row ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map(({ label, value, sub, icon: Icon, iconBg, iconColor, barColor, barPct }) => {
          const showSyncing = isScanning && (label === "Photos" || label === "Videos" || label === "Documents");
          return (
            <div
              key={label}
              className="relative rounded-lg border border-border bg-card px-4 py-4 pb-5 overflow-hidden min-w-0"
            >
              <div className={cn("inline-flex items-center justify-center w-9 h-9 rounded-lg mb-3", iconBg)}>
                <Icon className={cn("w-4.5 h-4.5", iconColor)} style={{ width: 18, height: 18 }} />
              </div>
              <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
              <p className="text-xl font-bold tabular-nums leading-tight">{value}</p>
              {showSyncing ? (
                <p className="text-[10px] text-blue-400/70 mt-0.5 truncate" title="Count may change while scan is running">· Syncing</p>
              ) : (
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{sub}</p>
              )}
              <StatBar pct={barPct} color={barColor} />
            </div>
          );
        })}
      </div>

      {/* ── Health Status Bar ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card px-6 py-4">
        <div className="flex items-start gap-8">
          <div className="flex items-center gap-3 min-w-fit">
            {!libraryOnline ? (
              <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
                <CloudOff className="w-5 h-5 text-red-500" />
              </div>
            ) : isScanning ? (
              <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
                <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
              </div>
            ) : allHealthy ? (
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              </div>
            ) : (
              <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              </div>
            )}
            <div>
              <p className={cn("text-sm font-semibold", !libraryOnline ? "text-red-400" : isScanning ? "text-blue-400" : allHealthy ? "text-green-400" : "text-amber-400")}>
                {!libraryOnline ? "Library Offline" : isScanning ? "Syncing in Background" : allHealthy ? "✓ Library Ready" : "Issues Detected"}
              </p>
              <p className="text-xs text-muted-foreground max-w-xs truncate" title={!libraryOnline ? `${libraryMessage}${libraryPath ? ` (${libraryPath})` : ""}` : undefined}>
                {!libraryOnline
                  ? (libraryMessage || `Cannot reach ${libraryPath || "the library location"}`)
                  : isScanning ? "Background sync running — your library is fully usable." : "All media indexed and up to date."}
              </p>
            </div>
          </div>

          <div className="border-l border-border pl-8 min-w-fit max-w-[14rem]">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Last Scan</p>
            {showScanFailure ? (
              <>
                <p className="text-sm font-medium text-red-400">Failed</p>
                <p className="text-xs text-muted-foreground truncate" title={scanFailureMessage}>{scanFailureMessage}</p>
              </>
            ) : (
              <p className="text-sm font-medium">{formatRelativeDate(data.lastScanAt)}</p>
            )}
            <Link href="/settings" className="text-xs text-primary hover:underline mt-0.5 block">
              View Settings
            </Link>
          </div>

          <div className="border-l border-border pl-8 flex-1">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-2">Library Health</p>
            <div className="grid grid-cols-3 gap-x-6 gap-y-1.5">
              {healthItems.map(({ label, ok, value }) => (
                <div key={label} className="flex items-center gap-1.5">
                  {ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  )}
                  <span className="text-xs text-muted-foreground truncate">{label}</span>
                  {value != null && value !== 0 && (
                    <span className={cn("text-xs font-medium ml-auto", ok ? "text-muted-foreground" : "text-amber-400")}>
                      {value}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Library Activity feed ───────────────────────────────────────── */}
      <LibraryActivityFeed />

      {/* ── Recently Added + Quick Actions ──────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Recently Added */}
        <div className="lg:col-span-3 rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
            <p className="text-sm font-semibold">Recently Added</p>
            <Link href="/library" className="text-xs text-primary hover:underline">
              View All
            </Link>
          </div>

          {files.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <ScanLine className="w-8 h-8 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No files indexed yet</p>
              <p className="text-xs text-muted-foreground mt-1">Run a scan to populate your library</p>
            </div>
          ) : (
            <div className="flex gap-3 p-4 overflow-x-auto">
              {files.slice(0, 5).map((file) => {
                const ext = file.filename.split(".").pop()?.toUpperCase() ?? "FILE";
                const badgeColor =
                  file.fileType === "image" ? "bg-purple-600" :
                  file.fileType === "video" ? "bg-blue-600" :
                  file.fileType === "document" ? "bg-green-600" :
                  "bg-gray-600";

                return (
                  <ThumbnailCard
                    key={file.filename}
                    file={file}
                    ext={ext}
                    badgeColor={badgeColor}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border">
            <p className="text-sm font-semibold">Quick Actions</p>
          </div>
          <div className="divide-y divide-border">
            {quickActions.map(({ label, sub, icon: Icon, href }) => (
              <Link key={label} href={href}>
                <div className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40 transition-colors cursor-pointer group">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{label}</p>
                    <p className="text-xs text-muted-foreground truncate">{sub}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* ── Storage Breakdown ───────────────────────────────────────────── */}
      {(hasDisk || data.totalSizeBytes > 0) && chartData.length > 0 && (
        <div className="rounded-lg border border-border bg-card px-6 py-5">
          <div className="flex items-center gap-8">
            <div className="shrink-0" style={{ width: 100, height: 100 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={28}
                    outerRadius={44}
                    paddingAngle={2}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {chartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [formatBytes(value), name]}
                    contentStyle={{ background: "#1a1f2e", border: "1px solid #2a2f3e", borderRadius: 6, fontSize: 11 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="shrink-0">
              {hasDisk && (
                <p className="text-2xl font-bold tabular-nums">{formatBytes(diskUsed)}</p>
              )}
              <p className="text-xs text-muted-foreground">Used</p>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 flex-1">
              {chartData.map((entry) => (
                <div key={entry.name} className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: entry.color }} />
                  <span className="text-xs text-muted-foreground">{entry.name}</span>
                  <span className="text-xs font-medium">{entry.pct}%</span>
                </div>
              ))}
            </div>

            {hasDisk && (
              <div className="shrink-0 text-right border-l border-border pl-8">
                <p className="text-xs text-muted-foreground">{formatBytes(diskTotal)} Total Capacity</p>
                <p className="text-sm font-semibold text-primary mt-0.5">{formatBytes(diskFree)} Free</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── First-run prompt ────────────────────────────────────────────── */}
      {data.totalFiles === 0 && !isScanning && !nasPath && (
        <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <Database className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">Getting started:</strong>{" "}
            Go to{" "}
            <Link href="/settings" className="text-primary hover:underline">
              Settings
            </Link>
            , set your NAS library path, then click{" "}
            <strong>Full Rescan</strong> in the top bar.
          </p>
        </div>
      )}
    </div>
  );
}
