import {
  useGetDashboard,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { useLibraryHealth } from "./library-status";
import { Progress } from "@/components/ui/progress";
import { Loader2, Image as ImageIcon, Film, FileText } from "lucide-react";

/**
 * "Building your media library…" card, shown on the dashboard while a scan
 * job is running. Per-category counts come from the live dashboard breakdown
 * (they grow as the scan indexes files); overall progress comes from the
 * active job. The user keeps full access to the app while it runs.
 */
export function BuildingLibraryProgress() {
  const { data: health } = useLibraryHealth(5000);
  const { data: dashboard } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: health?.activeJob ? 4000 : false,
    },
  });

  const job = health?.activeJob as {
    filesProcessed?: number;
    filesTotal?: number | null;
    stage?: string | null;
  } | null | undefined;

  if (!job) return null;

  const scanned = job.filesProcessed ?? 0;
  const total = job.filesTotal ?? null;
  const pct = total && total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : null;

  const count = (type: string) =>
    dashboard?.typeBreakdown?.find((b: { fileType: string; count: number }) => b.fileType === type)?.count ?? 0;

  const categories = [
    { label: "Photos", value: count("image"), icon: ImageIcon, color: "text-purple-400" },
    { label: "Videos", value: count("video"), icon: Film, color: "text-blue-400" },
    { label: "Documents", value: count("document"), icon: FileText, color: "text-green-400" },
  ];

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-5 py-4 space-y-3">
      <div className="flex items-center gap-3">
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-blue-300">Building your media library…</p>
          <p className="text-xs text-muted-foreground">
            {total
              ? `${scanned.toLocaleString()} of ${total.toLocaleString()} files indexed`
              : `${scanned.toLocaleString()} files indexed so far`}
            {job.stage ? ` • ${job.stage}` : ""}
            {" — you can start using Willard AI now."}
          </p>
        </div>
        {pct != null && <span className="text-sm font-bold tabular-nums text-blue-300 shrink-0">{pct}%</span>}
      </div>
      {pct != null && <Progress value={pct} className="h-1.5" />}
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {categories.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className={`w-3.5 h-3.5 ${color}`} />
            <span>{label}</span>
            <span className="font-medium text-foreground tabular-nums">{value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
