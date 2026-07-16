import { useEffect, useRef } from "react";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useUpdateSettings,
  useGetHealthStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLibraryHealth } from "./library-status";
import { CheckCircle2, Circle, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChecklistItem {
  label: string;
  done: boolean;
}

/**
 * Small onboarding checklist shown on the dashboard after Library Setup.
 * Items check themselves off; once everything is done the checklist
 * disappears permanently (persisted server-side).
 */
export function OnboardingChecklist() {
  const queryClient = useQueryClient();
  const { data: settings } = useGetSettings({ query: { queryKey: getGetSettingsQueryKey() } });
  const { data: health } = useLibraryHealth();
  const { data: appHealth } = useGetHealthStatus();

  const dismissMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() }),
    },
  });

  const libraryConnected = health?.status === "online";
  const scanning = health?.activeJob != null;
  const scanFinished = !scanning && Boolean(settings?.lastScanAt);
  const aiReady = appHealth?.database ?? false;

  const items: ChecklistItem[] = [
    { label: "Library connected", done: libraryConnected },
    { label: "AI engine ready", done: Boolean(aiReady) },
    { label: "Finish building your library", done: scanFinished },
  ];

  const allDone = items.every((i) => i.done);
  const dismissedRef = useRef(false);

  useEffect(() => {
    if (allDone && settings && !settings.onboardingDismissedAt && !dismissedRef.current) {
      dismissedRef.current = true;
      dismissMutation.mutate({ data: { onboardingDismissed: true } as any });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone, settings?.onboardingDismissedAt]);

  if (!settings || settings.onboardingDismissedAt || !settings.nasPath) return null;
  if (allDone) return null;

  const doneCount = items.filter((i) => i.done).length;

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <ListChecks className="w-4 h-4 text-primary" />
        <p className="text-sm font-semibold">Getting started</p>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{doneCount}/{items.length}</span>
      </div>
      <div className="space-y-2">
        {items.map(({ label, done }) => (
          <div key={label} className="flex items-center gap-2.5">
            {done ? (
              <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
            ) : (
              <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0" />
            )}
            <span className={cn("text-sm", done ? "text-muted-foreground line-through" : "text-foreground")}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
