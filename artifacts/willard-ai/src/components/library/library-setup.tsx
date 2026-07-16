import { useState } from "react";
import {
  useGetSystemEnvironment,
  useGetSystemDrives,
  useTestNasPath,
  useUpdateSettings,
  useStartScan,
  getGetSettingsQueryKey,
  getGetLibraryHealthQueryKey,
  getGetScanStatusQueryKey,
  getGetSystemDrivesQueryKey,
} from "@workspace/api-client-react";
import type { DriveCandidate, NasTestResult } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  HardDrive,
  Wifi,
  FolderOpen,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronRight,
  Monitor,
} from "lucide-react";
import { cn } from "@/lib/utils";

function driveIcon(kind: DriveCandidate["kind"]) {
  switch (kind) {
    case "network": return Wifi;
    case "local": return Monitor;
    default: return HardDrive;
  }
}

function driveDescription(d: DriveCandidate): string {
  const kindLabel =
    d.kind === "network" ? "looks like a network drive" :
    d.kind === "local" ? "this computer's own disk" :
    "looks like an attached drive";
  const items = d.itemCount != null ? ` • ${d.itemCount.toLocaleString()} items at the top level` : "";
  return `${kindLabel}${items}`;
}

/**
 * Reusable Library Setup flow — used as the first-run experience when the
 * server runs locally with no library configured, and again from
 * Settings → Libraries to change the library location later.
 */
export function LibrarySetup({
  title = "Let's set up your media library",
  subtitle = "Tell Willard AI where your photos, videos, and documents live. It will build a searchable library and keep it up to date automatically.",
  onDone,
}: {
  title?: string;
  subtitle?: string;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: env } = useGetSystemEnvironment();
  const detectionEnabled = env?.driveDetectionAvailable === true;
  const { data: driveList, isLoading: drivesLoading } = useGetSystemDrives({
    query: { queryKey: getGetSystemDrivesQueryKey(), enabled: detectionEnabled },
  });

  const [manualPath, setManualPath] = useState("");
  const [testResult, setTestResult] = useState<NasTestResult | null>(null);
  const [savingPath, setSavingPath] = useState<string | null>(null);

  const testMutation = useTestNasPath({
    mutation: {
      onSuccess: (data) => setTestResult(data),
      onError: () => setTestResult(null),
    },
  });

  const scanMutation = useStartScan({
    mutation: {
      onSettled: () => {
        queryClient.invalidateQueries({ queryKey: getGetScanStatusQueryKey() });
      },
    },
  });

  const updateMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetLibraryHealthQueryKey() });
        // Kick off the initial library build in the background; the user can
        // use the app immediately while it runs.
        scanMutation.mutate({ data: { type: "QUICK" } } as any);
        toast({ title: "Building your media library…", description: "You can start using Willard AI right away." });
        setSavingPath(null);
        onDone?.();
      },
      onError: (err: any) => {
        setSavingPath(null);
        toast({ title: "Couldn't save the library location", description: err?.message, variant: "destructive" });
      },
    },
  });

  const chooseLocation = (path: string) => {
    setSavingPath(path);
    updateMutation.mutate({ data: { nasPath: path } });
  };

  const drives = driveList?.available ? driveList.drives : [];
  const busy = updateMutation.isPending || scanMutation.isPending;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
          <FolderOpen className="w-7 h-7 text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">{subtitle}</p>
      </div>

      {detectionEnabled && (
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {drivesLoading ? "Looking for drives…" : drives.length > 0 ? "We found these locations" : "Drives"}
          </p>
          {drivesLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </div>
          ) : drives.length === 0 ? (
            <Card>
              <CardContent className="py-5 text-sm text-muted-foreground">
                No drives were detected automatically. Enter the folder path below instead.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {drives.map((d) => {
                const Icon = driveIcon(d.kind);
                const saving = savingPath === d.path && busy;
                return (
                  <button
                    key={d.path}
                    type="button"
                    disabled={busy}
                    onClick={() => chooseLocation(d.path)}
                    className={cn(
                      "w-full flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3.5 text-left transition-colors",
                      "hover:border-primary/50 hover:bg-muted/40 disabled:opacity-60"
                    )}
                  >
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{d.label} <span className="text-muted-foreground font-normal">({d.path})</span></p>
                      <p className="text-xs text-muted-foreground truncate">{driveDescription(d)}</p>
                    </div>
                    {saving ? (
                      <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
                    ) : (
                      <span className="flex items-center gap-1 text-xs font-medium text-primary shrink-0">
                        Use it <ChevronRight className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {detectionEnabled ? "Or enter a folder path" : "Enter the folder path"}
        </p>
        <div className="flex gap-2">
          <Input
            value={manualPath}
            onChange={(e) => { setManualPath(e.target.value); setTestResult(null); }}
            placeholder={env?.isWindows ? "e.g. Z:\\ or D:\\Media" : "e.g. /mnt/nas or /Volumes/Media"}
            className="font-mono"
            disabled={busy}
          />
          <Button
            variant="secondary"
            disabled={!manualPath || testMutation.isPending || busy}
            onClick={() => testMutation.mutate({ data: { path: manualPath } })}
          >
            {testMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check"}
          </Button>
        </div>
        {testResult && (
          <div className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
            testResult.accessible
              ? "border-green-500/40 bg-green-500/10 text-green-400"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          )}>
            {testResult.accessible
              ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <span className="text-xs">{testResult.message}</span>
          </div>
        )}
        <Button
          className="w-full"
          disabled={!manualPath || busy || (testResult != null && !testResult.accessible)}
          onClick={() => chooseLocation(manualPath)}
        >
          {busy && savingPath === manualPath
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Setting up…</>
            : "Use this folder"}
        </Button>
        <p className="text-[11px] text-muted-foreground text-center">
          Works with any storage — network drives (WD My Cloud, Synology, QNAP), USB drives, or folders on this computer.
        </p>
      </div>
    </div>
  );
}
