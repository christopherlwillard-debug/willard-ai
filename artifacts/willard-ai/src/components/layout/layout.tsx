import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Search, ScanLine, Loader2, CheckCircle2, Bell, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "./sidebar";
import {
  useStartScan,
} from "@workspace/api-client-react";
import { BackgroundTasksButton, BackgroundTasksPanel } from "@/components/library/background-tasks";
import { useLibraryJobStream } from "@/hooks/use-library-job-stream";

function TopBar() {
  const [, navigate] = useLocation();
  const [scanTriggered, setScanTriggered] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const { jobs } = useLibraryJobStream();

  const scanMutation = useStartScan({
    mutation: {
      onSuccess: () => {
        setScanTriggered(true);
        window.setTimeout(() => setScanTriggered(false), 2500);
      },
    },
  });

  const isScanning = scanTriggered || scanMutation.isPending;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        navigate("/search");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  return (
    <div className="glass-surface relative z-10 flex h-14 shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0 px-3 sm:px-5">
      <button
        onClick={() => navigate("/search")}
        className="cyan-focus flex min-w-0 max-w-xl flex-1 items-center gap-2 rounded-lg border border-border/80 bg-background/35 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        aria-label="Search your library"
      >
        <Search className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 truncate">Search your library…</span>
        <kbd className="hidden rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] tracking-tight sm:inline">Ctrl+K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
        {jobs.length > 0 && (
          <div className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex lg:mr-2">
            {isScanning ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-amber-300" />
                <span className="text-amber-300">Scanning…</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3 w-3 text-teal-300" />
              <span>{jobs.length} background task{jobs.length === 1 ? "" : "s"}</span>
              </>
            )}
          </div>
        )}

        <button aria-label="Notifications" onClick={() => navigate("/")} className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground">
          <Bell className="h-4 w-4" />
          {jobs.length > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />}
        </button>
        <BackgroundTasksButton onClick={() => setTasksOpen(true)} count={jobs.length} />

        <Link href="/settings" aria-label="Settings" className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground">
          <Settings className="h-4 w-4" />
        </Link>

        <Button
          size="sm"
          variant="default"
          onClick={() => scanMutation.mutate()}
          disabled={isScanning || scanMutation.isPending}
          className="ml-1 h-8 shrink-0 gap-1.5 rounded-lg border border-primary/40 bg-primary/10 text-xs text-primary shadow-[0_0_18px_rgba(43,218,255,.10)] hover:bg-primary/20 hover:text-primary"
          title="Checks the library for changes. Willard normally keeps it up to date automatically."
        >
          {isScanning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ScanLine className="w-3 h-3" />
          )}
           <span className="hidden sm:inline">{isScanning ? "Checking…" : "Check library"}</span>
           <span className="sm:hidden">{isScanning ? "Check…" : "Check"}</span>
        </Button>
      </div>
      <BackgroundTasksPanel open={tasksOpen} onOpenChange={setTasksOpen} />
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="archive-shell flex min-h-[100dvh] overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar />
        <main className="archive-scrollbar flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
