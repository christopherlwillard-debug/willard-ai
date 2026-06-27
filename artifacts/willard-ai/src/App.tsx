import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { Layout } from "@/components/layout/layout";

import Dashboard from "@/pages/dashboard";
import Media from "@/pages/media";
import Explorer from "@/pages/explorer";
import Archives from "@/pages/archives";
import Documents from "@/pages/documents";
import Cleanup from "@/pages/cleanup";
import Search from "@/pages/search";
import Chat from "@/pages/chat";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/media" component={Media} />
        <Route path="/explorer" component={Explorer} />
        <Route path="/archives" component={Archives} />
        <Route path="/documents" component={Documents} />
        <Route path="/cleanup" component={Cleanup} />
        <Route path="/search" component={Search} />
        <Route path="/chat" component={Chat} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
