import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Image as ImageIcon,
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLogout, getGetSettingsLogoUrl } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { useQueryClient } from "@tanstack/react-query";

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
    return <h1 className="text-xl font-bold font-mono tracking-tight text-primary">WILLARD_AI</h1>;
  }

  return (
    <img
      key={logoVersion}
      src={`${getGetSettingsLogoUrl()}?v=${logoVersion}`}
      alt="Willard AI"
      className="h-9 w-auto max-w-full object-contain"
      onError={() => setLogoFailed(true)}
    />
  );
}

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Media", href: "/media", icon: ImageIcon },
  { name: "Library", href: "/library", icon: BookImage },
  { name: "Collections", href: "/collections", icon: FolderHeart },
  { name: "People", href: "/people", icon: Users },
  { name: "Archives", href: "/archives", icon: Archive },
  { name: "Documents", href: "/documents", icon: FileText },
  { name: "Operations", href: "/organize", icon: Boxes },
  { name: "Optimize", href: "/optimize", icon: Zap },
  { name: "Cleanup", href: "/cleanup", icon: Trash2 },
  { name: "Search", href: "/search", icon: Search },
  { name: "AI Chat", href: "/chat", icon: MessageSquare },
  { name: "Settings", href: "/settings", icon: Settings },
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
    <div className="flex h-full w-64 flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-14 items-center px-4 border-b border-sidebar-border">
        <SidebarBrand />
      </div>
      <div className="flex-1 overflow-y-auto py-4">
        <nav className="space-y-1 px-2">
          {navigation.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "group flex items-center px-2 py-2 text-sm font-medium rounded-md font-mono transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon
                  className={cn(
                    "mr-3 h-4 w-4 flex-shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground group-hover:text-primary"
                  )}
                  aria-hidden="true"
                />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="border-t border-sidebar-border p-2">
        <button
          onClick={() => logoutMutation.mutate()}
          disabled={logoutMutation.isPending}
          className="group flex w-full items-center px-2 py-2 text-sm font-medium rounded-md font-mono transition-colors text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50"
        >
          {logoutMutation.isPending ? (
            <Loader2 className="mr-3 h-4 w-4 flex-shrink-0 animate-spin" />
          ) : (
            <LogOut className="mr-3 h-4 w-4 flex-shrink-0 group-hover:text-primary" />
          )}
          Logout
        </button>
      </div>
    </div>
  );
}
