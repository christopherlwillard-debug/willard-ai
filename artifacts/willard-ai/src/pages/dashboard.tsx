import { useEffect, useMemo, useState } from "react";
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
  useListArchives,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AlertTriangle, Archive, ArrowUpRight, CheckCircle2, ChevronRight, CloudOff,
  FileText, Film, FolderHeart, HardDrive, Image as ImageIcon, Loader2,
  Maximize2, PackageOpen, Search, Sparkles, Users, X,
} from "lucide-react";
import { LibraryStatusBanner } from "@/components/library/library-status";
import { LibraryActivityFeed } from "@/components/library/library-activity";
import { OnboardingChecklist } from "@/components/library/onboarding-checklist";
import { BuildingLibraryProgress } from "@/components/library/building-progress";
import { LibraryReadyCelebration } from "@/components/library/celebration";

function relativeDate(value: string | null | undefined) {
  if (!value) return "Not scanned yet";
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return `Today · ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function typeCount(breakdown: any[], type: string) {
  return breakdown.find((entry) => entry.fileType === type) ?? { count: 0, sizeBytes: 0 };
}

function MediaThumb({ file }: { file: any }) {
  const [failed, setFailed] = useState(false);
  const visual = file.fileType === "image" || file.fileType === "video";
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-muted/60">
      {visual && !failed ? (
        <img src={apiUrl(`/media/thumbnail/${file.id}`)} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="flex h-full items-center justify-center">
          {file.fileType === "video" ? <Film className="h-8 w-8 text-muted-foreground/40" /> : <FileText className="h-8 w-8 text-muted-foreground/40" />}
        </div>
      )}
    </div>
  );
}

function AttentionCard({ icon: Icon, title, detail, href, onDismiss }: { icon: any; title: string; detail: string; href: string; onDismiss: () => void }) {
  return (
    <div className="group relative rounded-2xl border border-border/70 bg-card/70 p-4 transition-colors hover:border-primary/35">
      <button onClick={onDismiss} aria-label={`Dismiss ${title}`} className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" /></div>
      <p className="pr-5 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      <Link href={href} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">Review <ArrowUpRight className="h-3 w-3" /></Link>
    </div>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [scanTriggered, setScanTriggered] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("willard-dismissed-attention") ?? "[]"); } catch { return []; }
  });
  const { data, isLoading, error } = useGetDashboard({
    query: { queryKey: getGetDashboardQueryKey(), refetchInterval: scanTriggered ? 3000 : 30000 },
  });
  const { data: settings } = useGetSettings();
  const { data: filesData } = useSearchFiles({ limit: 8 });
  const { data: health } = useGetHealthStatus();
  const { data: scanStatus } = useGetScanStatus({ query: { queryKey: getGetScanStatusQueryKey(), refetchInterval: scanTriggered ? 3000 : 30000 } });
  const { data: archives } = useListArchives({ limit: 1, status: "pending" });
  const scanMutation = useStartScan({ mutation: { onSuccess: () => setScanTriggered(true) } });

  useEffect(() => {
    if (scanTriggered && data && !data.isScanning) {
      setScanTriggered(false);
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }
  }, [data, queryClient, scanTriggered]);

  const isScanning = Boolean(data?.isScanning || scanTriggered);
  const breakdown = data?.typeBreakdown ?? [];
  const photos = typeCount(breakdown, "image");
  const videos = typeCount(breakdown, "video");
  const documents = typeCount(breakdown, "document");
  const incoming = Number((data as any)?.incomingCount ?? 0);
  const duplicateCount = Number(data?.duplicateCount ?? 0);
  const pendingArchives = Number(archives?.total ?? 0);
  const online = data?.libraryOnline ?? true;
  const issues = !online || health?.database === false || health?.thumbnailsOk === false || Number(health?.missingFiles ?? 0) > 0;
  const attention = useMemo(() => [
    pendingArchives > 0 ? { key: "archives", icon: Archive, title: `${pendingArchives} archive${pendingArchives === 1 ? "" : "s"} worth a look`, detail: "Willard found compressed files and can show you what is inside before anything changes.", href: "/archives" } : null,
    incoming > 0 ? { key: "incoming", icon: PackageOpen, title: `${incoming} item${incoming === 1 ? "" : "s"} waiting to be organized`, detail: "Review these suggestions when you are ready. Nothing moves without your approval.", href: "/organize" } : null,
    duplicateCount > 0 ? { key: "duplicates", icon: FolderHeart, title: `${duplicateCount} duplicate group${duplicateCount === 1 ? "" : "s"} to review`, detail: "Potential copies are grouped for comparison. Your originals stay safe.", href: "/cleanup" } : null,
  ].filter(Boolean).filter((item: any) => !dismissed.includes(item.key)) as any[], [dismissed, duplicateCount, incoming, pendingArchives]);

  const dismiss = (key: string) => {
    const next = [...dismissed, key];
    setDismissed(next);
    localStorage.setItem("willard-dismissed-attention", JSON.stringify(next));
  };

  if (isLoading) return <div className="space-y-5"><Skeleton className="h-44 rounded-3xl" /><Skeleton className="h-14 rounded-2xl" /><div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-28 rounded-2xl" /></div><Skeleton className="h-72 rounded-3xl" /></div>;
  if (error || !data) return <div className="mx-auto flex max-w-md flex-col items-center justify-center py-28 text-center"><CloudOff className="mb-4 h-10 w-10 text-muted-foreground" /><h1 className="text-lg font-semibold">Your library is taking a moment</h1><p className="mt-2 text-sm text-muted-foreground">Sign in or reconnect to see your media.</p></div>;

  const recentFiles = filesData?.files ?? [];
  const stats = [
    { label: "Photos", value: photos.count, sub: formatBytes(photos.sizeBytes), icon: ImageIcon, href: "/media", color: "text-violet-300" },
    { label: "Videos", value: videos.count, sub: formatBytes(videos.sizeBytes), icon: Film, href: "/media?type=video", color: "text-sky-300" },
    { label: "Documents", value: documents.count, sub: formatBytes(documents.sizeBytes), icon: FileText, href: "/documents", color: "text-emerald-300" },
    { label: "Collections", value: (data as any).collectionCount ?? "—", sub: "Curated by you", icon: FolderHeart, href: "/collections", color: "text-amber-300" },
    { label: "People", value: (data as any).peopleCount ?? "—", sub: "In your library", icon: Users, href: "/people", color: "text-rose-300" },
  ];

  return (
    <div className="space-y-7">
      <LibraryReadyCelebration /><LibraryStatusBanner /><BuildingLibraryProgress /><OnboardingChecklist />
      <section className="relative overflow-hidden rounded-3xl border border-border/70 bg-gradient-to-br from-card via-card/80 to-primary/5 p-6 sm:p-9">
        <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-7 sm:flex-row sm:items-end">
          <div className="max-w-xl">
            <p className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.22em] text-primary"><Sparkles className="h-3.5 w-3.5" /> Your media center</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Everything you keep, <span className="text-muted-foreground">within reach.</span></h1>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">Willard quietly watches over your library and brings useful things forward when they need your attention.</p>
            <Link href="/search" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/10 hover:bg-primary/90"><Search className="h-4 w-4" /> Search your library</Link>
          </div>
          <img src={`${getGetSettingsLogoUrl()}?v=0`} alt="Willard's Media Center" className="hidden h-24 w-auto max-w-[15rem] object-contain object-right opacity-90 sm:block" />
        </div>
      </section>

      <section className="flex flex-col justify-between gap-4 rounded-2xl border border-border/70 bg-card/45 px-5 py-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          {isScanning ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : issues ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <CheckCircle2 className="h-5 w-5 text-emerald-300" />}
          <div><p className="text-sm font-medium">{isScanning ? "Willard is working quietly" : issues ? "Your library needs a little attention" : "Your library is up to date"}</p><p className="text-xs text-muted-foreground">{isScanning ? "You can keep browsing while background work continues." : online ? `Last checked ${relativeDate(data.lastScanAt)}` : (data.libraryMessage || "Library location is offline")}</p></div>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground"><span>{data.totalFiles.toLocaleString()} items</span><span className="h-1 w-1 rounded-full bg-border" /><span>{formatBytes(data.totalSizeBytes)} indexed</span><Button variant="ghost" size="sm" onClick={() => scanMutation.mutate()} disabled={isScanning || scanMutation.isPending} className="h-8 text-xs text-primary">{isScanning ? "Working…" : "Check for changes"}</Button></div>
      </section>

      {attention.length > 0 && <section><div className="mb-3 flex items-center justify-between"><div><h2 className="text-lg font-semibold">A few things to review</h2><p className="text-xs text-muted-foreground">Only meaningful work appears here.</p></div><Link href="/settings" className="text-xs text-muted-foreground hover:text-foreground">Manage preferences</Link></div><div className="grid gap-3 md:grid-cols-3">{attention.map((item) => <AttentionCard key={item.key} {...item} onDismiss={() => dismiss(item.key)} />)}</div></section>}

      <section><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Your library</h2><Link href="/library" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Open all media <ChevronRight className="h-3 w-3" /></Link></div><div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{stats.map(({ label, value, sub, icon: Icon, href, color }) => <Link key={label} href={href} className="rounded-2xl border border-border/70 bg-card/55 p-4 transition-colors hover:border-primary/35 hover:bg-card"><Icon className={cn("mb-5 h-4 w-4", color)} /><p className="text-2xl font-semibold tabular-nums">{typeof value === "number" ? value.toLocaleString() : value}</p><p className="mt-1 text-sm">{label}</p><p className="mt-1 text-xs text-muted-foreground">{sub}</p></Link>)}</div></section>

      <section className="rounded-3xl border border-border/70 bg-card/45 p-5 sm:p-6"><div className="mb-5 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Recently added</h2><p className="text-xs text-muted-foreground">The latest moments and files Willard has found.</p></div><Link href="/library" className="text-xs text-primary hover:underline">View library</Link></div>{recentFiles.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-10 text-center"><HardDrive className="mx-auto mb-3 h-7 w-7 text-muted-foreground/50" /><p className="text-sm text-muted-foreground">Your library is ready when you are.</p><Link href="/settings" className="mt-2 inline-block text-xs text-primary hover:underline">Connect a library</Link></div> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">{recentFiles.map((file: any) => <Link key={file.id ?? file.filename} href={file.id ? `/media/${file.id}` : "/library"} className="group min-w-0"><MediaThumb file={file} /><p className="mt-2 truncate text-xs font-medium group-hover:text-primary">{file.filename}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{relativeDate(file.modifiedAt)}</p></Link>)}</div>}</section>
      <LibraryActivityFeed />
      {attention.length === 0 && duplicateCount === 0 && incoming === 0 && <div className="flex items-center justify-center gap-2 pb-3 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> Nothing urgent. Willard will let you know when it finds something useful.</div>}
      {(scanStatus as any)?.lastFailed && <p className="text-center text-xs text-muted-foreground">The last background check reported an issue. <Link href="/health" className="text-primary hover:underline">View library health</Link></p>}
    </div>
  );
}