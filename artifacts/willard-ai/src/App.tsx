import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { Layout } from "@/components/layout/layout";
import { AuthProvider, useAuth } from "@/context/auth-context";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useGetSystemEnvironment,
} from "@workspace/api-client-react";
import { LibrarySetup } from "@/components/library/library-setup";
import { Loader2 } from "lucide-react";

import Dashboard from "@/pages/dashboard";
import Media from "@/pages/media";
import MediaDetail from "@/pages/media-detail";
import MapPage from "@/pages/map";
import Library from "@/pages/library";
import Collections from "@/pages/collections";
import People from "@/pages/people";
import Archives from "@/pages/archives";
import Documents from "@/pages/documents";
import Organize from "@/pages/organize";
import Optimize from "@/pages/optimize";
import Cleanup from "@/pages/cleanup";
import Search from "@/pages/search";
import Chat from "@/pages/chat";
import Settings from "@/pages/settings";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import Diagnostics from "@/pages/diagnostics";
import Health from "@/pages/health";
import { ServiceAvailability } from "@/components/service-availability";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        if (error?.response?.status === 401) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoutes() {
  // First-run experience: when the server runs locally and no library is
  // configured yet, open into Library Setup instead of a bare dashboard.
  // On Replit/cloud (isLocal=false) behavior is unchanged.
  const { data: settings, isLoading: settingsLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });
  const { data: env } = useGetSystemEnvironment();

  if (!settingsLoading && settings && !settings.nasPath && env?.isLocal) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4 py-12">
        <LibrarySetup />
      </div>
    );
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/media" component={Media} />
        <Route path="/media/:id" component={MediaDetail} />
        <Route path="/map" component={MapPage} />
        <Route path="/library" component={Library} />
        <Route path="/collections" component={Collections} />
        <Route path="/people" component={People} />
        <Route path="/people/:id" component={People} />
        <Route path="/explorer">
          <Redirect to="/library" />
        </Route>
        <Route path="/archives" component={Archives} />
        <Route path="/documents" component={Documents} />
        <Route path="/organize" component={Organize} />
        <Route path="/optimize" component={Optimize} />
        <Route path="/cleanup" component={Cleanup} />
        <Route path="/health" component={Health} />
        <Route path="/search" component={Search} />
        <Route path="/chat" component={Chat} />
        <Route path="/settings" component={Settings} />
        <Route path="/diagnostics" component={Diagnostics} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function AuthGate() {
  const { authenticated, loading, authError, refetch } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground font-mono">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">INITIALIZING…</span>
        </div>
      </div>
    );
  }

  if (authError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-xl border border-destructive/40 bg-card p-8 text-center shadow-2xl">
          <h1 className="font-mono text-lg font-bold text-destructive">AUTHENTICATION UNAVAILABLE</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The server could not be reached. This is different from an incorrect password.
            Check the connection and try again.
          </p>
          <button className="mt-5 rounded-md border px-4 py-2 font-mono text-sm hover:bg-secondary" onClick={() => void refetch()}>
            RETRY_CONNECTION
          </button>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage />;
  }

  return <ProtectedRoutes />;
}

function App() {
  return (
    <ServiceAvailability>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            {/* Routing is intentionally centralized on wouter; do not add react-router-dom imports. */}
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AuthProvider>
                <AuthGate />
              </AuthProvider>
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ServiceAvailability>
  );
}

export default App;
