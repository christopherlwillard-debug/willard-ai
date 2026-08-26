import { apiUrl, eventUrl } from "@/lib/api";
import {
  isRecoverableJobStatus,
  isTerminalJobStatus,
  progressFromPersistedJob,
  shouldAcceptJobSnapshot,
  type JobStreamCursor,
} from "@/lib/library-job-recovery";
import { useEffect, useState } from "react";

export interface LibraryJobProgress {
  jobId: number;
  jobType: string;
  status: string;
  phase: string;
  profile: string | null;
  progress: number;
  filesProcessed: number;
  filesTotal: number;
  currentPath: string;
  etaSeconds: number | null;
  speed: number;
  counters: {
    new: number; modified: number; moved: number; unchanged: number;
    deleted: number; hashed: number; thumbnails: number;
    thumbnailsFailed: number; skipped: number; reanalyzed: number;
  };
  summary: Record<string, number> | null;
}

type StreamPayload = {
  jobs?: LibraryJobProgress[];
  lastCompleted?: LibraryJobProgress | null;
  streamId?: string;
  sequence?: number;
};

async function reconcileJobSnapshot(): Promise<{
  jobs: LibraryJobProgress[];
  lastCompleted: LibraryJobProgress | null;
}> {
  const [activeResponse, historyResponse] = await Promise.all([
    fetch(apiUrl("/library/jobs/active")),
    fetch(apiUrl("/library/jobs/history")),
  ]);
  if (!activeResponse.ok || !historyResponse.ok) {
    throw new Error("Could not reconcile library job progress");
  }

  const active = await activeResponse.json() as LibraryJobProgress | null;
  const history = await historyResponse.json() as { jobs?: Array<Record<string, unknown>> };
  const activeJob = active && isRecoverableJobStatus(active.status) ? active : null;
  const activeTerminal = active && isTerminalJobStatus(active.status) ? active : null;
  const historyTerminal = history.jobs?.find((job) => isTerminalJobStatus(job.status));

  return {
    jobs: activeJob ? [activeJob] : [],
    lastCompleted: activeTerminal ?? (historyTerminal ? progressFromPersistedJob(historyTerminal) : null),
  };
}

export function useLibraryJobStream() {
  const [jobs, setJobs] = useState<LibraryJobProgress[]>([]);
  const [lastCompleted, setLastCompleted] = useState<LibraryJobProgress | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let reconciling = false;
    let streamConnected = false;
    let currentJobs: LibraryJobProgress[] = [];
    let latestStreamAt = 0;
    let cursor: JobStreamCursor | null = null;
    let delay = 500;

    const scheduleFallback = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (stopped) return;
      const interval = !streamConnected || currentJobs.length > 0 ? 10_000 : 60_000;
      fallbackTimer = setTimeout(() => void reconcile(), interval);
    };

    const setStreamConnected = (next: boolean) => {
      streamConnected = next;
      setConnected(next);
      scheduleFallback();
    };

    const applySnapshot = (jobs: LibraryJobProgress[], lastCompleted: LibraryJobProgress | null) => {
      currentJobs = jobs;
      setJobs(jobs);
      setLastCompleted(lastCompleted);
      scheduleFallback();
    };

    const reconcile = async () => {
      if (stopped || reconciling) return;
      reconciling = true;
      const startedAt = Date.now();
      try {
        const snapshot = await reconcileJobSnapshot();
        // Never let a slower REST response overwrite fresher SSE progress.
        if (!stopped && latestStreamAt <= startedAt) {
          applySnapshot(snapshot.jobs, snapshot.lastCompleted);
        }
      } catch {
        // The next bounded fallback poll or SSE reconnect will try again.
      } finally {
        reconciling = false;
        scheduleFallback();
      }
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(eventUrl("/library/jobs/events"));
      source.addEventListener("jobs", onJobs);
      source.onopen = () => {
        delay = 500;
        setStreamConnected(true);
        void reconcile();
      };
      source.onerror = () => {
        setStreamConnected(false);
        source?.close();
        void reconcile();
        if (!stopped) {
          reconnectTimer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10_000);
        }
      };
    };
    const onJobs = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as StreamPayload;
        const incomingCursor = payload.streamId && typeof payload.sequence === "number"
          ? { streamId: payload.streamId, sequence: payload.sequence }
          : null;
        if (!shouldAcceptJobSnapshot(cursor, incomingCursor)) return;
        cursor = incomingCursor ?? cursor;
        latestStreamAt = Date.now();
        applySnapshot(payload.jobs ?? [], payload.lastCompleted ?? null);
        setStreamConnected(true);
      } catch { /* ignore malformed server events */ }
    };

    const reconcileAfterReconnect = () => {
      void reconcile();
      if (!source || source.readyState === EventSource.CLOSED) connect();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") reconcileAfterReconnect();
    };

    window.addEventListener("online", reconcileAfterReconnect);
    document.addEventListener("visibilitychange", onVisibility);
    void reconcile();
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      window.removeEventListener("online", reconcileAfterReconnect);
      document.removeEventListener("visibilitychange", onVisibility);
      source?.removeEventListener("jobs", onJobs);
      source?.close();
    };
  }, []);

  return { jobs, lastCompleted, connected };
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "Estimating time…";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec remaining`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min remaining`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m remaining`;
}