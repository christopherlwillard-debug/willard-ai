import { apiUrl } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";

type ServiceState = "checking" | "online" | "offline";

export function ServiceAvailability({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ServiceState>("checking");
  const [attempt, setAttempt] = useState(0);

  const checkService = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(apiUrl("/healthz"), { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Service unavailable");
      setState("online");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState("offline");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkService(controller.signal);
    const interval = window.setInterval(() => void checkService(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [checkService, attempt]);

  if (state !== "offline") return <>{children}</>;

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-xl">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-400/10">
          <Server className="h-6 w-6 text-amber-300" aria-hidden="true" />
        </div>
        <p className="mb-2 text-xs font-mono uppercase tracking-[0.22em] text-muted-foreground">Media Center unavailable</p>
        <h1 className="text-2xl font-semibold tracking-tight">Your local library service is not responding.</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          If this is a local installation, open <strong className="text-foreground">Start Willard AI.bat</strong>.
          The installed web app cannot start the database or local services by itself.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => { setState("checking"); setAttempt((value) => value + 1); }}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </Button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Offline mode keeps only the app shell available. Private media and library data require the local service.
          </div>
        </div>
      </div>
    </div>
  );
}