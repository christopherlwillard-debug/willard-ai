import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { Search, ScanLine, Loader2, CheckCircle2, Bell, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "./sidebar";
import {
  useGetDashboard,
  useStartScan,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

function TopBar() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [scanTriggered, setScanTriggered] = useState(false);

  const { data } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: scanTriggered ? 3000 : 30000,
    },
  });

  const scanMutation = useStartScan({
    mutation: {
      onSuccess: () => setScanTriggered(true),
    },
  });

  const isScanning = data?.isScanning || scanTriggered;

  useEffect(() => {
    if (scanTriggered && data && !data.isScanning) {
      setScanTriggered(false);
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    }
  }, [scanTriggered, data, queryClient]);

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
    <div className="flex items-center h-12 border-b border-border px-4 gap-3 bg-background shrink-0">
      <button
        onClick={() => navigate("/search")}
        className="flex items-center gap-2 flex-1 max-w-md rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors text-left"
      >
        <Search className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1">Search your library…</span>
        <kbd className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono tracking-tight">Ctrl+K</kbd>
      </button>

      <div className="flex items-center gap-1.5 ml-auto">
        {data && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mr-2">
            {isScanning ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
                <span className="text-amber-400">Scanning…</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-3 h-3 text-green-500" />
                <span>Healthy</span>
              </>
            )}
          </div>
        )}

        <button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <Bell className="w-4 h-4" />
        </button>

        <Link href="/settings">
          <button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <Settings className="w-4 h-4" />
          </button>
        </Link>

        <Button
          size="sm"
          variant="default"
          onClick={() => scanMutation.mutate()}
          disabled={isScanning || scanMutation.isPending}
          className="h-7 text-xs gap-1.5 shrink-0 ml-1"
          title="Re-indexes all files from scratch. Normally not needed — the library updates automatically."
        >
          {isScanning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ScanLine className="w-3 h-3" />
          )}
          {isScanning ? "Scanning…" : "Full Rescan"}
        </Button>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
