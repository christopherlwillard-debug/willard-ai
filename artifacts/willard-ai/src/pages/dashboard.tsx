import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  useGetDashboard,
  getGetDashboardQueryKey,
  useStartScan,
  useGetScanStatus,
  getGetScanStatusQueryKey,
  useGetSettings,
  useSearchFiles,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Image as ImageIcon,
  Film,
  FileText,
  Archive,
  HardDrive,
  ChevronRight,
  CheckCircle2,
  Loader2,
  MapPin,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

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
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
}

function getTypeCount(breakdown: Array<{ fileType: string; count: number }>, type: string): number {
  return breakdown.find((b) => b.fileType === type)?.count ?? 0;
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [scanPolling, setScanPolling] = useState(false);

  const { data, isLoading, error } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: scanPolling ? 3000 : 30000,
    },
  });

  const { data: scanStatus } = useGetScanStatus({
    query: {
      queryKey: getGetScanStatusQueryKey(),
      refetchInterval: scanPolling ? 2000 : false,
      enabled: scanPolling,
    },
  });

  const scanMutation = useStartScan({
    mutation: {
      onSuccess: () => setScanPolling(true),
    },
  });

  const { data: settings } = useGetSettings();
  const { data: recentFiles } = useSearchFiles({ limit: 5 });

  const isScanning = data?.isScanning || (scanPolling && (scanStatus?.isRunning ?? false));

  useEffect(() => {
    if (scanPolling && scanStatus && !scanStatus.isRunning) {
      setScanPolling(false);
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }
  }, [scanPolling, scanStatus, queryClient]);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-36 rounded-xl" />
        <div className="grid grid-cols-5 gap-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
        <Skeleton className="h-36 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
        <Skeleton className="h-52 rounded-lg" />
      </div>
    );
  }

  if (error || !data) {
    return <div className="text-red-500 font-mono text-sm">Failed to load dashboard data</div>;
  }

  const photoCount = getTypeCount(data.typeBreakdown, "image");
  const videoCount = getTypeCount(data.typeBreakdown, "video");
  const hasDiskStats = (data as any).diskTotal != null && (data as any).diskTotal > 0;
  const diskTotal: number = (data as any).diskTotal ?? 0;
  const diskUsed: number = (data as any).diskUsed ?? 0;
  const nasPath = settings?.nasPath ?? "";

  const statCards = [
    {
      label: "Photos",
      value: photoCount.toLocaleString(),
      icon: ImageIcon,
      color: "text-purple-400",
      bg: "bg-purple-400/10",
    },
    {
      label: "Videos",
      value: videoCount.toLocaleString(),
      icon: Film,
      color: "text-blue-400",
      bg: "bg-blue-400/10",
    },
    {
      label: "Documents",
      value: data.documentCount.toLocaleString(),
      icon: FileText,
      color: "text-green-400",
      bg: "bg-green-400/10",
    },
    {
      label: "Collections",
      value: data.archiveCount.toLocaleString(),
      icon: Archive,
      color: "text-orange-400",
      bg: "bg-orange-400/10",
    },
    {
      label: "Storage Used",
      value: hasDiskStats ? formatBytes(diskUsed) : formatBytes(data.totalSizeBytes),
      sub: hasDiskStats ? `of ${formatBytes(diskTotal)}` : `${data.totalFiles.toLocaleString()} files`,
      icon: HardDrive,
      color: "text-sky-400",
      bg: "bg-sky-400/10",
    },
  ];

  const actions: { label: string; href?: string; action?: () => void }[] = [
    { label: "Scan Library", action: () => scanMutation.mutate() },
    { label: "Open Library", href: "/library" },
    { label: "Organize Incoming", href: "/organize" },
    { label: "Optimize Library", href: "/optimize" },
    { label: "Library Health", href: "/cleanup" },
  ];

  const files = recentFiles?.files ?? [];

  return (
    <div className="space-y-5">
      {/* Hero banner */}
      <div className="relative flex items-center justify-between rounded-xl border border-border bg-card px-8 overflow-hidden" style={{ minHeight: 130 }}>
        <div className="py-6 z-10">
          <h1 className="text-2xl font-bold tracking-tight">Welcome back, Willard!</h1>
          <p className="text-muted-foreground mt-1 text-sm">Your media library is ready.</p>
        </div>
        <img
          src={`${import.meta.env.BASE_URL}opengraph.jpg`}
          alt="Willard's Media Center"
          className="h-24 w-auto object-contain opacity-90 shrink-0"
        />
      </div>

      {/* First-run onboarding */}
      {data.totalFiles === 0 && !isScanning && nasPath === "" && (
        <div className="flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <Settings2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">Getting started:</strong> Go to{" "}
            <Link href="/settings" className="text-primary hover:underline">Settings</Link>,
            enter your NAS mount path, save, then click <strong>Scan Library</strong> above.
          </p>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {statCards.map(({ label, value, sub, icon: Icon, color, bg }) => (
          <Card key={label} className="border-border">
            <CardContent className="p-4 flex items-center gap-3">
              <div className={cn("rounded-md p-2 shrink-0", bg)}>
                <Icon className={cn("w-4 h-4", color)} />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground leading-none mb-1">{label}</p>
                <p className="text-base font-semibold tabular-nums truncate leading-none">{value}</p>
                {sub && <p className="text-[10px] text-muted-foreground mt-1 truncate">{sub}</p>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Library Status card — full width, most prominent */}
      <Link href="/cleanup">
        <Card className="border-border hover:border-primary/40 transition-colors cursor-pointer group">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Library Status</p>
              <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-4">
              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5">Status</p>
                <div className="flex items-center gap-1.5">
                  {isScanning ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                      <span className="text-sm font-medium text-amber-400">Scanning…</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
                      <span className="text-sm font-medium">Healthy</span>
                    </>
                  )}
                </div>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5">Last Scan</p>
                <p className="text-sm font-medium">{formatRelativeDate(data.lastScanAt)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5">Storage</p>
                <p className="text-sm font-medium">
                  {hasDiskStats
                    ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`
                    : formatBytes(data.totalSizeBytes)}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5">Background Tasks</p>
                <p className="text-sm font-medium">{isScanning ? "Scanning" : "Idle"}</p>
              </div>
            </div>
            {nasPath && (
              <div className="flex items-center gap-2 mt-5 pt-4 border-t border-border">
                <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <p className="text-xs text-muted-foreground font-mono truncate">{nasPath}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </Link>

      {/* Actions */}
      <Card className="border-border">
        <CardContent className="p-0">
          <div className="px-6 pt-5 pb-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</p>
          </div>
          <div className="divide-y divide-border">
            {actions.map(({ label, href, action }) =>
              action ? (
                <button
                  key={label}
                  onClick={action}
                  disabled={isScanning || scanMutation.isPending}
                  className="w-full flex items-center justify-between px-6 py-3.5 hover:bg-muted/40 transition-colors group disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="text-sm">{label}</span>
                  {isScanning && label === "Scan Library" ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  )}
                </button>
              ) : (
                <Link key={label} href={href!}>
                  <div className="flex items-center justify-between px-6 py-3.5 hover:bg-muted/40 transition-colors cursor-pointer group">
                    <span className="text-sm">{label}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </Link>
              )
            )}
          </div>
        </CardContent>
      </Card>

      {/* Recent Imports */}
      <Card className="border-border">
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Recent Imports{files.length > 0 ? ` (${files.length})` : ""}
            </p>
          </div>
          <div className="divide-y divide-border">
            {files.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-muted-foreground">
                No files indexed yet — run a scan to populate.
              </div>
            ) : (
              files.slice(0, 5).map((file) => (
                <div key={file.filename} className="flex items-center justify-between px-6 py-3">
                  <p className="text-sm truncate pr-6 min-w-0">{file.filename}</p>
                  <p className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                    {formatRelativeDate(file.modifiedAt)}
                  </p>
                </div>
              ))
            )}
          </div>
          <div className="px-6 py-3.5 border-t border-border">
            <Link href="/library" className="text-sm text-primary hover:underline">
              View Library →
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
