import { useMemo } from "react";
import {
  getGetLibraryJobsActiveQueryKey,
  getGetLibraryJobsHistoryQueryKey,
  useGetLibraryJobsActive,
  useGetLibraryJobsHistory,
  useStartLibraryScan,
} from "@workspace/api-client-react";

export { useStartLibraryScan };

export const libraryScanQueryKeys = {
  active: getGetLibraryJobsActiveQueryKey(),
  history: getGetLibraryJobsHistoryQueryKey(),
};

export type ScanDisplayJob = {
  id: number;
  status: "running" | "completed" | "failed" | "idle";
  filesScanned: number;
  totalFiles: number | null;
  stage: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

function displayStatus(status: unknown): ScanDisplayJob["status"] {
  if (status === "RUNNING") return "running";
  if (status === "DONE") return "completed";
  if (status === "FAILED") return "failed";
  return "idle";
}

function displayJob(job: any): ScanDisplayJob {
  return {
    id: Number(job.id ?? job.jobId),
    status: displayStatus(job.status),
    filesScanned: Number(job.processedFiles ?? job.filesScanned ?? 0),
    totalFiles: job.filesTotal ?? job.totalFiles ?? null,
    stage: String(job.phase ?? job.stage ?? "Starting").replaceAll("_", " "),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    error: job.error ?? null,
  };
}

export function useLibraryScanStatus(options?: { refetchInterval?: number }) {
  const queryOptions = {
    query: {
      queryKey: libraryScanQueryKeys.active,
      refetchInterval: options?.refetchInterval,
    },
  };
  const activeQuery = useGetLibraryJobsActive(queryOptions);
  const historyQuery = useGetLibraryJobsHistory({
    query: {
      queryKey: libraryScanQueryKeys.history,
      refetchInterval: options?.refetchInterval,
    },
  });

  const data = useMemo(() => {
    const active = activeQuery.data;
    const history = (historyQuery.data?.jobs ?? []) as any[];
    const current = active && ["RUNNING", "PAUSED", "INTERRUPTED_BY_RESTART"].includes(active.status)
      ? displayJob(active)
      : null;
    const completed = history.find(job => job.status === "DONE");
    const failed = history.find(job => job.status === "FAILED");

    return {
      isRunning: active?.status === "RUNNING",
      current,
      lastCompleted: completed ? displayJob(completed) : active?.status === "DONE" ? displayJob(active) : null,
      lastFailed: failed ? displayJob(failed) : null,
    };
  }, [activeQuery.data, historyQuery.data]);

  const history = useMemo(
    () => ((historyQuery.data?.jobs ?? []) as any[]).map(displayJob),
    [historyQuery.data],
  );

  return {
    data,
    history,
    isLoading: activeQuery.isLoading || historyQuery.isLoading,
    historyLoading: historyQuery.isLoading,
    error: activeQuery.error ?? historyQuery.error,
  };
}

export function invalidateLibraryScanQueries(queryClient: {
  invalidateQueries: (options: { queryKey: readonly unknown[] }) => unknown;
}): void {
  queryClient.invalidateQueries({ queryKey: libraryScanQueryKeys.active });
  queryClient.invalidateQueries({ queryKey: libraryScanQueryKeys.history });
}