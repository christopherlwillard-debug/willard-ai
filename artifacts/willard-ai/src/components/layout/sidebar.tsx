import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Image as ImageIcon,
  FolderTree,
  Archive,
  FileText,
  HardDrive,
  Trash2,
  Search,
  MessageSquare,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Media", href: "/media", icon: ImageIcon },
  { name: "Explorer", href: "/explorer", icon: FolderTree },
  { name: "Archives", href: "/archives", icon: Archive },
  { name: "Documents", href: "/documents", icon: FileText },
  { name: "Storage", href: "/storage", icon: HardDrive },
  { name: "Cleanup", href: "/cleanup", icon: Trash2 },
  { name: "Search", href: "/search", icon: Search },
  { name: "AI Chat", href: "/chat", icon: MessageSquare },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function Sidebar() {
  const [location] = useLocation();

  return (
    <div className="flex h-full w-64 flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-14 items-center px-4 border-b border-sidebar-border">
        <h1 className="text-xl font-bold font-mono tracking-tight text-primary">WILLARD_AI</h1>
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
    </div>
  );
}
