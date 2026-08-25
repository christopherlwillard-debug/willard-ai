import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Activity,
  Sparkles,
  CloudOff,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Radio,
  Layers,
  FileStack,
  SlidersHorizontal,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ActivityEntry {
  id: number;
  kind: string;
  message: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

function formatAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs} seconds ago`;
  const mins = Math.floor(secs / 60);
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function kindIcon(kind: string) {
  switch (kind) {
    case "scan_summary": return <FileStack className="w-3.5 h-3.5 text-blue-400" />;
    case "catchup": return <Sparkles className="w-3.5 h-3.5 text-green-400" />;
    case "reconnected": return <Sparkles className="w-3.5 h-3.5 text-green-400" />;
    case "offline": return <CloudOff className="w-3.5 h-3.5 text-red-400" />;
    case "burst": return <Layers className="w-3.5 h-3.5 text-amber-400" />;
    case "watcher_restart": return <RefreshCw className="w-3.5 h-3.5 text-amber-400" />;
    case "watcher_mode": return <Radio className="w-3.5 h-3.5 text-violet-400" />;
    case "paused": return <PauseCircle className="w-3.5 h-3.5 text-amber-400" />;
    case "resumed": return <PlayCircle className="w-3.5 h-3.5 text-green-400" />;
    default: return <Activity className="w-3.5 h-3.5 text-muted-foreground" />;
  }
}

type ActivityFilter = "all" | "watcher";

export function useLibraryActivity(filter: ActivityFilter = "all", pollMs = 10000) {
  return useQuery<{ entries: ActivityEntry[] }>({
    queryKey: ["library-activity", filter],
    queryFn: async () => {
      const kindQuery = filter === "watcher" ? "&kind=watcher" : "";
      const res = await fetch(`${import.meta.env.BASE_URL}api/library/activity?limit=100${kindQuery}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load library activity");
      return res.json();
    },
    refetchInterval: pollMs,
  });
}

/**
 * Friendly Library Activity feed — makes the live library feel alive:
 * "17 new files, 3 updated, 2 moved — 8 seconds ago".
 */
export function LibraryActivityFeed() {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  // Keep the full result set in the client so changing filters never loses
  // the controls, even when there are currently no watcher entries.
  const { data } = useLibraryActivity("all");
  const allEntries = data?.entries ?? [];
  const entries = filter === "watcher"
    ? allEntries.filter((entry) => entry.kind === "watcher_mode" || entry.kind === "watcher_restart")
    : allEntries;

  if (allEntries.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-400" />
          <h3 className="text-sm font-semibold">Library Activity</h3>
          <span className="relative flex h-2 w-2 ml-1">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
        </div>
        <Select value={filter} onValueChange={(value) => setFilter(value as ActivityFilter)}>
          <SelectTrigger
            aria-label="Filter library activity"
            className="h-8 w-auto min-w-[155px] gap-1.5 px-2.5 text-xs"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="all">All activity</SelectItem>
            <SelectItem value="watcher">Watcher changes</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {entries.length > 0 ? (
        <ul className="px-5 pb-4 divide-y divide-border/60">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-2.5 py-2 first:pt-1">
              <span className="mt-0.5 shrink-0">{kindIcon(e.kind)}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-foreground/90 leading-snug">{e.message}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{formatAgo(e.createdAt)}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pb-4 pt-2 text-xs text-muted-foreground">
          No watcher changes recorded yet.
        </p>
      )}
    </div>
  );
}
