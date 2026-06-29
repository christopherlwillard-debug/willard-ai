import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Search, ScanLine, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "./sidebar";
import {
  useGetDashboard,
  useStartScan,
  getGetDashboardQueryKey,
  getGetScanStatusQueryKey,
  useGetScanStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

function TopBar() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [scanPolling, setScanPolling] = useState(false);

  const { data } = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      refetchInterval: 30000,
    },
  });

  const { data: scanStatus } = useGetScanStatus({
    query: {
      queryKey: getGetScanStatusQueryKey(),
      refetchInterval: scanPolling ? 2000 : false,
      enabled: scanPolling,
    },
  });

  const scanMutation = useStartScan({
    mutation: {
      onSuccess: () => setScanPolling(true),
    },
  });

  const isScanning = data?.isScanning || (scanPolling && (scanStatus?.isRunning ?? false));

  if (scanPolling && scanStatus && !scanStatus.isRunning) {
    setScanPolling(false);
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  }

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
        className="flex items-center gap-2 flex-1 max-w-sm rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors text-left"
      >
        <Search className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1">Search your library…</span>
        <kbd className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono tracking-tight">⌘K</kbd>
      </button>

      {data && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
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

      <Button
        size="sm"
        variant="outline"
        onClick={() => scanMutation.mutate()}
        disabled={isScanning || scanMutation.isPending}
        className="h-7 text-xs gap-1.5 shrink-0"
      >
        {isScanning ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <ScanLine className="w-3 h-3" />
        )}
        {isScanning ? "Scanning…" : "Scan Library"}
      </Button>
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
          <div className="mx-auto max-w-5xl p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
