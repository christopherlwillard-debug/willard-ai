import { eventUrl } from "@/lib/api";
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

export function useLibraryJobStream() {
  const [jobs, setJobs] = useState<LibraryJobProgress[]>([]);
  const [lastCompleted, setLastCompleted] = useState<LibraryJobProgress | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let delay = 500;
    const connect = () => {
      if (stopped) return;
      source = new EventSource(eventUrl("/library/jobs/events"));
      source.addEventListener("jobs", onJobs);
      source.onopen = () => { delay = 500; setConnected(true); };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (!stopped) {
          reconnectTimer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10_000);
        }
      };
    };
    const onJobs = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { jobs?: LibraryJobProgress[]; lastCompleted?: LibraryJobProgress | null };
        setJobs(payload.jobs ?? []);
        setLastCompleted(payload.lastCompleted ?? null);
        setConnected(true);
      } catch { /* ignore malformed server events */ }
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
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