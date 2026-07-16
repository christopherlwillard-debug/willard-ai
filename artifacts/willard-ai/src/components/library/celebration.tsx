import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useUpdateSettings,
  useGetDashboard,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLibraryHealth } from "./library-status";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PartyPopper, Search, Image as ImageIcon, Film, FileText } from "lucide-react";

const EXAMPLE_SEARCHES = [
  "Show vacation pictures",
  "Find every PDF about flooring",
  "Videos from last summer",
];

/**
 * One-time "Your media library is ready!" moment, shown when the initial
 * indexing finishes. Persisted server-side so it never reappears.
 */
export function LibraryReadyCelebration() {
  const queryClient = useQueryClient();
  const { data: settings } = useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
  const { data: health } = useLibraryHealth();
  const { data: dashboard } = useGetDashboard();

  const [open, setOpen] = useState(false);
  const markedRef = useRef(false);

  const markMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() }),
    },
  });

  const scanning = health?.activeJob != null;
  const scanFinished = !scanning && Boolean(settings?.lastScanAt);
  const hasFiles = (dashboard?.totalFiles ?? 0) > 0;

  useEffect(() => {
    if (
      settings &&
      !settings.celebrationShownAt &&
      settings.nasPath &&
      scanFinished &&
      hasFiles &&
      !markedRef.current
    ) {
      markedRef.current = true;
      setOpen(true);
      markMutation.mutate({ data: { celebrationShown: true } as any });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.celebrationShownAt, settings?.nasPath, scanFinished, hasFiles]);

  if (!dashboard) return null;

  const count = (type: string) =>
    dashboard.typeBreakdown?.find((b: { fileType: string; count: number }) => b.fileType === type)?.count ?? 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
            <PartyPopper className="w-6 h-6 text-primary" />
          </div>
          <DialogTitle className="text-center text-xl">Your media library is ready!</DialogTitle>
          <DialogDescription className="text-center">
            Willard AI finished building your library.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 py-2">
          {[
            { label: "Photos", value: count("image"), icon: ImageIcon, color: "text-purple-400" },
            { label: "Videos", value: count("video"), icon: Film, color: "text-blue-400" },
            { label: "Documents", value: count("document"), icon: FileText, color: "text-green-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="rounded-lg border border-border bg-card px-3 py-3 text-center">
              <Icon className={`w-4 h-4 mx-auto mb-1 ${color}`} />
              <p className="text-lg font-bold tabular-nums">{value.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Try asking</p>
          {EXAMPLE_SEARCHES.map((q) => (
            <Link key={q} href="/search" onClick={() => setOpen(false)}>
              <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/40 cursor-pointer">
                <Search className="w-3.5 h-3.5 text-muted-foreground" />
                <span>&ldquo;{q}&rdquo;</span>
              </div>
            </Link>
          ))}
        </div>

        <Button className="w-full" onClick={() => setOpen(false)}>
          Start exploring
        </Button>
      </DialogContent>
    </Dialog>
  );
}
