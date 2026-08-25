import "./_group.css";
import "./quiet-assistant.css";
import {
  Archive, ArrowUpFromLine, Bell, BookImage, Check, CheckCircle2, ChevronDown, ChevronRight,
  CircleHelp, Copy, Database, FileText, Film, FolderHeart, FolderOpen, HardDrive, HeartPulse,
  Image as ImageIcon, LayoutDashboard, MapPinned, Maximize2, Menu, MessageSquare, MoreHorizontal,
  Play, Search, Settings, ShieldCheck, Sparkles, Trash2, Users, X, Zap,
} from "lucide-react";
import { useMemo, useState } from "react";

type IconType = typeof ImageIcon;
type FileKind = "image" | "video" | "document";

type RecentFile = {
  filename: string;
  kind: FileKind;
  time: string;
  label: string;
  thumbA: string;
  thumbB: string;
};

const nav = [
  ["Dashboard", LayoutDashboard], ["Media", ImageIcon], ["Memory Map", MapPinned], ["Library", BookImage],
  ["Collections", FolderHeart], ["People", Users], ["Archives", Archive], ["Documents", FileText],
  ["Operations", Database], ["Optimize", Zap], ["Cleanup", Trash2], ["Health Center", ShieldCheck],
  ["Search", Search], ["AI Chat", MessageSquare], ["Settings", Settings],
] as const;

const recentFiles: RecentFile[] = [
  { filename: "summer-cabin.jpg", kind: "image", time: "Today · 09:42", label: "PHOTO", thumbA: "#7899a9", thumbB: "#243f5a" },
  { filename: "family-reunion.mp4", kind: "video", time: "Yesterday", label: "VIDEO", thumbA: "#c6926b", thumbB: "#4a3040" },
  { filename: "renovation-notes.pdf", kind: "document", time: "2 days ago", label: "PDF", thumbA: "#6d8291", thumbB: "#243a43" },
  { filename: "garden-party.png", kind: "image", time: "3 days ago", label: "PHOTO", thumbA: "#aa8a76", thumbB: "#38435f" },
  { filename: "travel-plans.docx", kind: "document", time: "4 days ago", label: "DOC", thumbA: "#8298a0", thumbB: "#384657" },
  { filename: "lake-weekend.mov", kind: "video", time: "6 days ago", label: "VIDEO", thumbA: "#879cbd", thumbB: "#293956" },
];

const collections = [
  { name: "Family", count: "8,432 items", icon: Users, a: "#9f7766", b: "#27384d" },
  { name: "Arizona Trip", count: "2,120 items", icon: MapPinned, a: "#af7656", b: "#54362d" },
  { name: "Vehicles", count: "1,298 items", icon: FolderOpen, a: "#687887", b: "#263543" },
  { name: "Business", count: "3,421 items", icon: BriefcaseIcon, a: "#77859d", b: "#2b354d" },
  { name: "Favorites", count: "1,024 items", icon: HeartPulse, a: "#95859b", b: "#3a2f4b" },
];

const initialNotes = [
  { id: 1, title: "12 items ready to optimize", detail: "Organize, convert & enrich", icon: Sparkles, tint: "text-violet-300", bg: "bg-violet-400/10" },
  { id: 2, title: "3 ZIP files found", detail: "Ready to be extracted", icon: Archive, tint: "text-sky-300", bg: "bg-sky-400/10" },
];

function BriefcaseIcon({ className }: { className?: string }) {
  return <FolderOpen className={className} />;
}

function Stat({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: IconType; tone: string }) {
  return (
    <div className="quiet-panel-soft flex min-w-0 items-center gap-3 rounded-xl px-3.5 py-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
        <Icon className="h-[17px] w-[17px]" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[10px] uppercase tracking-[.14em] text-slate-500">{label}</p>
        <p className="mt-0.5 text-[17px] font-semibold leading-none text-slate-100">{value}</p>
        <p className="mt-1 truncate text-[10px] text-slate-500">{detail}</p>
      </div>
    </div>
  );
}

function SectionHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold tracking-wide text-slate-100">{title}</h2>
      {action && <button onClick={onAction} className="text-[11px] text-slate-400 transition-colors hover:text-cyan-300">{action}</button>}
    </div>
  );
}

export function QuietAssistant() {
  const [activeNav, setActiveNav] = useState("Dashboard");
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState(initialNotes);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [isHealthy, setIsHealthy] = useState(true);

  const visibleFiles = useMemo(() => {
    const filtered = recentFiles.filter((file) => file.filename.toLowerCase().includes(search.toLowerCase()));
    return showAllFiles ? filtered : filtered.slice(0, 6);
  }, [search, showAllFiles]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };

  const runAction = (label: string) => notify(`${label} is ready in this preview`);

  return (
    <div className="quiet-assistant quiet-grid min-h-[100dvh]">
      <div className="mx-auto flex min-h-[100dvh] max-w-[1540px]">
        <aside className={`${mobileNav ? "fixed inset-y-0 left-0 z-30 flex w-[250px]" : "hidden"} w-[250px] shrink-0 flex-col border-r border-slate-800/70 bg-[#090d17]/95 px-4 py-5 backdrop-blur-xl lg:flex`}>
          <div className="mb-8 flex items-center justify-between px-2">
            <button onClick={() => { setActiveNav("Dashboard"); setMobileNav(false); }} className="flex items-center gap-2.5 text-left">
              <span className="relative flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-cyan-300 via-blue-500 to-violet-500 shadow-[0_0_24px_rgba(77,170,255,.24)]">
                <span className="h-3.5 w-3.5 rounded-[4px] border-2 border-white/90 rotate-45" />
              </span>
              <span>
                <span className="block text-[15px] font-semibold tracking-[.18em] text-slate-100">WILLARD</span>
                <span className="block text-[9px] tracking-[.34em] text-violet-300">AI / PRIVATE</span>
              </span>
            </button>
            {mobileNav && <button onClick={() => setMobileNav(false)} className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white"><X className="h-4 w-4" /></button>}
          </div>
          <p className="mb-2 px-3 text-[9px] uppercase tracking-[.2em] text-slate-600">Your library</p>
          <nav className="space-y-0.5">
            {nav.map(([name, Icon]) => (
              <button key={name} onClick={() => { setActiveNav(name); setMobileNav(false); }} className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[12px] transition-colors ${activeNav === name ? "bg-cyan-300/[.09] text-cyan-200 shadow-[inset_2px_0_0_#73e8ef]" : "text-slate-500 hover:bg-white/[.035] hover:text-slate-200"}`}>
                <Icon className={`h-[15px] w-[15px] ${activeNav === name ? "text-cyan-300" : "text-slate-600 group-hover:text-slate-400"}`} />
                <span>{name}</span>
                {name === "Cleanup" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-300/80" />}
              </button>
            ))}
          </nav>
          <div className="mt-auto">
            <div className="quiet-panel-soft mb-4 rounded-xl p-3.5">
              <div className="mb-2.5 flex items-center justify-between"><span className="text-[10px] text-slate-500">Storage used</span><HardDrive className="h-3.5 w-3.5 text-slate-600" /></div>
              <p className="text-sm font-semibold text-slate-200">146.2 GB <span className="text-[10px] font-normal text-slate-500">of 512 GB</span></p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-800"><div className="h-full w-[29%] rounded-full bg-gradient-to-r from-cyan-300 to-violet-400" /></div>
              <button onClick={() => runAction("Storage details")} className="mt-3 text-[10px] text-cyan-300 hover:text-cyan-200">View storage <ChevronRight className="ml-0.5 inline h-3 w-3" /></button>
            </div>
            <button onClick={() => runAction("Account menu")} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-white/[.035]">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 to-rose-400 text-[10px] font-bold text-slate-900">CW</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs text-slate-200">Chris Willard</span><span className="block text-[10px] text-slate-600">Local administrator</span></span>
              <ChevronDown className="h-3.5 w-3.5 text-slate-600" />
            </button>
          </div>
        </aside>

        {mobileNav && <button aria-label="Close navigation" onClick={() => setMobileNav(false)} className="fixed inset-0 z-20 bg-slate-950/70 lg:hidden" />}

        <main className="min-w-0 flex-1 px-4 py-4 sm:px-6 sm:py-6 lg:px-9 lg:py-7">
          <header className="mb-7 flex items-center gap-3">
            <button onClick={() => setMobileNav(true)} className="rounded-lg border border-slate-800 p-2 text-slate-400 lg:hidden"><Menu className="h-4 w-4" /></button>
            <div className="relative min-w-0 max-w-[520px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your library..." className="h-10 w-full rounded-xl border border-slate-800 bg-slate-950/30 pl-10 pr-16 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-cyan-300/40" />
              <span className="absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-slate-800 px-1.5 py-0.5 font-mono text-[9px] text-slate-600 sm:inline">⌘ K</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => runAction("Notifications")} className="relative rounded-lg border border-slate-800 p-2 text-slate-500 hover:border-slate-700 hover:text-slate-200"><Bell className="h-4 w-4" /><span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-violet-400 ring-2 ring-[#080b14]" /></button>
              <button onClick={() => runAction("Help")} className="hidden rounded-lg border border-slate-800 p-2 text-slate-500 hover:text-slate-200 sm:block"><CircleHelp className="h-4 w-4" /></button>
            </div>
          </header>

          <div className="quiet-fade-in mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[.22em] text-cyan-300/80"><span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> Library is settled</div>
              <h1 className="quiet-display text-3xl font-medium text-slate-100 sm:text-[39px]">Good evening, Chris.</h1>
              <p className="mt-2 text-sm text-slate-500">A quiet look at what has changed since you last visited.</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span className={`h-2 w-2 rounded-full ${isHealthy ? "bg-emerald-300" : "bg-amber-300"}`} />
              {isHealthy ? "All caught up" : "Attention needed"}
              <button onClick={() => setIsHealthy(!isHealthy)} className="ml-1 text-slate-700 hover:text-slate-400"><MoreHorizontal className="h-4 w-4" /></button>
            </div>
          </div>

          <section className="quiet-fade-in quiet-delay-1 relative mb-5 min-h-[190px] overflow-hidden rounded-2xl border border-slate-800/80 bg-[#0d1425]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_67%_48%,rgba(80,143,255,.24),transparent_17%),radial-gradient(circle_at_81%_15%,rgba(164,100,255,.16),transparent_26%)]" />
            <div className="absolute -right-10 top-4 h-44 w-[52%] opacity-80 sm:right-8 sm:w-[43%]">
              <div className="absolute left-[15%] top-[23%] h-24 w-24 rounded-[35%] border border-cyan-300/60 bg-gradient-to-br from-cyan-300/30 to-blue-700/20 shadow-[0_0_45px_rgba(59,176,255,.35)] rotate-12" />
              <div className="absolute left-[32%] top-[11%] h-28 w-28 rounded-[40%] border border-violet-300/60 bg-gradient-to-br from-violet-400/25 to-blue-700/20 shadow-[0_0_55px_rgba(142,88,255,.34)] -rotate-12" />
              <div className="absolute right-[18%] top-[43%] h-px w-36 bg-gradient-to-r from-transparent via-cyan-200/80 to-transparent rotate-[18deg]" />
              <div className="absolute right-[2%] top-[12%] h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_14px_#9befff]" />
              <div className="absolute left-[5%] top-[70%] h-1 w-1 rounded-full bg-violet-300 shadow-[0_0_11px_#b18aff]" />
              <div className="absolute right-[28%] top-[22%] h-1 w-1 rounded-full bg-blue-200" />
            </div>
            <div className="relative z-10 flex min-h-[190px] max-w-[76%] flex-col justify-center px-6 py-7 sm:max-w-[58%] sm:px-8">
              <span className="mb-3 text-[10px] uppercase tracking-[.2em] text-slate-500">The library, in focus</span>
              <p className="max-w-[370px] text-xl font-medium leading-tight text-slate-100 sm:text-2xl">Your memories are organized. Willard is keeping watch in the background.</p>
              <button onClick={() => runAction("Library overview")} className="mt-5 flex w-fit items-center gap-1.5 text-[11px] text-cyan-300 hover:text-cyan-200">See library overview <ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
          </section>

          <section className="quiet-fade-in quiet-delay-2 mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-5">
            <Stat label="Photos" value="18,642" detail="84.3 GB" icon={ImageIcon} tone="bg-cyan-300/10 text-cyan-300" />
            <Stat label="Videos" value="1,284" detail="42.7 GB" icon={Film} tone="bg-violet-300/10 text-violet-300" />
            <Stat label="Documents" value="3,906" detail="8.1 GB" icon={FileText} tone="bg-amber-300/10 text-amber-200" />
            <Stat label="Storage" value="146.2 GB" detail="29% of 512 GB" icon={HardDrive} tone="bg-emerald-300/10 text-emerald-300" />
            <div className="quiet-panel-soft col-span-2 flex items-center justify-between rounded-xl px-4 py-3 sm:col-span-4 lg:col-span-1 lg:block">
              <div><p className="text-[10px] uppercase tracking-[.14em] text-slate-500">Library health</p><p className={`mt-1 text-[17px] font-semibold ${isHealthy ? "text-emerald-300" : "text-amber-300"}`}>{isHealthy ? "Healthy" : "Review"}</p></div>
              <button onClick={() => setIsHealthy(!isHealthy)} className="text-[10px] text-slate-500 hover:text-cyan-300">{isHealthy ? "View details" : "Mark healthy"} <ChevronRight className="inline h-3 w-3" /></button>
            </div>
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_296px]">
            <div className="min-w-0">
              <section className="quiet-fade-in quiet-delay-2 quiet-panel mb-5 overflow-hidden rounded-2xl p-4 sm:p-5">
                <SectionHeading title="Recently added" action={showAllFiles ? "Show less" : "View all"} onAction={() => setShowAllFiles(!showAllFiles)} />
                <div className="quiet-scrollbar flex gap-3 overflow-x-auto pb-1">
                  {visibleFiles.length ? visibleFiles.map((file) => (
                    <button onClick={() => runAction(file.filename)} key={file.filename} className="group w-[116px] shrink-0 text-left sm:w-[134px]">
                      <div className="quiet-thumbnail h-[105px] rounded-xl border border-slate-700/70" style={{ "--thumb-a": file.thumbA, "--thumb-b": file.thumbB } as React.CSSProperties}>
                        <span className="absolute left-2 top-2 z-10 rounded bg-slate-950/55 px-1.5 py-1 text-[8px] font-medium tracking-wider text-slate-200">{file.label}</span>
                        {file.kind === "video" && <span className="absolute bottom-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/55 text-white"><Play className="h-3 w-3 fill-current" /></span>}
                        {file.kind === "document" && <FileText className="absolute bottom-2 right-2 z-10 h-5 w-5 text-white/70" />}
                      </div>
                      <p className="mt-2 truncate text-[11px] text-slate-300 group-hover:text-cyan-200">{file.filename}</p>
                      <p className="mt-0.5 text-[10px] text-slate-600">{file.time}</p>
                    </button>
                  )) : <div className="flex h-28 w-full items-center justify-center text-xs text-slate-600">No library items match that search.</div>}
                </div>
              </section>

              <section className="quiet-fade-in quiet-delay-3 quiet-panel overflow-hidden rounded-2xl p-4 sm:p-5">
                <SectionHeading title="Your collections" action="View all" onAction={() => runAction("Collections")} />
                <div className="quiet-scrollbar flex gap-3 overflow-x-auto pb-1">
                  {collections.map((collection) => {
                    const Icon = collection.icon;
                    return <button onClick={() => runAction(collection.name)} key={collection.name} className="group w-[126px] shrink-0 text-left sm:w-[142px]">
                      <div className="quiet-thumbnail h-[92px] rounded-xl border border-slate-700/70" style={{ "--thumb-a": collection.a, "--thumb-b": collection.b } as React.CSSProperties}>
                        <span className="absolute bottom-2 left-2 z-10 flex items-center gap-1.5 rounded bg-slate-950/60 px-1.5 py-1 text-[9px] text-white"><Icon className="h-3 w-3" /> {collection.name}</span>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-300 group-hover:text-cyan-200">{collection.name}</p>
                      <p className="mt-0.5 text-[10px] text-slate-600">{collection.count}</p>
                    </button>;
                  })}
                </div>
              </section>
            </div>

            <aside className="space-y-5">
              <section className="quiet-fade-in quiet-delay-2 quiet-panel rounded-2xl p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-300" /><h2 className="text-[13px] font-semibold">Quiet notes</h2></div>
                  {notes.length > 0 && <span className="rounded-full bg-violet-300/10 px-2 py-1 text-[9px] text-violet-200">{notes.length} to review</span>}
                </div>
                {notes.length > 0 ? <div className="space-y-2">{notes.map((note) => {
                  const Icon = note.icon;
                  return <div key={note.id} className="rounded-xl border border-slate-800 bg-slate-950/20 p-3">
                    <div className="flex items-start gap-2.5">
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${note.bg}`}><Icon className={`h-3.5 w-3.5 ${note.tint}`} /></span>
                      <div className="min-w-0 flex-1"><p className="text-[11px] font-medium text-slate-200">{note.title}</p><p className="mt-1 text-[10px] text-slate-600">{note.detail}</p></div>
                      <button onClick={() => setNotes(notes.filter((item) => item.id !== note.id))} aria-label={`Dismiss ${note.title}`} className="text-slate-700 hover:text-slate-300"><X className="h-3.5 w-3.5" /></button>
                    </div>
                    <button onClick={() => runAction(note.title)} className="mt-2.5 w-full rounded-lg border border-slate-800 py-1.5 text-[10px] text-slate-400 hover:border-cyan-300/30 hover:text-cyan-200">Review</button>
                  </div>;
                })}</div> : <div className="rounded-xl border border-dashed border-slate-800 px-3 py-7 text-center"><Check className="mx-auto h-5 w-5 text-emerald-300" /><p className="mt-2 text-xs text-slate-300">Nothing needs your attention.</p><p className="mt-1 text-[10px] text-slate-600">Willard will keep an eye on the rest.</p></div>}
              </section>

              <section className="quiet-fade-in quiet-delay-3 quiet-panel rounded-2xl p-4">
                <SectionHeading title="Quick actions" />
                <div className="space-y-1">
                  {[
                    ["Import media", "Add files to your library", ArrowUpFromLine],
                    ["Find duplicates", "Review possible matches", Copy],
                    ["Optimize library", "Free up space", Maximize2],
                    ["Open library", "Browse all media", FolderOpen],
                  ].map(([label, detail, Icon]) => <button onClick={() => runAction(String(label))} key={String(label)} className="group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-2.5 text-left hover:bg-white/[.035]">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-800/60 text-slate-500 group-hover:text-cyan-300"><Icon className="h-3.5 w-3.5" /></span>
                    <span className="min-w-0 flex-1"><span className="block text-[11px] text-slate-300">{String(label)}</span><span className="block truncate text-[10px] text-slate-600">{String(detail)}</span></span>
                    <ChevronRight className="h-3.5 w-3.5 text-slate-700 group-hover:text-slate-400" />
                  </button>)}
                </div>
              </section>

              <section className="quiet-panel-soft rounded-2xl p-4">
                <div className="flex items-start gap-3">
                  <div className="relative mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-300/10"><Sparkles className="h-3.5 w-3.5 text-cyan-300" /><span className="absolute inset-0 animate-ping rounded-full border border-cyan-300/20" /></div>
                  <div><p className="text-[11px] font-medium text-slate-200">Ask Willard</p><p className="mt-1 text-[10px] leading-relaxed text-slate-600">Find anything, get answers, or revisit a memory.</p><button onClick={() => runAction("AI Chat")} className="mt-2.5 text-[10px] text-cyan-300 hover:text-cyan-200">Start a conversation <ChevronRight className="inline h-3 w-3" /></button></div>
                </div>
              </section>
            </aside>
          </div>

          <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/70 pt-4 text-[10px] text-slate-600">
            <span className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> Willard is up to date</span>
            <span>Last scan: today · 09:40</span>
            <button onClick={() => runAction("Full rescan")} className="text-slate-500 hover:text-cyan-300">Run a full rescan <ChevronRight className="inline h-3 w-3" /></button>
          </footer>
        </main>
      </div>
      {toast && <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-cyan-300/20 bg-slate-900/95 px-4 py-2.5 text-xs text-slate-200 shadow-2xl">{toast}</div>}
    </div>
  );
}

export default QuietAssistant;