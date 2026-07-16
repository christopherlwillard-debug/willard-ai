import { Link } from "wouter";
import {
  useGetLibraryHealth,
  getGetLibraryHealthQueryKey,
  useRetryLibraryConnection,
  useAcknowledgeLibraryReconnect,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  CloudOff,
  Loader2,
  RefreshCw,
  FolderOpen,
  Sparkles,
  PauseCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

function formatTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "unknown";
  const d = new Date(dateStr);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function formatAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "never";
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function useLibraryHealth(pollMs = 10000) {
  return useGetLibraryHealth({
    query: {
      queryKey: getGetLibraryHealthQueryKey(),
      refetchInterval: pollMs,
    },
  });
}

/** Small, unobtrusive dashboard status indicator (Connected / Indexing / Offline). */
export function LibraryStatusIndicator() {
  const { data: health } = useLibraryHealth();
  if (!health || health.status === "unconfigured") return null;

  const job = health.activeJob as { filesScanned?: number; totalFiles?: number | null; stage?: string } | null | undefined;
  const indexing = job != null;
  const pct = indexing && job?.totalFiles ? Math.min(100, Math.round(((job.filesScanned ?? 0) / job.totalFiles) * 100)) : null;

  let icon;
  let text;
  let tone;
  if (health.status === "offline") {
    icon = <CloudOff className="w-3.5 h-3.5" />;
    text = "Library offline";
    tone = "text-red-400 border-red-500/30 bg-red-500/10";
  } else if (health.indexingPaused) {
    icon = <PauseCircle className="w-3.5 h-3.5" />;
    text = "Watching Paused";
    tone = "text-amber-400 border-amber-500/30 bg-amber-500/10";
  } else if (indexing) {
    icon = <Loader2 className="w-3.5 h-3.5 animate-spin" />;
    text = pct != null ? `Indexing ${pct}%` : `Indexing… ${(job?.filesScanned ?? 0).toLocaleString()} files`;
    tone = "text-blue-400 border-blue-500/30 bg-blue-500/10";
  } else {
    icon = <CheckCircle2 className="w-3.5 h-3.5" />;
    text = health.watching ? "Connected • Watching" : "Connected";
    tone = "text-green-400 border-green-500/30 bg-green-500/10";
  }

  const watcher = (health as unknown as {
    watcher?: { lastChangeAt?: string | null; mechanism?: string };
    lastScanAt?: string | null;
  }).watcher;
  const lastScanAt = (health as unknown as { lastScanAt?: string | null }).lastScanAt;
  const tooltip = [
    `Library: ${health.path || "not configured"}`,
    `Last check ${formatAgo(health.lastCheckAt)}`,
    watcher?.lastChangeAt ? `Last change ${formatAgo(watcher.lastChangeAt)}` : null,
    lastScanAt ? `Last scan ${formatAgo(lastScanAt)}` : null,
    watcher?.mechanism === "sweep" ? "Watching via periodic sweeps" : null,
  ].filter(Boolean).join(" • ");

  return (
    <div
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium", tone)}
      title={tooltip}
    >
      {icon}
      <span>{text}</span>
    </div>
  );
}

/**
 * Offline banner (Retry Now / Change Library) and the one-time
 * "Library reconnected" announcement. Renders nothing when all is well.
 */
export function LibraryStatusBanner() {
  const queryClient = useQueryClient();
  const { data: health } = useLibraryHealth();

  const retryMutation = useRetryLibraryConnection({
    mutation: {
      onSettled: () => queryClient.invalidateQueries({ queryKey: getGetLibraryHealthQueryKey() }),
    },
  });
  const ackMutation = useAcknowledgeLibraryReconnect({
    mutation: {
      onSettled: () => queryClient.invalidateQueries({ queryKey: getGetLibraryHealthQueryKey() }),
    },
  });

  if (!health || health.status === "unconfigured") return null;

  if (health.status === "offline") {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
        <CloudOff className="w-5 h-5 text-red-400 shrink-0" />
        <div className="flex-1 min-w-[16rem]">
          <p className="text-sm font-semibold text-red-300">Your media library is currently offline.</p>
          <p className="text-xs text-red-200/70">
            {health.lastOnlineAt ? `Last successful connection: ${formatTime(health.lastOnlineAt)}. ` : ""}
            Willard AI will reconnect automatically. You can keep browsing what's already indexed.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            size="sm"
            variant="secondary"
            disabled={retryMutation.isPending}
            onClick={() => retryMutation.mutate()}
          >
            {retryMutation.isPending
              ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
            Retry Now
          </Button>
          <Link href="/settings">
            <Button size="sm" variant="outline">
              <FolderOpen className="w-3.5 h-3.5 mr-1.5" /> Change Library
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // Reconnected announcement — shown until acknowledged.
  if (health.reconnectedAt) {
    const job = health.activeJob as { filesScanned?: number } | null | undefined;
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3">
        <Sparkles className="w-5 h-5 text-green-400 shrink-0" />
        <div className="flex-1 min-w-[16rem]">
          <p className="text-sm font-semibold text-green-300">Library reconnected. Checking for new media…</p>
          <p className="text-xs text-green-200/70">
            {job
              ? `Indexing only new and changed files — ${(job.filesScanned ?? 0).toLocaleString()} checked so far.`
              : "Only new and changed files will be indexed."}
          </p>
        </div>
        <Button size="sm" variant="ghost" className="shrink-0" onClick={() => ackMutation.mutate()}>
          Dismiss
        </Button>
      </div>
    );
  }

  return null;
}
