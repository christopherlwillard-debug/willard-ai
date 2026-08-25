import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Image as ImageIcon,
  Film,
  Music2,
  Archive,
  FileText,
  Trash2,
  Search,
  MessageSquare,
  Settings,
  LogOut,
  Loader2,
  Boxes,
  Zap,
  BookImage,
  FolderHeart,
  Users,
  ShieldCheck,
  MapPinned,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLogout, getGetSettingsLogoUrl } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { useQueryClient } from "@tanstack/react-query";
import { PwaInstallButton } from "@/components/pwa-install-button";

function SidebarBrand() {
  const [logoVersion, setLogoVersion] = useState(0);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    const onUpdate = () => {
      setLogoFailed(false);
      setLogoVersion((v) => v + 1);
    };
    window.addEventListener("willard-logo-updated", onUpdate);
    return () => window.removeEventListener("willard-logo-updated", onUpdate);
  }, []);

  if (logoFailed) {
    return <h1 className="brand-mark text-center font-mono text-lg font-bold tracking-[0.18em] md:text-xl">WILLARD_AI</h1>;
  }

  return (
    <img
      key={logoVersion}
      src={`${getGetSettingsLogoUrl()}?v=${logoVersion}`}
      alt="Willard AI"
      className="h-8 w-full max-w-full object-contain object-left md:h-9"
      onError={() => setLogoFailed(true)}
    />
  );
}

const primaryNavigation = [
  { name: "Home", href: "/", icon: LayoutDashboard },
  { name: "Photos", href: "/media", icon: ImageIcon },
  { name: "Videos", href: "/media?type=video", icon: Film },
  { name: "Documents", href: "/documents", icon: FileText },
  { name: "Music", href: "/library?type=audio", icon: Music2 },
  { name: "Collections", href: "/collections", icon: FolderHeart },
  { name: "People", href: "/people", icon: Users },
  { name: "Places", href: "/map", icon: MapPinned },
  { name: "Search", href: "/search", icon: Search },
  { name: "Ask Willard", href: "/chat", icon: MessageSquare },
];

const advancedNavigation = [
  { name: "Operations", href: "/organize", icon: Boxes },
  { name: "Optimize", href: "/optimize", icon: Zap },
  { name: "Cleanup", href: "/cleanup", icon: Trash2 },
  { name: "Archives", href: "/archives", icon: Archive },
  { name: "Health Center", href: "/health", icon: ShieldCheck },
];

export function Sidebar() {
  const [location] = useLocation();
  const { invalidate } = useAuth();
  const queryClient = useQueryClient();

  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        invalidate();
      },
    },
  });

  return (
    <div className="flex h-full w-[4.75rem] shrink-0 flex-col border-r border-sidebar-border bg-sidebar/90 backdrop-blur-xl md:w-64">
      <div className="flex h-14 items-center justify-center border-b border-sidebar-border px-2 md:justify-start md:px-4">
        <SidebarBrand />
      </div>
      <div className="archive-scrollbar flex-1 overflow-y-auto py-3 md:py-4">
        <nav className="space-y-1 px-2">
          {primaryNavigation.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                aria-label={item.name}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group flex items-center justify-center rounded-lg border border-transparent px-2 py-2.5 font-mono text-sm font-medium transition-all md:justify-start",
                  isActive
                    ? "border-primary/20 bg-sidebar-accent/90 text-sidebar-accent-foreground shadow-[inset_2px_0_0_hsl(var(--primary)),0_0_22px_rgba(42,213,255,.08)]"
                    : "text-sidebar-foreground/75 hover:border-border/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                )}
                data-testid={`link-nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <item.icon
                  className={cn(
                    "h-4 w-4 flex-shrink-0 md:mr-3",
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-primary"
                  )}
                  aria-hidden="true"
                />
                <span className="hidden truncate md:inline">{item.name}</span>
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 px-2">
          <p className="mb-2 hidden px-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60 md:block">
            More
          </p>
          <nav className="space-y-1">
            {advancedNavigation.map((item) => {
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  aria-label={item.name}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group flex items-center justify-center rounded-lg border border-transparent px-2 py-2 font-mono text-xs transition-all md:justify-start",
                    isActive
                      ? "border-primary/20 bg-sidebar-accent/90 text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/60 hover:border-border/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                  )}
                  data-testid={`link-nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <item.icon className={cn("h-3.5 w-3.5 flex-shrink-0 md:mr-3", isActive ? "text-primary" : "text-muted-foreground group-hover:text-primary")} aria-hidden="true" />
                  <span className="hidden truncate md:inline">{item.name}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
      <div className="border-t border-sidebar-border p-2">
        <div className="pwa-install-container">
          <PwaInstallButton />
        </div>
        <button
          aria-label="Logout"
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending}
          className="group flex w-full items-center justify-center rounded-lg border border-transparent px-2 py-2.5 font-mono text-sm font-medium text-muted-foreground transition-colors hover:border-border/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50 md:justify-start"
        >
          {logoutMutation.isPending ? (
            <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin md:mr-3" />
          ) : (
            <LogOut className="h-4 w-4 flex-shrink-0 group-hover:text-primary md:mr-3" />
          )}
          <span className="hidden md:inline">Logout</span>
        </button>
      </div>
    </div>
  );
}
