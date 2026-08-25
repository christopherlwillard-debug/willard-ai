import "./_group.css";
import {
  AlertTriangle, Archive, ArrowUpFromLine, BookImage, CheckCircle2, ChevronRight,
  CloudOff, Copy, Database, Download, FileText, Film, FolderHeart, FolderOpen,
  HardDrive, HeartPulse, Image as ImageIcon, LayoutDashboard, Loader2, MapPinned,
  Maximize2, MessageSquare, Search, ScanLine, Settings, ShieldCheck, Trash2, Users, Zap,
} from "lucide-react";

type FileType = "image" | "video" | "document";
type RecentFile = { filename: string; fileType: FileType; modifiedAt: string; color: string };

const files: RecentFile[] = [
  { filename: "summer-cabin.jpg", fileType: "image", modifiedAt: "Today • 09:42", color: "from-violet-500 to-fuchsia-500" },
  { filename: "family-reunion.mp4", fileType: "video", modifiedAt: "Yesterday", color: "from-blue-500 to-cyan-500" },
  { filename: "renovation-notes.pdf", fileType: "document", modifiedAt: "2 days ago", color: "from-emerald-500 to-teal-500" },
  { filename: "garden-party.png", fileType: "image", modifiedAt: "3 days ago", color: "from-purple-500 to-indigo-500" },
  { filename: "travel-plans.docx", fileType: "document", modifiedAt: "4 days ago", color: "from-green-500 to-lime-500" },
];

const nav = [
  ["Dashboard", LayoutDashboard], ["Media", ImageIcon], ["Memory Map", MapPinned], ["Library", BookImage],
  ["Collections", FolderHeart], ["People", Users], ["Archives", Archive], ["Documents", FileText],
  ["Operations", Database], ["Optimize", Zap], ["Cleanup", Trash2], ["Health Center", ShieldCheck],
  ["Search", Search], ["AI Chat", MessageSquare], ["Settings", Settings],
] as const;

function bytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function StatCard({ label, value, sub, icon: Icon, iconBg, iconColor, bar, pct }: {
  label: string; value: string; sub: string; icon: typeof ImageIcon; iconBg: string; iconColor: string; bar: string; pct: number;
}) {
  return <div className="relative min-w-0 overflow-hidden rounded-lg border border-border bg-card px-4 py-4 pb-5">
    <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ${iconBg}`}><Icon className={`h-[18px] w-[18px] ${iconColor}`} /></div>
    <p className="mb-0.5 text-[11px] text-muted-foreground">{label}</p>
    <p className="text-xl font-bold leading-tight tabular-nums">{value}</p>
    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{sub}</p>
    <div className="absolute bottom-0 left-0 right-0 h-[3px] overflow-hidden rounded-b-lg bg-white/5"><div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(2, pct)}%` }} /></div>
  </div>;
}

function Activity() {
  const activity: { title: string; detail: string; time: string; icon: typeof CheckCircle2; color: string }[] = [
    { title: "Scan completed", detail: "1,284 files indexed", time: "2 minutes ago", icon: CheckCircle2, color: "text-green-400" },
    { title: "Thumbnails generated", detail: "248 new previews ready", time: "18 minutes ago", icon: ImageIcon, color: "text-blue-400" },
    { title: "Duplicate review", detail: "12 possible matches found", time: "Today", icon: Copy, color: "text-amber-400" },
  ];
  return <div className="rounded-lg border border-border bg-card px-5 py-4">
    <div className="mb-3 flex items-center justify-between"><p className="text-sm font-semibold">Library Activity</p><span className="font-mono text-[10px] text-muted-foreground">LIVE FEED</span></div>
    <div className="grid gap-3 sm:grid-cols-3">
      {activity.map(({ title, detail, time, icon: Icon, color }) =>
        <div className="flex items-start gap-2.5" key={title}><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} /><div className="min-w-0"><p className="truncate text-xs font-medium">{title}</p><p className="truncate text-[11px] text-muted-foreground">{detail}</p><p className="mt-0.5 text-[10px] text-muted-foreground/70">{time}</p></div></div>,
      )}
    </div>
  </div>;
}

export function Current() {
  const stats = [
    ["Photos", "18,642", bytes(84.3 * 1024 ** 3), ImageIcon, "bg-purple-500/20", "text-purple-400", "bg-purple-500", 58],
    ["Videos", "1,284", bytes(42.7 * 1024 ** 3), Film, "bg-blue-500/20", "text-blue-400", "bg-blue-500", 29],
    ["Documents", "3,906", bytes(8.1 * 1024 ** 3), FileText, "bg-green-500/20", "text-green-400", "bg-green-500", 8],
    ["Storage Used", bytes(146.2 * 1024 ** 3), "of 512 GB (29%)", HardDrive, "bg-amber-500/20", "text-amber-400", "bg-amber-500", 29],
    ["Duplicates", "347", bytes(6.4 * 1024 ** 3), Copy, "bg-red-500/20", "text-red-400", "bg-red-500", 1],
    ["Incoming", "26", "Awaiting review", Download, "bg-sky-500/20", "text-sky-400", "bg-sky-500", 2],
  ] as const;
  const quick = [["Import Media", "Add files to your library", ArrowUpFromLine], ["Find Duplicates", "Locate duplicate files", Copy], ["Optimize Library", "Free up space", Maximize2], ["Open Library", "Browse all media", FolderOpen], ["Health Center", "Check library health", HeartPulse]] as const;
  return <div className="willard-shell min-h-screen bg-background p-4 text-foreground sm:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl gap-6">
      <aside className="hidden w-52 shrink-0 md:block"><div className="mb-7 flex h-10 items-center px-2"><span className="willard-brand font-mono text-lg font-bold tracking-[.18em]">WILLARD_AI</span></div><nav className="space-y-1">{nav.map(([name, Icon]) => <div key={name} className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 font-mono text-xs ${name === "Dashboard" ? "border border-primary/20 bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]" : "text-sidebar-foreground/70"}`}><Icon className={`h-4 w-4 ${name === "Dashboard" ? "text-primary" : "text-muted-foreground"}`} /><span>{name}</span></div>)}</nav></aside>
      <main className="min-w-0 flex-1 space-y-4">
        <div className="glass-surface flex h-11 items-center gap-3 rounded-lg border border-border/80 bg-background/35 px-3 text-sm text-muted-foreground"><Search className="h-3.5 w-3.5" /><span className="flex-1">Search your library…</span><span className="rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px]">Ctrl+K</span><CheckCircle2 className="ml-auto h-3.5 w-3.5 text-teal-300" /><span className="hidden text-xs md:inline">Healthy</span><button className="ml-2 flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs text-primary"><ScanLine className="h-3 w-3" /> Full Rescan</button></div>
        <div className="relative flex min-h-[140px] items-center justify-between overflow-hidden rounded-xl border border-border" style={{ background: "linear-gradient(135deg,#0f1117 0%,#141b2d 60%,#0c1520 100%)" }}><div className="z-10 px-8 py-6"><div className="flex items-center gap-3"><h1 className="text-3xl font-bold tracking-tight text-white">Welcome back, Willard!</h1><span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 className="h-4 w-4" /> Ready</span></div><p className="mt-1.5 text-sm text-blue-200/70">Here&apos;s what&apos;s happening with your media library today.</p></div><div className="pr-10 text-blue-300/50"><Database className="h-20 w-20" /></div></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{stats.map(([label,value,sub,icon,iconBg,iconColor,bar,pct]) => <StatCard key={label} label={label} value={value} sub={sub} icon={icon} iconBg={iconBg} iconColor={iconColor} bar={bar} pct={pct} />)}</div>
        <div className="rounded-lg border border-border bg-card px-6 py-4"><div className="flex flex-wrap items-center gap-6"><div className="flex min-w-fit items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500/20"><CheckCircle2 className="h-5 w-5 text-green-500" /></div><div><p className="text-sm font-semibold text-green-400">✓ Library Ready</p><p className="text-xs text-muted-foreground">All media indexed and up to date.</p></div></div><div className="border-l border-border pl-6"><p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">Last Scan</p><p className="text-sm font-medium">Today • 09:40</p><p className="mt-0.5 text-xs text-primary">View Settings</p></div><div className="border-l border-border pl-6"><p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Library Health</p><div className="grid grid-cols-3 gap-x-5 gap-y-1.5">{["Library","Database","Thumbnails","Duplicates","Metadata","Corrupt Files"].map(x=><span className="flex items-center gap-1.5 text-xs text-muted-foreground" key={x}><CheckCircle2 className="h-3.5 w-3.5 text-green-500" />{x}</span>)}</div></div></div></div>
        <Activity />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5"><div className="overflow-hidden rounded-lg border border-border bg-card lg:col-span-3"><div className="flex items-center justify-between border-b border-border px-5 py-3.5"><p className="text-sm font-semibold">Recently Added</p><span className="text-xs text-primary">View All</span></div><div className="flex gap-3 overflow-x-auto p-4">{files.map(file=><div className="w-36 shrink-0" key={file.filename}><div className={`relative flex h-24 items-center justify-center overflow-hidden rounded-lg border border-border bg-gradient-to-br ${file.color}`}><div className="absolute inset-0 bg-black/25" /><span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">{file.filename.split(".").pop()?.toUpperCase()}</span><ImageIcon className="h-9 w-9 text-white/60" /></div><p className="mt-1.5 truncate text-xs">{file.filename}</p><p className="mt-0.5 text-[10px] text-muted-foreground">{file.modifiedAt}</p></div>)}</div></div>
          <div className="overflow-hidden rounded-lg border border-border bg-card lg:col-span-2"><div className="border-b border-border px-5 py-3.5"><p className="text-sm font-semibold">Quick Actions</p></div><div className="divide-y divide-border">{quick.map(([label,sub,Icon])=><div className="group flex items-center gap-3 px-5 py-3" key={label}><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10"><Icon className="h-4 w-4 text-primary" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{label}</p><p className="truncate text-xs text-muted-foreground">{sub}</p></div><ChevronRight className="h-4 w-4 text-muted-foreground" /></div>)}</div></div></div>
        <div className="rounded-lg border border-border bg-card px-6 py-5"><div className="flex flex-wrap items-center gap-7"><div className="relative h-24 w-24 shrink-0 rounded-full" style={{ background: "conic-gradient(#8b5cf6 0 58%,#3b82f6 58% 87%,#22c55e 87% 95%,#f59e0b 95% 100%)" }}><div className="absolute inset-3 flex items-center justify-center rounded-full bg-card"><span className="text-center text-[10px] text-muted-foreground">146 GB<br /><b className="text-xs text-foreground">Used</b></span></div></div><div className="flex flex-wrap gap-x-6 gap-y-2">{[["Images","58%","#8b5cf6"],["Videos","29%","#3b82f6"],["Documents","8%","#22c55e"],["Other","5%","#f59e0b"]].map(([x,p,c])=><span className="flex items-center gap-2 text-xs text-muted-foreground" key={x}><i className="h-2.5 w-2.5 rounded-full" style={{background:c}} />{x} <b className="text-foreground">{p}</b></span>)}</div><div className="ml-auto border-l border-border pl-8 text-right"><p className="text-xs text-muted-foreground">512 GB Total Capacity</p><p className="mt-0.5 text-sm font-semibold text-primary">365.8 GB Free</p></div></div></div>
      </main>
    </div>
  </div>;
}

export default Current;